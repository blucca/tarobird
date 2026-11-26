import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import os from "node:os";
import { z } from "zod";
import { blocksText, idSchema, type Block, type Conversation, type HubEvent } from "../client-protocol/index.js";
import {
  DISPATCH_ENGINES, REMOTE_DISPATCH_TARGET_BOT, crossHostDispatchGrantCommandSchema, crossHostDispatchGrantsSnapshotSchema,
  engineHealthSchema, hostLoadReportSchema, remoteDispatchRunRequestSchema, remoteDispatchRunResponseSchema,
  remoteDispatchStatusResponseSchema, remoteDispatchStopRequestSchema, remoteDispatchStopResponseSchema,
  type CrossHostDispatchGrantsSnapshot, type DispatchEngine, type EngineHealth, type HostEngineCapacity, type HostLoadReport,
  type RemoteDispatchRunResponse, type RemoteDispatchStatusResponse, type RemoteDispatchStopResponse, type TicketArtifact, type TicketFailure,
} from "../client-protocol/dispatch.js";
import type { BotCatalog } from "../client-protocol/bots.js";
import { anyRun, isRunActive, nativeRun, runSummarySchema } from "../client-protocol/run.js";
import { renderedEngineFailure, renderedEngineResetHint } from "../core/errors.js";
import type { QuotaScope } from "../client-protocol/engine-quota.js";
import type { HubAuth } from "./auth.js";
import type { HubAttachments } from "./attachments.js";
import type { PrivateNetwork } from "./private-network.js";
import { HubError, newId, type HubStore, type TransactionGuard } from "./store.js";

const activeRunPhases = runSummarySchema.shape.phase.options.filter(isRunActive);
const activeRunPhaseParams = activeRunPhases.map(() => "?").join(",");
const SWITCH_CATEGORIES = new Set(["engine-quota", "auth", "engine-rate-limit", "engine-backend", "engine-cli"]);
const RESULT_CHARS = 4000;

type DispatchGrant = { sourceKey: string; sourceBot: string; revoked: boolean };
type RemoteTicketRow = {
  id: string; source_key: string; source_host_id: string; source_bot_id: string; remote_request_id: string;
  title: string; request: string; engine: string; model: string; effort: string;
  bot_id: string; conversation_id: string; input_message_id: string; status: string;
  created_at: number; updated_at: number;
};

const hostIdOfKey = (key: string) => `hub_${createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")}`;
const dispatchGrantKey = (sourceKey: string, sourceBot: string) =>
  `bot-messages:dispatch-grant:${createHash("sha256").update(JSON.stringify([sourceKey, sourceBot])).digest("hex")}`;
const botGrantKey = (sourceKey: string, sourceBot: string, targetBot: string) =>
  `bot-messages:grant:${createHash("sha256").update(JSON.stringify([sourceKey, sourceBot, targetBot])).digest("hex")}`;

export interface RemoteDispatchWorkers {
  catalog(): Promise<BotCatalog>;
  engineAvailable?(engine: DispatchEngine): boolean;
  remoteDispatchWorker?(sourceHostId: string, engine: DispatchEngine, validate?: TransactionGuard): Promise<string>;
  remoteTicketWorkspace?(sourceHostId: string, remoteTicketId: string): Promise<string>;
}

export interface RemoteDispatchContext {
  store: HubStore;
  auth: HubAuth;
  network: PrivateNetwork;
  attachments: HubAttachments;
  workers?: RemoteDispatchWorkers;
  quotaScopes?: () => Promise<QuotaScope[]>;
  conversationCreated: (userId: string, conversation: Conversation) => void;
  stop: (botId: string, conversationId: string, userId: string, messageId: string) => Promise<unknown>;
}

