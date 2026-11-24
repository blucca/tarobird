import { StringDecoder } from "node:string_decoder";
import {
  ENGINE_QUOTA_REFRESH_MS,
  quotaSnapshotSchema,
  type QuotaBalance,
  type QuotaReason,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError, unavailableQuota } from "./account-quota.js";
import {
  AdapterQuotaCache,
  type AdapterQuotaScope,
  type EngineQuotaReadOptions,
  type EngineQuotaReadResult,
} from "./adapter-account-quota.js";
import { killProcessTree } from "./process-tree.js";

export type KimiQuotaSpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

export type KimiQuotaChildLike = {
  pid?: number;
  stdin?: { end(chunk?: string): void; on?(event: "error", listener: (error: Error) => void): void };
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): void;
};

export type KimiQuotaSpawn = (
  command: string,
  args: string[],
  options: KimiQuotaSpawnOptions,
) => KimiQuotaChildLike;

const MAX_STDOUT_BYTES = 64 * 1024;
const KIMI_WINDOWS: Array<{ key: "limit5h" | "limit7d" | "monthTotal" | "monthCode"; id: string; label: string; periodSeconds: number }> = [
  { key: "limit5h", id: "five_hour", label: "5 hours", periodSeconds: 18_000 },
  { key: "limit7d", id: "seven_day", label: "7 days", periodSeconds: 604_800 },
  { key: "monthTotal", id: "month_total", label: "Monthly", periodSeconds: 30 * 86_400 },
  { key: "monthCode", id: "month_code", label: "Monthly coding", periodSeconds: 30 * 86_400 },
];

type OwnedRead = { abort: AbortController; closed: Promise<void> };
const owned = new WeakMap<AdapterQuotaCache, Set<OwnedRead>>();

