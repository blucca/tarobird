import { createHash } from "node:crypto";
import { z } from "zod";
import { blocksText, type Conversation, type Json, type Message } from "../client-protocol/index.js";
import {
  HISTORY_FORK_CALL_MS, HISTORY_FORK_EXCERPT_MAX, HISTORY_REWIND_CALL_MS, HISTORY_UNKNOWN_AFTER_MS,
  historyBotForkCallSchema, historyBotForkReplySchema, historyBotRewindCallSchema, historyBotRewindReplySchema,
  historyBotStatusCallSchema, historyBotStatusSchema, historyForkSchema, historyRewindSchema, historyStatusSchema,
  type ForkOrigin, type HistoryError, type HistoryForkRequest, type HistoryHints, type HistoryOperation, type HistoryRewindRequest, type HistoryStatus,
} from "../client-protocol/history.js";
import { anyRun } from "../client-protocol/run.js";
import type { AuthSession, HubAuth } from "./auth.js";
import { historyReceipt, type HistoryOpRow } from "./history-records.js";
import { isQueueCommand } from "./prompt-queue.js";
import { HubError, newId, type HubStore, type TransactionGuard } from "./store.js";

const STATUS_CALL_MS = 10_000;
const TITLE_MAX = 256, HINT_TEXT_MAX = 200_000, NEXT_INPUT_PAGE = 64;
const FORK_TITLE_SUFFIX = " · 分叉";
/** Hub-private snapshot taken when a fork starts; the origin is written from it. */
const forkStartSchema = z.object({ sourceTitle: z.string().max(TITLE_MAX), title: z.string().min(1).max(TITLE_MAX), excerpt: z.string().max(HISTORY_FORK_EXCERPT_MAX) }).strict();

export type HistoryHooks = {
  /** undefined: no ready Gateway for this Bot; otherwise whether it advertised HISTORY_CAPABILITY. */
  capable(botId: string): boolean | undefined;
  call(botId: string, method: string, params: unknown, timeoutMs: number): Promise<Json>;
  conversationChanged(conversation: Conversation): void;
  conversationCreated(userId: string, conversation: Conversation): void;
  /** An operation stopped holding this Bot's dispatch in its conversation. */
  released(botId: string): void;
  stopping(): boolean;
  track(work: Promise<unknown>): void;
  warn(code: string): void;
};
/** Internal overrides for isolated tests. */
export type HistoryTimings = { rewindMs?: number; forkMs?: number; statusMs?: number; unknownAfterMs?: number };

/** At most `max` UTF-16 units without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const char of text) { if (out.length + char.length > max) break; out += char; }
  return out;
}
export function defaultForkTitle(source: string): string { return `${clip(source, TITLE_MAX - FORK_TITLE_SUFFIX.length)}${FORK_TITLE_SUFFIX}`; }
const userText = (message: Message) => message.blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");

/**
 * Conversation rewind and fork (#53), Hub side. One `conversation_history_ops`
 * row is the idempotency receipt, the per-conversation mutex and the restart
 * record. The engine changes first (in the Gateway); the Hub records the
 * outcome afterwards. Without an answer the row stays `started` (dispatch held)
 * and is re-sent with the same requestId when the Bot reconnects, until
 * `unknownAfterMs` releases it as `unknown`.
 */
export class HubHistory {
  private readonly inflight = new Map<string, Promise<void>>();
  /** Started operations of this process and when they become `unknown`. */
  private readonly deadlines = new Map<string, number>();
  private readonly timings: Required<HistoryTimings>;
  constructor(private readonly store: HubStore, private readonly auth: HubAuth, private readonly hooks: HistoryHooks, timings: HistoryTimings = {}) {
    this.timings = { rewindMs: HISTORY_REWIND_CALL_MS, forkMs: HISTORY_FORK_CALL_MS, statusMs: STATUS_CALL_MS, unknownAfterMs: HISTORY_UNKNOWN_AFTER_MS, ...timings };
  }
  private get db() { return this.store.db; }

