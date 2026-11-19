import { spawn } from "node:child_process";
import type { EngineQuotaBalance, EngineQuotaStatus, EngineQuotaWindow } from "../client-protocol/engine-quota.js";

/**
 * Read-only quota readers. Each one asks the engine's own CLI through a
 * documented channel that starts no model turn, so a refresh never spends
 * quota. Raw responses stay in this module: only the parsed summary below
 * leaves it, and account identifiers are never copied out.
 */
export type QuotaReading = {
  status: EngineQuotaStatus;
  reason?: "timeout" | "rate_limited" | "invalid_response" | "upstream_error";
  plan?: string;
  windows: EngineQuotaWindow[];
  balances: EngineQuotaBalance[];
};
export type QuotaReaderOptions = { executable: string; env: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const empty = (status: EngineQuotaStatus, reason?: QuotaReading["reason"]): QuotaReading => ({ status, ...(reason ? { reason } : {}), windows: [], balances: [] });
const failure = (error: unknown): QuotaReading => error instanceof QuotaTimeout ? empty("error", "timeout") : empty("error", "upstream_error");
class QuotaTimeout extends Error {}

/** Epoch seconds or ms → ms. Anything implausible is dropped, never guessed. */
export function epochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 1e11 ? value * 1000 : value;
  return ms < 1e12 || ms > 1e14 ? undefined : Math.round(ms);
}
const percent = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(10_000, Math.round(value * 10) / 10) : undefined;
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
const id = (value: string) => value.replace(/[^\w.:-]/g, "_").slice(0, 64) || "pool";
const decimal = (value: unknown): string | undefined => {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^-?\d{1,15}(?:\.\d{1,8})?$/.test(raw) ? raw : undefined;
};

// ---------------------------------------------------------------- Codex

type CodexWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
type CodexSnapshot = { limitId?: unknown; limitName?: unknown; primary?: CodexWindow; secondary?: CodexWindow; credits?: { hasCredits?: unknown; unlimited?: unknown; balance?: unknown } | null; planType?: unknown; rateLimitReachedType?: unknown; spendControlReached?: unknown };
type CodexRateLimits = { ordinaryUsageAllowed?: unknown; rateLimits?: CodexSnapshot; rateLimitsByLimitId?: Record<string, CodexSnapshot | undefined> | null };
type CodexAccount = { account?: { type?: unknown; planType?: unknown } | null; requiresOpenaiAuth?: unknown };

/** Pure mapping of `account/read` + `account/rateLimits/read` (Codex CLI ≥ 0.170). */
export function parseCodexQuota(account: CodexAccount | undefined, limits: CodexRateLimits | undefined): QuotaReading {
  const type = account?.account?.type;
  if (account && !account.account) return empty("login_required");
  if (type === "apiKey") return empty("unsupported");
  if (!limits || typeof limits !== "object") return empty("error", "invalid_response");
  const snapshots = limits.rateLimitsByLimitId && typeof limits.rateLimitsByLimitId === "object"
    ? Object.values(limits.rateLimitsByLimitId).filter((item): item is CodexSnapshot => !!item && typeof item === "object")
    : limits.rateLimits ? [limits.rateLimits] : [];
  const windows: EngineQuotaWindow[] = [], balances: EngineQuotaBalance[] = [];
  let plan = text(account?.account?.planType, 80), reached = limits.ordinaryUsageAllowed === false;
  for (const snapshot of snapshots) {
    const limitId = text(snapshot.limitId, 48) ?? "codex", label = text(snapshot.limitName, 80) ?? (limitId === "codex" ? undefined : limitId);
    plan ??= text(snapshot.planType, 80);
    if (snapshot.rateLimitReachedType || snapshot.spendControlReached === true) reached = true;
    for (const [slot, window] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]] as const) {
      if (!window || typeof window !== "object") continue;
      const usedPercent = percent(window.usedPercent);
      if (usedPercent === undefined) continue;
      const minutes = typeof window.windowDurationMins === "number" && Number.isInteger(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : undefined;
      const resetsAt = epochMs(window.resetsAt);
      windows.push({ id: id(`${limitId}:${slot}`), ...(label ? { label } : {}), ...(minutes && minutes <= 60 * 24 * 62 ? { windowMinutes: minutes } : {}), usedPercent, ...(resetsAt ? { resetsAt } : {}) });
      if (usedPercent >= 100) reached = true;
    }
    const credits = snapshot.credits;
    const amount = credits && credits.hasCredits === true && credits.unlimited !== true ? decimal(credits.balance) : undefined;
    if (amount !== undefined && !balances.some(item => item.id === "credits")) balances.push({ id: "credits", amount, unit: "credits" });
  }
  if (!windows.length && !balances.length) return { ...empty(reached ? "exhausted" : "unknown"), ...(plan ? { plan } : {}) };
  return { status: reached ? "exhausted" : "ok", ...(plan ? { plan } : {}), windows: windows.slice(0, 16), balances };
}

