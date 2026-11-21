import { createHash, randomUUID, verify } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";
import { CHUNK_BYTES, idSchema, textSchema, uploadSchema, blocksText, type Block, type Conversation } from "../client-protocol/index.js";
import { BOT_PASSPORT_TTL_MS, BOT_PASSPORT_CLOCK_SKEW_MS, TargetResolutionError, botLocalRequestSchema, botMessageTargetSchema, botPassportProof, botSourceSchema, isBotControl, resolveBotTarget, signedBotPassportSchema, type BotPassport, type BotSource, type BotMessageTarget, type SignedBotPassport } from "../client-protocol/bot-messages.js";
import { networkCanonical, type NetworkHost } from "../client-protocol/private-network.js";
import { isRunActive, runSummarySchema } from "../client-protocol/run.js";
import { hashSecret, parsePublicKey, type HubAuth } from "./auth.js";
import { HubError, type HubStore } from "./store.js";
import type { HubAttachments } from "./attachments.js";
import type { PrivateNetwork } from "./private-network.js";
import { exchangeBotMessage } from "./bot-message-transport.js";
import { botMessageGrantsCommandSchema, crossHostMessageGrantsCommandSchema, messageHostIdSchema, type BotMessageGrantsSnapshot, type CrossHostMessageGrantsSnapshot } from "../client-protocol/bot-message-grants.js";
import { botMessageCapabilitiesSchema, botMessageSendSchema, botMessageSteeringCommandSchema, botSteerRejectionReason, supportsBotMessageSteerEngine,
  type BotMessageDelivery, type BotMessageDeliveryReceipt, type BotMessageSteeringSnapshot, type BotSteerFallbackReason } from "../client-protocol/bot-message-delivery.js";
import { botSteerCallSchema, botSteerStatusSchema, steerResultSchema, type SteerResult } from "../client-protocol/steering.js";
import { hasPendingCardAction } from "../client-protocol/message-clear.js";
import type { Message } from "../client-protocol/index.js";
import { STEER_EDGE_LIMIT, STEER_EDGE_WINDOW_MS, STEER_TURN_LIMIT, offlineSteering, steerFallbackNotice, steeringDisabledKey, type BotMessageSteeringHooks, type IncomingMemo } from "./bot-message-steering.js";

export const messageHostId = (key: string) => `hub_${createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")}`;
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const activeRunPhases = runSummarySchema.shape.phase.options.filter(isRunActive);
const activeRunPhaseParams = activeRunPhases.map(() => "?").join(",");
const memoKey = (kind: string, ...parts: string[]) => `bot-messages:${kind}:${hashSecret(JSON.stringify(parts))}`;
/** Steer records with no final outcome yet (pending call or unconfirmed),
 * per recipient Bot; reconciled when its worker attaches. Bot IDs are idSchema. */
const OPEN_STEER = "bot-messages:steer-open:";
const openSteerKey = (botId: string, messageId: string) => `${OPEN_STEER}${botId}:${messageId}`;
type OpenSteer = { key: string; conversationId: string };
type Guard = () => Promise<unknown>;
type Grant = { sourceKey: string; sourceBot: string; targetBot: string; revoked: boolean };
const grantSchema = z.object({ sourceHost: z.string().min(1).max(256), sourceBot: idSchema, targetBot: z.string().min(1).max(256), revoke: z.boolean().default(false) }).strict();
const LOCAL_GRANTS_EPOCH = "bot-messages:local-grants-revision", CROSS_HOST_GRANTS_EPOCH = "bot-messages:cross-host-grants-revision";
// Only the host list of the stored signed membership is read here; message
// eligibility itself is always PrivateNetwork.requireMessagePeerInTransaction.
const storedMembershipHostsSchema = z.object({ membership: z.object({ manifest: z.object({ id: z.string(),
  hosts: z.array(z.object({ publicKey: z.string(), name: z.string(), state: z.string(), revoked: z.boolean() }).passthrough()) }).passthrough() }).passthrough().optional() }).passthrough();
type CrossHostState = { snapshot: CrossHostMessageGrantsSnapshot; keys: Map<string, string>; live: Set<string>; listed: Set<string> };
const resolutionCode = (error: TargetResolutionError): unknown => { try { return (JSON.parse(error.message) as { code?: unknown }).code; } catch { return undefined; } };
/** A steer condition (limit, owner switch, engine, chat shape) that no longer holds inside the creating transaction: that write rolls back and the message is queued instead. */
class SteerLimitReached extends Error { constructor(readonly reason: BotSteerFallbackReason) { super(reason); } }
type ReplyState = { status: string; activeReplies?: number; text: string; files: { id: string; name: string; size: number; mime: string; sha256: string }[]; truncated: boolean };
type WaitResult = BotMessageTarget & { messageId: string } & ReplyState & { delivery?: BotMessageDeliveryReceipt; reply?: { kind: "merged_turn"; turnMessageId: string } };
/** Everything receive() resolved for one send; the delivery paths share it. */
type DeliveryContext = { p: BotPassport; bot: { id: string; name: string }; target: BotMessageTarget; input: { text: string; attachments: string[] }; delivery: BotMessageDelivery;
  key: string; content: string; clientMsgId: string; scope: (admitting?: boolean) => Promise<void>; attachmentGuard: (id: string) => Promise<void>; guard: Guard; validate: Guard };

/** A narrow peer protocol, independent of Agent Bus. All authority is checked
 * by the receiving Hub; the CLI never receives either Hub's signing key. */
