import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextUsage } from "../../src/client-protocol/context-usage.js";
import type { HubConnection } from "./connection.js";
import { applyHostQuotaScope, readStoredQuota, subscribeQuotaStore } from "./quota-store.js";
import {
  contextView,
  mayAskEngine,
  QUOTA_SHOWN_FOR_MS,
  quotaRetryDelayMs,
  quotaView,
  quotaViewNextChangeAt,
  workerAnswered,
  type QuotaAttempt,
} from "./usage-readings.js";

/** The engine is asked for quota again once the shown reading is this old; opening the details asks after a minute. */
const QUOTA_READ_AGAIN_MS = 5 * 60_000, QUOTA_DETAILS_READ_AGAIN_MS = 60_000;
/** Minute tick so stale age labels ("as of 12 min ago") stay accurate while a conversation stays open. */
const QUOTA_AGE_TICK_MS = 60_000;
/** When the engine was last asked per Host and Bot, so a failing read is not repeated at every opened conversation. */
const attempts = new WeakMap<HubConnection, Map<string, QuotaAttempt>>();
/** Consecutive failed/unproductive renewal attempts per Host and Bot, used for background retry backoff. */
const failureCounts = new WeakMap<HubConnection, Map<string, { failures: number; signIn: boolean }>>();

/** Context left in one conversation and quota left for its Bot.
 * A known quota reading stays visible (marked old) past its fresh period until a window resets
 * or a newer reading arrives, and retries in the background with exponential backoff. */