/** One short-lived `codex app-server` session: initialize, read account and limits, exit. */
export async function readCodexQuota(options: QuotaReaderOptions): Promise<QuotaReading> {
  try {
    const rpc = jsonRpcChild(options.executable, ["app-server"], options);
    try {
      await rpc.request("initialize", { clientInfo: { name: "tarocub", title: "TaroCub", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      rpc.notify("initialized");
      const account = await rpc.request("account/read", {}) as CodexAccount;
      if (account && !account.account) return empty("login_required");
      if (account?.account?.type === "apiKey") return empty("unsupported");
      return parseCodexQuota(account, await rpc.request("account/rateLimits/read", {}) as CodexRateLimits);
    } finally { rpc.close(); }
  } catch (error) {
    if (error instanceof JsonRpcError && /auth|login|sign.?in|unauthori[sz]ed/i.test(error.message)) return empty("login_required");
    if (error instanceof JsonRpcError && /rate.?limit|429/i.test(error.message)) return empty("error", "rate_limited");
    return failure(error);
  }
}

class JsonRpcError extends Error {}
function jsonRpcChild(executable: string, args: string[], options: QuotaReaderOptions) {
  const child = spawn(executable, args, { env: options.env, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let next = 0, buffer = "", size = 0, dead: Error | undefined;
  const fail = (error: Error) => { dead ??= error; for (const item of pending.values()) item.reject(error); pending.clear(); };
  const timer = setTimeout(() => { fail(new QuotaTimeout("quota read timed out")); child.kill("SIGKILL"); }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref();
  const abort = () => { fail(new QuotaTimeout("quota read aborted")); child.kill("SIGKILL"); };
  options.signal?.addEventListener("abort", abort, { once: true });
  child.on("error", error => fail(error));
  child.on("exit", () => fail(new Error("engine exited")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    size += chunk.length;
    if (size > MAX_OUTPUT_BYTES) { fail(new Error("engine output too large")); child.kill("SIGKILL"); return; }
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== "number" || !pending.has(message.id)) continue;
      const item = pending.get(message.id)!; pending.delete(message.id);
      if (message.error) item.reject(new JsonRpcError(typeof message.error.message === "string" ? message.error.message.slice(0, 200) : "request failed"));
      else item.resolve(message.result);
    }
  });
  return {
    request(method: string, params: unknown): Promise<unknown> {
      if (dead) return Promise.reject(dead);
      const requestId = ++next;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
      });
    },
    notify(method: string) { if (!dead) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); },
    close() { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); child.stdin.end(); child.kill("SIGTERM"); },
  };
}

// ---------------------------------------------------------------- Antigravity

/** `agy -p /usage` answers without an agent turn since 1.1.11; older CLIs would
 * send "/usage" to the model as a prompt and spend quota, so they are refused. */
export const AGY_READ_ONLY_COMMANDS_SINCE = [1, 1, 11] as const;
export function agyVersionSupported(version: string | undefined): boolean {
  const match = version?.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index++) if (parts[index] !== AGY_READ_ONLY_COMMANDS_SINCE[index]) return parts[index]! > AGY_READ_ONLY_COMMANDS_SINCE[index]!;
  return true;
}
const AGY_WINDOWS: Record<string, number> = { "5h": 300, daily: 1440, weekly: 10080, monthly: 43200 };

type AgyPayload = { status?: unknown; num_turns?: unknown; command?: { name?: unknown; data?: unknown } };
/** A command answer is accepted only if it provably started no turn. */
function agyCommandData(raw: string, name: string): Record<string, unknown> | undefined {
  let payload: AgyPayload;
  try { payload = JSON.parse(raw); } catch { return undefined; }
  if (!payload || payload.status !== "SUCCESS" || payload.num_turns !== 0 || payload.command?.name !== name) return undefined;
  return payload.command.data && typeof payload.command.data === "object" ? payload.command.data as Record<string, unknown> : undefined;
}