export class BotMessages {
  constructor(readonly store: HubStore, readonly auth: HubAuth, readonly network: PrivateNetwork, readonly attachments: HubAttachments,
    readonly exchange: typeof exchangeBotMessage = exchangeBotMessage,
    readonly workerCapable: (botId: string) => boolean | undefined = () => undefined,
    // Live App sockets learn about conversations only when told, as for every
    // other creation path; otherwise a delegated chat stays hidden until reconnect.
    readonly conversationCreated: (userId: string, conversation: Conversation) => void = () => undefined,
    /** Hub → Gateway calls for steered delivery (issue #62); HubServer owns them. */
    public steering: BotMessageSteeringHooks = offlineSteering) {}
  /** Steer records whose Gateway call this process is still awaiting: they are
   * reconciled only after that call has returned or been lost. */
  private readonly steersInFlight = new Set<string>();
  private async memo<T>(key: string): Promise<T | undefined> {
    const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [key]);
    return row ? JSON.parse(row.value) as T : undefined;
  }
  private put(key: string, value: unknown) { return this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, JSON.stringify(value)]); }
  private async hosts(guard?: Guard) {
    const view = await this.network.view(guard);
    const hosts = [view.host, ...(view.membership?.manifest.hosts ?? []).filter(h => h.publicKey !== view.host.publicKey && h.state === "active" && !h.revoked)];
    return hosts.map(h => ({ ...h, id: messageHostId(h.publicKey) }));
  }
  /** This Host as a Bot-message source (dispatcher ticket inputs and notices). */
  async ownSource(): Promise<{ hostId: string; hostName: string }> {
    const host = (await this.hosts()).find(h => h.publicKey === this.auth.publicKey)!;
    return { hostId: host.id, hostName: host.name };
  }
  async grant(raw: unknown, guard: Guard, admit?: Guard, actor = "owner") {
    const input = grantSchema.parse(raw);
    // Allow, and revocation of a current edge, keep the active-peer/live-Bot
    // rules. Like the App's Cross-host scope, a revocation the current rules
    // reject may still remove an existing stored edge (a removed or departed
    // source Host, or a deleted recipient). Beyond the existing resolution
    // (Hosts listed in current membership, live Bots), only an exact `hub_` Host
    // ID or deleted Bot ID resolves such an edge. Without a current stored edge
    // the original rejection stands, so no grant or tombstone is created.
    let residual: unknown;
    const resolve = async <T>(current: () => Promise<T>, exact: () => Promise<T | undefined>): Promise<T> => {
      try { return await current(); }
      catch (error) {
        if (!input.revoke || !(error instanceof TargetResolutionError) || resolutionCode(error) !== "target_not_found") throw error;
        const found = await exact();
        if (!found) throw error;
        residual ??= error; return found;
      }
    };
    const host = await resolve<{ id: string; publicKey: string }>(async () => resolveBotTarget(input.sourceHost, await this.hosts(guard), "host"),
      () => this.store.db.serial(async () => { await guard(); return this.storedSourceHost(input.sourceHost); }));
    const bot = await resolve<{ id: string }>(async () => resolveBotTarget(input.targetBot, await this.store.bots("owner"), "bot"),
      () => this.store.db.serial(async () => {
        await guard();
        return idSchema.safeParse(input.targetBot).success && await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NOT NULL", [input.targetBot]) ? { id: input.targetBot } : undefined;
      }));
    const key = memoKey("grant", host.publicKey, input.sourceBot, bot.id);
    const stored = async () => {
      const grant = await this.memo<Grant>(key);
      return !!grant && !grant.revoked && grant.sourceKey === host.publicKey && grant.sourceBot === input.sourceBot && grant.targetBot === bot.id;
    };
    // Reject before spending the owner's one-use proof; repeated in the write.
    if (residual && !await this.store.db.serial(stored)) throw residual;
    await this.store.db.transaction(async () => {
      await guard(); await admit?.();
      try { await this.network.requireMessagePeerInTransaction(host.publicKey); }
      catch (error) { if (!input.revoke || !(error instanceof HubError)) throw error; residual ??= error; }
      if (!await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [bot.id])) {
        if (!input.revoke) throw new HubError("bot_deleted", 410);
        residual ??= new HubError("bot_deleted", 410);
      }
      if (residual && !await stored()) throw residual;
      await this.put(key, { sourceKey: host.publicKey, sourceBot: input.sourceBot, targetBot: bot.id, revoked: input.revoke } satisfies Grant);
      // Either tab's revision covers CLI writes, including allow/revoke ABA.
      await this.put(host.publicKey === this.auth.publicKey ? LOCAL_GRANTS_EPOCH : CROSS_HOST_GRANTS_EPOCH, randomUUID());
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, input.revoke ? "bot-message.grant-revoked" : "bot-message.granted", JSON.stringify({ hostId: host.id, sourceBot: input.sourceBot, targetBot: bot.id, ...(residual ? { residual: true } : {}) })]);
    });
    return { hostId: host.id, sourceBotId: input.sourceBot, botId: bot.id, revoked: input.revoke };
  }
  /** Caller holds the DB queue. The source key of a stored edge, by exact `hub_` ID only. */
  private async storedSourceHost(id: string): Promise<{ id: string; publicKey: string } | undefined> {
    if (!messageHostIdSchema.safeParse(id).success) return undefined;
    for (const row of await this.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key")) {
      const grant = JSON.parse(row.value) as Grant;
      if (row.key === memoKey("grant", grant.sourceKey, grant.sourceBot, grant.targetBot) && messageHostId(grant.sourceKey) === id) return { id, publicKey: grant.sourceKey };
    }
    return undefined;
  }
  private async grantsInTransaction(): Promise<BotMessageGrantsSnapshot> {
    // Internal dispatch workers are not user-selectable grant endpoints. Keep
    // their stored grants and task history intact; filter only this snapshot.
    const bots = await this.store.db.all<{ id: string; name: string; online: number }>("SELECT id,name,online FROM bots WHERE deleted_at IS NULL AND role!='worker' ORDER BY id");
    const ids = new Set(bots.map(bot => bot.id));
    const rows = await this.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key");
    const local: Grant[] = [];
    for (const row of rows) {
      const grant = JSON.parse(row.value) as Grant;
      if (grant.sourceKey === this.auth.publicKey && ids.has(grant.sourceBot) && ids.has(grant.targetBot)
        && row.key === memoKey("grant", grant.sourceKey, grant.sourceBot, grant.targetBot)) local.push(grant);
    }
    const epoch = await this.memo<string>(LOCAL_GRANTS_EPOCH) ?? "legacy";
    return { revision: hashSecret(networkCanonical({ epoch, ids: [...ids], local, selfTargetSupported: true })), selfTargetSupported: true,
      bots: bots.map(bot => ({ ...bot, online: !!bot.online })),
      grants: local.filter(grant => !grant.revoked).map(({ sourceBot, targetBot }) => ({ sourceBot, targetBot })) };
  }
  async readGrants(userId: string, guard: Guard): Promise<BotMessageGrantsSnapshot> {
    return this.store.db.serial(async () => { await guard(); await this.store.requireOwner(userId); return this.grantsInTransaction(); });
  }
  async updateGrants(userId: string, actor: string, raw: unknown, guard: Guard, admit: Guard): Promise<BotMessageGrantsSnapshot> {
    const command = botMessageGrantsCommandSchema.parse(raw);
    return this.store.db.transaction(async () => {
      await guard(); await this.store.requireOwner(userId); await admit();
      const before = await this.grantsInTransaction();
      if (command.revision !== before.revision) throw new HubError("bot_message_grants_changed", 409);
      const ids = new Set(before.bots.map(bot => bot.id));
      if (!ids.has(command.sourceBot) || command.changes.some(change => !ids.has(change.targetBot))) throw new HubError("bot_deleted", 410);
      for (const change of command.changes) {
        await this.put(memoKey("grant", this.auth.publicKey, command.sourceBot, change.targetBot),
          { sourceKey: this.auth.publicKey, sourceBot: command.sourceBot, targetBot: change.targetBot, revoked: !change.allowed } satisfies Grant);
      }
      await this.put(LOCAL_GRANTS_EPOCH, randomUUID());
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, "bot-message.grants-updated", JSON.stringify({ sourceBot: command.sourceBot, changes: command.changes.map(change => ({ ...change,
        previous: before.grants.some(grant => grant.sourceBot === command.sourceBot && grant.targetBot === change.targetBot) })) })]);
      return this.grantsInTransaction();
    });
  }
  /** Caller holds the DB queue. The receiving Host's view of one-way edges from
   * other Hosts to its own Bots. `hostName` is display-only. Workers stay hidden
   * as in the local tab; their stored grants and history remain untouched. */
  private async crossHostInTransaction(hostName: string): Promise<CrossHostState> {
    const own = this.auth.publicKey, ownId = messageHostId(own);
    const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
    const manifest = row ? storedMembershipHostsSchema.parse(JSON.parse(row.value)).membership?.manifest : undefined;
    const names = new Map<string, string>(), keys = new Map<string, string>(), available = new Set<string>();
    for (const host of manifest?.hosts ?? []) {
      if (host.publicKey === own) continue;
      const id = messageHostId(host.publicKey);
      names.set(id, host.name); keys.set(id, host.publicKey);
      // Each check reloads network state; only active entries (at most 32) can pass.
      if (host.state !== "active" || host.revoked) continue;
      try { await this.network.requireMessagePeerInTransaction(host.publicKey); available.add(id); }
      catch (error) { if (!(error instanceof HubError)) throw error; }
    }
    const bots = await this.store.db.all<{ id: string; name: string; online: number; deleted_at: number | null }>("SELECT id,name,online,deleted_at FROM bots WHERE role!='worker' ORDER BY id");
    const byId = new Map(bots.map(bot => [bot.id, bot]));
    const grants: CrossHostMessageGrantsSnapshot["grants"] = [];
    for (const row of await this.store.db.all<{ key: string; value: string }>("SELECT key,value FROM meta WHERE key LIKE 'bot-messages:grant:%' ORDER BY key")) {
      const grant = JSON.parse(row.value) as Grant;
      if (grant.revoked || grant.sourceKey === own || !byId.has(grant.targetBot) || !idSchema.safeParse(grant.sourceBot).success
        || row.key !== memoKey("grant", grant.sourceKey, grant.sourceBot, grant.targetBot)) continue;
      const id = messageHostId(grant.sourceKey);
      keys.set(id, grant.sourceKey);
      grants.push({ sourceHost: id, sourceBot: grant.sourceBot, targetBot: grant.targetBot });
    }
    const order = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
    grants.sort((x, y) => order(x.sourceHost, y.sourceHost) || order(x.sourceBot, y.sourceBot) || order(x.targetBot, y.targetBot));
    const targets = new Set(grants.map(grant => grant.targetBot)), live = new Set(bots.filter(bot => bot.deleted_at === null).map(bot => bot.id));
    const listed = bots.filter(bot => bot.deleted_at === null || targets.has(bot.id));
    const residual = new Set(grants.map(grant => grant.sourceHost));
    const hosts = [...new Set([...available, ...residual])].sort(order).map(id => ({ id, name: names.get(id) ?? id, available: available.has(id) }));
    // Names and online state are excluded so they never invalidate a draft.
    const epoch = await this.memo<string>(CROSS_HOST_GRANTS_EPOCH) ?? "legacy";
    const revision = hashSecret(networkCanonical({ kind: "cross-host", epoch, network: manifest?.id ?? null, available: [...available].sort(order), live: [...live], grants }));
    return { keys, live, listed: new Set(listed.map(bot => bot.id)), snapshot: { revision, host: { id: ownId, name: hostName }, hosts, grants,
      bots: listed.map(bot => bot.deleted_at === null ? { id: bot.id, name: bot.name, online: !!bot.online } : { id: bot.id, name: bot.name, online: false, deleted: true as const }) } };
  }
  async readCrossHostGrants(userId: string, guard: Guard): Promise<CrossHostMessageGrantsSnapshot> {
    const check = async () => { await guard(); await this.store.requireOwner(userId); };
    const { host } = await this.network.view(check);
    return this.store.db.serial(async () => { await check(); return (await this.crossHostInTransaction(host.name)).snapshot; });
  }
  /** Owner + one-use device proof (`admit`); every check repeats in the write
   * transaction. A batch is all-or-nothing: an allow for a source that is not
   * a current message peer rejects its revocations too. Revocation needs an
   * existing visible edge, which keeps removed/offline sources revocable. */
  async updateCrossHostGrants(userId: string, actor: string, raw: unknown, guard: Guard, admit: Guard): Promise<CrossHostMessageGrantsSnapshot> {
    const command = crossHostMessageGrantsCommandSchema.parse(raw);
    const check = async () => { await guard(); await this.store.requireOwner(userId); };
    const { host } = await this.network.view(check);
    return this.store.db.transaction(async () => {
      await check(); await admit();
      const before = await this.crossHostInTransaction(host.name);
      if (command.revision !== before.snapshot.revision) throw new HubError("bot_message_grants_changed", 409);
      // This Host's own Bots use the local tab, which also excludes worker sources.
      if (command.sourceHost === before.snapshot.host.id) throw new HubError("bot_message_grant_local_source", 400);
      const sourceKey = before.keys.get(command.sourceHost);
      if (!sourceKey) throw new HubError("bot_message_host_not_found", 404);
      const existing = new Set(before.snapshot.grants.filter(grant => grant.sourceHost === command.sourceHost && grant.sourceBot === command.sourceBot).map(grant => grant.targetBot));
      if (command.changes.some(change => change.allowed)) await this.network.requireMessagePeerInTransaction(sourceKey);
      for (const change of command.changes) {
        if (change.allowed ? !before.live.has(change.targetBot) : !before.listed.has(change.targetBot)) throw new HubError("bot_deleted", 410);
        if (!change.allowed && !existing.has(change.targetBot)) throw new HubError("bot_message_grant_not_found", 409);
      }
      for (const change of command.changes) await this.put(memoKey("grant", sourceKey, command.sourceBot, change.targetBot),
        { sourceKey, sourceBot: command.sourceBot, targetBot: change.targetBot, revoked: !change.allowed } satisfies Grant);
      await this.put(CROSS_HOST_GRANTS_EPOCH, randomUUID());
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, "bot-message.cross-host-grants-updated", JSON.stringify({ sourceHost: command.sourceHost, sourceBot: command.sourceBot,
        changes: command.changes.map(change => ({ ...change, previous: existing.has(change.targetBot) })) })]);
      return (await this.crossHostInTransaction(host.name)).snapshot;
    });
  }
  private async allowed(p: BotPassport, botId: string): Promise<void> {
    if (p.expiresAt <= Date.now() - BOT_PASSPORT_CLOCK_SKEW_MS || p.expiresAt > Date.now() + BOT_PASSPORT_TTL_MS + BOT_PASSPORT_CLOCK_SKEW_MS) throw new HubError("bot_message_passport_expired", 401);
    await this.network.requireMessagePeerInTransaction(p.sourceKey);
    const grant = await this.memo<Grant>(memoKey("grant", p.sourceKey, p.source.botId, botId));
    if (!grant || grant.revoked) throw new HubError(grant ? "bot_message_grant_revoked" : "bot_message_not_authorized", 403);
    if (!await this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NULL", [botId])) throw new HubError("bot_deleted", 410);
  }
  /** Only local instance auth or the enrolled owner controller may invoke this. */
  async local(raw: unknown, sourceBot: string, guard: Guard, operator = false): Promise<unknown> {
    let requestId = "invalid";
    try {
      const input = botLocalRequestSchema.parse(raw); requestId = input.requestId;
      const contextBound = input.contextMessage && ["resolve", "send", "upload", "chunk", "complete"].includes(input.operation);
      const context = async () => {
        const row = await this.store.db.get<{ bot_source_json: string | null }>("SELECT m.bot_source_json FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=? AND d.bot_id=? AND d.status='pending' AND d.dispatched=1", [input.contextMessage!, sourceBot]);
        if (!row) throw new HubError("bot_message_context_not_active", 403);
        if (await this.store.db.get("SELECT 1 FROM group_discussion_turns WHERE input_message_id=?", [input.contextMessage!])) throw new HubError("group_discussion_bot_messages_blocked", 403);
        return row;
      };
      // Recheck at admission, after awaited preparation. A valid turn at API
      // entry is not authority to start a new send after that turn has ended.
      const admit = async () => { await guard(); if (contextBound) await context(); };
      const hosts = await this.hosts(guard), own = hosts.find(h => h.publicKey === this.auth.publicKey)!;
      const host = resolveBotTarget(input.host, hosts, "host");
      const source = await this.store.db.serial(async () => {
        await guard(); await this.network.requireMessagePeerInTransaction(host.publicKey);
        const bot = await this.store.db.get<{ name: string }>("SELECT name FROM bots WHERE id=? AND deleted_at IS NULL", [sourceBot]);
        if (!bot || input.sourceBot && input.sourceBot !== sourceBot) throw new HubError("bot_message_source_invalid", 403);
        let hops = 1;
        if (contextBound) {
          const row = await context();
          // A group discussion turn speaks only in its own group. It never
          // delegates or messages other Bots (which could also leak a sealed
          // independent answer), whatever the Hub-side grants allow.
          hops = row.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)).hops + 1 : 1;
        } else if (!operator && (["send", "upload", "chunk", "complete"].includes(input.operation) || input.operation === "resolve" && !input.conversation)) throw new HubError("bot_message_context_required", 403);
        if (hops > 3 && (input.operation !== "resolve" || !input.conversation)) throw new HubError("bot_message_hop_limit", 429);
        return { hostId: own.id, hostName: own.name, botId: sourceBot, botName: bot.name, requestId: input.requestId, hops: Math.min(hops, 3) };
      });
      let data = input.data, downgraded = false, queueRequested = false;
      // Queue is the default: never put it on the wire (an older receiving Host refuses the field).
      if (input.operation === "send" && data.delivery === "queue") { const { delivery: _delivery, ...plain } = data; data = plain; queueRequested = true; }
      // An older receiving Host refuses `delivery` (strict body). Ask it first;
      // a Host that does not know the probe route queues the plain message.
      if (input.operation === "send" && data.delivery === "steer" && host.publicKey !== this.auth.publicKey && !await this.peerSteers(host as NetworkHost, source, input.bot, admit)) {
        const { delivery: _delivery, ...plain } = data; data = plain; downgraded = true;
      }
      const routes = {
        list: "/api/bot-messages/conversations", resolve: "/api/bot-messages/resolve", send: "/api/bot-messages/send", wait: "/api/bot-messages/wait",
        upload: "/api/uploads", chunk: `/api/uploads/${idSchema.optional().parse(data.uploadId) ?? "invalid"}/${z.number().int().nonnegative().optional().parse(data.index) ?? 0}`,
        complete: `/api/uploads/${idSchema.optional().parse(data.uploadId) ?? "invalid"}/complete`, download: "/api/bot-messages/download",
      };
      const body = input.operation === "chunk" ? Buffer.from(z.string().max(CHUNK_BYTES * 2).parse(data.bytes), "base64") : Buffer.from(JSON.stringify(data));
      if (body.length > CHUNK_BYTES) throw new HubError("bot_message_body_too_large", 413);
      const passport: BotPassport = { v: 1, sourceKey: this.auth.publicKey, targetKey: host.publicKey, source, targetBot: input.bot, ...(input.conversation ? { conversation: input.conversation } : {}),
        method: input.operation === "chunk" ? "PUT" : "POST", path: routes[input.operation], digest: digest(body), expiresAt: Date.now() + BOT_PASSPORT_TTL_MS, nonce: randomUUID() };
      // A lost reply is uncertain. Only an explicit caller rerun can transmit
      // again; the same request number cannot change target or content.
      if (input.operation === "send") await this.store.db.transaction(async () => {
        await admit(); await this.network.requireMessagePeerInTransaction(host.publicKey);
        const key = memoKey("outgoing", sourceBot, input.requestId);
        // Delivery is a preference, not content: a retry may name another one.
        const { delivery: _delivery, ...sent } = data;
        const content = hashSecret(networkCanonical({ target: host.publicKey, bot: input.bot, conversation: input.conversation, data: sent }));
        const old = await this.memo<{ content: string }>(key);
        if (old && old.content !== content) throw new HubError("bot_message_request_conflict", 409);
        await this.put(key, { content, state: "unconfirmed", at: Date.now() });
      });
      const signed = { passport, signature: this.auth.signBotPassport(passport) };
      await this.store.db.serial(admit);
      // Local delivery can recheck the source in the same target transaction.
      // Remote delivery checks before exchange; a sent request is uncertain,
      // not automatically cancelled or retransmitted when its source ends.
      let result = host.publicKey === this.auth.publicKey ? await this.receive(signed, passport.method, passport.path, body, admit) : await this.exchange(host as NetworkHost, signed, body);
      if (input.operation === "resolve") {
        const parsed = botMessageTargetSchema.safeParse(result);
        if (!parsed.success) throw new HubError("bot_message_reply_invalid", 502);
        if (parsed.data.hostId !== messageHostId(host.publicKey)) throw new HubError("bot_message_reply_target_mismatch", 502);
        result = parsed.data;
      }
      await this.store.db.serial(async () => { await guard(); await this.network.requireMessagePeerInTransaction(host.publicKey); });
      if (input.operation === "send" || input.operation === "wait") await this.store.audit(`bot-message.outgoing-${input.operation}`, sourceBot, { requestId: input.requestId, hostId: host.id, ...(downgraded ? { delivery: "receiver_update_required" } : {}) });
      if (downgraded && result && typeof result === "object") result = { ...result, delivery: { requested: "steer", actual: "fell_back_to_queue", reason: "receiver_update_required" } satisfies BotMessageDeliveryReceipt };
      if (queueRequested && result && typeof result === "object" && !("delivery" in result)) result = { ...result, delivery: { requested: "queue", actual: "queued" } satisfies BotMessageDeliveryReceipt };
      return result;
    } catch (error) {
      await this.store.audit("bot-message.rejected", sourceBot, { stage: "source", requestId, reason: error instanceof HubError ? error.code : "invalid_request" }); throw error instanceof TargetResolutionError ? new HubError(error.message, 409) : error;
    }
  }
  /** Authenticate the bounded header before accepting an upload/request body.
   * receive() repeats the grant/expiry checks after reading, closing revocation
   * races while leaving request idempotency and digest verification intact. */
  async authorizePassport(raw: unknown, method: string, path: string): Promise<{ signed: SignedBotPassport; bot: { id: string; name: string } }> {
      let signed: SignedBotPassport;
      try {
        signed = signedBotPassportSchema.parse(raw);
        const p = signed.passport;
        if (p.targetKey !== this.auth.publicKey || p.method !== method || p.path !== path
          || p.source.hostId !== messageHostId(p.sourceKey) || !verify(null, Buffer.from(botPassportProof(p)), parsePublicKey(p.sourceKey), Buffer.from(signed.signature, "base64"))) throw new Error("signature");
      } catch { throw new HubError("bot_message_signature_invalid", 403); }
      const passport = signed.passport;
      const allowedRoute = method === "POST" && (/^\/api\/bot-messages\/(conversations|resolve|send|wait|download|capabilities)$/.test(path) || path === "/api/uploads" || /^\/api\/uploads\/[\w-]+\/complete$/.test(path))
        || method === "PUT" && /^\/api\/uploads\/[\w-]+\/\d+$/.test(path);
      if (!allowedRoute) throw new HubError("bot_message_operation_forbidden", 403);
      const bots = await this.store.db.serial(async () => {
        await this.network.requireMessagePeerInTransaction(passport.sourceKey);
        const rows = await this.store.db.all<{ id: string; name: string }>("SELECT id,name FROM bots WHERE deleted_at IS NULL ORDER BY name,id");
        const allowed = [];
        for (const bot of rows) { const grant = await this.memo<Grant>(memoKey("grant", passport.sourceKey, passport.source.botId, bot.id)); if (grant && !grant.revoked) allowed.push(bot); }
        return allowed;
      });
      // Do not disclose a private Bot directory to an unauthorized source.
      if (!bots.length) throw new HubError("bot_message_not_authorized_or_revoked", 403);
      const bot = resolveBotTarget(passport.targetBot, bots, "bot");
      await this.store.db.serial(() => this.allowed(passport, bot.id));
      return { signed, bot };
  }
  async receive(raw: unknown, method: string, path: string, body: Buffer, localAdmission?: Guard): Promise<unknown> {
    let p: BotPassport | undefined;
    try {
      const { signed, bot } = await this.authorizePassport(raw, method, path);
      p = signed.passport;
      if (p.digest !== digest(body)) throw new HubError("bot_message_signature_invalid", 403);
      const passport = p;
      const guard = () => this.allowed(passport, bot.id), validate = () => this.store.db.serial(guard);
      await validate();
      const data = method === "PUT" ? {} : z.record(z.string(), z.unknown()).parse(JSON.parse(body.toString("utf8")));
      const conversations = () => this.store.db.serial(async () => {
        await guard(); return this.store.db.all<{ id: string; name: string; lastActivityAt: number }>(`SELECT c.id,c.title AS name,COALESCE(MAX(m.created_at),c.created_at) AS lastActivityAt FROM conversations c
          JOIN conversation_members b ON b.conversation_id=c.id AND b.member_type='bot' AND b.member_id=?
          JOIN conversation_members u ON u.conversation_id=c.id AND u.member_type='user' AND u.member_id='owner'
          LEFT JOIN messages m ON m.conversation_id=c.id WHERE c.archived=0 GROUP BY c.id ORDER BY lastActivityAt DESC,c.id`, [bot.id]);
      });
      // Archiving removes a chat from the list and name resolution. Its exact ID
      // still reaches results of requests accepted there; the store refuses new input.
      const exactConversation = (id: string) => this.store.db.serial(async () => {
        await guard(); return this.store.db.get<{ id: string; name: string; archived: number }>(`SELECT c.id,c.title AS name,c.archived FROM conversations c
          JOIN conversation_members b ON b.conversation_id=c.id AND b.member_type='bot' AND b.member_id=?
          JOIN conversation_members u ON u.conversation_id=c.id AND u.member_type='user' AND u.member_id='owner' WHERE c.id=?`, [bot.id, id]);
      });
      const profile = await this.network.view(guard);
      const base = { hostId: messageHostId(this.auth.publicKey), hostName: profile.host.name, botId: bot.id, botName: bot.name };
      if (path === "/api/bot-messages/conversations" && method === "POST") { const result = { ...base, conversations: await conversations() }; await validate(); return result; }
      if (path === "/api/bot-messages/capabilities" && method === "POST") { const result = botMessageCapabilitiesSchema.parse({ hostId: base.hostId, deliveries: ["queue", "steer"] }); await validate(); return result; }
      let conversation;
      if (p.conversation) {
        const requested = p.conversation;
        // IDs precede names, even when an active chat is named after an archived
        // ID. Exact-ID polling also avoids enumerating/aggregating every chat.
        const row = await exactConversation(requested);
        if (row?.archived && path.startsWith("/api/uploads")) throw new HubError("conversation_archived", 409);
        conversation = row ?? resolveBotTarget(requested, await conversations(), "conversation");
      } else if (path === "/api/bot-messages/resolve" && method === "POST") {
        const name = z.string().min(1).max(256).optional().parse(data.newConversation);
        const key = memoKey(name ? "new-conversation" : "collaboration", p.sourceKey, p.source.botId, bot.id, name ? p.source.requestId : "default");
        const actionId = `bm_${hashSecret(key)}`;
        const c = await this.store.createConversation("owner", [bot.id], name ?? `来自 ${p.source.botName} 的协作`.slice(0, 256), actionId, {}, async () => {
          await guard(); await localAdmission?.();
          if (await this.store.db.get("SELECT 1 FROM conversations WHERE owner_id='owner' AND client_action_id=?", [actionId])) return;
          const rateKey = memoKey("conversation-rate", passport.sourceKey, passport.source.botId);
          const times = (await this.memo<number[]>(rateKey) ?? []).filter(t => t > Date.now() - 60_000);
          if (times.length >= 10) throw new HubError("bot_message_rate_limit", 429);
          await this.put(rateKey, [...times, Date.now()]);
        });
        // Never rotate or unarchive the owner's archived default chat. A
        // per-request chat replays only so its own request can be reconciled.
        if (c.archived && !name) throw new HubError("bot_message_collaboration_archived", 409);
        if (!c.archived) this.conversationCreated("owner", c);
        conversation = { id: c.id, name: c.title };
      } else throw new HubError("bot_message_conversation_required", 400);
      const target: BotMessageTarget = { ...base, conversationId: conversation.id, conversationName: conversation.name };
      const scope = async (admitting = true) => {
        await guard(); if (admitting) await localAdmission?.(); await this.store.requireMember("owner", target.conversationId); await this.store.requireBot(bot.id, target.conversationId);
        // The owner may archive between resolution and upload admission.
        if (admitting && path.startsWith("/api/uploads") && await this.store.db.get("SELECT 1 FROM conversations WHERE id=? AND archived=1", [target.conversationId])) throw new HubError("conversation_archived", 409);
      };
      if (path === "/api/bot-messages/resolve" && method === "POST") { await validate(); return target; }
      const attachmentGuard = async (id: string, admitting = true) => {
        await scope(admitting);
        if (!await this.memo(memoKey("upload", p!.sourceKey, p!.source.botId, bot.id, target.conversationId, id))) throw new HubError("bot_message_upload_forbidden", 403);
      };
      if (path === "/api/uploads" && method === "POST") {
        const input = uploadSchema.parse({ ...data, conversationId: target.conversationId });
        const result = await this.attachments.create("owner", input, scope);
        await this.store.db.transaction(async () => {
          await scope();
          const key = memoKey("upload", passport.sourceKey, passport.source.botId, bot.id, target.conversationId, result.id);
          const existing = await this.memo(key);
          await this.put(key, { requestId: passport.source.requestId });
          // Only a newly created permit has known consumption history. Keep
          // the old wire value and never reclassify an existing/legacy permit.
          // The SQL reference trigger also tracks compatible older writers.
          if (!existing) await this.store.db.run(`INSERT INTO bot_message_upload_permits(permit_key,attachment_id,used)
            VALUES(?,?,EXISTS(SELECT 1 FROM message_attachments WHERE attachment_id=?))`, [key, result.id, result.id]);
        });
        await validate(); return result;
      }
      const upload = /^\/api\/uploads\/([\w-]+)\/(complete|\d+)$/.exec(path);
      if (upload) {
        const check = () => this.store.db.serial(() => attachmentGuard(upload[1]!));
        // Admission belongs before the write. Preserve a successful receipt if
        // the source ends or owner archives afterward; authorization still holds.
        const receipt = () => this.store.db.serial(() => attachmentGuard(upload[1]!, false));
        if (upload[2] === "complete" && method === "POST") { const result = await this.attachments.complete("owner", upload[1]!, check); await receipt(); return { id: result.id }; }
        if (method === "PUT" && upload[2] !== "complete") { await this.attachments.putChunk("owner", upload[1]!, Number(upload[2]), body, check); await receipt(); return { ok: true }; }
      }
      if (path === "/api/bot-messages/send" && method === "POST") {
        const { delivery, ...input } = botMessageSendSchema.parse(data);
        if (isBotControl(input.text)) throw new HubError("bot_message_control_forbidden", 400);
        const key = memoKey("incoming", p.sourceKey, p.source.botId, p.source.requestId);
        const content = hashSecret(networkCanonical({ bot: bot.id, conversation: target.conversationId, ...input }));
        // Without `delivery` this stays the legacy path below, unless this
        // request ID already asked to steer: its replay reports that outcome.
        const context: DeliveryContext = { p, bot, target, input, delivery: delivery ?? "queue", key, content, clientMsgId: `bm_${hashSecret(key)}`, scope, attachmentGuard: id => attachmentGuard(id), guard, validate };
        // A failed lookup keeps the legacy path; it only adds replay of a steer request.
        if (delivery || await this.priorSteerRequest(key).catch(() => false)) return await this.deliver(context);
        try {
        const result = await this.store.sendMessage("owner", { ...input, conversationId: target.conversationId, clientMsgId: `bm_${hashSecret(key)}`, mentions: [bot.id], botSource: p.source, previewUrl: null }, async () => {
          await scope();
          const old = await this.memo<{ content: string }>(key);
          if (old && old.content !== content) throw new HubError("bot_message_request_conflict", 409);
          for (const id of input.attachments) await attachmentGuard(id);
          if (!old) {
            if (this.workerCapable(bot.id) === false) throw new HubError("bot_message_worker_update_required", 409);
            const rateKey = memoKey("rate", passport.sourceKey, passport.source.botId);
            const times = (await this.memo<number[]>(rateKey) ?? []).filter(t => t > Date.now() - 60_000);
            if (times.length >= 10) throw new HubError("bot_message_rate_limit", 429);
            await this.put(rateKey, [...times, Date.now()]); await this.put(key, { content, at: Date.now() });
          }
          await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), passport.source.botId, "bot-message.send", JSON.stringify({ ...target, requestId: passport.source.requestId, duplicate: !!old, sourceHost: passport.source.hostId, hops: passport.source.hops })]);
        });
        await validate(); return { ...target, requestId: p.source.requestId, messageId: result.message.id, duplicate: result.duplicate, status: "queued" };
        } catch (error) {
          // The same request ID was just created as a steer by a concurrent call: report that record.
          if (error instanceof HubError && error.code === "idempotency_conflict" && await this.priorSteerRequest(key)) return await this.deliver(context);
          throw error;
        }
      }
      if (["/api/bot-messages/wait", "/api/bot-messages/download"].includes(path) && method === "POST") {
        const messageId = idSchema.parse(data.messageId);
        if (path.endsWith("/wait")) await this.reconcileSteer(p, bot.id, target, messageId);
        const result = await this.store.db.serial(async (): Promise<WaitResult> => {
          await scope();
          const row = await this.store.db.get<{ bot_source_json: string; status: string }>("SELECT m.bot_source_json,d.status FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND d.bot_id=?", [messageId, target.conversationId, bot.id]);
          // A steered message has no delivery of its own: it reports the turn it joined.
          if (!row) { const steered = await this.steeredWaitInTransaction(passport, bot.id, target, messageId); if (steered) return steered; }
          const origin = row?.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)) : undefined;
          if (!row || !origin || origin.hostId !== passport.source.hostId || origin.botId !== passport.source.botId) throw new HubError("bot_message_reply_forbidden", 403);
          const reason = (await this.memo<IncomingMemo>(memoKey("incoming", passport.sourceKey, passport.source.botId, origin.requestId)))?.steer?.reason;
          return { ...target, messageId, ...await this.replyStateInTransaction(bot.id, target.conversationId, messageId, row.status),
            ...(reason ? { delivery: { requested: "steer" as const, actual: "fell_back_to_queue" as const, reason } } : {}) };
        });
        if (path.endsWith("/wait")) { await this.store.audit("bot-message.wait", p.source.botId, { messageId, sourceHost: p.source.hostId, status: result.status }); await validate(); return result; }
        const id = idSchema.parse(data.attachmentId), file = result.files.find(f => f.id === id);
        if (!file) throw new HubError("bot_message_reply_file_forbidden", 403);
        const offset = z.number().int().min(0).parse(data.offset);
        if (offset >= file.size) throw new HubError("invalid_offset", 416);
        const download = await this.attachments.download({ botId: bot.id }, id), handle = await open(download.path, "r");
        try { const bytes = Buffer.alloc(Math.min(1024 * 1024, file.size - offset)); const read = await handle.read(bytes, 0, bytes.length, offset); await validate(); return { bytes: bytes.subarray(0, read.bytesRead).toString("base64"), offset, ...file }; }
        finally { await handle.close(); }
      }
      throw new HubError("bot_message_operation_forbidden", 403);
    } catch (error) {
      await this.store.audit("bot-message.rejected", p?.source.botId ?? null, { stage: "target", reason: error instanceof HubError ? error.code : "invalid_request" }); throw error instanceof TargetResolutionError ? new HubError(error.message, 409) : error;
    }
  }

  /** The replies to one input message, as `messages wait` reports them. */
  private async replyStateInTransaction(botId: string, conversationId: string, inputId: string, deliveryStatus: string): Promise<ReplyState> {
    const messages = await this.store.db.all<{ id: string; blocks_json: string; status: string }>("SELECT id,blocks_json,status FROM messages WHERE conversation_id=? AND author_type='bot' AND author_id=? AND reply_to=? AND status!='deleted' ORDER BY created_at,id LIMIT 201", [conversationId, botId, inputId]);
    const files = await this.store.db.all<{ id: string; name: string; size: number; mime: string; sha256: string }>(`SELECT DISTINCT a.id,a.name,a.size,a.mime,a.sha256 FROM attachments a JOIN message_attachments ma ON ma.attachment_id=a.id JOIN messages m ON m.id=ma.message_id WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted' AND a.complete=1`, [inputId, botId, conversationId]);
    // An accepted delivery only ends the foreground turn. Bound background
    // work keeps replying to the same input; its process cards always carry
    // a complete envelope, so their run phase decides whether more may come.
    const { active } = (await this.store.db.get<{ active: number }>(`SELECT COUNT(*) AS active FROM messages m WHERE m.reply_to=? AND m.author_type='bot' AND m.author_id=? AND m.conversation_id=? AND m.status!='deleted'
      AND (m.status IN ('pending','streaming') OR EXISTS (SELECT 1 FROM json_each(m.blocks_json) b WHERE json_extract(b.value,'$.type')='card'
        AND (json_extract(b.value,'$.extra.nativeRun.phase') IN (${activeRunPhaseParams}) OR json_extract(b.value,'$.extra.scopedRun.phase') IN (${activeRunPhaseParams}))))`,
    [inputId, botId, conversationId, ...activeRunPhases, ...activeRunPhases]))!;
    const replying = deliveryStatus === "accepted" && active > 0;
    return { status: replying ? "pending" : deliveryStatus === "accepted" ? messages.some(m => m.status === "error") ? "failed" : "completed" : deliveryStatus === "failed" ? "failed" : deliveryStatus === "cancelled" ? "cancelled" : "pending",
      ...(replying ? { activeReplies: active } : {}), text: messages.slice(0, 200).map(m => blocksText(JSON.parse(m.blocks_json) as Block[])).filter(Boolean).join("\n\n"), files, truncated: messages.length > 200 };
  }
  /** What actually happened to a request that asked to steer. The record's
   * steering block is authoritative; the memo carries the turn and reason. */
  private deliveryOf(blocks: Block[], memo: IncomingMemo | undefined): BotMessageDeliveryReceipt {
    const control = blocks.find(block => block.type === "steering"), turn = memo?.steer?.turn ? { turn: { messageId: memo.steer.turn } } : {};
    if (!control) return memo?.steer?.reason ? { requested: "steer", actual: "fell_back_to_queue", reason: memo.steer.reason } : { requested: "steer", actual: "queued" };
    // Not final: the call is in flight, or this Host got no answer yet (reconcilable).
    if (control.outcome === "pending") return { requested: "steer", actual: "pending", reason: "steer_in_flight", ...turn };
    if (control.outcome === "unknown" && control.reason !== "gateway_uncertain") return { requested: "steer", actual: "pending", reason: "steer_unconfirmed", ...turn };
    // Final: steered, or the Gateway itself cannot tell (never queued, never called merged).
    return { requested: "steer", actual: control.outcome === "accepted" ? "steered" : "steer_uncertain", ...turn, ...(control.application?.status === "dropped" ? { dropped: control.application.reason } : {}) };
  }
  /** Caller holds the DB queue. Undefined unless `messageId` is this sender's steer record for `botId`. */
  private async steeredWaitInTransaction(p: BotPassport, botId: string, target: BotMessageTarget, messageId: string): Promise<WaitResult | undefined> {
    const row = await this.store.db.get<{ bot_source_json: string | null; blocks_json: string }>("SELECT bot_source_json,blocks_json FROM messages WHERE id=? AND conversation_id=? AND author_type='user' AND status!='deleted'", [messageId, target.conversationId]);
    const origin = row?.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)) : undefined;
    if (!row || !origin || origin.hostId !== p.source.hostId || origin.botId !== p.source.botId) return undefined;
    const blocks = JSON.parse(row.blocks_json) as Block[];
    if (!blocks.some(block => block.type === "steering" && block.botId === botId)) return undefined;
    const memo = await this.memo<IncomingMemo>(memoKey("incoming", p.sourceKey, p.source.botId, origin.requestId));
    const delivery = this.deliveryOf(blocks, memo), turn = memo?.steer?.turn, empty = { text: "", files: [], truncated: false };
    if (delivery.actual === "pending") return { ...target, messageId, status: "pending", ...empty, delivery };
    // Unknown whether it joined: report that, not the turn's reply. delivery.turn names the sender's own turn input.
    if (delivery.actual === "steer_uncertain") return { ...target, messageId, status: "uncertain", ...empty, delivery };
    // The joined turn, re-checked: only a turn this same sender started is readable.
    const turnRow = turn ? await this.store.db.get<{ bot_source_json: string | null; status: string }>("SELECT m.bot_source_json,d.status FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=? AND m.conversation_id=? AND d.bot_id=?", [turn, target.conversationId, botId]) : undefined;
    const turnOrigin = turnRow?.bot_source_json ? botSourceSchema.parse(JSON.parse(turnRow.bot_source_json)) : undefined;
    if (!turn || !turnRow || turnOrigin?.hostId !== p.source.hostId || turnOrigin.botId !== p.source.botId) return { ...target, messageId, status: "uncertain", ...empty, delivery };
    const state = await this.replyStateInTransaction(botId, target.conversationId, turn, turnRow.status);
    // Merged text the engine dropped will not be acted on: no need to wait for the turn.
    return { ...target, messageId, ...state, ...(delivery.dropped ? { status: "failed" } : {}), delivery, reply: { kind: "merged_turn" as const, turnMessageId: turn } };
  }
  /** New input admission shared by queued and steered deliveries (the legacy path keeps its own copy). */
  private async admitNewInTransaction(c: DeliveryContext): Promise<void> {
    if (this.workerCapable(c.bot.id) === false) throw new HubError("bot_message_worker_update_required", 409);
    const rateKey = memoKey("rate", c.p.sourceKey, c.p.source.botId);
    const times = (await this.memo<number[]>(rateKey) ?? []).filter(t => t > Date.now() - 60_000);
    if (times.length >= 10) throw new HubError("bot_message_rate_limit", 429);
    await this.put(rateKey, [...times, Date.now()]);
  }
  private auditSendInTransaction(c: DeliveryContext, duplicate: boolean, extra: Record<string, string>) {
    return this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), c.p.source.botId, "bot-message.send", JSON.stringify({ ...c.target, requestId: c.p.source.requestId, duplicate, sourceHost: c.p.source.hostId, hops: c.p.source.hops, delivery: c.delivery, ...extra })]);
  }
  private receipt(c: DeliveryContext, message: Message, duplicate: boolean, delivery: BotMessageDeliveryReceipt) {
    return { ...c.target, requestId: c.p.source.requestId, messageId: message.id, duplicate,
      status: delivery.actual === "steered" ? "steered" : delivery.actual === "steer_uncertain" ? "uncertain" : delivery.actual === "pending" ? "pending" : "queued", delivery };
  }
  /** One ordinary queued Bot message; with `reason` it records why a steer request was queued. */
  private async queueDelivery(c: DeliveryContext, reason?: BotSteerFallbackReason): Promise<unknown> {
    const input = { ...c.input, conversationId: c.target.conversationId, clientMsgId: c.clientMsgId, mentions: [c.bot.id], botSource: c.p.source, previewUrl: null };
    const admit = async () => {
      await c.scope();
      const old = await this.memo<IncomingMemo>(c.key);
      if (old && old.content !== c.content) throw new HubError("bot_message_request_conflict", 409);
      for (const id of c.input.attachments) await c.attachmentGuard(id);
      if (!old) { await this.admitNewInTransaction(c); await this.put(c.key, { content: c.content, at: Date.now(), ...(reason ? { steer: { reason } } : {}) } satisfies IncomingMemo); }
      await this.auditSendInTransaction(c, !!old, reason ? { fallback: reason } : {});
    };
    let result: { message: Message; duplicate: boolean };
    try { result = reason ? await this.store.sendMessageWithNotice("owner", input, steerFallbackNotice(c.bot.id, reason), admit) : await this.store.sendMessage("owner", input, admit); }
    catch (error) {
      // A concurrent call with this request ID created its steer record first: report that one.
      if (error instanceof HubError && error.code === "idempotency_conflict" && await this.priorSteerRequest(c.key)) return this.deliver(c);
      throw error;
    }
    const stored = (await this.store.db.serial(() => this.memo<IncomingMemo>(c.key)))?.steer?.reason;
    await c.validate();
    return this.receipt(c, result.message, result.duplicate, stored ? { requested: c.delivery, actual: "fell_back_to_queue", reason: stored } : { requested: c.delivery, actual: "queued" });
  }
  /** Every Host-side condition for merging into a live turn; any miss queues. */
  /** Caller holds the DB queue. Bot steer records that joined (or may have
   * joined) one live run; records that fell back to the queue no longer count. */
  private async turnSteersInTransaction(conversationId: string, botId: string, targetId: string): Promise<number> {
    return (await this.store.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM messages m WHERE m.conversation_id=? AND m.author_type='user' AND m.bot_source_json IS NOT NULL
      AND instr(m.blocks_json,?)>0 AND EXISTS (SELECT 1 FROM json_each(m.blocks_json) b WHERE json_extract(b.value,'$.type')='steering' AND json_extract(b.value,'$.botId')=? AND json_extract(b.value,'$.targetId')=?)`,
    [conversationId, `"targetId":${JSON.stringify(targetId)}`, botId, targetId]))!.count;
  }
  /** Whether this request ID already asked to steer (its replay reports that record). */
  private async priorSteerRequest(key: string): Promise<boolean> {
    return !!(await this.store.db.serial(() => this.memo<IncomingMemo>(key)))?.steer;
  }
  /** Caller holds the DB queue. The Hub-side conditions of a steer: checked
   * when planning and again in the transaction that creates the record, so
   * an owner switch turned off (or an engine/chat change) during the Gateway
   * status call still queues the message. */
  private async hubSteerConditionsInTransaction(c: DeliveryContext): Promise<BotSteerFallbackReason | undefined> {
    const conversationId = c.target.conversationId;
    if (await this.memo(steeringDisabledKey(c.bot.id))) return "steering_disabled";
    const bot = await this.store.db.get<{ engine: string }>("SELECT engine FROM bots WHERE id=?", [c.bot.id]);
    if (!bot || !supportsBotMessageSteerEngine(bot.engine)) return "unsupported_engine";
    const conversation = await this.store.db.get<{ type: string; parent_id: string | null; ticket_json: string | null }>("SELECT type,parent_id,ticket_json FROM conversations WHERE id=?", [conversationId]);
    const members = await this.store.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [conversationId]);
    if (conversation?.type !== "direct" || conversation.parent_id || conversation.ticket_json || members?.count !== 1) return "unsupported_conversation";
    const times = (await this.memo<number[]>(memoKey("steer-rate", c.p.sourceKey, c.p.source.botId, c.bot.id)) ?? []).filter(t => t > Date.now() - STEER_EDGE_WINDOW_MS);
    if (times.length >= STEER_EDGE_LIMIT) return "steer_rate_limited";
  }
  private async steerPlan(c: DeliveryContext): Promise<{ reason: BotSteerFallbackReason } | { targetId: string; turn: string; epoch: string }> {
    if (c.input.attachments.length) return { reason: "attachments_unsupported" };
    const conversationId = c.target.conversationId;
    const hub = await this.store.db.serial(async () => { await c.guard(); return this.hubSteerConditionsInTransaction(c); });
    if (hub) return { reason: hub };
    const capable = this.steering.capable(c.bot.id);
    if (capable === undefined) return { reason: "bot_offline" };
    if (!capable) return { reason: "worker_update_required" };
    // Read-only: a failed status lookup cannot have injected anything.
    let status;
    try { status = botSteerStatusSchema.parse(await this.steering.status(c.bot.id, conversationId)); } catch { return { reason: "status_unavailable" }; }
    if (!status.supported) return { reason: status.reason === "no_active_turn" ? "no_active_turn" : "unsupported_engine" };
    if (status.reason === "background_review") return { reason: "background_review" };
    if (!status.targetId || !status.sourceMessageId || !status.receiptEpoch) return { reason: "no_active_turn" };
    const { targetId, sourceMessageId: turn, receiptEpoch: epoch } = status;
    const turnReason = await this.store.db.serial(async (): Promise<BotSteerFallbackReason | undefined> => {
      await c.guard();
      const row = await this.store.db.get<{ bot_source_json: string | null; status: string; dispatched: number }>("SELECT m.bot_source_json,d.status,d.dispatched FROM messages m JOIN deliveries d ON d.message_id=m.id AND d.bot_id=? WHERE m.id=? AND m.conversation_id=?", [c.bot.id, turn, conversationId]);
      const origin = row?.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)) : undefined;
      if (!row || origin?.hostId !== c.p.source.hostId || origin.botId !== c.p.source.botId) return "turn_not_from_sender";
      if (row.status !== "pending" || !row.dispatched) return "turn_ended";
      // An open approval or question owns this turn's next input; a Bot cannot answer it.
      for (const reply of await this.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND reply_to=? AND author_type='bot' AND author_id=? AND status!='deleted' AND instr(blocks_json,'\"actionId\"')>0", [conversationId, turn, c.bot.id])) {
        let blocks: unknown; try { blocks = JSON.parse(reply.blocks_json); } catch { continue; }
        if (hasPendingCardAction(blocks)) return "pending_card";
      }
      if (await this.turnSteersInTransaction(conversationId, c.bot.id, targetId) >= STEER_TURN_LIMIT) return "turn_steer_limit";
    });
    return turnReason ? { reason: turnReason } : { targetId, turn, epoch };
  }
  /** A request that named a delivery (or replays one that asked to steer). */
  /** A record under this request's client ID must be this request's own. */
  private ownsRecord(c: DeliveryContext, message: Pick<Message, "botSource" | "conversationId">): boolean {
    const origin = message.botSource;
    return !!origin && origin.hostId === c.p.source.hostId && origin.botId === c.p.source.botId && origin.requestId === c.p.source.requestId && message.conversationId === c.target.conversationId;
  }
  private async deliver(c: DeliveryContext, replays = 0): Promise<unknown> {
    const prior = await this.store.db.serial(async () => { await c.scope(); return this.memo<IncomingMemo>(c.key); });
    if (prior && prior.content !== c.content) throw new HubError("bot_message_request_conflict", 409);
    if (prior?.steer) {
      const existing = await this.store.db.serial(() => this.store.db.get<{ id: string; bot_source_json: string | null; conversation_id: string }>("SELECT id,bot_source_json,conversation_id FROM messages WHERE author_id='owner' AND client_msg_id=?", [c.clientMsgId]));
      if (existing) {
        if (!this.ownsRecord(c, { conversationId: existing.conversation_id, botSource: existing.bot_source_json ? botSourceSchema.parse(JSON.parse(existing.bot_source_json)) : undefined })) throw new HubError("bot_message_request_conflict", 409);
        await this.reconcileSteer(c.p, c.bot.id, c.target, existing.id);
        const row = (await this.store.db.serial(() => this.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=?", [existing.id])))!;
        const memo = await this.store.db.serial(() => this.memo<IncomingMemo>(c.key));
        await this.store.db.transaction(() => this.auditSendInTransaction(c, true, {}));
        await c.validate(); return this.receipt(c, { id: existing.id } as Message, true, this.deliveryOf(JSON.parse(row.blocks_json) as Block[], memo));
      }
    }
    // An existing plain record replays through the ordinary queue path.
    if (c.delivery === "queue" || prior) return this.queueDelivery(c);
    // The queue path's own rules first: empty text is its empty_message, before
    // any record exists; blank text (which it accepts) is queued, never steered.
    if (!c.input.text && !c.input.attachments.length) return this.queueDelivery(c);
    if (!c.input.text.trim() && !c.input.attachments.length) return this.queueDelivery(c, "blank_text");
    // The source's own rate limit is the queue path's answer too, and costs no Gateway call.
    if (await this.store.db.serial(async () => (await this.memo<number[]>(memoKey("rate", c.p.sourceKey, c.p.source.botId)) ?? []).filter(t => t > Date.now() - 60_000).length >= 10)) throw new HubError("bot_message_rate_limit", 429);
    const plan = await this.steerPlan(c);
    if ("reason" in plan) return this.queueDelivery(c, plan.reason);
    const call = { conversationId: c.target.conversationId, userId: "owner", requestId: c.clientMsgId, targetId: plan.targetId, sourceMessageId: plan.turn, text: c.input.text, source: c.p.source };
    // The exact Gateway call must be valid before a record is created for it.
    if (!botSteerCallSchema.safeParse(call).success) throw new HubError("bot_message_invalid_request", 400);
    let created: { message: Message; created: boolean }, opened = false;
    try {
      created = await this.store.beginBotSteer("owner", { conversationId: c.target.conversationId, botId: c.bot.id, clientMsgId: c.clientMsgId, text: c.input.text, botSource: c.p.source, targetId: plan.targetId }, async () => {
        await c.scope();
        if (await this.memo(c.key)) throw new HubError("bot_message_request_conflict", 409);
        await this.admitNewInTransaction(c);
        const refused = await this.hubSteerConditionsInTransaction(c);
        if (refused) throw new SteerLimitReached(refused);
        const edgeKey = memoKey("steer-rate", c.p.sourceKey, c.p.source.botId, c.bot.id);
        const times = (await this.memo<number[]>(edgeKey) ?? []).filter(t => t > Date.now() - STEER_EDGE_WINDOW_MS);
        if (await this.turnSteersInTransaction(c.target.conversationId, c.bot.id, plan.targetId) >= STEER_TURN_LIMIT) throw new SteerLimitReached("turn_steer_limit");
        if (times.length >= STEER_EDGE_LIMIT) throw new SteerLimitReached("steer_rate_limited");
        await this.put(edgeKey, [...times, Date.now()]);
        await this.put(c.key, { content: c.content, at: Date.now(), steer: { turn: plan.turn, targetId: plan.targetId, epoch: plan.epoch } } satisfies IncomingMemo);
        opened = true;
        await this.auditSendInTransaction(c, false, {});
      });
    } catch (error) { if (error instanceof SteerLimitReached) return this.queueDelivery(c, error.reason); throw error; }
    // Another call with this request created the record first: report that one, once.
    if (!created.created) {
      if (replays > 0 || !this.ownsRecord(c, created.message)) throw new HubError("bot_message_request_conflict", 409);
      return this.deliver(c, replays + 1);
    }
    if (opened) await this.store.db.transaction(() => this.put(openSteerKey(c.bot.id, created.message.id), { key: c.key, conversationId: c.target.conversationId } satisfies OpenSteer));
    // The Gateway journals this call at most once. Only its explicit refusal
    // proves nothing reached the engine; its own "unknown" is final; a lost
    // call leaves the record unconfirmed for reconciliation.
    let result: SteerResult, answered = true;
    this.steersInFlight.add(created.message.id);
    try {
      try { result = steerResultSchema.parse(await this.steering.steer(c.bot.id, call)); }
      catch { result = { outcome: "unknown", reason: "uncertain" }; answered = false; }
      await this.settleSteer(c.p.source, c.bot.id, created.message.id, c.key, result, plan.turn, answered);
    } finally { this.steersInFlight.delete(created.message.id); }
    const message = await this.store.db.serial(() => this.store.queuedMessageInTransaction(created.message.id));
    const delivery = this.deliveryOf(message.blocks, await this.store.db.serial(() => this.memo<IncomingMemo>(c.key)));
    await c.validate();
    return this.receipt(c, message, false, delivery);
  }
  /** Apply one Gateway answer (direct or reconciled; `answered` is false when
   * this Host got none). Every transition is idempotent: a definite refusal
   * queues the record once; acceptance and uncertainty never create a delivery. */
  private async settleSteer(source: BotSource, botId: string, messageId: string, key: string, result: SteerResult, turn: string, answered: boolean): Promise<void> {
    const audit = (outcome: string, extra: Record<string, string> = {}) => this.store.audit("bot-message.steer", source.botId, { messageId, requestId: source.requestId, sourceHost: source.hostId, sourceBot: source.botId, outcome, turn, ...extra });
    const close = () => this.store.db.transaction(() => this.store.db.run("DELETE FROM meta WHERE key=?", [openSteerKey(botId, messageId)]));
    if (result.outcome === "rejected" && result.reason === "control_forbidden") {
      // Unreachable: control text is refused before any record exists. Never
      // queue it and never call it an engine limitation.
      await this.store.settleBotSteer(messageId, botId, { outcome: "unknown", reason: "gateway_uncertain" });
      await audit("steer_uncertain", { reason: "control_forbidden_unreachable" }); await close();
      return;
    }
    if (result.outcome === "rejected") {
      const reason = botSteerRejectionReason(result.reason);
      const changed = (await this.store.fallBackBotSteer(messageId, botId, steerFallbackNotice(botId, reason), async () => {
        const memo = await this.memo<IncomingMemo>(key);
        await this.put(key, { ...memo!, steer: { ...memo!.steer, reason } } satisfies IncomingMemo);
      })).changed;
      if (changed) {
        // The delivery was inserted into an existing record: no message.created
        // event will wake the dispatch loop, so ask for it explicitly.
        this.steering.dispatch(botId);
        await audit("fell_back_to_queue", { reason });
      }
      await close();
      return;
    }
    // Like an owner steer: the joined (or possibly joined) run records this
    // input, so a history rewind of that turn also marks an adopted Bot record.
    await this.store.bindRunInput(turn, messageId);
    const outcome = (blocks: Block[]) => { const control = blocks.find(block => block.type === "steering"); return control ? `${control.outcome}:${control.reason ?? ""}` : "none"; };
    const before = outcome((await this.store.db.serial(() => this.store.queuedMessageInTransaction(messageId))).blocks);
    const settled = await this.store.settleBotSteer(messageId, botId, result.outcome === "accepted" ? { outcome: "accepted" } : { outcome: "unknown", reason: answered ? "gateway_uncertain" : "uncertain" });
    const after = outcome(settled.blocks), delivery = this.deliveryOf(settled.blocks, undefined);
    if (after !== before) await audit(delivery.actual === "pending" ? "steer_unconfirmed" : delivery.actual);
    if (delivery.actual !== "pending") await close();
  }
  /** Learn the recorded outcome of an open steer from the Gateway (never
   * steering again). Skipped while this process still awaits the original
   * call, or while no capable worker is attached: the record stays open. */
  private async reconcileRecord(botId: string, messageId: string, sender?: { hostId: string; botId: string }): Promise<void> {
    if (this.steersInFlight.has(messageId) || this.steering.capable(botId) !== true) return;
    const found = await this.store.db.serial(async () => {
      const open = await this.memo<OpenSteer>(openSteerKey(botId, messageId));
      const row = await this.store.db.get<{ bot_source_json: string | null; blocks_json: string; client_msg_id: string | null; conversation_id: string }>("SELECT bot_source_json,blocks_json,client_msg_id,conversation_id FROM messages WHERE id=? AND author_type='user'", [messageId]);
      const origin = row?.bot_source_json ? botSourceSchema.parse(JSON.parse(row.bot_source_json)) : undefined;
      if (!open || !row?.client_msg_id || !origin || open.conversationId !== row.conversation_id || sender && (origin.hostId !== sender.hostId || origin.botId !== sender.botId)) return undefined;
      const control = (JSON.parse(row.blocks_json) as Block[]).find(block => block.type === "steering");
      if (control?.botId !== botId || !(control.outcome === "pending" || control.outcome === "unknown" && control.reason !== "gateway_uncertain")) return { stale: true as const };
      const steer = (await this.memo<IncomingMemo>(open.key))?.steer;
      return steer?.turn && steer.targetId && steer.epoch ? { origin, key: open.key, conversationId: row.conversation_id, requestId: row.client_msg_id, turn: steer.turn, targetId: steer.targetId, epoch: steer.epoch } : undefined;
    });
    if (!found) return;
    if ("stale" in found) { await this.store.db.transaction(() => this.store.db.run("DELETE FROM meta WHERE key=?", [openSteerKey(botId, messageId)])); return; }
    let result: SteerResult;
    try { result = steerResultSchema.parse(await this.steering.reconcile(botId, { conversationId: found.conversationId, requestId: found.requestId, targetId: found.targetId, sourceMessageId: found.turn, receiptEpoch: found.epoch })); }
    catch { return; }
    if (this.steersInFlight.has(messageId)) return;
    await this.settleSteer(found.origin, botId, messageId, found.key, result, found.turn, true);
  }
  /** wait / replay: only the sender's own record. */
  private reconcileSteer(p: BotPassport, botId: string, _target: BotMessageTarget, messageId: string): Promise<void> {
    return this.reconcileRecord(botId, messageId, { hostId: p.source.hostId, botId: p.source.botId });
  }
  /** A capable worker attached: reconcile this Bot's open steers, so a recorded
   * refusal is queued without the sender having to ask. Bounded per attach. */
  async reconcileForBot(botId: string): Promise<void> {
    const prefix = `${OPEN_STEER}${idSchema.parse(botId)}:`;
    const rows = await this.store.db.serial(() => this.store.db.all<{ key: string }>("SELECT key FROM meta WHERE key>=? AND key<? ORDER BY key LIMIT 100", [prefix, `${prefix}\uffff`]));
    for (const { key } of rows) await this.reconcileRecord(botId, key.slice(prefix.length));
  }
  /** Signed probe of a remote receiving Host. Only an explicit refusal of the
   * unknown route (an older Host) means queue; other failures stop the send. */
  private async peerSteers(host: NetworkHost, source: BotSource, targetBot: string, admit: Guard): Promise<boolean> {
    const body = Buffer.from("{}");
    const passport: BotPassport = { v: 1, sourceKey: this.auth.publicKey, targetKey: host.publicKey, source, targetBot, method: "POST", path: "/api/bot-messages/capabilities", digest: digest(body), expiresAt: Date.now() + BOT_PASSPORT_TTL_MS, nonce: randomUUID() };
    await this.store.db.serial(admit);
    try {
      const reply = botMessageCapabilitiesSchema.parse(await this.exchange(host, { passport, signature: this.auth.signBotPassport(passport) }, body));
      if (reply.hostId !== messageHostId(host.publicKey)) throw new HubError("bot_message_reply_target_mismatch", 502);
      return reply.deliveries.includes("steer");
    } catch (error) {
      if (error instanceof HubError && error.code === "bot_message_operation_forbidden") return false;
      throw error;
    }
  }
  /** Caller holds the DB queue. Internal dispatch workers are not listed. */
  private async steeringInTransaction(botId: string): Promise<BotMessageSteeringSnapshot> {
    const bot = await this.store.db.get<{ engine: string }>("SELECT engine FROM bots WHERE id=? AND deleted_at IS NULL AND role!='worker'", [botId]);
    if (!bot) throw new HubError("bot_not_found", 404);
    return { botId, allowed: !await this.memo(steeringDisabledKey(botId)), supported: supportsBotMessageSteerEngine(bot.engine) };
  }
  /** Receiving owner's switch "allow other Bots to steer this Bot" (default on). */
  /** `bot` is an ID or an exact unique name (IDs first); the snapshot names the ID. */
  async readSteering(userId: string, bot: string, guard: Guard): Promise<BotMessageSteeringSnapshot> {
    return this.store.db.serial(async () => {
      await guard(); await this.store.requireOwner(userId);
      const bots = await this.store.db.all<{ id: string; name: string }>("SELECT id,name FROM bots WHERE deleted_at IS NULL AND role!='worker' ORDER BY id");
      let id: string;
      try { id = resolveBotTarget(bot, bots, "bot").id; } catch (error) { if (error instanceof TargetResolutionError && resolutionCode(error) === "target_not_found") throw new HubError("bot_not_found", 404); throw error; }
      return this.steeringInTransaction(id);
    });
  }
  /** Owner + one-use device proof (`admit`), like Bot-message grants. Bot
   * instance authorization never reaches this. */
  async setSteering(userId: string, raw: unknown, guard: Guard, admit: Guard, actor: string): Promise<BotMessageSteeringSnapshot> {
    const command = botMessageSteeringCommandSchema.parse(raw);
    return this.store.db.transaction(async () => {
      await guard(); await this.store.requireOwner(userId);
      const before = await this.steeringInTransaction(command.botId);
      await admit();
      if (command.allowed) await this.store.db.run("DELETE FROM meta WHERE key=?", [steeringDisabledKey(command.botId)]);
      else await this.put(steeringDisabledKey(command.botId), true);
      await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), actor, "bot-message.steering-updated", JSON.stringify({ botId: command.botId, allowed: command.allowed, previous: before.allowed })]);
      return this.steeringInTransaction(command.botId);
    });
  }
}
