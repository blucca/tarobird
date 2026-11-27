import { nativeQuotaReplySchema, quotaDirectorySchema, quotaEngineSchema, quotaScopeSchema, type QuotaScope } from "../client-protocol/engine-quota.js";
import { unavailableQuota } from "../codex/account-quota.js";
import { HubError } from "./errors.js";

type Bot = { id: string; name: string; engine: string; role?: string; deletedAt?: number };
export function hubEngineQuotas(options: {
  bots: () => Promise<Bot[]>;
  connection: (botId: string) => { key: object; supported: boolean; ready: boolean } | undefined;
  call: (botId: string, request: { scopeId: string; refresh: boolean; expectedRevision?: string }) => Promise<unknown>;
  validate: () => Promise<void>;
  /** Opt-in flag for clients that accept `"omp"` in `quotaEngineSchema`; 1.6.0 clients validate a closed 6-engine enum. */
  includeOmp?: boolean;
}) {
  const allowedEngine = (engine: string) => (engine !== "omp" || options.includeOmp === true) && quotaEngineSchema.safeParse(engine).success;
  const list = async () => (await options.bots()).filter(bot => !bot.deletedAt && bot.role !== "worker" && allowedEngine(bot.engine));
  const origins = new WeakMap<QuotaScope, object>();
  const fallback = (bot: Bot, reason: "offline" | "host_upgrade_required" | "timeout" | "invalid_response"): QuotaScope => {
    const engine = quotaEngineSchema.parse(bot.engine);
    return { ...unavailableQuota(engine, reason), id: bot.id, revision: reason, engine,
      label: bot.name.slice(0, 120).replace(/[\x00-\x1f\x7f]/g, " ") || engine,
      botIds: [bot.id], sharing: "unverified" };
  };
  const current = (bot: Bot, value: QuotaScope): QuotaScope => {
    const origin = origins.get(value), connection = options.connection(bot.id);
    return origin && (connection?.key !== origin || !connection.ready || bot.engine !== value.engine)
      ? fallback(bot, "offline") : value;
  };
  const read = async (bot: Bot, refresh = false, revision?: string, deadline?: number): Promise<QuotaScope> => {
    const engine = quotaEngineSchema.parse(bot.engine), initial = options.connection(bot.id);
    if (deadline !== undefined && Date.now() >= deadline) return fallback(bot, "timeout");
    if (!initial?.ready) return fallback(bot, "offline");
    if (!initial.supported) return fallback(bot, "host_upgrade_required");
    await options.validate();
    try {
      const result = nativeQuotaReplySchema.parse(await options.call(bot.id, { scopeId: bot.id, refresh, ...(revision ? { expectedRevision: revision } : {}) }));
      await options.validate();
      if (options.connection(bot.id)?.key !== initial.key) return fallback(bot, "offline");
      if (result.scopeId !== bot.id || result.value.id !== bot.id || result.value.engine !== engine || result.revision !== result.value.revision
        || result.value.botIds.length !== 1 || result.value.botIds[0] !== bot.id) return fallback(bot, "invalid_response");
      // The owner directory is authoritative for labels and Bot membership.
      const value = quotaScopeSchema.parse({ ...result.value, label: fallback(bot, "offline").label, sharing: "unverified" });
      origins.set(value, initial.key); return value;
    } catch (error) {
      await options.validate();
      if (error instanceof HubError && (error.status === 401 || error.status === 403)) throw error;
      return fallback(bot, error instanceof HubError && error.code === "bot_timeout" ? "timeout" : "invalid_response");
    }
  };
  return {
    async directory() {
      const bots = await list(), scopes: QuotaScope[] = [], deadline = Date.now() + 5_000;
      // Bound concurrent worker reads. These are cache-only; none launches a CLI.
      for (let i = 0; i < Math.min(bots.length, 256); i += 4) scopes.push(...await Promise.all(bots.slice(i, Math.min(i + 4, 256)).map(bot => read(bot, false, undefined, deadline))));
      const visible = new Map((await list()).map(bot => [bot.id, bot]));
      await options.validate();
      return quotaDirectorySchema.parse({ generatedAt: new Date().toISOString(), scopes: scopes.filter(scope => visible.has(scope.id)).map(scope => current(visible.get(scope.id)!, scope)), ...(bots.length > 256 ? { truncated: true } : {}) });
    },
    async scope(id: string, refresh: boolean, revision?: string) {
      if (refresh && !revision) throw new HubError("quota_revision_required", 400);
      const bot = (await list()).find(bot => bot.id === id);
      if (!bot) throw new HubError("quota_scope_missing", 404);
      const result = await read(bot, refresh, revision);
      const latest = (await list()).find(bot => bot.id === id);
      if (!latest) throw new HubError("quota_scope_missing", 404);
      await options.validate(); return current(latest, result);
    },
  };
}
