import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextUsage } from "../../src/client-protocol/context-usage.js";
import type { QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { contextView, loadSavedQuota, mayAskEngine, nextHeldQuota, quotaView, quotaViewEndsAt, savedQuotaAfter, saveQuota, SAVED_QUOTA_KEY, type QuotaAttempt } from "./usage-readings.js";

/** The engine is asked for quota again only once the shown reading is this old; opening the details asks after a minute.
 * There is no timer: a reading is taken when a conversation opens and when a reply ends. */
const QUOTA_READ_AGAIN_MS = 5 * 60_000, QUOTA_DETAILS_READ_AGAIN_MS = 60_000;
/** The last quota reading per Host and Bot, so a Bot's battery is there when another of its conversations opens. */
const held = new WeakMap<HubConnection, Map<string, QuotaScope>>();
/** Readings saved on this device by an earlier run of the App. One is shown only after its Bot's worker has
 * answered that the login is still the same; until then it waits here. */
const saved = new WeakMap<HubConnection, Map<string, QuotaScope>>();
const storage = { read: () => { try { return localStorage.getItem(SAVED_QUOTA_KEY); } catch { return null; } }, write: (value: string) => { try { localStorage.setItem(SAVED_QUOTA_KEY, value); } catch { /* a full or blocked store only loses the saved copy */ } } };
/** When the engine was last asked per Host and Bot, so a failing read is not repeated at every opened conversation. */
const attempts = new WeakMap<HubConnection, Map<string, QuotaAttempt>>();

/** Context left in one conversation and quota left for its Bot. Each is absent when it cannot be read. */
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
      const store = held.get(connection) ?? new Map<string, QuotaScope>(); held.set(connection, store);
      const asked = attempts.get(connection) ?? new Map<string, QuotaAttempt>(); attempts.set(connection, asked);
      // Readings are saved per Host by its public key; a connection without one saves nothing.
      const host = connection.identity.hubPublicKey;
      const waiting = saved.get(connection) ?? (host ? loadSavedQuota(storage.read(), host, Date.now()) : new Map<string, QuotaScope>()); saved.set(connection, waiting);
      const keep = (scope: QuotaScope) => {
        const earlier = waiting.get(botId), fate = earlier && !store.has(botId) ? savedQuotaAfter(earlier, scope) : "drop";
        if (fate !== "wait") waiting.delete(botId);
        const next = nextHeldQuota(store.get(botId) ?? (fate === "adopt" ? earlier : undefined), scope);
        if (next) store.set(botId, next); else store.delete(botId);
        // A reading still waiting for its worker stays saved; everything else follows what is held now.
        if (host) storage.write(saveQuota(storage.read(), host, new Map([...waiting, ...store]), Date.now()));
      };
      try {
        let scope = await connection.readEngineQuota(botId); keep(scope);
        if (mayAskEngine(scope, store.get(botId), asked.get(botId), Date.now(), olderThan)) {
          asked.set(botId, { revision: scope.revision, at: Date.now(), signIn: false });
          scope = await connection.refreshEngineQuota(scope); keep(scope);
          if (scope.state === "login_required") asked.set(botId, { revision: scope.revision, at: Date.now(), signIn: true });
        }
      } finally { if (current()) redraw(count => count + 1); }
    })());
    // A failed quota read leaves the held reading; that one goes away by its own age rule.
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
  const quotaReading = quota && botId ? quotaView(held.get(connection)?.get(botId), model, Date.now()) : undefined;
  const endsAt = quotaReading ? quotaViewEndsAt(quotaReading) : undefined;
  useEffect(() => {
    if (endsAt === undefined) return;
    const timer = setTimeout(() => redraw(count => count + 1), Math.max(0, endsAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [endsAt]);
  return {
    context: context && usage?.key === key ? contextView(usage.value) : undefined,
    quota: quotaReading,
    /** The details were opened: take a newer reading if the shown one is over a minute old. */
    readForDetails: useCallback(() => { void read(QUOTA_DETAILS_READ_AGAIN_MS); }, [read]),
  };
}
