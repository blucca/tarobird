import path from "node:path";
import { z } from "zod";
import {
  historyBotForkCallSchema, historyBotForkReplySchema, historyBotRewindCallSchema, historyBotRewindReplySchema, historyBotStatusCallSchema,
  historyBotStatusSchema, historyErrorSchema, type EngineHistoryAnchor, type HistoryError, type HistoryHints, type HistoryLedgerLine,
} from "../client-protocol/history.js";
import { idSchema, type Json } from "../client-protocol/index.js";
import { EngineHistoryUnconfirmedError, type AppPlatformTools } from "../codex/adapter.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import type { CoreServiceRuntime } from "../core/runtime.js";
import type { CoreBridgeLike, CoreHistoryRunHint, CoreHistoryScope } from "../core/types.js";
import { HistoryOperationBusyError } from "../runtime/bridge.js";
import { getConversationKey } from "../runtime/conversation-key.js";
import { resolveConversationResume } from "../runtime/conversation-resume.js";
import { appendHistoryLedgerLine, findHistoryLedgerRun, historyLedgerSinceMessageId, lastHistoryLedgerRewind, readHistoryLedger, readHistoryLedgerEntries } from "../runtime/history-ledger.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import { SessionStore } from "../state/session-store.js";
import type { SessionRecord } from "../types.js";
import { GatewayReceipts } from "./receipts.js";

/** A rewind is re-entrant: an interrupted or failed receipt may run again. */
const REWIND_RECEIPT_RETRY_MS = 24 * 60 * 60_000;
/** Ledger run id of an older run matched in the engine (no line of its own). */
const RESOLVED_RUN_PREFIX = "resolved-";

export interface GatewayHistoryOptions {
  /** The authenticated surface sharing the engine, sessions and locks. */
  bridge: CoreBridgeLike;
  runtime: CoreServiceRuntime;
  stateDir: string;
  receipts?: Pick<GatewayReceipts, "run" | "peek">;
  /** False while a Hub session selection still waits for the main queue. */
  bindingReady?: (conversationId: string) => Promise<boolean>;
  /** A received input not yet admitted to the Core queue. */
  hasPendingAdmission?: (conversationId: string) => boolean;
  /** Close every side handle of the conversation (after a rewind). */
  closeSideSessions?: (conversationId: string) => Promise<void>;
  /** App tools of a conversation, to carry the source thread's tool schema to a fork. */
  appTools?: (conversationId: string) => AppPlatformTools | undefined;
}

type Blocked = "running" | "pending_action" | "goal_active" | "background_work";
class HistoryRefusal extends Error { constructor(readonly code: HistoryError) { super(code); } }
const refuse = (code: HistoryError): never => { throw new HistoryRefusal(code); };
const blockedError = (blocked: Blocked | undefined): void => { if (blocked) refuse(blocked === "goal_active" ? "goal_active" : "busy"); };
function historyErrorCode(error: unknown): HistoryError {
  if (error instanceof HistoryRefusal) return error.code;
  if (error instanceof HistoryOperationBusyError) return "busy";
  const direct = historyErrorSchema.safeParse(error instanceof Error ? error.message : undefined);
  return direct.success ? direct.data : "engine_failed";
}
const recordKey = (record: SessionRecord) => record.conversationKey ?? getConversationKey(record.telegramChatId, record.telegramThreadId);
const runHint = (hint: NonNullable<HistoryHints["next"]>): CoreHistoryRunHint => ({ sourceMessageId: hint.sourceMessageId, text: hint.text, startedAt: hint.startedAt ?? hint.createdAt });

/** The fork's workspace selection is the source's own; its symlink ownership is not. */
function carriedResume(record: SessionRecord | null, sessionId: string): { resume: SessionRecord["resume"] } | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, "resume")) return undefined;
  if (!record.resume) return { resume: null };
  const { symlinkPath: _owned, ...workspace } = record.resume;
  return { resume: { ...workspace, sessionId } };
}