function summarizeEngineQuota(scopes: readonly QuotaScope[], engine: DispatchEngine): { quotaState: HostEngineCapacity["quotaState"]; quotaSummary?: string } {
  const matching = scopes.filter(s => s.engine === engine && (s.state === "ready" || s.state === "stale"));
  if (!matching.length) return { quotaState: "unknown" };
  let worst: "ok" | "warning" | "blocked" = "ok";
  let summary: string | undefined;
  for (const scope of matching) {
    if (scope.availability === "blocked") {
      worst = "blocked";
      summary = "quota_blocked";
      break;
    }
    const maxPct = Math.max(0, ...scope.pools.flatMap(p => p.windows.map(w => w.metric === "percent" ? w.usedPercent : 0)));
    if (scope.availability === "warning" || maxPct >= 85) {
      if (worst === "ok") worst = "warning";
      summary = `${Math.round(maxPct)}% used`;
    } else if (!summary && maxPct > 0) {
      summary = `${Math.round(maxPct)}% used`;
    }
  }
  return { quotaState: worst, ...(summary ? { quotaSummary: summary } : {}) };
}

/** Read-only local Host load, capacity and cached engine quota snapshot (aligned with #88). */
export async function readLocalHostLoad(ctx: RemoteDispatchContext, health: readonly EngineHealth[]): Promise<HostLoadReport> {
  const view = await ctx.network.view();
  const hostId = hostIdOfKey(ctx.auth.publicKey);
  const hostName = view.host.name;
  const cpuCount = Math.max(1, os.cpus().length || 1);
  const load1m = os.loadavg()[0];
  const cpuLoadRatio = Number.isFinite(load1m) && load1m >= 0 ? Math.round((load1m / cpuCount) * 100) / 100 : undefined;
  const totalMem = os.totalmem();
  const freeMemoryRatio = totalMem > 0 ? Math.round((os.freemem() / totalMem) * 100) / 100 : undefined;

  const counts = await ctx.store.db.serial(async () => {
    const turns = await ctx.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending' AND dispatched=1");
    const localTickets = await ctx.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch_tickets WHERE status='working'");
    const remoteTickets = await ctx.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM remote_dispatch_tickets WHERE status='working'");
    return { activeTurns: turns?.n ?? 0, activeTickets: (localTickets?.n ?? 0) + (remoteTickets?.n ?? 0) };
  });

  const catalog = ctx.workers ? await ctx.workers.catalog() : { engines: [] };
  const quotas = await ctx.quotaScopes?.().catch(() => [] as QuotaScope[]) ?? [];
  const engines: HostEngineCapacity[] = DISPATCH_ENGINES.map(engine => {
    const cat = catalog.engines.find(e => e.id === engine);
    const installed = cat?.available ?? (ctx.workers?.engineAvailable?.(engine) ?? false);
    const state = health.find(h => h.engine === engine);
    const quota = summarizeEngineQuota(quotas, engine);
    const available = installed && (!state || state.state === "ok") && quota.quotaState !== "blocked";
    return {
      engine,
      installed,
      available,
      ...(state ? { health: state } : {}),
      ...quota,
      models: cat ? cat.models.map(m => ({ ...m, label: m.label ?? (m.id || "CLI default") })) : [{ id: "", efforts: [""] }],
      defaultModel: cat?.defaultModel ?? "",
      defaultEffort: cat?.defaultEffort ?? "",
    };
  });

  return hostLoadReportSchema.parse({
    hostId,
    hostName,
    online: true,
    authorized: true,
    cpuCount,
    ...(cpuLoadRatio !== undefined ? { cpuLoadRatio } : {}),
    ...(freeMemoryRatio !== undefined ? { freeMemoryRatio } : {}),
    activeTurns: counts.activeTurns,
    activeTickets: counts.activeTickets,
    engines,
    observedAt: Date.now(),
  });
}