  /** Startup: operations left `started` wait for their Bot again. Their
   * deadline restarts from now, the time this Hub could first resend. */
  async recover(): Promise<number> {
    const rows = await this.db.serial(() => this.db.all<{ id: string }>("SELECT id FROM conversation_history_ops WHERE state='started'"));
    const deadline = Date.now() + this.timings.unknownAfterMs;
    for (const row of rows) this.deadlines.set(row.id, deadline);
    return rows.length;
  }
  /** A Gateway became ready: resend each of its started operations once. */
  async resume(botId: string): Promise<void> {
    const rows = await this.db.serial(() => this.db.all<{ id: string }>("SELECT id FROM conversation_history_ops WHERE state='started' AND bot_id=?", [botId]));
    await Promise.all(rows.map(row => this.send(row.id)));
  }
  /** Releases operations that never got an answer. */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, deadline] of [...this.deadlines]) {
      if (now < deadline) continue;
      const row = await this.row(id);
      // finish() drops the deadline; a failed write is retried next sweep.
      if (row?.state === "started") await this.finish(row, "unknown");
      else this.deadlines.delete(id);
    }
  }

  async status(session: AuthSession, conversationId: string, botId: string, validate?: TransactionGuard): Promise<HistoryStatus> {
    const none = { supported: false, rewind: "none", fork: "none" } as const;
    const local = <T>(read: () => Promise<T>) => this.db.serial(async () => {
      await validate?.(); await this.authorizeInTransaction(session, conversationId, botId);
      const reason = await this.scopeInTransaction(conversationId, botId);
      return reason ? { reason } : await read();
    });
    const before = await local(async () => ({}));
    if ("reason" in before) return historyStatusSchema.parse({ ...none, reason: before.reason });
    const capable = this.hooks.capable(botId);
    if (capable === undefined) throw new HubError("bot_offline", 503);
    if (!capable) return historyStatusSchema.parse({ ...none, reason: "unsupported" });
    let bot: z.infer<typeof historyBotStatusSchema>;
    try { bot = historyBotStatusSchema.parse(await this.hooks.call(botId, "history.status", historyBotStatusCallSchema.parse({ conversationId, userId: session.userId }), this.timings.statusMs)); }
    catch (error) {
      if (error instanceof HubError && (error.code === "bot_offline" || error.code === "bot_timeout")) throw error;
      // An advertised Gateway whose answer is unusable is treated as unable.
      bot = { ...none, reason: "unsupported" };
    }
    // Re-authorize and take the Hub's half after the call; it wins.
    const hub = await local(async () => {
      const active = await this.activeInTransaction(conversationId);
      return { active, busy: active ? undefined : await this.store.historyBusyInTransaction(conversationId, botId), canFork: await this.canForkInTransaction(session.userId, botId) };
    });
    if ("reason" in hub) return historyStatusSchema.parse({ ...none, reason: hub.reason });
    const { blocked: botBlocked, ...rest } = bot;
    const blocked = bot.supported ? (hub.active ? "operation_active" : hub.busy ?? botBlocked) : botBlocked;
    return historyStatusSchema.parse({ ...rest, ...(bot.supported && !hub.canFork ? { fork: "none" } : {}), ...(blocked ? { blocked } : {}),
      ...(hub.active ? { operation: historyReceipt(hub.active) } : {}) });
  }
  rewind(session: AuthSession, conversationId: string, raw: unknown, validate?: TransactionGuard): Promise<HistoryOperation> {
    return this.request(session, conversationId, { kind: "rewind", input: historyRewindSchema.parse(raw) }, validate);
  }
  fork(session: AuthSession, conversationId: string, raw: unknown, validate?: TransactionGuard): Promise<HistoryOperation> {
    return this.request(session, conversationId, { kind: "fork", input: historyForkSchema.parse(raw) }, validate);
  }
  /** The receipt of an earlier POST, e.g. after the client lost its answer. */
  operation(session: AuthSession, conversationId: string, requestId: string, validate?: TransactionGuard): Promise<HistoryOperation> {
    return this.db.serial(async () => {
      await validate?.(); await this.auth.validateSessionInTransaction(session); await this.store.requireMember(session.userId, conversationId);
      const row = await this.db.get<HistoryOpRow>("SELECT * FROM conversation_history_ops WHERE user_id=? AND request_id=? AND conversation_id=?", [session.userId, requestId, conversationId]);
      if (!row) throw new HubError("history_operation_not_found", 404);
      return historyReceipt(row);
    });
  }

  private async request(session: AuthSession, conversationId: string, request: { kind: "rewind"; input: HistoryRewindRequest } | { kind: "fork"; input: HistoryForkRequest }, validate?: TransactionGuard): Promise<HistoryOperation> {
    const { row, replayed, restarted } = await this.begin(session, conversationId, request, validate);
    if (row.state === "started") {
      if (!replayed || restarted) this.deadlines.set(row.id, Date.now() + this.timings.unknownAfterMs);
      // Wait for one send. Without an answer the receipt stays `started`; the
      // client polls the operation while this Hub keeps resending.
      await this.send(row.id);
    }
    return historyReceipt(await this.row(row.id) ?? row, replayed);
  }
  /** §4.4 step 1, in one write transaction. Every business refusal is stored
   * as a `failed` receipt, so a retry with the same requestId gets the same answer. */
  private begin(session: AuthSession, conversationId: string, request: { kind: "rewind"; input: HistoryRewindRequest } | { kind: "fork"; input: HistoryForkRequest }, validate?: TransactionGuard): Promise<{ row: HistoryOpRow; replayed: boolean; restarted: boolean }> {
    const { kind, input } = request, userId = session.userId;
    const targetId = request.kind === "rewind" ? request.input.beforeMessageId : request.input.throughMessageId;
    const title = request.kind === "fork" ? request.input.title : undefined;
    const payloadHash = createHash("sha256").update(JSON.stringify([kind, conversationId, input.botId, targetId ?? null, input.expectedLastMessageId, title ?? null])).digest("hex");
    return this.db.transaction(async () => {
      await validate?.(); await this.authorizeInTransaction(session, conversationId, input.botId);
      const prior = await this.db.get<HistoryOpRow>("SELECT * FROM conversation_history_ops WHERE user_id=? AND request_id=?", [userId, input.requestId]);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new HubError("idempotency_conflict", 409);
        // An expired operation is asked again with the same requestId; the
        // Gateway's receipt makes that safe. Only from an idle conversation.
        if (prior.state === "unknown" && this.hooks.capable(prior.bot_id) === true && !await this.scopeInTransaction(conversationId, prior.bot_id)
          && !await this.activeInTransaction(conversationId) && !await this.store.historyBusyInTransaction(conversationId, prior.bot_id)) {
          const now = Date.now();
          // A rewind drops everything after its anchor from the engine. If the
          // first attempt never ran and the user kept chatting, the retry also
          // drops those turns, so the marked range must reach today's last message.
          const through = prior.kind === "rewind"
            ? await this.db.get<{ id: string; created_at: number }>("SELECT id,created_at FROM messages WHERE conversation_id=? AND status!='deleted' ORDER BY created_at DESC,rowid DESC LIMIT 1", [conversationId])
            : undefined;
          const throughId = through?.id ?? prior.through_message_id, throughAt = through?.created_at ?? prior.through_created_at;
          await this.db.run("UPDATE conversation_history_ops SET state='started',error=NULL,through_message_id=?,through_created_at=?,updated_at=? WHERE id=? AND state='unknown'", [throughId, throughAt, now, prior.id]);
          return { row: { ...prior, state: "started", error: null, through_message_id: throughId, through_created_at: throughAt, updated_at: now }, replayed: true, restarted: true };
        }
        return { row: prior, replayed: true, restarted: false };
      }
      if (await this.scopeInTransaction(conversationId, input.botId)) throw new HubError("history_unavailable", 409);
      // Forking creates a conversation: the same rule as creating one.
      if (kind === "fork" && !await this.canForkInTransaction(userId, input.botId)) throw new HubError("bot_forbidden", 403);
      const capable = this.hooks.capable(input.botId);
      if (capable === undefined) throw new HubError("bot_offline", 503);
      const target = targetId ? await this.targetInTransaction(userId, conversationId, input.botId, targetId) : undefined;
      const now = Date.now();
      const insert = async (row: Partial<HistoryOpRow> & Pick<HistoryOpRow, "state">) => {
        const full: HistoryOpRow = { id: newId("hop"), user_id: userId, request_id: input.requestId, payload_hash: payloadHash, conversation_id: conversationId, bot_id: input.botId, kind,
          anchor_message_id: target?.message.id ?? null, anchor_created_at: target?.message.createdAt ?? null, through_message_id: null, through_created_at: null,
          target_conversation_id: null, error: null, result_json: null, created_at: now, updated_at: now, ...row };
        await this.db.run(`INSERT INTO conversation_history_ops(id,user_id,request_id,payload_hash,conversation_id,bot_id,kind,anchor_message_id,anchor_created_at,through_message_id,through_created_at,target_conversation_id,state,error,result_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [full.id, full.user_id, full.request_id, full.payload_hash, full.conversation_id, full.bot_id, full.kind, full.anchor_message_id, full.anchor_created_at,
          full.through_message_id, full.through_created_at, full.target_conversation_id, full.state, full.error, full.result_json, full.created_at, full.updated_at]);
        return { row: full, replayed: false, restarted: false };
      };
      const fail = (error: HistoryError) => insert({ state: "failed", error });
      if (!capable) return fail("unsupported");
      // A second device's operation, a turn, queue, question or approval.
      if (await this.activeInTransaction(conversationId) || await this.store.historyBusyInTransaction(conversationId, input.botId)) return fail("busy");
      const last = await this.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?) ORDER BY rowid DESC LIMIT 1", [conversationId, userId]);
      if (last?.id !== input.expectedLastMessageId) return fail("history_changed");
      if (target?.error) return fail(target.error);
      if (target && await this.db.get("SELECT 1 FROM conversation_history_ops WHERE conversation_id=? AND kind='rewind' AND state='completed' AND anchor_created_at<=? AND through_created_at>=? LIMIT 1", [conversationId, target.message.createdAt, target.message.createdAt])) return fail("already_rewound");
      if (kind === "rewind") {
        // Fixed now: whatever arrives during the operation stays outside the range.
        const through = await this.db.get<{ id: string; created_at: number }>("SELECT id,created_at FROM messages WHERE conversation_id=? AND status!='deleted' ORDER BY created_at DESC,rowid DESC LIMIT 1", [conversationId]);
        return insert({ state: "started", through_message_id: through?.id ?? null, through_created_at: through?.created_at ?? null });
      }
      const source = await this.store.conversationInTransaction(conversationId);
      const start = forkStartSchema.parse({ sourceTitle: clip(source.title, TITLE_MAX), title: title ?? defaultForkTitle(source.title), excerpt: target ? clip(blocksText(target.message.blocks), HISTORY_FORK_EXCERPT_MAX) : "" });
      return insert({ state: "started", target_conversation_id: newId("gw"), result_json: JSON.stringify(start) });
    });
  }

  /** One send of a started operation. Concurrent callers share it; a timeout
   * with the Gateway still connected sends again with the same requestId. */
  private send(id: string): Promise<void> {
    const current = this.inflight.get(id);
    if (current) return current;
    const work: Promise<void> = this.sendOnce(id).catch(() => { this.hooks.warn("history_send_failed"); return false; }).then(again => {
      if (this.inflight.get(id) === work) this.inflight.delete(id);
      if (again && !this.hooks.stopping()) this.hooks.track(this.send(id));
    });
    this.inflight.set(id, work);
    return work;
  }
  private async sendOnce(id: string): Promise<boolean> {
    const row = await this.row(id);
    if (!row || row.state !== "started" || this.hooks.stopping()) return false;
    const capable = this.hooks.capable(row.bot_id);
    if (capable === undefined) return false; // Resent when the Bot reconnects.
    // A downgraded Gateway cannot tell what happened; stop holding dispatch.
    if (!capable) { await this.finish(row, "unknown"); return false; }
    const payload = await this.payload(row);
    let raw: Json;
    try { raw = await this.hooks.call(row.bot_id, `history.${row.kind}`, payload, row.kind === "rewind" ? this.timings.rewindMs : this.timings.forkMs); }
    catch (error) {
      if (this.hooks.stopping()) return false;
      if (error instanceof HubError && error.code === "bot_timeout") return this.hooks.capable(row.bot_id) === true;
      if (error instanceof HubError && error.code === "bot_offline") return false;
      // The Gateway answered with an error instead of an outcome.
      await this.finish(row, "failed", "engine_failed"); return false;
    }
    if (row.kind === "rewind") {
      const reply = historyBotRewindReplySchema.safeParse(raw);
      if (!reply.success) await this.finish(row, "failed", "engine_failed");
      else if (!reply.data.ok) await this.finish(row, "failed", reply.data.error === "operation_interrupted" ? "uncertain" : reply.data.error);
      else await this.completeRewind(row, reply.data.restarted === true);
    } else {
      const reply = historyBotForkReplySchema.safeParse(raw);
      if (!reply.success) await this.finish(row, "failed", "engine_failed");
      else if (!reply.data.ok) await this.finish(row, "failed", reply.data.error === "operation_interrupted" ? "uncertain" : reply.data.error);
      else await this.completeFork(row, reply.data.mode);
    }
    return false;
  }
  private payload(row: HistoryOpRow): Promise<unknown> {
    return this.db.serial(async () => {
      const base = { conversationId: row.conversation_id, userId: row.user_id, requestId: row.request_id };
      const target = row.anchor_message_id ? await this.store.queuedMessageInTransaction(row.anchor_message_id) : undefined;
      // Both operations carry the next run: without it an older run is taken
      // to be the latest, and its matched anchor (persisted by the Gateway,
      // reused by every later operation) would end at the thread's last turn.
      const hints = target ? await this.hints(target, row.bot_id) : undefined;
      if (row.kind === "rewind") return historyBotRewindCallSchema.parse({ ...base, beforeMessageId: row.anchor_message_id, ...(hints ? { hints } : {}) });
      return historyBotForkCallSchema.parse({ ...base, targetConversationId: row.target_conversation_id, ...(target ? { throughMessageId: target.id, hints } : {}) });
    });
  }
  private async hints(target: Message, botId: string): Promise<HistoryHints> {
    const next = await this.nextInput(target, botId);
    return { target: await this.hint(target, botId), ...(next ? { next: await this.hint(next, botId) } : {}) };
  }
  /** Hub facts for matching an older run to engine turns (§4.2). */
  private async hint(message: Message, botId: string): Promise<HistoryHints["target"]> {
    let startedAt: number | undefined;
    const replies = await this.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND reply_to=? AND author_id=? AND author_type='bot' AND status!='deleted' ORDER BY created_at,rowid LIMIT 8", [message.conversationId, message.id, botId]);
    for (const reply of replies) {
      let blocks: unknown; try { blocks = JSON.parse(reply.blocks_json); } catch { continue; }
      for (const block of Array.isArray(blocks) ? blocks : []) {
        const run = block && typeof block === "object" && (block as { type?: unknown }).type === "card" ? anyRun(block as { extra?: Record<string, unknown> }) : undefined;
        if (run) { startedAt = Math.floor(run.startedAt); break; }
      }
      if (startedAt !== undefined) break;
    }
    return { sourceMessageId: message.id, text: clip(userText(message), HINT_TEXT_MAX), createdAt: message.createdAt, ...(startedAt !== undefined && Number.isSafeInteger(startedAt) ? { startedAt } : {}) };
  }
  /** The next input after `message` that started a run of this Bot, by the
   * anchor rule (accepted or failed delivery: an interrupted run may have
   * turns; not steering, not a command). A deleted one still ran, so it counts.
   * Scanned to the end: "none found" must mean `message` is the latest run. */
  private async nextInput(message: Message, botId: string): Promise<Message | undefined> {
    let after = (await this.db.get<{ rowid: number }>("SELECT rowid FROM messages WHERE id=?", [message.id]))?.rowid;
    while (after !== undefined) {
      const rows = await this.db.all<{ id: string; position: number }>(`SELECT m.id,m.rowid AS position FROM messages m JOIN deliveries d ON d.message_id=m.id AND d.bot_id=? AND d.status IN ('accepted','failed')
        WHERE m.conversation_id=? AND m.author_type='user' AND m.rowid>? ORDER BY m.rowid LIMIT ?`, [botId, message.conversationId, after, NEXT_INPUT_PAGE]);
      for (const row of rows) {
        const next = await this.store.queuedMessageInTransaction(row.id);
        if (!isQueueCommand(next) && !next.blocks.some(block => block.type === "steering")) return next;
      }
      after = rows.length === NEXT_INPUT_PAGE ? rows.at(-1)!.position : undefined;
    }
    return undefined;
  }
  private async completeRewind(row: HistoryOpRow, restarted: boolean): Promise<void> {
    const conversation = await this.db.transaction(async () => {
      const changed = await this.db.run("UPDATE conversation_history_ops SET state='completed',error=NULL,result_json=?,updated_at=? WHERE id=? AND state IN ('started','unknown')", [restarted ? JSON.stringify({ restarted: true }) : null, Date.now(), row.id]);
      return changed.changes ? this.store.conversationInTransaction(row.conversation_id) : undefined;
    });
    if (!conversation) return;
    this.ended(row, "completed");
    this.hooks.conversationChanged(conversation);
  }
  private async completeFork(row: HistoryOpRow, mode: ForkOrigin["mode"]): Promise<void> {
    let created: { userId: string; conversation: Conversation } | undefined;
    try {
      created = await this.db.transaction(async () => {
        const current = await this.db.get<HistoryOpRow>("SELECT * FROM conversation_history_ops WHERE id=?", [row.id]);
        if (!current || (current.state !== "started" && current.state !== "unknown") || !current.target_conversation_id) return undefined;
        const start = forkStartSchema.parse(JSON.parse(current.result_json ?? "null"));
        const now = Date.now(), through = mode === "turn" && current.anchor_message_id ? current.anchor_message_id : undefined;
        const fork: ForkOrigin = { opId: current.id, conversationId: current.conversation_id, title: start.sourceTitle, mode, ...(through ? { throughMessageId: through, excerpt: start.excerpt } : { excerpt: "" }), at: now };
        // Same transaction, reserved ID, deterministic creation key: a resent
        // answer or a restart can only find this conversation, never a second one.
        const conversation = await this.store.createConversationInTransaction(current.user_id, [current.bot_id], start.title, `fork_${current.request_id}`, { type: "direct", id: current.target_conversation_id, fork });
        await this.db.run("UPDATE conversation_history_ops SET state='completed',error=NULL,result_json=?,updated_at=? WHERE id=?", [JSON.stringify({ ...start, mode }), now, current.id]);
        return { userId: current.user_id, conversation };
      });
    } catch (error) {
      // The engine forked but the Hub cannot record it (e.g. access changed meanwhile).
      await this.store.audit("history.fork_unrecorded", row.user_id, { opId: row.id, code: error instanceof HubError ? error.code : "internal_error" }).catch(() => undefined);
      await this.finish(row, "failed", "engine_failed"); return;
    }
    if (!created) return;
    this.ended(row, "completed");
    this.hooks.conversationCreated(created.userId, created.conversation);
  }
  private async finish(row: HistoryOpRow, state: "failed" | "unknown", error?: HistoryError): Promise<void> {
    const changed = await this.db.transaction(() => this.db.run(`UPDATE conversation_history_ops SET state=?,error=?,updated_at=? WHERE id=? AND ${state === "unknown" ? "state='started'" : "state IN ('started','unknown')"}`, [state, error ?? null, Date.now(), row.id]));
    if (changed.changes) this.ended(row, state, error);
  }
  private ended(row: HistoryOpRow, state: HistoryOpRow["state"], error?: HistoryError): void {
    this.deadlines.delete(row.id);
    // Identifiers and outcome only; never message content.
    void this.store.audit("history.operation", row.user_id, { opId: row.id, kind: row.kind, conversationId: row.conversation_id, botId: row.bot_id, state, ...(error ? { error } : {}) }).catch(() => undefined);
    this.hooks.released(row.bot_id);
  }
  private row(id: string): Promise<HistoryOpRow | undefined> {
    return this.db.serial(() => this.db.get<HistoryOpRow>("SELECT * FROM conversation_history_ops WHERE id=?", [id]));
  }

  // ---------------------------------------------------------------- checks (caller holds db.serial/transaction)
  private async authorizeInTransaction(session: AuthSession, conversationId: string, botId: string): Promise<void> {
    await this.auth.validateSessionInTransaction(session);
    await this.store.requireMember(session.userId, conversationId);
    await this.store.requireBot(botId, conversationId);
  }
  /** Same scope as side questions (direct, not a topic, unarchived, exactly
   * one Bot), minus dispatcher tickets, dispatcher Bots and Agent Bus chats. */
  private async scopeInTransaction(conversationId: string, botId: string): Promise<"conversation_kind" | "archived" | "dispatcher" | undefined> {
    const row = await this.db.get<{ type: string; archived: number; parent_id: string | null; hidden: number; ticket_json: string | null; client_action_id: string | null; bots: number; role: string | null }>(`SELECT c.type,c.archived,c.parent_id,c.hidden,c.ticket_json,c.client_action_id,
      (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id=c.id AND m.member_type='bot') AS bots,(SELECT role FROM bots WHERE id=?) AS role FROM conversations c WHERE c.id=?`, [botId, conversationId]);
    if (!row) throw new HubError("conversation_not_found", 404);
    if (row.hidden || row.ticket_json || row.role === "dispatcher" || row.role === "worker") return "dispatcher";
    if (row.type !== "direct" || row.parent_id || row.bots !== 1 || row.client_action_id?.startsWith("agentbus_")) return "conversation_kind";
    if (row.archived) return "archived";
    return undefined;
  }
  private async canForkInTransaction(userId: string, botId: string): Promise<boolean> {
    return !!await this.db.get("SELECT 1 FROM users WHERE id=? AND role='owner' UNION ALL SELECT 1 FROM bot_grants WHERE user_id=? AND bot_id=? LIMIT 1", [userId, userId, botId]);
  }
  private activeInTransaction(conversationId: string): Promise<HistoryOpRow | undefined> {
    return this.db.get<HistoryOpRow>("SELECT * FROM conversation_history_ops WHERE conversation_id=? AND state='started'", [conversationId]);
  }
  /** A visible input of this conversation that started a run of this Bot:
   * not a steering control, not a slash command, not a cancelled queue entry. */
  private async targetInTransaction(userId: string, conversationId: string, botId: string, messageId: string): Promise<{ message: Message; error?: HistoryError }> {
    const row = await this.db.get<{ id: string; author_type: string; delivery: string | null }>(`SELECT m.id,m.author_type,(SELECT d.status FROM deliveries d WHERE d.message_id=m.id AND d.bot_id=?) AS delivery FROM messages m
      WHERE m.id=? AND m.conversation_id=? AND m.status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions x WHERE x.message_id=m.id AND x.user_id=?)`, [botId, messageId, conversationId, userId]);
    if (!row) throw new HubError("message_not_found", 404);
    const message = await this.store.queuedMessageInTransaction(row.id);
    const anchor = row.author_type === "user" && (row.delivery === "accepted" || row.delivery === "failed")
      && !message.blocks.some(block => block.type === "steering") && !isQueueCommand(message);
    return { message, ...(anchor ? {} : { error: "not_an_anchor" as const }) };
  }
}