export function parseAgyUsage(usageRaw: string, creditsRaw?: string): QuotaReading {
  const usage = agyCommandData(usageRaw, "usage");
  if (!usage) return empty("error", "invalid_response");
  const windows: EngineQuotaWindow[] = [];
  let exhausted = false;
  for (const group of Array.isArray(usage.groups) ? usage.groups : []) {
    if (!group || typeof group !== "object") continue;
    const label = text((group as { name?: unknown }).name, 80);
    const description = text((group as { description?: unknown }).description, 2000);
    const listed = description?.match(/^Models within this group:\s*(.+)$/)?.[1];
    const models = listed?.split(",").map(item => item.trim().slice(0, 120)).filter(Boolean).slice(0, 32);
    for (const bucket of Array.isArray((group as { buckets?: unknown }).buckets) ? (group as { buckets: unknown[] }).buckets : []) {
      if (!bucket || typeof bucket !== "object") continue;
      const value = bucket as { id?: unknown; window?: unknown; remaining_fraction?: unknown; reset_time?: unknown };
      if (typeof value.remaining_fraction !== "number" || !Number.isFinite(value.remaining_fraction) || value.remaining_fraction < 0) continue;
      const usedPercent = percent(Math.max(0, (1 - value.remaining_fraction) * 100))!;
      const resetsAt = typeof value.reset_time === "string" ? epochMs(Date.parse(value.reset_time)) : undefined;
      const minutes = typeof value.window === "string" ? AGY_WINDOWS[value.window] : undefined;
      windows.push({ id: id(text(value.id, 64) ?? `${label ?? "pool"}:${value.window ?? windows.length}`), ...(label ? { label } : {}), ...(minutes ? { windowMinutes: minutes } : {}), usedPercent, ...(resetsAt ? { resetsAt } : {}), ...(models?.length ? { models } : {}) });
      if (value.remaining_fraction <= 0) exhausted = true;
    }
  }
  const balances: EngineQuotaBalance[] = [];
  const credits = creditsRaw ? agyCommandData(creditsRaw, "credits") : undefined;
  const amount = decimal(credits?.remaining_credits);
  if (amount !== undefined) balances.push({ id: "credits", amount, unit: "credits" });
  if (!windows.length && !balances.length) return empty("unknown");
  return { status: exhausted ? "exhausted" : "ok", windows: windows.slice(0, 16), balances };
}

/** Exit code 2 means the login has no account quota (API-key mode). */
export async function readAntigravityQuota(options: QuotaReaderOptions & { version?: string }): Promise<QuotaReading> {
  if (!agyVersionSupported(options.version)) return empty("unsupported");
  try {
    // Both answers are turn-free, so they run side by side; credits are optional.
    const [usage, credits] = await Promise.all([
      runCapture(options.executable, ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], options),
      runCapture(options.executable, ["-p", "/credits", "--output-format", "json", "--print-timeout", "20s"], options).catch(() => undefined),
    ]);
    if (usage.code === 2) return empty("unsupported");
    if (usage.code !== 0) return /log.?in|sign.?in|auth/i.test(usage.stdout) ? empty("login_required") : empty("error", "upstream_error");
    return parseAgyUsage(usage.stdout, credits?.code === 0 ? credits.stdout : undefined);
  } catch (error) { return failure(error); }
}

/** `agy --version` prints a bare semver; nothing else is trusted. */
export async function readAgyVersion(options: QuotaReaderOptions): Promise<string | undefined> {
  try { const result = await runCapture(options.executable, ["--version"], { ...options, timeoutMs: 5_000 }); return result.code === 0 ? result.stdout.trim().match(/^\d+\.\d+\.\d+/)?.[0] : undefined; }
  catch { return undefined; }
}

function runCapture(executable: string, args: string[], options: QuotaReaderOptions): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: options.env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "", settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve({ code, stdout });
    };
    const timer = setTimeout(() => finish(new QuotaTimeout("quota read timed out")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS * 3);
    timer.unref();
    const abort = () => finish(new QuotaTimeout("quota read aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; if (stdout.length > MAX_OUTPUT_BYTES) finish(new Error("engine output too large")); });
    child.on("error", error => finish(error));
    child.on("close", code => finish(undefined, code));
  });
}