export function useUsageReadings(connection: HubConnection, input: {
  conversationId?: string; botId?: string; model: string;
  /** This user may see the Bot's quota and the Host serves it. */ quota: boolean;
  /** The Host serves context usage and this view shows it. */ context: boolean;
  /** The conversation's newest finished Bot message, once its messages are loaded. A change means a reply has just ended. */ turn: string | undefined;
}) {
  const { conversationId, botId, model, quota, context, turn } = input;
  const [, redraw] = useState(0);
  const [usage, setUsage] = useState<{ key: string; value: ContextUsage }>();
  const key = `${conversationId ?? ""}:${botId ?? ""}`;
  const live = useRef({ connection, key }); live.current = { connection, key };
  // Subscribe to shared quota store so refreshes from Settings → Model quotas or other views update here immediately.
  useEffect(() => {
    if (!quota || !botId) return;
    return subscribeQuotaStore(connection, () => redraw(count => count + 1));
  }, [connection, quota, botId]);

  // One read at a time per conversation; a request that arrives meanwhile runs once afterwards.
  const reading = useRef<{ key: string; again?: number }>(undefined);
  const read = useCallback(async (olderThan: number) => {
    if (!botId) return;
    const current = () => live.current.connection === connection && live.current.key === key;
    if (reading.current?.key === key) { reading.current.again = Math.min(reading.current.again ?? Infinity, olderThan); return; }
    const mine = reading.current = { key } as { key: string; again?: number };
    const readings: Promise<void>[] = [];
    // A context read that fails has no answer: the ring goes rather than keep an old number.
    if (context && conversationId) readings.push(connection.readContextUsage(conversationId, botId).then(value => { if (current()) setUsage({ key, value }); }, () => { if (current()) setUsage(undefined); }));
    if (quota) readings.push((async () => {
      const asked = attempts.get(connection) ?? new Map<string, QuotaAttempt>(); attempts.set(connection, asked);
      const fails = failureCounts.get(connection) ?? new Map<string, { failures: number; signIn: boolean }>(); failureCounts.set(connection, fails);
      const recordFailure = (signIn = false) => {
        const prev = fails.get(botId);
        fails.set(botId, { failures: (prev?.failures ?? 0) + 1, signIn });
      };
      const recordSuccess = () => { fails.set(botId, { failures: 0, signIn: false }); };
      try {
        const before = readStoredQuota(connection, botId, Date.now());
        let scope = await connection.readEngineQuota(botId);
        let held = applyHostQuotaScope(connection, botId, scope, Date.now());
        const nowAfterRead = Date.now();
        const isFreshNow = !!held?.observedAt && held.state === "ready" && (nowAfterRead - Date.parse(held.observedAt)) < QUOTA_SHOWN_FOR_MS;
        if (mayAskEngine(scope, held, asked.get(botId), nowAfterRead, olderThan)) {
          asked.set(botId, { revision: scope.revision, at: nowAfterRead, signIn: false });
          scope = await connection.refreshEngineQuota(scope);
          held = applyHostQuotaScope(connection, botId, scope, Date.now());
          if (scope.state === "login_required") {
            asked.set(botId, { revision: scope.revision, at: Date.now(), signIn: true });
            recordFailure(true);
          } else if (scope.observedAt && scope.state === "ready" && (!before?.scope.observedAt || scope.observedAt >= before.scope.observedAt)) {
            recordSuccess();
          } else {
            recordFailure(false);
          }
        } else if (!workerAnswered(scope)) {
          recordFailure(false);
        } else if (scope.state === "login_required") {
          recordFailure(true);
        } else if (isFreshNow) {
          recordSuccess();
        } else if (scope.capability.mode === "passive" && !isFreshNow) {
          // Passive engines update when used; keep retrying gently so passive updates picked up on the Host show up.
          recordFailure(false);
        }
      } catch {
        recordFailure(false);
      } finally { if (current()) redraw(count => count + 1); }
    })());
    await Promise.allSettled(readings);
    if (reading.current === mine) reading.current = undefined;
    // The request that waited runs with the view's current settings, not the ones this read started with.
    if (mine.again !== undefined && current()) void latest.current(mine.again);
  }, [connection, conversationId, botId, key, quota, context]);

  const latest = useRef(read); latest.current = read;
  useEffect(() => { void read(QUOTA_READ_AGAIN_MS); }, [read]);

  const seen = useRef<{ key: string; turn: string | undefined }>(undefined);
  useEffect(() => {
    const previous = seen.current; seen.current = { key, turn };
    if (previous?.key === key && previous.turn !== undefined && turn !== undefined && previous.turn !== turn) void read(QUOTA_READ_AGAIN_MS);
  }, [key, turn, read]);

  const now = Date.now();
  const stored = quota && botId ? readStoredQuota(connection, botId, now) : undefined;
  const quotaReading = stored ? quotaView(stored.scope, model, now, { fromCache: stored.fromCache }) : undefined;

  // Keep trying in the background with exponential backoff while this conversation stays open.
  const failState = botId ? failureCounts.get(connection)?.get(botId) : undefined;
  const failCount = failState?.failures ?? 0;
  const signInBackoff = failState?.signIn ?? false;
  useEffect(() => {
    if (!quota || !botId) return;
    const delay = quotaRetryDelayMs(failCount, signInBackoff);
    const retryOlderThan = failCount > 0 ? Math.min(QUOTA_READ_AGAIN_MS, delay) : QUOTA_READ_AGAIN_MS;
    const timer = setTimeout(() => { void latest.current(retryOlderThan); }, delay);
    return () => clearTimeout(timer);
  }, [quota, botId, failCount, signInBackoff, quotaReading?.observedAt, quotaReading?.stale]);

  // Redraw at fresh→stale boundary, window reset, or every minute while stale so age text stays current.
  const nextChangeAt = quotaReading ? quotaViewNextChangeAt(quotaReading) : undefined;
  useEffect(() => {
    if (!quotaReading || nextChangeAt === undefined) return;
    const untilChange = Math.max(0, nextChangeAt - Date.now()) + 50;
    const wait = quotaReading.stale ? Math.min(untilChange, QUOTA_AGE_TICK_MS) : untilChange;
    const timer = setTimeout(() => redraw(count => count + 1), wait);
    return () => clearTimeout(timer);
  }, [quotaReading?.observedAt, quotaReading?.stale, nextChangeAt]);

  return {
    context: context && usage?.key === key ? contextView(usage.value) : undefined,
    quota: quotaReading,
    /** The details were opened: take a newer reading if the shown one is over a minute old. */
    readForDetails: useCallback(() => { void read(QUOTA_DETAILS_READ_AGAIN_MS); }, [read]),
  };
}
