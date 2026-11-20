import { z } from "zod";

/**
 * Conversation history operations (#53): rewind (drop a user message and
 * everything after it from the engine's context) and fork (copy history into
 * a new conversation). Only engines whose CLI exposes a documented,
 * programmatic operation take part; the rest report `none` and the App shows
 * no entry.
 *
 * Capability layers:
 * - Hub: HISTORY_CAPABILITY in `ready.serverCapabilities` only. Never add it
 *   to the shared CAPABILITIES list: that is also the App `hello` list, which
 *   released Hubs cap at 64 entries.
 * - Gateway: HISTORY_CAPABILITY in `instance.hello.capabilities`.
 * - Conversation: `GET /api/conversations/:id/history`.
 */
export const HISTORY_CAPABILITY = "conversations.history.v1";
export const HISTORY_REWIND_CALL_MS = 60_000;
export const HISTORY_FORK_CALL_MS = 120_000;
/** A `started` operation with no answer this long becomes `unknown` and stops blocking dispatch. */
export const HISTORY_UNKNOWN_AFTER_MS = 10 * 60_000;
export const HISTORY_REWIND_RANGES_MAX = 64;
export const HISTORY_FORK_EXCERPT_MAX = 200;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const at = z.number().int().nonnegative();

/** Business outcomes returned in a 200 receipt. Permission, argument and
 * not-found problems stay HubError (403 / 400 / 404). */
export const historyErrorSchema = z.enum([
  "unsupported",      // engine, version or this thread cannot do it
  "busy",             // a turn, queue, pending question/approval, background work or another operation
  "goal_active",      // an unfinished /goal
  "no_main_session",  // no real engine session yet
  "history_changed",  // expectedLastMessageId no longer matches
  "not_an_anchor",    // the message did not start a run (steering, command, cancelled queue)
  "already_rewound",  // the target is inside an existing rewind range
  "session_changed",  // the message belongs to an earlier engine session
  "turn_unresolved",  // an older message could not be matched to an engine turn
  "engine_busy",      // the engine refused: the thread is held by another client
  "engine_failed",    // the engine explicitly failed
  "uncertain",        // fork interrupted mid-way; no conversation was created
]);
export type HistoryError = z.infer<typeof historyErrorSchema>;

/** One completed rewind. Messages whose Hub `createdAt` falls inside
 * [fromCreatedAt, throughCreatedAt] no longer enter the context. Ranges only
 * grow; an engine rewind cannot be undone. */
export const rewindRangeSchema = z.object({
  id,
  fromMessageId: id, fromCreatedAt: at,
  throughMessageId: id, throughCreatedAt: at,
  at, by: id,
}).strict();
export type RewindRange = z.infer<typeof rewindRangeSchema>;

/** Where a forked conversation came from. A snapshot: renaming the source later does not change it. */
export const forkOriginSchema = z.object({
  opId: id,
  conversationId: id,
  title: z.string().max(256),
  /** turn: through the run of `throughMessageId`; head: the whole history at fork time. */
  mode: z.enum(["turn", "head"]),
  throughMessageId: id.optional(),
  excerpt: z.string().max(HISTORY_FORK_EXCERPT_MAX),
  at,
}).strict();
export type ForkOrigin = z.infer<typeof forkOriginSchema>;

/** Optional on `conversationSchema`; older Apps drop it and simply show no marks. */
export const conversationHistorySchema = z.object({
  rewinds: z.array(rewindRangeSchema).max(HISTORY_REWIND_RANGES_MAX).optional(),
  forkedFrom: forkOriginSchema.optional(),
}).strict();
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;

export const historyOperationSchema = z.object({
  id, requestId: id,
  kind: z.enum(["rewind", "fork"]),
  state: z.enum(["started", "completed", "failed", "unknown"]),
  error: historyErrorSchema.optional(),
  /** Completed rewind. */
  rewind: rewindRangeSchema.optional(),
  /** Completed fork: the new conversation. */
  conversationId: id.optional(),
  /** Same (userId, requestId, payload) seen before: the stored receipt, engine not called again. */
  replayed: z.boolean().optional(),
}).strict();
export type HistoryOperation = z.infer<typeof historyOperationSchema>;

export const historyBlockedSchema = z.enum(["running", "queued", "pending_action", "goal_active", "background_work", "operation_active", "no_main_session"]);
export const historyUnavailableSchema = z.enum(["unsupported", "conversation_kind", "archived", "dispatcher", "legacy_history", "external_session"]);

/** `GET /api/conversations/:id/history?botId=`. `blocked` is temporary; `reason` disables the whole conversation. */
export const historyStatusSchema = z.object({
  supported: z.boolean(),
  rewind: z.enum(["turn", "none"]),
  fork: z.enum(["turn", "head", "none"]),
  blocked: historyBlockedSchema.optional(),
  reason: historyUnavailableSchema.optional(),
  /** First message of the current engine session; earlier messages cannot be anchors. */
  sinceMessageId: id.optional(),
  operation: historyOperationSchema.optional(),
}).strict();
export type HistoryStatus = z.infer<typeof historyStatusSchema>;

/** `POST /api/conversations/:id/history/rewind`: this user message and everything after it leave the context. */
export const historyRewindSchema = z.object({
  botId: id, requestId: id,
  beforeMessageId: id,
  /** Last message the client saw when the confirmation opened. */
  expectedLastMessageId: id,
}).strict();
export type HistoryRewindRequest = z.infer<typeof historyRewindSchema>;

