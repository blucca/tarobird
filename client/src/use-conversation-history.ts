import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HistoryStatus } from "../../src/client-protocol/history.js";
import type { Bot, HubConnection } from "./connection.js";
import { isDispatcher } from "./dispatcher.js";
import { timeoutSignal } from "./abort-signals.js";

type CacheEntry = {
  status?: HistoryStatus;
  stale: boolean;
  inflight?: Promise<HistoryStatus | undefined>;
  version: number;
};

/** Per-connection history status cache (§4.3):
 * - Never probes when the Hub lacks `conversations.history.v1`.
 * - Fetches once on conversation open, caches per (conversation, bot).
 * - Marks stale on `turn.state`, `conversation.updated`, non-stream message
 *   events, `bot.status`, reconnects, and snapshots.
 * - Opening a menu renders from cache immediately and refreshes in the
 *   background if stale; failed fetches behave as unsupported and stay stale. */
export function useConversationHistory(input: {
  connection: HubConnection;
  conversation?: Conversation;
  bot?: Bot;
  dispatchWorker?: boolean;
  historyAvailable: boolean;
  online: boolean;
  active: boolean;
}) {
  const { connection, conversation, bot, dispatchWorker, historyAvailable, online, active } = input;
  const cacheRef = useRef<WeakMap<HubConnection, Map<string, CacheEntry>>>(new WeakMap());
  const store = useMemo(() => {
    let map = cacheRef.current.get(connection);
    if (!map) { map = new Map(); cacheRef.current.set(connection, map); }
    return map;
  }, [connection]);

  const conversationId = conversation?.id ?? "";
  const botId = conversation?.botIds.length === 1 ? conversation.botIds[0]! : "";
  const eligible = !!conversation
    && historyAvailable
    && conversation.type === "direct"
    && !conversation.parentId
    && !conversation.archived
    && !conversation.hidden
    && !conversation.ticket
    && conversation.botIds.length === 1
    && !isDispatcher(bot)
    && !dispatchWorker
    && !bot?.deletedAt;

  const scopeKey = eligible && conversationId && botId ? `${conversationId}\0${botId}` : "";
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick(n => n + 1), []);
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);

  const fetchStatus = useCallback((force = false): Promise<HistoryStatus | undefined> => {
    if (!eligible || !online || !scopeKey || !conversationId || !botId || connection.isReadOnly) {
      return Promise.resolve(undefined);
    }
    let entry = store.get(scopeKey);
    if (!entry) {
      entry = { stale: true, version: 0 };
      store.set(scopeKey, entry);
    }
    if (!force && !entry.stale) return Promise.resolve(entry.status);
    if (entry.inflight) return entry.inflight;
    const startedVersion = ++entry.version;
    const work = connection.historyStatus(conversationId, botId, timeoutSignal(15_000))
      .then(status => {
        if (entry!.version === startedVersion) {
          entry!.status = status;
          entry!.stale = false;
        }
        return status;
      })
      .catch(() => {
        // §4.3: treat failures (e.g. bot_offline) as no capability; retry next menu open.
        if (entry!.version === startedVersion) {
          entry!.status = undefined;
          entry!.stale = true;
        }
        return undefined;
      })
      .finally(() => {
        if (entry!.inflight === work) entry!.inflight = undefined;
        if (aliveRef.current) bump();
      });
    entry.inflight = work;
    return work;
  }, [eligible, online, scopeKey, conversationId, botId, connection, store, bump]);

  // Mark cached status stale when the Hub emits `turn.state`, `conversation.updated`,
  // reconnects, or updates Bot online status.
  useEffect(() => {
    return connection.subscribeHistoryInvalidation(targetConversationId => {
      if (!targetConversationId) {
        for (const entry of store.values()) { entry.stale = true; entry.version++; }
      } else {
        for (const [key, entry] of store.entries()) {
          if (key.startsWith(`${targetConversationId}\0`)) { entry.stale = true; entry.version++; }
        }
      }
    });
  }, [connection, store]);

  // Fetch once when opening an eligible conversation (or when coming online / Bot changes engine).
  const runtimeKey = `${bot?.engine ?? ""}:${bot?.online ?? 0}`;
  useEffect(() => {
    if (!active || !eligible || !online || !scopeKey) return;
    const entry = store.get(scopeKey);
    if (!entry || entry.stale) void fetchStatus(false);
  }, [active, eligible, online, scopeKey, runtimeKey, store, fetchStatus]);

  const refreshIfStale = useCallback(() => {
    if (!eligible || !online || !scopeKey) return;
    const entry = store.get(scopeKey);
    if (!entry || entry.stale) void fetchStatus(false);
  }, [eligible, online, scopeKey, store, fetchStatus]);

  const invalidate = useCallback((refresh = false) => {
    if (!scopeKey) return;
    const entry = store.get(scopeKey);
    if (entry) { entry.stale = true; entry.version++; }
    if (refresh && eligible && online) void fetchStatus(true);
  }, [scopeKey, store, eligible, online, fetchStatus]);

  const status = scopeKey ? store.get(scopeKey)?.status : undefined;
  return { status, eligible, botId, refreshIfStale, invalidate };
}