export async function cancelOwnedKimiQuotaReads(cache: AdapterQuotaCache): Promise<void> {
  const reads = [...(owned.get(cache) ?? [])];
  if (reads.length === 0) return;
  for (const read of reads) read.abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(reads.map(read => read.closed)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("quota_process_close_timeout")), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopChild(child: KimiQuotaChildLike): Promise<void> {
  if (child.pid) return killProcessTree(child.pid, { graceMs: 300 });
  try { child.kill?.("SIGTERM"); } catch { /* already gone */ }
  return Promise.resolve();
}

function parseIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Parse Kimi's local `GET /api/v1/oauth/usage` response envelope into a TaroBird `QuotaSnapshot`.
 * Distinguishes normal plan quotas + top-up pack balance, 401 (not signed in), 404 (non-Kimi For Coding),
 * and API-key-only errors. */
export function parseKimiManagedUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuotaReadError("invalid_response");
  }
  const envelope = payload as Record<string, unknown>;
  const data = (envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data
    : envelope) as Record<string, unknown>;

  if (data.kind === "error") {
    const status = typeof data.status === "number" ? data.status : undefined;
    const message = typeof data.message === "string" ? data.message : "";
    if (status === 401 || /authorization failed|not logged in|unauthorized|try \/login|please login/i.test(message)) {
      return unavailableQuota("kimi", "login_required", now, "unknown");
    }
    if (status === 404 || /usage endpoint not available|kimi for coding/i.test(message)) {
      return unavailableQuota("kimi", "mode_not_supported", now, "other");
    }
    if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
      return unavailableQuota("kimi", "rate_limited", now, "subscription");
    }
    if (/api.?key/i.test(message)) {
      return unavailableQuota("kimi", "mode_not_supported", now, "api_key");
    }
    return unavailableQuota("kimi", "native_error", now, "subscription");
  }

  if (data.kind !== "ok" || !data.quota || typeof data.quota !== "object" || Array.isArray(data.quota)) {
    throw new QuotaReadError("invalid_response");
  }
  const quota = data.quota as Record<string, unknown>;
  const usages = quota.usages && typeof quota.usages === "object" && !Array.isArray(quota.usages)
    ? quota.usages as Record<string, unknown>
    : {};

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const windows: QuotaWindow[] = [];

  for (const spec of KIMI_WINDOWS) {
    const raw = usages[spec.key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.usedRatio !== "number" || !Number.isFinite(entry.usedRatio) || entry.usedRatio < 0 || entry.usedRatio > 1000) {
      throw new QuotaReadError("invalid_response");
    }
    const usedPercent = Math.round(entry.usedRatio * 10_000) / 100;
    const resetsAt = parseIso(entry.resetAt);
    windows.push({
      id: spec.id,
      label: spec.label,
      periodSeconds: spec.periodSeconds,
      metric: "percent",
      usedPercent,
      availability: "unknown",
      observedAt,
      expiresAt,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const balances: QuotaBalance[] = [];
  if (quota.extraUsage && typeof quota.extraUsage === "object" && !Array.isArray(quota.extraUsage)) {
    const extra = quota.extraUsage as Record<string, unknown>;
    const currencyRaw = typeof extra.currency === "string" ? extra.currency.trim().toUpperCase() : "CNY";
    const unit = /^[A-Za-z0-9._-]{1,16}$/.test(currencyRaw) ? currencyRaw : "CNY";
    if (typeof extra.balanceCents === "number" && Number.isFinite(extra.balanceCents) && extra.balanceCents >= 0) {
      balances.push({
        id: "top_up",
        kind: "currency",
        amount: (extra.balanceCents / 100).toFixed(2),
        unit,
        observedAt,
        expiresAt,
      });
    }
    if (
      extra.monthlyChargeLimitEnabled === true
      && typeof extra.monthlyChargeLimitCents === "number"
      && extra.monthlyChargeLimitCents > 0
      && typeof extra.monthlyUsedCents === "number"
      && extra.monthlyUsedCents >= 0
    ) {
      const usedPercent = Math.round((extra.monthlyUsedCents / extra.monthlyChargeLimitCents) * 10_000) / 100;
      windows.push({
        id: "extra_monthly",
        label: "Top-up monthly limit",
        periodSeconds: 30 * 86_400,
        metric: "percent",
        usedPercent,
        availability: "unknown",
        observedAt,
        expiresAt,
      });
    }
  }

  const hasData = windows.length > 0 || balances.length > 0;
  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: hasData ? "ready" : "unknown",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools: hasData ? [{
      id: "kimi",
      label: "Kimi Code",
      sharing: "shared",
      availability: "unknown",
      windows,
      balances,
      constraints: [],
    }] : [],
    constraints: [],
    help: "kimi_usage",
  };

  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

function isLoopbackOrigin(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1");
  } catch {
    return false;
  }
}

/** Start a short-lived local `kimi web --port 0 --json`, query its loopback
 * `GET /api/v1/oauth/usage` endpoint once with the ephemeral bearer token, and
 * terminate the process tree immediately. Never sends model turns or reads Kimi credentials. */
export async function readOwnedKimiQuota(input: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: KimiQuotaSpawn;
  cache: AdapterQuotaCache;
  scope: AdapterQuotaScope;
  options: EngineQuotaReadOptions;
  captureScope: () => AdapterQuotaScope;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<EngineQuotaReadResult> {
  if (owned.get(input.cache)?.size) return input.cache.failure(input.scope, "timeout");
  if (input.options.signal?.aborted) return input.cache.failure(input.scope, "cancelled");
  const now = input.now ?? Date.now;
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Math.max(1, Math.min(ENGINE_QUOTA_REFRESH_MS, input.options.timeoutMs ?? ENGINE_QUOTA_REFRESH_MS));

  const abort = new AbortController();
  let timedOut = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>(resolve => { closedResolve = resolve; });
  const entry: OwnedRead = { abort, closed };
  const reads = owned.get(input.cache) ?? new Set<OwnedRead>();
  owned.set(input.cache, reads);
  reads.add(entry);
  void closed.then(() => reads.delete(entry));

  const cancel = () => abort.abort();
  input.options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);

  const fail = (reason: QuotaReason, authMode = input.scope.authMode): EngineQuotaReadResult => {
    const after = input.captureScope();
    if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
    return input.cache.store(after, { snapshot: unavailableQuota("kimi", reason, now(), authMode) });
  };

  let child: KimiQuotaChildLike | undefined;
  let childClosed = false;
  let childClosePromise: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const terminate = () => {
    if (!child) return Promise.resolve();
    return stopping ??= stopChild(child);
  };

  try {
    try {
      child = input.spawn(input.executable, ["web", "--port", "0", "--json"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: input.env,
        cwd: input.cwd,
        windowsHide: true,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      return fail(code === "ENOENT" ? "cli_unavailable" : "native_error");
    }

    let spawnErrorCode: string | undefined;
    childClosePromise = new Promise<void>(resolve => {
      const done = () => { if (!childClosed) { childClosed = true; resolve(); } };
      child!.once("error", err => {
        spawnErrorCode = err && typeof err === "object" && "code" in err ? String(err.code) : "error";
        done();
      });
      child!.once("close", () => done());
    });
    child.stdin?.on?.("error", () => undefined);
    try { child.stdin?.end(); } catch { /* ignore */ }

    const ready = await new Promise<{ origin: string; token?: string } | { error: QuotaReason }>((resolve) => {
      let settled = false;
      const finish = (value: { origin: string; token?: string } | { error: QuotaReason }) => {
        if (settled) return;
        settled = true;
        abort.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onAbort = () => finish({ error: timedOut ? "timeout" : "cancelled" });
      abort.signal.addEventListener("abort", onAbort, { once: true });
      if (abort.signal.aborted) { onAbort(); return; }

      const decoder = new StringDecoder("utf8");
      let buf = "";
      let bytes = 0;
      child!.stdout?.on("data", chunk => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > MAX_STDOUT_BYTES) { finish({ error: "invalid_response" }); return; }
        buf += text;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const origin = typeof parsed.origin === "string" ? parsed.origin.trim() : "";
            const token = typeof parsed.token === "string" ? parsed.token.trim() : undefined;
            if (origin && isLoopbackOrigin(origin)) {
              finish({ origin, token });
              return;
            }
          } catch { /* wait for valid ready JSON line */ }
        }
      });
      void childClosePromise.then(() => {
        finish({ error: spawnErrorCode === "ENOENT" ? "cli_unavailable" : "native_error" });
      });
    });

    if ("error" in ready) {
      await terminate();
      await Promise.race([childClosePromise, new Promise(r => setTimeout(r, 1500))]);
      return fail(ready.error);
    }

    if (input.captureScope().revision !== input.scope.revision) {
      await terminate();
      await Promise.race([childClosePromise, new Promise(r => setTimeout(r, 1500))]);
      return input.cache.failure(input.captureScope(), "auth_changed");
    }

    const res = await fetchFn(`${ready.origin}/api/v1/oauth/usage`, {
      method: "GET",
      headers: ready.token ? { Authorization: `Bearer ${ready.token}` } : {},
      credentials: "omit",
      signal: abort.signal,
    });

    await terminate();
    await Promise.race([childClosePromise, new Promise(r => setTimeout(r, 1500))]);

    const after = input.captureScope();
    if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
    if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    if (res.status === 401 || res.status === 403) return fail("login_required", "unknown");
    if (res.status === 404) return fail("mode_not_supported", "other");
    if (res.status === 429) return fail("rate_limited");
    if (!res.ok) return fail("native_error");

    const payload = await res.json();
    const snapshot = parseKimiManagedUsage(payload, now());
    return input.cache.store(after, { snapshot });
  } catch (error) {
    await terminate();
    await Promise.race([childClosePromise, new Promise(r => setTimeout(r, 1500))]);
    if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    const reason = error instanceof QuotaReadError ? error.reason : "native_error";
    return fail(reason);
  } finally {
    clearTimeout(timer);
    input.options.signal?.removeEventListener("abort", cancel);
    void terminate();
    closedResolve();
  }
}