/** `POST /api/conversations/:id/history/fork`. Omitted `throughMessageId` forks the whole history. */
export const historyForkSchema = z.object({
  botId: id, requestId: id,
  throughMessageId: id.optional(),
  expectedLastMessageId: id,
  title: z.string().min(1).max(256).optional(),
}).strict();
export type HistoryForkRequest = z.infer<typeof historyForkSchema>;

// ---------------------------------------------------------------- Hub ⇄ Gateway

/** Hub-side facts for matching an older run (no ledger line) to engine turns. */
const runHintSchema = z.object({ sourceMessageId: id, text: z.string().max(200_000), createdAt: at, startedAt: at.optional() }).strict();
export const historyHintsSchema = z.object({ target: runHintSchema, next: runHintSchema.optional() }).strict();
export type HistoryHints = z.infer<typeof historyHintsSchema>;

export const historyBotStatusCallSchema = z.object({ conversationId: id, userId: id }).strict();
/** Gateway answer for `history.status`; the Hub adds queue/operation blocks and `operation`. */
export const historyBotStatusSchema = historyStatusSchema.omit({ operation: true });

export const historyBotRewindCallSchema = z.object({
  conversationId: id, userId: id, requestId: id,
  beforeMessageId: id,
  /** The range's right edge, fixed when the operation started. The Gateway
   * records it with the rewind, so a later request that finds the anchor
   * already gone can still say where that earlier rewind ended. */
  throughMessageId: id.optional(),
  hints: historyHintsSchema.optional(),
  /** Retry of an expired rewind after later input already ran: answer this
   * request's stored success only, never execute. Executing now would also
   * drop turns the range does not cover; without a stored success the answer
   * is `history_changed`. */
  replayOnly: z.literal(true).optional(),
}).strict();
export const historyBotForkCallSchema = z.object({
  conversationId: id, userId: id, requestId: id,
  /** Reserved by the Hub; the Gateway writes this conversation's session record. */
  targetConversationId: id,
  throughMessageId: id.optional(),
  hints: historyHintsSchema.optional(),
}).strict();

/** Gateway-only. `operation_interrupted`: a fork receipt left `running` by a
 * crash; the Hub records it as `uncertain`. `operation_pending`: the engine
 * has not confirmed a rewind either way (e.g. `thread/revert` timed out with
 * the turn still listed); the Hub keeps the operation `started` and asks
 * again with the same requestId. */
export const historyBotErrorSchema = z.union([historyErrorSchema, z.literal("operation_interrupted"), z.literal("operation_pending")]);
export const historyBotRewindReplySchema = z.discriminatedUnion("ok", [
  /** `throughMessageId`: the anchor's turn was already gone (an earlier
   * rewind of it landed); its range ends there, not at this request's edge. */
  z.object({ ok: z.literal(true), restarted: z.literal(true).optional(), throughMessageId: id.optional() }).strict(),
  z.object({ ok: z.literal(false), error: historyBotErrorSchema }).strict(),
]);
export const historyBotForkReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), mode: z.enum(["turn", "head"]) }).strict(),
  z.object({ ok: z.literal(false), error: historyBotErrorSchema }).strict(),
]);

// ---------------------------------------------------------------- Gateway ledger

/** Engine position marker; only the adapter interprets it. Codex: turn ids; DeepSeek: event sequence. */
export const engineHistoryAnchorSchema = z.object({
  firstTurnId: z.string().min(1).max(200).optional(),
  lastTurnId: z.string().min(1).max(200).optional(),
  endSeq: z.number().int().nonnegative().optional(),
}).strict();
export type EngineHistoryAnchor = z.infer<typeof engineHistoryAnchorSchema>;

/** One line of `<stateDir>/history-ledger/<sha256(conversationKey)>.jsonl`, appended
 * at run start, on turn changes and at run end. The last line per `runId` wins. */
export const historyLedgerLineSchema = z.object({
  v: z.literal(1),
  sourceMessageId: id,
  runId: z.string().min(1).max(200),
  engine: z.enum(["codex", "claude", "kimi", "deepseek", "antigravity"]),
  /** Lines of another engine session no longer apply. */
  sessionId: z.string().min(1).max(200),
  anchor: engineHistoryAnchorSchema.optional(),
  startedAt: at,
  endedAt: at.optional(),
  /** "ok" or "failed:<FailureCategory>"; feeds the upstream-rejection streak. */
  outcome: z.string().max(80).regex(/^(?:ok|failed:[a-z-]{1,60})$/).optional(),
}).strict();
export type HistoryLedgerLine = z.infer<typeof historyLedgerLineSchema>;

/** A rewind about to be sent to the engine, appended to the same ledger file
 * right before the engine call (and only when the anchor's turn is still
 * there). Readers of run lines skip it. */
export const historyLedgerRewindLineSchema = z.object({
  v: z.literal(1),
  kind: z.literal("rewind"),
  requestId: id,
  sessionId: z.string().min(1).max(200),
  /** The anchor: its run and everything after it leave the session. */
  fromMessageId: id,
  /** The Hub's right edge for this rewind (`historyBotRewindCallSchema`). */
  throughMessageId: id.optional(),
  at,
}).strict();
export type HistoryLedgerRewindLine = z.infer<typeof historyLedgerRewindLineSchema>;

/** On a failed run card's `extra` (outside strict `nativeRun`): the chat keeps
 * failing as an invalid request. `firstMessageId` is the suggested rewind point. */
export const upstreamRejectionSchema = z.object({
  v: z.literal(1),
  streak: z.number().int().min(2).max(1000),
  firstMessageId: id,
}).strict();
export type UpstreamRejection = z.infer<typeof upstreamRejectionSchema>;
