import { hostEngineSchema, type HostEngine } from "../client-protocol/engine-settings.js";
import { engineQuotaViewSchema, type EngineQuotaEntry, type EngineQuotaView } from "../client-protocol/engine-quota.js";
import { readAgyVersion, readAntigravityQuota, readCodexQuota, type QuotaReaderOptions, type QuotaReading } from "../runtime/engine-quota-readers.js";
import { claudeQuotaFromEvents, readEngineQuotaEvents } from "../runtime/engine-quota-events.js";

/** Engines read by an active, turn-free query. Claude is passive (events from
 * normal turns); Kimi and DeepSeek are not adapted yet and say so. */
const ACTIVE = ["codex", "antigravity"] as const satisfies readonly HostEngine[];
type ActiveEngine = typeof ACTIVE[number];
const NOT_ADAPTED: readonly HostEngine[] = ["kimi", "deepseek"];
/** Two owner devices tapping refresh share one read; no engine is asked more often. */
export const QUOTA_MIN_INTERVAL_MS = 30_000;
/** Opening the view refreshes in the background when the last read is older. */
export const QUOTA_BACKGROUND_AFTER_MS = 5 * 60_000;
export const QUOTA_REFRESH_WAIT_MS = 10_000;

export type QuotaReaders = {
  codex: (options: QuotaReaderOptions) => Promise<QuotaReading>;
  antigravity: (options: QuotaReaderOptions & { version?: string }) => Promise<QuotaReading>;
  agyVersion: (options: QuotaReaderOptions) => Promise<string | undefined>;
};
export type QuotaSources = {
  /** Resolved engine executables, the same view as the engine settings page. */
  engines: () => Array<{ id: HostEngine; executable: string | null }>;
  /** Environment Bots are launched with, including engine path settings. */
  env: () => NodeJS.ProcessEnv;
  /** Managed Bots on this Host. */
  bots: () => Promise<Array<{ id: string; name: string; engine: string }>>;
  botStateDir: (botId: string) => string;
  now?: () => number;
  readers?: Partial<QuotaReaders>;
};
type Cached = { reading: QuotaReading; updatedAt?: number; checkedAt: number };

/**
 * Owner-only quota view for this Host's own engine logins. Reads go through
 * each CLI's documented read-only channel; the App receives only the parsed
 * summary. One entry per engine covers the Host's shared login, which managed
 * Bots copy into their engine homes.
 */
export class HubEngineQuota {
  private readonly cache = new Map<ActiveEngine, Cached>();
  private running?: Promise<void>;
  private readonly readers: QuotaReaders;
  constructor(private readonly sources: QuotaSources) {
    this.readers = { codex: readCodexQuota, antigravity: readAntigravityQuota, agyVersion: readAgyVersion, ...sources.readers };
  }
  private now() { return this.sources.now?.() ?? Date.now(); }

  /** Cached view; starts a background read when the cache is old. */
  async view(): Promise<EngineQuotaView> {
    const now = this.now();
    if (ACTIVE.some(engine => (this.cache.get(engine)?.checkedAt ?? 0) + QUOTA_BACKGROUND_AFTER_MS <= now)) void this.read().catch(() => undefined);
    return this.compose();
  }

  /** Explicit refresh: waits a bounded time, then answers with what is known. */
  async refresh(waitMs = QUOTA_REFRESH_WAIT_MS): Promise<EngineQuotaView> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.read().catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); timer.unref(); })]);
    clearTimeout(timer);
    return this.compose();
  }

  /** Single flight: concurrent callers join the read already running. */
  private read(): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      const engines = this.sources.engines(), env = this.sources.env();
      await Promise.all(ACTIVE.map(async engine => {
        const executable = engines.find(item => item.id === engine)?.executable;
        if (!executable) { this.cache.delete(engine); return; }
        const previous = this.cache.get(engine);
        if (previous && this.now() - previous.checkedAt < QUOTA_MIN_INTERVAL_MS) return;
        const options = { executable, env };
        let reading: QuotaReading;
        try { reading = engine === "codex" ? await this.readers.codex(options) : await this.readers.antigravity({ ...options, version: await this.readers.agyVersion(options) }); }
        catch { reading = { status: "error", reason: "upstream_error", windows: [], balances: [] }; }
        const checkedAt = this.now();
        if (reading.status === "ok" || reading.status === "exhausted") this.cache.set(engine, { reading, updatedAt: checkedAt, checkedAt });
        // A transient failure keeps the last good numbers, labelled with their age.
        else if (reading.status === "error" && previous?.updatedAt) this.cache.set(engine, { reading: { ...previous.reading, status: "error", ...(reading.reason ? { reason: reading.reason } : {}) }, updatedAt: previous.updatedAt, checkedAt });
        // Logged out, API-key mode, unsupported: the old numbers no longer apply.
        else this.cache.set(engine, { reading, checkedAt });
      }));
    })().finally(() => { if (this.running === run) this.running = undefined; });
    this.running = run;
    return run;
  }

  private async compose(): Promise<EngineQuotaView> {
    const now = this.now(), engines = this.sources.engines();
    const bots = await this.sources.bots().catch(() => []);
    const entries: EngineQuotaEntry[] = [];
    for (const engine of hostEngineSchema.options) {
      const executable = engines.find(item => item.id === engine)?.executable ?? null;
      const users = bots.filter(bot => bot.engine === engine).slice(0, 256).map(bot => ({ id: bot.id, name: bot.name.slice(0, 200) || bot.id }));
      if (!executable && !users.length) continue;
      const base = { id: `${engine}:default`, engine, bots: users };
      if (!executable) { entries.push({ ...base, status: "engine_missing", windows: [], balances: [] }); continue; }
      if (NOT_ADAPTED.includes(engine)) { entries.push({ ...base, status: "not_adapted", windows: [], balances: [] }); continue; }
      if (engine === "claude") {
        const reading = claudeQuotaFromEvents(await Promise.all(users.map(bot => readEngineQuotaEvents(this.sources.botStateDir(bot.id)))), now);
        entries.push({ ...base, status: reading.status, source: "event", windows: reading.windows, balances: [], ...(reading.updatedAt ? { updatedAt: reading.updatedAt } : {}) });
        continue;
      }
      const cached = this.cache.get(engine as ActiveEngine);
      if (!cached) { entries.push({ ...base, status: "unknown", source: "query", windows: [], balances: [] }); continue; }
      const { reading } = cached;
      entries.push({ ...base, status: reading.status, ...(reading.reason ? { reason: reading.reason } : {}), source: "query", ...(reading.plan ? { plan: reading.plan } : {}),
        windows: reading.windows, balances: reading.balances, ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {}), checkedAt: cached.checkedAt });
    }
    return engineQuotaViewSchema.parse({ generatedAt: now, refreshing: !!this.running, entries });
  }
}