export async function readCrossHostDispatchGrants(ctx: RemoteDispatchContext, userId: string, guard: () => Promise<unknown>): Promise<CrossHostDispatchGrantsSnapshot> {
  const view = await ctx.network.view(guard);
  const ownId = hostIdOfKey(ctx.auth.publicKey);
  return ctx.store.db.serial(async () => {
    await guard();
    await ctx.store.requireOwner(userId);
    const peers = (view.membership?.manifest.hosts ?? []).filter(h => h.publicKey !== ctx.auth.publicKey);
    const hosts: CrossHostDispatchGrantsSnapshot["hosts"] = [];
    for (const peer of peers) {
      let available = false;
      if (peer.state === "active" && !peer.revoked) {
        try { await ctx.network.requireMessagePeerInTransaction(peer.publicKey); available = true; } catch { available = false; }
      }
      hosts.push({ id: hostIdOfKey(peer.publicKey), name: peer.name, available });
    }
    const rows = await ctx.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:dispatch-grant:%' ORDER BY key");
    const grants: CrossHostDispatchGrantsSnapshot["grants"] = [];
    for (const row of rows) {
      try {
        const grant = JSON.parse(row.value) as DispatchGrant;
        if (!grant.revoked && row.key === dispatchGrantKey(grant.sourceKey, grant.sourceBot)) {
          grants.push({ sourceHost: hostIdOfKey(grant.sourceKey), sourceBot: grant.sourceBot });
        }
      } catch { /* ignore malformed entry */ }
    }
    return crossHostDispatchGrantsSnapshotSchema.parse({ host: { id: ownId, name: view.host.name }, hosts, grants });
  });
}

export async function updateCrossHostDispatchGrants(
  ctx: RemoteDispatchContext,
  userId: string,
  actor: string,
  raw: unknown,
  guard: () => Promise<unknown>,
  admit: () => Promise<unknown>,
): Promise<CrossHostDispatchGrantsSnapshot> {
  const command = crossHostDispatchGrantCommandSchema.parse(raw);
  const view = await ctx.network.view(guard);
  await ctx.store.db.transaction(async () => {
    await guard();
    await ctx.store.requireOwner(userId);
    await admit();
    const peer = view.membership?.manifest.hosts.find(h => hostIdOfKey(h.publicKey) === command.sourceHost);
    if (!peer) throw new HubError("bot_message_host_not_found", 404);
    if (peer.publicKey === ctx.auth.publicKey) throw new HubError("bot_message_grant_local_source", 400);
    if (command.allowed) await ctx.network.requireMessagePeerInTransaction(peer.publicKey);
    await ctx.store.db.run(
      "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [dispatchGrantKey(peer.publicKey, command.sourceBot), JSON.stringify({ sourceKey: peer.publicKey, sourceBot: command.sourceBot, revoked: !command.allowed } satisfies DispatchGrant)],
    );
    await ctx.store.db.run(
      "INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)",
      [Date.now(), actor, command.allowed ? "dispatch.cross-host-granted" : "dispatch.cross-host-revoked", JSON.stringify({ sourceHost: command.sourceHost, sourceBot: command.sourceBot })],
    );
  });
  return readCrossHostDispatchGrants(ctx, userId, guard);
}

