import type { QuotaDirectory, QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { hasUnresetQuotaData, loadSavedQuota, nextHeldQuota, savedQuotaAfter, saveQuota, SAVED_QUOTA_KEY, workerAnswered } from "./usage-readings.js";

/** Shared per-connection quota store so the in-conversation battery and the
 * Settings → Model quotas page always render the exact same reading, including
 * immediately after an App restart from device-local saved readings. */
type StoreEntry = {
  held: Map<string, QuotaScope>;
  saved: Map<string, QuotaScope>;
  hydrated: boolean;
  listeners: Set<() => void>;
};

let stores = new WeakMap<HubConnection, StoreEntry>();

const storage = {
  read: () => { try { return localStorage.getItem(SAVED_QUOTA_KEY); } catch { return null; } },
  write: (value: string) => { try { localStorage.setItem(SAVED_QUOTA_KEY, value); } catch { /* blocked storage */ } },
};

function entryFor(connection: HubConnection, now = Date.now()): StoreEntry {
  let entry = stores.get(connection);
  if (!entry) {
    entry = { held: new Map(), saved: new Map(), hydrated: false, listeners: new Set() };
    stores.set(connection, entry);
  }
  const host = connection.identity.hubPublicKey;
  if (!entry.hydrated && host) {
    entry.saved = loadSavedQuota(storage.read(), host, now);
    entry.hydrated = true;
  }
  return entry;
}

function notify(entry: StoreEntry): void {
  for (const listener of entry.listeners) listener();
}

export function subscribeQuotaStore(connection: HubConnection, listener: () => void): () => void {
  const entry = entryFor(connection);
  entry.listeners.add(listener);
  return () => { entry.listeners.delete(listener); };
}

/** Returns the best known reading for a Bot right now. A persisted reading from an
 * earlier run is returned immediately with `fromCache: true` so the battery shows
 * right away (marked old) before the Host answers. */
export function readStoredQuota(connection: HubConnection, botId: string, now = Date.now()): { scope: QuotaScope; fromCache: boolean } | undefined {
  const entry = entryFor(connection, now);
  const live = entry.held.get(botId);
  if (live) return { scope: live, fromCache: false };
  const cached = entry.saved.get(botId);
  if (cached && hasUnresetQuotaData(cached, now)) return { scope: cached, fromCache: true };
  return undefined;
}

/** Returns all currently held or cached scopes for this connection (used to seed Settings → Model quotas after restart or while offline). */
export function readAllStoredQuotas(connection: HubConnection, now = Date.now()): Map<string, { scope: QuotaScope; fromCache: boolean }> {
  const entry = entryFor(connection, now);
  const out = new Map<string, { scope: QuotaScope; fromCache: boolean }>();
  for (const [id, scope] of entry.saved) {
    if (hasUnresetQuotaData(scope, now)) out.set(id, { scope, fromCache: true });
  }
  for (const [id, scope] of entry.held) {
    out.set(id, { scope, fromCache: false });
  }
  return out;
}

/** Reconciles an incoming Host/worker scope reply with held + persisted readings and persists the result. */
export function applyHostQuotaScope(connection: HubConnection, botId: string, scope: QuotaScope, now = Date.now()): QuotaScope | undefined {
  const entry = entryFor(connection, now);
  const earlier = entry.saved.get(botId);
  const fate = earlier && !entry.held.has(botId) ? savedQuotaAfter(earlier, scope) : "drop";
  if (fate !== "wait") entry.saved.delete(botId);
  const next = nextHeldQuota(entry.held.get(botId) ?? (fate === "adopt" ? earlier : undefined), scope);
  if (next) entry.held.set(botId, next);
  else entry.held.delete(botId);
  const host = connection.identity.hubPublicKey;
  if (host) {
    storage.write(saveQuota(storage.read(), host, new Map([...entry.saved, ...entry.held]), now));
  }
  notify(entry);
  return next;
}

/** Merges a live directory with the shared quota store so Settings → Model quotas
 * keeps showing the last valid reading (marked stale) whenever the worker has not yet
 * returned a fresh reading, and shares any newly read scopes with open conversations. */
export function syncQuotaDirectory(connection: HubConnection, directory: QuotaDirectory, now = Date.now()): QuotaDirectory {
  const scopes = directory.scopes.map((scope) => {
    const held = applyHostQuotaScope(connection, scope.id, scope, now);
    const stored = held ? { scope: held, fromCache: false } : readStoredQuota(connection, scope.id, now);
    if (!scope.observedAt && stored && hasUnresetQuotaData(stored.scope, now)) {
      const canFallback = !workerAnswered(scope) || stored.scope.revision === scope.revision;
      if (canFallback) {
        return {
          ...scope,
          state: "stale" as const,
          availability: stored.scope.availability,
          observedAt: stored.scope.observedAt,
          pools: stored.scope.pools,
          constraints: stored.scope.constraints,
        };
      }
    }
    return scope;
  });
  return { ...directory, scopes };
}

/** Builds a fallback cached directory from persisted readings while loading or offline. */
export function cachedQuotaDirectory(connection: HubConnection, now = Date.now()): QuotaDirectory | undefined {
  const all = readAllStoredQuotas(connection, now);
  if (!all.size) return undefined;
  return {
    generatedAt: new Date(now).toISOString(),
    scopes: [...all.values()].map(({ scope }) => ({ ...scope, state: "stale" as const })),
    truncated: false,
  };
}

/** Test-only helper to clear in-memory WeakMap entries between tests. */
export function resetQuotaStoreForTests(): void {
  stores = new WeakMap<HubConnection, StoreEntry>();
}
