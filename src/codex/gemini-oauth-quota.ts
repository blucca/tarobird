import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QuotaPool, QuotaSnapshot, QuotaWindow } from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError, unavailableQuota } from "./account-quota.js";

const RETRIEVE_USER_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const MAX_FILE_BYTES = 1024 * 1024;

export type GeminiStoredOAuth = {
  accessToken: string;
  projectId?: string;
};

function readBoundedFile(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    return buf.toString("utf8", 0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readLocalProjectId(home: string, env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = (env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID || "").trim();
  if (fromEnv) return fromEnv;
  for (const file of [
    path.join(home, ".gemini", "antigravity-cli", "settings.json"),
    path.join(home, ".gemini", "settings.json"),
  ]) {
    const raw = readBoundedFile(file);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const direct = typeof parsed.cloudaicompanionProject === "string"
        ? parsed.cloudaicompanionProject
        : typeof parsed.project === "string"
          ? parsed.project
          : undefined;
      if (direct?.trim()) return direct.trim();
    } catch { /* ignore */ }
  }
  return undefined;
}

/** Read Gemini's stored OAuth access token strictly read-only on the Host.
 * If the stored access token is missing or already expired, returns null without
 * ever refreshing or modifying the stored login. */
export function readGeminiStoredOAuth(env: NodeJS.ProcessEnv, now = Date.now()): GeminiStoredOAuth | null {
  if (env.GEMINI_API_KEY || env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const raw = readBoundedFile(path.join(home, ".gemini", "oauth_creds.json"));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const accessToken = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
    if (!accessToken) return null;
    const expiry = typeof parsed.expiry_date === "number" ? parsed.expiry_date : undefined;
    // Never refresh or modify stored login: if the stored token is expired, let the caller fall back.
    if (expiry !== undefined && Number.isFinite(expiry) && expiry <= now + 30_000) return null;
    const projectId = readLocalProjectId(home, env);
    return { accessToken, ...(projectId ? { projectId } : {}) };
  } catch {
    return null;
  }
}

type RawGeminiBucket = {
  remainingFraction: number;
  resetTime?: string;
  modelId: string;
};

function poolHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Parse Google's `retrieveUserQuota` JSON into a TaroBird `QuotaSnapshot`. */
export function parseGeminiUserQuotaResponse(data: unknown, now = Date.now()): QuotaSnapshot {
  const rawBuckets: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "buckets" in data && Array.isArray((data as { buckets: unknown }).buckets)
      ? (data as { buckets: unknown[] }).buckets
      : [];

  const valid: RawGeminiBucket[] = [];
  for (const item of rawBuckets.slice(0, 64)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const b = item as Record<string, unknown>;
    if (typeof b.remainingFraction !== "number" || !Number.isFinite(b.remainingFraction) || b.remainingFraction < 0 || b.remainingFraction > 1) continue;
    if (typeof b.modelId !== "string" || !b.modelId.trim() || b.modelId.length > 120 || /[\x00-\x1f\x7f]/.test(b.modelId)) continue;
    const resetTime = typeof b.resetTime === "string" && /^\d{4}-\d\d-\d\dT/.test(b.resetTime) && Number.isFinite(Date.parse(b.resetTime))
      ? new Date(b.resetTime).toISOString()
      : undefined;
    valid.push({ remainingFraction: b.remainingFraction, modelId: b.modelId.trim(), ...(resetTime ? { resetTime } : {}) });
  }

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();

  // Group buckets by modelId, keeping each distinct reset window.
  const byModel = new Map<string, RawGeminiBucket[]>();
  for (const bucket of valid) {
    const list = byModel.get(bucket.modelId) ?? [];
    list.push(bucket);
    byModel.set(bucket.modelId, list);
  }

  const pools: QuotaPool[] = [];
  let modelIndex = 0;
  for (const [modelId, buckets] of byModel) {
    const seen = new Set<string>();
    const windows: QuotaWindow[] = [];
    for (const [idx, bucket] of buckets.entries()) {
      const dedupKey = `${bucket.remainingFraction}|${bucket.resetTime ?? ""}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const usedPercent = Math.round((1 - bucket.remainingFraction) * 10000) / 100;
      windows.push({
        id: `gemini-${poolHash(`${modelId}:${idx}:${bucket.resetTime ?? ""}`)}`,
        label: bucket.resetTime ? "Quota" : `Window ${idx + 1}`,
        metric: "percent",
        usedPercent,
        availability: "unknown",
        observedAt,
        expiresAt,
        ...(bucket.resetTime ? { resetsAt: bucket.resetTime } : {}),
      });
    }
    if (windows.length) {
      pools.push({
        id: poolHash(`${modelId}:${modelIndex++}`),
        label: modelId,
        models: [modelId],
        sharing: "model",
        availability: "unknown",
        windows,
        balances: [],
        constraints: [],
      });
    }
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
    help: "antigravity_usage",
  };
}

/** Fetch Gemini user quota read-only via Google's `retrieveUserQuota` endpoint.
 * Never logs, copies, or refreshes the stored OAuth credentials. */
export async function fetchGeminiOAuthQuota(options: {
  accessToken: string;
  projectId?: string;
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
    let projectId = options.projectId;
    if (!projectId) {
      try {
        const loadRes = await fetchFn(LOAD_CODE_ASSIST_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.accessToken}`,
          },
          body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
          credentials: "omit",
          signal: controller.signal,
        });
        if (loadRes.ok) {
          const loadData = await loadRes.json() as Record<string, unknown>;
          if (typeof loadData?.cloudaicompanionProject === "string" && loadData.cloudaicompanionProject.trim()) {
            projectId = loadData.cloudaicompanionProject.trim();
          }
        }
      } catch { /* proceed without projectId */ }
    }

    const res = await fetchFn(RETRIEVE_USER_QUOTA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
      credentials: "omit",
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return unavailableQuota("antigravity", "login_required", now(), "subscription");
    }
    if (res.status === 429) {
      return unavailableQuota("antigravity", "rate_limited", now(), "subscription");
    }
    if (!res.ok) {
      return unavailableQuota("antigravity", "native_error", now(), "subscription");
    }
    const payload = await res.json();
    return parseGeminiUserQuotaResponse(payload, now());
  } catch (error) {
    if (controller.signal.aborted) {
      return unavailableQuota("antigravity", timedOut ? "timeout" : "cancelled", now(), "subscription");
    }
    const reason = error instanceof QuotaReadError ? error.reason : "native_error";
    return unavailableQuota("antigravity", reason, now(), "subscription");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
