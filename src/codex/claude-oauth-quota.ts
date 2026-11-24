import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { QuotaPool, QuotaSnapshot, QuotaWindow } from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError, unavailableQuota } from "./account-quota.js";

const execFileAsync = promisify(execFile);

const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/;
const CLAUDE_KEYCHAIN_FALLBACK_USER = "claude-code-user";
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

export type ClaudeOAuthTokenSource = "env" | "credentials-file" | "keychain";
export type ClaudeOAuthTokenResult = {
  token: string;
  source: ClaudeOAuthTokenSource;
};

export type KeychainReader = (service: string, account: string) => Promise<string | null>;

/** Config-dir-scoped Keychain service name matching Claude Code 2.1+. */
export function claudeKeychainService(configDir?: string): string {
  if (!configDir) return CLAUDE_KEYCHAIN_SERVICE;
  const suffix = createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

function claudeConfigDirAliases(configDir: string): string[] {
  const aliases = [configDir];
  try {
    const canonical = realpathSync(configDir);
    if (canonical !== configDir) aliases.push(canonical);
  } catch {
    try {
      lstatSync(configDir);
    } catch { /* missing dir, keep raw path */ }
  }
  return aliases;
}

function getKeychainAccount(env: NodeJS.ProcessEnv): string {
  let user: string;
  try {
    user = env.USER || env.USERNAME || os.userInfo().username;
  } catch {
    return CLAUDE_KEYCHAIN_FALLBACK_USER;
  }
  return KEYCHAIN_ACCOUNT_PATTERN.test(user) ? user : CLAUDE_KEYCHAIN_FALLBACK_USER;
}

/** Read a macOS Keychain generic password item strictly read-only. Never logs output. */
export async function readMacOsKeychainPassword(service: string, account: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { timeout: 3_000, maxBuffer: 256 * 1024, encoding: "utf8" },
    );
    const value = String(stdout ?? "").trim();
    return value || null;
  } catch {
    return null;
  }
}

function readBoundedCredentialFile(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    return buffer.toString("utf8", 0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function extractClaudeAccessTokenFromJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;
    const token = (oauth as Record<string, unknown>).accessToken;
    return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
  } catch {
    return null;
  }
}

function isClaudeNonOAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.CLAUDE_CODE_USE_BEDROCK === "1"
    || env.CLAUDE_CODE_USE_VERTEX === "1"
    || env.CLAUDE_CODE_USE_FOUNDRY === "1"
    || env.ANTHROPIC_API_KEY
    || env.ANTHROPIC_AUTH_TOKEN,
  );
}

/** Read Claude Code's stored OAuth access token strictly read-only on the Host.
 * Never refreshes, writes, or logs credentials. */
export async function readClaudeOAuthToken(
  env: NodeJS.ProcessEnv,
  options: {
    platform?: NodeJS.Platform;
    systemHome?: string;
    readKeychain?: KeychainReader;
  } = {},
): Promise<ClaudeOAuthTokenResult | null> {
  if (isClaudeNonOAuthEnv(env)) return null;

  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "env" };

  const platform = options.platform ?? process.platform;
  const systemHome = options.systemHome ?? os.homedir();
  const home = env.HOME || env.USERPROFILE || systemHome;
  const explicitConfigDir = env.CLAUDE_CONFIG_DIR?.trim() || undefined;
  const configDir = explicitConfigDir || path.join(home, ".claude");

  const fileRaw = readBoundedCredentialFile(path.join(configDir, ".credentials.json"));
  if (fileRaw) {
    const token = extractClaudeAccessTokenFromJson(fileRaw);
    if (token) return { token, source: "credentials-file" };
  }

  // On macOS, check Keychain only when configDir is explicitly scoped or HOME matches the real user home
  // (preventing isolated temp-HOME test fixtures from touching the operator's real Keychain).
  const allowKeychain = platform === "darwin" && (
    Boolean(options.readKeychain)
    || Boolean(explicitConfigDir)
    || !env.HOME
    || path.resolve(env.HOME) === path.resolve(systemHome)
  );
  if (!allowKeychain) return null;

  const readKeychain = options.readKeychain ?? readMacOsKeychainPassword;
  const account = getKeychainAccount(env);

  if (explicitConfigDir) {
    for (const alias of claudeConfigDirAliases(explicitConfigDir)) {
      const raw = await readKeychain(claudeKeychainService(alias), account);
      const token = raw ? extractClaudeAccessTokenFromJson(raw) : null;
      if (token) return { token, source: "keychain" };
    }
    return null;
  }

  const raw = await readKeychain(claudeKeychainService(), account);
  const token = raw ? extractClaudeAccessTokenFromJson(raw) : null;
  return token ? { token, source: "keychain" } : null;
}

const OAUTH_WINDOWS: Record<string, { label: string; periodSeconds?: number }> = {
  five_hour: { label: "5 hours", periodSeconds: 18_000 },
  seven_day: { label: "7 days", periodSeconds: 604_800 },
  seven_day_opus: { label: "Opus · 7 days", periodSeconds: 604_800 },
  seven_day_sonnet: { label: "Sonnet · 7 days", periodSeconds: 604_800 },
  seven_day_overage_included: { label: "Included extra usage · 7 days", periodSeconds: 604_800 },
  overage: { label: "Extra usage" },
};

function parseResetTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const iso = new Date(ms).toISOString();
    return Number.isFinite(Date.parse(iso)) ? iso : undefined;
  }
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function parseUtilizationPercent(entry: Record<string, unknown>): number | undefined {
  const raw = entry.utilization ?? entry.used_percentage ?? entry.percent;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100_000) return undefined;
  return raw;
}

function poolHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

/** Parse Anthropic's `/api/oauth/usage` response into a TaroBird `QuotaSnapshot`. */
export function parseClaudeOAuthUsageResponse(data: unknown, now = Date.now()): QuotaSnapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new QuotaReadError("invalid_response");
  }
  const body = data as Record<string, unknown>;
  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();

  const windows: QuotaWindow[] = [];
  for (const [id, detail] of Object.entries(OAUTH_WINDOWS)) {
    const raw = body[id];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const usedPercent = parseUtilizationPercent(entry);
    if (usedPercent === undefined) continue;
    const resetsAt = parseResetTimestamp(entry.resets_at ?? entry.resetsAt);
    windows.push({
      id,
      label: detail.label,
      ...(detail.periodSeconds ? { periodSeconds: detail.periodSeconds } : {}),
      metric: "percent",
      usedPercent,
      availability: "unknown",
      observedAt,
      expiresAt,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const pools: QuotaPool[] = windows.length
    ? [{ id: "claude", label: "Claude", sharing: "shared", availability: "unknown", windows, balances: [], constraints: [] }]
    : [];

  // Optional model-scoped weekly windows (e.g. Fable / model-specific limits).
  const scopedSeen = new Set<string>();
  if (Array.isArray(body.limits)) {
    for (const [index, item] of body.limits.slice(0, 32).entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const limit = item as Record<string, unknown>;
      if (limit.kind !== "weekly_scoped") continue;
      const scope = limit.scope && typeof limit.scope === "object" ? limit.scope as Record<string, unknown> : undefined;
      const model = scope?.model && typeof scope.model === "object" ? scope.model as Record<string, unknown> : undefined;
      const displayName = typeof model?.display_name === "string" ? model.display_name.trim() : "";
      if (!displayName || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(displayName)) continue;
      const usedPercent = parseUtilizationPercent(limit);
      if (usedPercent === undefined) continue;
      const resetsAt = parseResetTimestamp(limit.resets_at ?? limit.resetsAt);
      scopedSeen.add(displayName.toLowerCase());
      pools.push({
        id: `claude-model-${poolHash(`${displayName}:${index}`)}`,
        label: displayName,
        models: [displayName],
        sharing: "model",
        availability: "unknown",
        windows: [{
          id: "seven_day",
          label: "7 days",
          periodSeconds: 604_800,
          metric: "percent",
          usedPercent,
          availability: "unknown",
          observedAt,
          expiresAt,
          ...(resetsAt ? { resetsAt } : {}),
        }],
        balances: [],
        constraints: [],
      });
    }
  }

  for (const key of ["fable_weekly", "fable_seven_day", "seven_day_fable"] as const) {
    if (scopedSeen.has("fable")) break;
    const raw = body[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const usedPercent = parseUtilizationPercent(entry);
    if (usedPercent === undefined) continue;
    const resetsAt = parseResetTimestamp(entry.resets_at ?? entry.resetsAt);
    scopedSeen.add("fable");
    pools.push({
      id: `claude-model-${poolHash("Fable:0")}`,
      label: "Fable",
      models: ["Fable"],
      sharing: "model",
      availability: "unknown",
      windows: [{
        id: "seven_day",
        label: "7 days",
        periodSeconds: 604_800,
        metric: "percent",
        usedPercent,
        availability: "unknown",
        observedAt,
        expiresAt,
        ...(resetsAt ? { resetsAt } : {}),
      }],
      balances: [],
      constraints: [],
    });
  }

  return {
    authMode: "subscription",
    capability: { mode: "active" },
    state: pools.length ? "ready" : "unknown",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools,
    constraints: [],
    help: "claude_usage",
  };
}

/** Fetch Claude usage directly from Anthropic's OAuth usage endpoint using the
 * Host's read-only stored token. Never logs, copies, or refreshes the token. */
export async function fetchClaudeOAuthQuota(options: {
  token: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<QuotaSnapshot> {
  const now = options.now ?? Date.now;
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.max(1, Math.min(10_000, options.timeoutMs ?? 10_000));
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    const response = await fetchFn(CLAUDE_OAUTH_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      credentials: "omit",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { ...unavailableQuota("claude", "login_required", now(), "subscription"), capability: { mode: "active" } };
    }
    if (response.status === 429) {
      return { ...unavailableQuota("claude", "rate_limited", now(), "subscription"), capability: { mode: "active" } };
    }
    if (!response.ok) {
      return { ...unavailableQuota("claude", "native_error", now(), "subscription"), capability: { mode: "active" } };
    }
    const payload = await response.json();
    return parseClaudeOAuthUsageResponse(payload, now());
  } catch (error) {
    if (controller.signal.aborted) {
      return { ...unavailableQuota("claude", timedOut ? "timeout" : "cancelled", now(), "subscription"), capability: { mode: "active" } };
    }
    const reason = error instanceof QuotaReadError ? error.reason : "native_error";
    return { ...unavailableQuota("claude", reason, now(), "subscription"), capability: { mode: "active" } };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export type ClaudeOAuthQuotaReader = {
  readToken: (env: NodeJS.ProcessEnv) => Promise<ClaudeOAuthTokenResult | null>;
  fetchQuota: (options: { token: string; signal?: AbortSignal; timeoutMs?: number }) => Promise<QuotaSnapshot>;
};

export const defaultClaudeOAuthQuotaReader: ClaudeOAuthQuotaReader = {
  readToken: (env) => readClaudeOAuthToken(env),
  fetchQuota: (options) => fetchClaudeOAuthQuota(options),
};
