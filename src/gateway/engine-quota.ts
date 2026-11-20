import { randomUUID } from "node:crypto";
import { nativeQuotaRequestSchema, nativeQuotaReplySchema, quotaReadingExpired, quotaSnapshotSchema, type QuotaEngine, type QuotaSnapshot } from "../client-protocol/engine-quota.js";
import { unavailableQuota } from "../codex/account-quota.js";
import type { EngineQuotaReadResult, EngineQuotaReadOptions } from "../codex/adapter.js";

/** No credentials or account proof leave the worker. In particular, equal HOME
 * paths are not evidence that two Bots share an account. */
export function gatewayEngineQuota(options: {
  botId: string; engine: QuotaEngine;
  read?: (options: EngineQuotaReadOptions) => Promise<EngineQuotaReadResult | undefined>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now, unsupportedRevision = randomUUID();
  let active: Promise<EngineQuotaReadResult> | undefined;
  let activeRevision: string | undefined;
  let refreshRevision: string | undefined;
  let nextRefreshAt = 0;
  const read = async (refresh: boolean, expectedRevision?: string): Promise<EngineQuotaReadResult> => {
    if (!options.read) return { revision: unsupportedRevision, snapshot: unavailableQuota(options.engine, "not_adapted", now()) };
    const signal = AbortSignal.timeout(refresh ? 7_500 : 2_000);
    // A cancelled read must not stop a chatting worker. Native adapters own
    // their helpers and are responsible for observing this deadline.
    return await options.read({ refresh, ...(expectedRevision ? { expectedRevision } : {}), signal, timeoutMs: refresh ? 7_000 : 1_500 })
      ?? { revision: unsupportedRevision, snapshot: unavailableQuota(options.engine, "not_adapted", now()) };
  };
  return async (raw: unknown) => {
    const request = nativeQuotaRequestSchema.parse(raw);
    if (request.scopeId !== options.botId || request.refresh && !request.expectedRevision) throw new Error("quota_request_invalid");
    // Read the current credential/configuration generation even on a cache hit.
    // Do not return a prior account's cache after a login or worker change.
    let result = await read(false);
    if (refreshRevision !== result.revision) { nextRefreshAt = 0; refreshRevision = result.revision; }
    if (request.expectedRevision && result.revision !== request.expectedRevision) {
      result = { revision: result.revision, snapshot: unavailableQuota(options.engine, "auth_changed", now()) };
    } else if (request.refresh && result.snapshot.capability.mode === "active") {
      if (!active && now() >= nextRefreshAt) {
        nextRefreshAt = now() + 60_000;
        const current = read(true, result.revision);
        active = current;
        activeRevision = result.revision;
        void current.finally(() => { if (active === current) { active = undefined; activeRevision = undefined; } }).catch(() => undefined);
      }
      if (active && activeRevision === result.revision) result = await active;
    }
    const snapshot: QuotaSnapshot = quotaSnapshotSchema.parse(result.snapshot);
    if (snapshot.state === "ready" && quotaReadingExpired(snapshot, now())) snapshot.state = "stale";
    if (snapshot.capability.mode === "active" && nextRefreshAt > now()) snapshot.nextRefreshAt = new Date(nextRefreshAt).toISOString();
    return nativeQuotaReplySchema.parse({ scopeId: options.botId, revision: result.revision,
      value: { ...snapshot, id: options.botId, revision: result.revision, engine: options.engine, label: options.engine,
        botIds: [options.botId], sharing: "unverified" } });
  };
}