/**
 * #53 Hub → Gateway history calls. Each operation runs at most once per
 * (user, request) through GatewayReceipts; concurrent duplicates join the
 * same execution. A rewind may run again after an interruption (it is
 * re-entrant); an interrupted fork reports `operation_interrupted`.
 * Replies are enums, never thrown errors.
 */
export function gatewayHistory(options: GatewayHistoryOptions) {
  const { bridge, runtime, stateDir } = options;
  const receipts = options.receipts ?? new GatewayReceipts(stateDir);
  const support = () => bridge.withHistoryLocks && bridge.historySession && bridge.historyCapability ? bridge.historySupport?.() ?? { rewind: false, fork: false } : { rewind: false, fork: false };
  const scopeOf = (conversationId: string, userId: string): CoreHistoryScope => {
    const conversationKey = buildCoreConversationKey(conversationId);
    return { chatId: stableCoreNumericId(conversationKey), userId: stableCoreNumericId(`user:gwuser_${userId}`), chatType: "bus", conversationKey };
  };
  /** In-memory reads only: repeated inside the locks. */
  const localBlock = (conversationId: string, conversationKey: string): Blocked | undefined => {
    const run = runtime.activeRuns.get(conversationKey);
    if (run && !run.goalWatch || runtime.concurrentRuns.get(conversationKey)?.size || runtime.chatQueue.isBusy(conversationKey) || options.hasPendingAdmission?.(conversationId)) return "running";
    if ([...runtime.pendingApprovals.values()].some(pending => pending.conversationKey === conversationKey && !pending.cancelled)) return "pending_action";
    if (run?.goalWatch) return "goal_active";
    if (bridge.hasPendingNativeWork?.()) return "background_work";
    return undefined;
  };
  /** A saved active goal without an observer still pursues turns natively. */
  const goalActive = async (scope: CoreHistoryScope, workspaceOverride: string | undefined): Promise<boolean> => {
    if (!bridge.getThreadGoal) return false;
    try { return (await bridge.getThreadGoal({ ...scope, workspaceOverride })).goal?.status === "active"; }
    catch { return false; }
  };
  const context = async (conversationId: string, userId: string) => {
    const scope = scopeOf(conversationId, userId);
    const cfg = await loadInstanceConfig(stateDir);
    const inspected = await new SessionStore(path.join(stateDir, "session.json")).inspect();
    if (inspected.warning) refuse("engine_failed");
    const record = inspected.state.chats.find(entry => recordKey(entry) === scope.conversationKey) ?? null;
    return {
      scope, cfg, record,
      workspaceOverride: resolveInstanceWorkspacePath({ workspacePath: cfg.workspacePath, resume: resolveConversationResume(record, cfg.resume) }),
      /** Another conversation is attached to the same engine session. */
      shared: (sessionId: string) => inspected.state.chats.some(entry => entry.codexSessionId === sessionId && recordKey(entry) !== scope.conversationKey),
      bound: (conversationKey: string) => inspected.state.chats.some(entry => recordKey(entry) === conversationKey),
    };
  };

  /** Ledger first; an older run is matched in the engine and persisted before
   * any engine change, so a retried rewind proves its own success. */
  const resolveAnchor = async (input: { scope: CoreHistoryScope; sessionId: string; messageId: string; hints?: HistoryHints; engine: HistoryLedgerLine["engine"]; rewind: boolean }): Promise<EngineHistoryAnchor> => {
    let runs: Awaited<ReturnType<typeof readHistoryLedger>>;
    try { runs = await readHistoryLedger(stateDir, input.scope.conversationKey); }
    catch { return refuse("engine_failed"); }
    const run = findHistoryLedgerRun(runs, input.messageId);
    const matched = run?.runId === `${RESOLVED_RUN_PREFIX}${input.messageId}`;
    if (run) {
      const anchor = run.last.anchor;
      if (!anchor?.firstTurnId && anchor?.endSeq === undefined) refuse("not_an_anchor");
      if (run.last.sessionId !== input.sessionId) refuse("session_changed");
      // A matched older run whose next run could not be matched then has no
      // fork end yet: match again rather than refusing it forever.
      if (input.rewind || !matched || anchor!.lastTurnId || anchor!.endSeq !== undefined) return anchor!;
    }
    const target = input.hints?.target, next = input.hints?.next;
    if (!target || target.sourceMessageId !== input.messageId || !bridge.resolveHistoryAnchor) return refuse("turn_unresolved");
    const resolved = await bridge.resolveHistoryAnchor({ ...input.scope, sessionId: input.sessionId, target: runHint(target), ...(next ? { next: runHint(next) } : {}) });
    if (!resolved?.firstTurnId) return refuse("turn_unresolved");
    // The persisted start may already have been rewound from; never move it.
    if (run && resolved.firstTurnId !== run.last.anchor?.firstTurnId) return refuse("turn_unresolved");
    if (run && !resolved.lastTurnId) return resolved;
    const persisted = await appendHistoryLedgerLine(stateDir, input.scope.conversationKey, { v: 1, sourceMessageId: input.messageId,
      runId: `${RESOLVED_RUN_PREFIX}${input.messageId}`, engine: input.engine, sessionId: input.sessionId, anchor: resolved, startedAt: target.startedAt ?? target.createdAt });
    if (!persisted && input.rewind) refuse("engine_failed");
    return resolved;
  };

  const status = async (raw: unknown) => {
    const { conversationId, userId } = historyBotStatusCallSchema.parse(raw);
    const supported = support();
    if (!supported.rewind && !supported.fork) return { supported: false, rewind: "none", fork: "none", reason: "unsupported" };
    const ctx = await context(conversationId, userId);
    let session = await bridge.historySession!(ctx.scope);
    if (session && options.bindingReady && !await options.bindingReady(conversationId)) session = null;
    let capability: Awaited<ReturnType<NonNullable<CoreBridgeLike["historyCapability"]>>>;
    try { capability = await bridge.historyCapability!({ ...ctx.scope, ...(session ? { sessionId: session.sessionId } : {}), workspaceOverride: ctx.workspaceOverride }); }
    catch (error) {
      // The recorded thread is gone: the next message starts a new one.
      if (!session || historyErrorCode(error) !== "no_main_session") throw error;
      session = null;
      capability = await bridge.historyCapability!({ ...ctx.scope, workspaceOverride: ctx.workspaceOverride });
    }
    let { rewind, fork, reason } = capability;
    if (!supported.rewind) rewind = "none";
    if (!supported.fork) fork = "none";
    if (session && rewind !== "none" && ctx.shared(session.sessionId)) { rewind = "none"; reason = "external_session"; }
    if (rewind === "none" && fork === "none") return historyBotStatusSchema.parse({ supported: false, rewind, fork, reason: reason ?? "unsupported" });
    const blocked = localBlock(conversationId, ctx.scope.conversationKey)
      ?? (!session ? "no_main_session" : await goalActive(ctx.scope, ctx.workspaceOverride) ? "goal_active" : undefined);
    const sinceMessageId = session ? historyLedgerSinceMessageId(await readHistoryLedger(stateDir, ctx.scope.conversationKey).catch(() => []), session.sessionId) : undefined;
    return historyBotStatusSchema.parse({ supported: true, rewind, fork, ...(blocked ? { blocked } : {}), ...(reason ? { reason } : {}), ...(sinceMessageId ? { sinceMessageId } : {}) });
  };

  /** Locks, idle recheck and the current session shared by both operations. */
  const underLocks = async <T>(conversationId: string, userId: string, operation: (session: { sessionId: string }, ctx: Awaited<ReturnType<typeof context>>) => Promise<T>): Promise<T> => {
    const scope = scopeOf(conversationId, userId);
    blockedError(localBlock(conversationId, scope.conversationKey));
    return await bridge.withHistoryLocks!(scope, async (session) => {
      blockedError(localBlock(conversationId, scope.conversationKey));
      if (!session || options.bindingReady && !await options.bindingReady(conversationId)) return refuse("no_main_session");
      const ctx = await context(conversationId, userId);
      return await operation(session, ctx);
    });
  };

  const executeRewind = async (call: z.infer<typeof historyBotRewindCallSchema>): Promise<z.infer<typeof historyBotRewindReplySchema>> => {
    try {
      if (!support().rewind || !bridge.rewindHistory) return { ok: false, error: "unsupported" };
      return await underLocks(call.conversationId, call.userId, async (session, ctx) => {
        const capability = await bridge.historyCapability!({ ...ctx.scope, sessionId: session.sessionId, workspaceOverride: ctx.workspaceOverride });
        // Truncating a session another conversation (or client) also uses
        // would silently drop its context.
        if (capability.rewind !== "turn" || ctx.shared(session.sessionId)) refuse("unsupported");
        if (await goalActive(ctx.scope, ctx.workspaceOverride)) refuse("goal_active");
        const anchor = await resolveAnchor({ scope: ctx.scope, sessionId: session.sessionId, messageId: call.beforeMessageId, hints: call.hints, engine: ctx.cfg.engine, rewind: true });
        // Recorded while the anchor's turn is known present, before the engine
        // changes: a later request that finds it gone learns where it ended.
        const record = { v: 1 as const, kind: "rewind" as const, requestId: call.requestId, sessionId: session.sessionId, fromMessageId: call.beforeMessageId,
          ...(call.throughMessageId ? { throughMessageId: call.throughMessageId } : {}) };
        const beforeRevert = async () => {
          if (!await appendHistoryLedgerLine(stateDir, ctx.scope.conversationKey, { ...record, at: Date.now() })) refuse("engine_failed");
        };
        const result = await bridge.rewindHistory!({ ...ctx.scope, sessionId: session.sessionId, anchor, workspaceOverride: ctx.workspaceOverride, beforeRevert });
        // Side handles were forked from the history that is gone.
        await options.closeSideSessions?.(call.conversationId).catch(() => undefined);
        if (result.reverted) return { ok: true as const };
        // Gone before this call. Turns chatted since that earlier rewind are
        // live: its own edge bounds the range, never this request's. Without a
        // record nothing proves where it ended, so nothing is marked.
        let rewinds: Awaited<ReturnType<typeof readHistoryLedgerEntries>>["rewinds"];
        try { ({ rewinds } = await readHistoryLedgerEntries(stateDir, ctx.scope.conversationKey)); }
        catch { return refuse("engine_failed"); }
        const earlier = lastHistoryLedgerRewind(rewinds, call.beforeMessageId, session.sessionId);
        return earlier?.throughMessageId ? { ok: true as const, throughMessageId: earlier.throughMessageId } : refuse("already_rewound");
      });
    } catch (error) {
      // Not an answer: the receipt stays retryable and the Hub asks again.
      if (error instanceof EngineHistoryUnconfirmedError) throw error;
      return { ok: false, error: historyErrorCode(error) };
    }
  };

  const executeFork = async (call: z.infer<typeof historyBotForkCallSchema>): Promise<z.infer<typeof historyBotForkReplySchema>> => {
    try {
      if (!support().fork || !bridge.forkHistory || !bridge.bindForkedHistorySession) return { ok: false, error: "unsupported" };
      const target = scopeOf(call.targetConversationId, call.userId);
      if (call.targetConversationId === call.conversationId) return { ok: false, error: "engine_failed" };
      return await underLocks(call.conversationId, call.userId, async (session, ctx) => {
        const capability = await bridge.historyCapability!({ ...ctx.scope, sessionId: session.sessionId, workspaceOverride: ctx.workspaceOverride });
        if (capability.fork === "none" || call.throughMessageId && capability.fork !== "turn") refuse("unsupported");
        if (await goalActive(ctx.scope, ctx.workspaceOverride)) refuse("goal_active");
        const through = call.throughMessageId
          ? await resolveAnchor({ scope: ctx.scope, sessionId: session.sessionId, messageId: call.throughMessageId, hints: call.hints, engine: ctx.cfg.engine, rewind: false })
          : undefined;
        if (call.throughMessageId && !through?.lastTurnId && through?.endSeq === undefined) refuse("turn_unresolved");
        // A reserved conversation is new; never replace a binding.
        if (ctx.bound(target.conversationKey)) refuse("engine_failed");
        const appPlatformTools = options.appTools?.(call.targetConversationId);
        const forked = await bridge.forkHistory!({ ...ctx.scope, sessionId: session.sessionId,
          ...(through ? { through: { ...(through.lastTurnId ? { lastTurnId: through.lastTurnId } : {}), ...(through.endSeq !== undefined ? { endSeq: through.endSeq } : {}) } } : {}),
          workspaceOverride: ctx.workspaceOverride, ...(appPlatformTools ? { appPlatformTools } : {}) });
        // Model and effort follow the Bot configuration; goals, queue, side
        // sessions and approval grants stay with the source conversation.
        await bridge.bindForkedHistorySession!(target, forked.sessionId, carriedResume(ctx.record, forked.sessionId));
        return { ok: true as const, mode: call.throughMessageId ? "turn" as const : "head" as const };
      });
    } catch (error) { return { ok: false, error: historyErrorCode(error) }; }
  };

  return async (method: string, raw: unknown): Promise<Json> => {
    if (method === "history.status") return z.json().parse(await status(raw));
    if (method === "history.rewind") {
      const call = historyBotRewindCallSchema.parse(raw);
      const identity = { conversationId: call.conversationId, beforeMessageId: call.beforeMessageId };
      const key = `history.rewind:${call.userId}:${call.requestId}`;
      const storedReply = (result: Json | undefined) => {
        const stored = z.object({ conversationId: idSchema, beforeMessageId: idSchema, reply: historyBotRewindReplySchema }).safeParse(result);
        if (!stored.success) return undefined;
        return stored.data.conversationId === identity.conversationId && stored.data.beforeMessageId === identity.beforeMessageId ? stored.data.reply : { ok: false as const, error: "history_changed" as const };
      };
      if (call.replayOnly) {
        // Later input already ran on this thread: only a success this request
        // already produced may be reported; nothing is executed.
        const receipt = await receipts.peek(key);
        const reply = receipt?.ok ? storedReply(receipt.result) : undefined;
        return reply?.ok ? reply : { ok: false, error: "history_changed" };
      }
      const receipt = await receipts.run(key, async () => ({ ...identity, reply: await executeRewind(call) }), REWIND_RECEIPT_RETRY_MS);
      // executeRewind answers every outcome; only an unconfirmed engine call
      // throws, leaving the receipt open for the same request's next call.
      if (!receipt.ok) return { ok: false, error: receipt.error === "operation_interrupted" ? "operation_interrupted" : "operation_pending" };
      return storedReply(receipt.result) ?? { ok: false, error: "engine_failed" };
    }
    if (method === "history.fork") {
      const call = historyBotForkCallSchema.parse(raw);
      const identity = { conversationId: call.conversationId, targetConversationId: call.targetConversationId, throughMessageId: call.throughMessageId ?? null };
      // No retry window: a fork interrupted mid-way may have created a session.
      const receipt = await receipts.run(`history.fork:${call.userId}:${call.requestId}`, async () => ({ ...identity, reply: await executeFork(call) }));
      if (!receipt.ok) return { ok: false, error: receipt.error === "operation_interrupted" ? "operation_interrupted" : "engine_failed" };
      const stored = z.object({ conversationId: idSchema, targetConversationId: idSchema, throughMessageId: idSchema.nullable(), reply: historyBotForkReplySchema }).safeParse(receipt.result);
      if (!stored.success) return { ok: false, error: "engine_failed" };
      return stored.data.conversationId === identity.conversationId && stored.data.targetConversationId === identity.targetConversationId && stored.data.throughMessageId === identity.throughMessageId
        ? stored.data.reply : { ok: false, error: "history_changed" };
    }
    throw new Error("unknown_gateway_call");
  };
}