/** Caller holds DB serial/transaction. True when `(sourceKey, sourceBot)` is authorized for remote dispatch. */
export async function isRemoteDispatchAuthorizedInTransaction(
  ctx: RemoteDispatchContext,
  sourceKey: string,
  sourceBot: string,
  targetBot: string = REMOTE_DISPATCH_TARGET_BOT,
): Promise<boolean> {
  await ctx.network.requireMessagePeerInTransaction(sourceKey);
  const dispatchRow = await ctx.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [dispatchGrantKey(sourceKey, sourceBot)]);
  if (dispatchRow) {
    try {
      const grant = JSON.parse(dispatchRow.value) as DispatchGrant;
      if (!grant.revoked && grant.sourceKey === sourceKey && grant.sourceBot === sourceBot) return true;
    } catch { /* ignore */ }
  }
  if (targetBot !== REMOTE_DISPATCH_TARGET_BOT) {
    const botRow = await ctx.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [botGrantKey(sourceKey, sourceBot, targetBot)]);
    if (botRow) {
      try {
        const grant = JSON.parse(botRow.value) as { sourceKey: string; sourceBot: string; targetBot: string; revoked: boolean };
        if (!grant.revoked && grant.sourceKey === sourceKey && grant.sourceBot === sourceBot && grant.targetBot === targetBot) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

async function healthList(ctx: RemoteDispatchContext): Promise<EngineHealth[]> {
  const rows = await ctx.store.db.all<{ engine: string; state: string; until: number | null; reason: string | null; updated_at: number }>("SELECT * FROM engine_health ORDER BY engine");
  const now = Date.now();
  return rows.flatMap(row => {
    const parsed = engineHealthSchema.safeParse({ engine: row.engine, state: row.state, ...(row.until ? { until: row.until } : {}), ...(row.reason ? { reason: row.reason } : {}), updatedAt: row.updated_at });
    return parsed.success && !(parsed.data.state === "cooldown" && parsed.data.until !== undefined && parsed.data.until <= now) ? [parsed.data] : [];
  });
}

async function inspectRemoteTicketState(ctx: RemoteDispatchContext, row: RemoteTicketRow): Promise<RemoteDispatchStatusResponse> {
  const delivery = await ctx.store.db.get<{ status: string; dispatched: number }>("SELECT status,dispatched FROM deliveries WHERE message_id=? AND bot_id=?", [row.input_message_id, row.bot_id]);
  const deleted = !await ctx.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [row.bot_id]);
  const active = (await ctx.store.db.get<{ active: number }>(`SELECT 1 AS active FROM messages m WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted'
    AND (m.status IN ('pending','streaming') OR EXISTS (SELECT 1 FROM json_each(m.blocks_json) b WHERE json_extract(b.value,'$.type')='card'
      AND (json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams}) OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams})))) LIMIT 1`,
  [row.input_message_id, row.bot_id, row.conversation_id, ...activeRunPhases, ...activeRunPhases]))?.active ?? 0;

  const waiting = await ctx.store.db.get<{ id: string; phase: string }>(`SELECT m.id,COALESCE(json_extract(b.value,'$.extra.nativeRun.phase'),json_extract(b.value,'$.extra.scopedRun.phase')) AS phase
    FROM messages m,json_each(m.blocks_json) b WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted'
    AND COALESCE(json_extract(b.value,'$.extra.nativeRun.phase'),json_extract(b.value,'$.extra.scopedRun.phase')) IN ('waiting_answer','waiting_approval') ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
  [row.input_message_id, row.bot_id, row.conversation_id]);
  const waitingFor = waiting ? { kind: (waiting.phase === "waiting_answer" ? "answer" : "approval") as "answer" | "approval", messageId: waiting.id } : undefined;

  const replies = await ctx.store.db.all<{ id: string; blocks_json: string; status: string; created_at: number }>(
    "SELECT id,blocks_json,status,created_at FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND reply_to=? AND status!='deleted' ORDER BY created_at,id LIMIT 200",
    [row.conversation_id, row.bot_id, row.input_message_id],
  );
  const files = await ctx.store.db.all<{ id: string; name: string; size: number; mime: string; sha256: string }>(
    `SELECT DISTINCT a.id,a.name,a.size,a.mime,a.sha256 FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id
     WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted' AND a.complete=1`,
    [row.input_message_id, row.bot_id, row.conversation_id],
  );

  let error = false, incomplete = false, tail = "", length = 0, updatedAt = row.updated_at;
  let category: NonNullable<ReturnType<typeof renderedEngineFailure>>["category"] | undefined, resetHint: string | undefined;
  for (const r of replies) {
    updatedAt = Math.max(updatedAt, r.created_at);
    error ||= r.status === "error";
    const blocks = JSON.parse(r.blocks_json) as Block[];
    for (const block of blocks) {
      const fg = block.type === "card" ? nativeRun(block) ?? anyRun(block) : undefined;
      if (fg?.phase === "error") error = true;
      if (fg && ["partial", "stopped", "interrupted"].includes(fg.phase)) incomplete = true;
    }
    const text = blocksText(blocks).trim();
    if (text) {
      const part = (length ? "\n\n" : "") + text;
      tail = (tail + part).slice(-RESULT_CHARS);
      length += part.length;
      const f = renderedEngineFailure(text);
      if (f && SWITCH_CATEGORIES.has(f.category)) category = f.category;
      resetHint ??= renderedEngineResetHint(text);
    }
  }

  let status: RemoteDispatchStatusResponse["status"];
  let failure: TicketFailure | undefined;
  if (row.status === "cancelled" || (!deleted && delivery?.status === "cancelled")) {
    status = "cancelled";
  } else if (deleted) {
    status = "failed";
    failure = { category: "bot-deleted", message: "Worker bot was deleted" };
  } else if (waitingFor) {
    status = "needs_answer";
  } else if (active > 0 || !delivery || delivery.status === "pending") {
    status = delivery?.dispatched || active > 0 ? "working" : "queued";
  } else if (delivery.status === "failed" || error || incomplete) {
    status = "failed";
    failure = { category: (!incomplete ? category : undefined) ?? "task", ...(resetHint ? { resetHint } : {}), ...(tail ? { message: tail.slice(-1000) } : {}) };
  } else {
    status = "completed";
  }

  const artifacts: TicketArtifact[] = files.slice(0, 64).map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, sha256: f.sha256 }));
  return remoteDispatchStatusResponseSchema.parse({
    remoteTicketId: row.id,
    status,
    ...(waitingFor ? { waitingFor } : {}),
    ...(tail ? { result: tail } : {}),
    ...(length > RESULT_CHARS ? { resultTruncated: true } : {}),
    ...(failure ? { failure } : {}),
    artifacts,
    updatedAt,
  });
}

/** Handles authenticated `/api/bot-messages/dispatch/*` requests on the receiving Host B. */
export async function handleRemoteDispatchRequest(
  ctx: RemoteDispatchContext,
  sourceKey: string,
  source: { hostId: string; hostName: string; botId: string; botName: string; requestId: string; hops: number },
  targetBot: string,
  routePath: string,
  data: Record<string, unknown>,
  localAdmission?: () => Promise<unknown>,
): Promise<unknown> {
  if (routePath === "/api/bot-messages/dispatch/probe") {
    const authorized = await ctx.store.db.serial(() => isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot));
    if (!authorized) {
      const view = await ctx.network.view();
      return hostLoadReportSchema.parse({
        hostId: hostIdOfKey(ctx.auth.publicKey),
        hostName: view.host.name,
        online: true,
        authorized: false,
        activeTurns: 0,
        activeTickets: 0,
        engines: [],
        observedAt: Date.now(),
      });
    }
    const health = await ctx.store.db.serial(() => healthList(ctx));
    const load = await readLocalHostLoad(ctx, health);
    return hostLoadReportSchema.parse({ ...load, authorized: true });
  }

  const authorized = await ctx.store.db.serial(() => isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot));
  if (!authorized) throw new HubError("bot_message_not_authorized", 403);

  if (routePath === "/api/bot-messages/dispatch/run") {
    const input = remoteDispatchRunRequestSchema.parse(data);
    const existing = await ctx.store.db.serial(() => ctx.store.db.get<RemoteTicketRow>(
      "SELECT * FROM remote_dispatch_tickets WHERE source_key=? AND source_bot_id=? AND remote_request_id=?",
      [sourceKey, source.botId, input.remoteRequestId],
    ));
    if (existing) {
      if (existing.title !== input.title || existing.request !== input.request || existing.engine !== input.engine) {
        throw new HubError("idempotency_conflict", 409);
      }
      const bot = await ctx.store.db.serial(() => ctx.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=?", [existing.bot_id]));
      return remoteDispatchRunResponseSchema.parse({
        remoteTicketId: existing.id,
        conversationId: existing.conversation_id,
        messageId: existing.input_message_id,
        botId: existing.bot_id,
        botName: bot?.name ?? existing.bot_id,
        engine: existing.engine,
        model: existing.model,
        effort: existing.effort,
        status: existing.status === "working" ? "working" : "queued",
      });
    }

    const remoteTicketId = newId("rtk");
    let workerId: string;
    if (targetBot !== REMOTE_DISPATCH_TARGET_BOT) {
      const bot = await ctx.store.db.serial(() => ctx.store.db.get<{ id: string }>("SELECT id FROM bots WHERE id=? AND deleted_at IS NULL", [targetBot]));
      if (!bot) throw new HubError("bot_deleted", 410);
      workerId = bot.id;
    } else if (ctx.workers?.remoteDispatchWorker) {
      workerId = await ctx.workers.remoteDispatchWorker(source.hostId, input.engine);
    } else {
      const fallback = await ctx.store.db.serial(() => ctx.store.db.get<{ id: string }>(
        "SELECT id FROM bots WHERE engine=? AND deleted_at IS NULL ORDER BY CASE WHEN role='worker' THEN 0 ELSE 1 END, id LIMIT 1",
        [input.engine],
      ));
      if (!fallback) throw new HubError("dispatch_worker_unavailable", 409);
      workerId = fallback.id;
    }
    const workspace = ctx.workers?.remoteTicketWorkspace
      ? await ctx.workers.remoteTicketWorkspace(source.hostId, remoteTicketId)
      : undefined;

    const events: HubEvent[] = [];
    let createdConversation: Conversation | undefined;
    const response = await ctx.store.db.transaction(async (): Promise<RemoteDispatchRunResponse> => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) {
        throw new HubError("bot_message_not_authorized", 403);
      }
      await localAdmission?.();
      const dup = await ctx.store.db.get<RemoteTicketRow>(
        "SELECT * FROM remote_dispatch_tickets WHERE source_key=? AND source_bot_id=? AND remote_request_id=?",
        [sourceKey, source.botId, input.remoteRequestId],
      );
      if (dup) {
        const bot = await ctx.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=?", [dup.bot_id]);
        return remoteDispatchRunResponseSchema.parse({
          remoteTicketId: dup.id,
          conversationId: dup.conversation_id,
          messageId: dup.input_message_id,
          botId: dup.bot_id,
          botName: bot?.name ?? dup.bot_id,
          engine: dup.engine,
          model: dup.model,
          effort: dup.effort,
          status: dup.status === "working" ? "working" : "queued",
        });
      }
      const bot = await ctx.store.db.get<{ id: string; name: string; role: string }>("SELECT id,name,role FROM bots WHERE id=? AND deleted_at IS NULL", [workerId]);
      if (!bot) throw new HubError("dispatch_worker_unavailable", 409);
      const isWorker = bot.role === "worker";
      const conv = await ctx.store.createConversationInTransaction("owner", [bot.id], input.title.slice(0, 256), `rtk_${remoteTicketId}`, isWorker ? { dispatchWorker: true } : {});
      if (isWorker) {
        const marker = { id: remoteTicketId, dispatcherBotId: source.botId, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(workspace ? { workspace } : {}) };
        await ctx.store.db.run("UPDATE conversations SET hidden=1,ticket_json=? WHERE id=?", [JSON.stringify(marker), conv.id]);
      }
      createdConversation = await ctx.store.conversationInTransaction(conv.id);
      const sent = await ctx.store.sendMessageInTransaction("owner", {
        conversationId: conv.id,
        clientMsgId: `rtk_${remoteTicketId}`,
        text: input.request,
        attachments: [],
        mentions: [bot.id],
        previewUrl: null,
        botSource: {
          hostId: source.hostId,
          hostName: source.hostName.slice(0, 256),
          botId: source.botId,
          botName: source.botName.slice(0, 256),
          requestId: remoteTicketId,
          hops: Math.min(source.hops, 3),
        },
      });
      if (sent.event) events.push(sent.event);
      const now = Date.now();
      await ctx.store.db.run(
        `INSERT INTO remote_dispatch_tickets(id,source_key,source_host_id,source_bot_id,remote_request_id,title,request,engine,model,effort,bot_id,conversation_id,input_message_id,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [remoteTicketId, sourceKey, source.hostId, source.botId, input.remoteRequestId, input.title, input.request, input.engine, input.model, input.effort, bot.id, conv.id, sent.message.id, "working", now, now],
      );
      await ctx.store.db.run(
        "INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)",
        [now, source.botId, "dispatch.remote_run_started", JSON.stringify({ remoteTicketId, sourceHost: source.hostId, engine: input.engine })],
      );
      return remoteDispatchRunResponseSchema.parse({
        remoteTicketId,
        conversationId: conv.id,
        messageId: sent.message.id,
        botId: bot.id,
        botName: bot.name,
        engine: input.engine,
        model: input.model,
        effort: input.effort,
        status: "working",
      });
    });
    if (createdConversation && !createdConversation.hidden) ctx.conversationCreated("owner", createdConversation);
    ctx.store.emitCommitted(events);
    return response;
  }

  if (routePath === "/api/bot-messages/dispatch/status") {
    const { remoteTicketId } = z.object({ remoteTicketId: idSchema }).strict().parse(data);
    return ctx.store.db.serial(async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) throw new HubError("bot_message_not_authorized", 403);
      const row = await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [remoteTicketId]);
      if (!row || row.source_key !== sourceKey || row.source_bot_id !== source.botId) throw new HubError("ticket_not_found", 404);
      const result = await inspectRemoteTicketState(ctx, row);
      if (result.status !== row.status && ["completed", "failed", "cancelled"].includes(result.status)) {
        await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status=?,updated_at=? WHERE id=?", [result.status, Date.now(), row.id]);
      }
      return result;
    });
  }

  if (routePath === "/api/bot-messages/dispatch/stop") {
    const input = remoteDispatchStopRequestSchema.parse(data);
    const events: HubEvent[] = [];
    const prep = await ctx.store.db.transaction(async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) throw new HubError("bot_message_not_authorized", 403);
      const row = await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [input.remoteTicketId]);
      if (!row || row.source_key !== sourceKey || row.source_bot_id !== source.botId) throw new HubError("ticket_not_found", 404);
      const cancelled = await ctx.store.db.run(
        "UPDATE deliveries SET status='cancelled' WHERE message_id=? AND bot_id=? AND dispatched=0 AND status='pending'",
        [row.input_message_id, row.bot_id],
      );
      if (cancelled.changes) {
        events.push(await ctx.store.queueEventInTransaction(row.conversation_id, row.bot_id));
        await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status='cancelled',updated_at=? WHERE id=?", [Date.now(), row.id]);
        return { row, needRpc: false, status: "cancelled" as const };
      }
      if (input.action === "cancel") {
        await ctx.store.db.run("UPDATE remote_dispatch_tickets SET status='cancelled',updated_at=? WHERE id=?", [Date.now(), row.id]);
      }
      return { row, needRpc: true, status: (await inspectRemoteTicketState(ctx, row)).status };
    });
    ctx.store.emitCommitted(events);
    if (prep.needRpc) {
      await ctx.stop(prep.row.bot_id, prep.row.conversation_id, "owner", prep.row.input_message_id).catch(() => undefined);
    }
    const latest = await ctx.store.db.serial(async () => {
      const row = (await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [input.remoteTicketId]))!;
      return inspectRemoteTicketState(ctx, row);
    });
    return remoteDispatchStopResponseSchema.parse({
      remoteTicketId: input.remoteTicketId,
      status: latest.status,
      stopped: latest.status === "cancelled" || latest.status === "failed" || latest.status === "completed",
    } satisfies RemoteDispatchStopResponse);
  }

  if (routePath === "/api/bot-messages/dispatch/download") {
    const input = z.object({ remoteTicketId: idSchema, attachmentId: idSchema, offset: z.number().int().min(0) }).strict().parse(data);
    const meta = await ctx.store.db.serial(async () => {
      if (!await isRemoteDispatchAuthorizedInTransaction(ctx, sourceKey, source.botId, targetBot)) throw new HubError("bot_message_not_authorized", 403);
      const row = await ctx.store.db.get<RemoteTicketRow>("SELECT * FROM remote_dispatch_tickets WHERE id=?", [input.remoteTicketId]);
      if (!row || row.source_key !== sourceKey || row.source_bot_id !== source.botId) throw new HubError("ticket_not_found", 404);
      const state = await inspectRemoteTicketState(ctx, row);
      const file = state.artifacts.find(a => a.id === input.attachmentId);
      if (!file) throw new HubError("bot_message_reply_file_forbidden", 403);
      return { botId: row.bot_id, file };
    });
    if (input.offset >= meta.file.size) throw new HubError("invalid_offset", 416);
    const download = await ctx.attachments.download({ botId: meta.botId }, meta.file.id);
    const handle = await open(download.path, "r");
    try {
      const bytes = Buffer.alloc(Math.min(1024 * 1024, meta.file.size - input.offset));
      const read = await handle.read(bytes, 0, bytes.length, input.offset);
      return { bytes: bytes.subarray(0, read.bytesRead).toString("base64"), offset: input.offset, ...meta.file };
    } finally {
      await handle.close();
    }
  }

  throw new HubError("bot_message_operation_forbidden", 403);
}
