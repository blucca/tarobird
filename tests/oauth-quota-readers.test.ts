import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeKeychainService,
  fetchClaudeOAuthQuota,
  parseClaudeOAuthUsageResponse,
  readClaudeOAuthToken,
} from "../src/codex/claude-oauth-quota.js";
import {
  fetchGeminiOAuthQuota,
  parseGeminiUserQuotaResponse,
  readGeminiStoredOAuth,
} from "../src/codex/gemini-oauth-quota.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { formatTimeRemaining } from "../client/src/usage-readings.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "oauth-quota-"));
  roots.push(root);
  return root;
}

describe("Claude OAuth read-only quota reader (#96 Part B)", () => {
  it("reads Claude Code quota from stored .credentials.json even when no Claude process is running", async () => {
    const home = await tempHome();
    const claudeDir = path.join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const credsPath = path.join(claudeDir, ".credentials.json");
    const originalBytes = JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-token-123", refreshToken: "never-used" } });
    await writeFile(credsPath, originalBytes);

    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("authorization") });
      return new Response(JSON.stringify({
        five_hour: { utilization: 18, resets_at: "2026-11-24T12:00:00Z" },
        seven_day: { utilization: 42.5, resets_at: "2026-11-28T09:00:00Z" },
        limits: [{ kind: "weekly_scoped", percent: 15, resets_at: "2026-11-28T09:00:00Z", scope: { model: { display_name: "Fable" } } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const spawn = vi.fn(() => { throw new Error("must_not_spawn_claude"); });
    const adapter = new ClaudeStreamAdapter("claude", {
      childEnv: { HOME: home },
      spawnFn: spawn,
      idleSweepIntervalMs: 0,
      oauthQuotaReader: {
        readToken: env => readClaudeOAuthToken(env),
        fetchQuota: opts => fetchClaudeOAuthQuota({ ...opts, fetchFn, now: () => Date.parse("2026-11-24T08:00:00Z") }),
      },
    });

    try {
      // Cache read before refresh reports active capability so Settings / battery auto-read it.
      const before = await adapter.getAccountQuota({ refresh: false });
      expect(before.snapshot).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" }, authMode: "subscription" });
      expect(spawn).not.toHaveBeenCalled();

      // Active refresh reads Anthropic OAuth usage directly without starting any Claude process.
      const res = await adapter.getAccountQuota({ refresh: true, expectedRevision: before.revision });
      expect(spawn).not.toHaveBeenCalled();
      expect(calls).toEqual([{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer synthetic-token-123" }]);
      expect(res.snapshot.state).toBe("ready");
      expect(res.snapshot.pools[0]?.windows.map(w => [w.id, w.metric === "percent" ? w.usedPercent : null, w.resetsAt])).toEqual([
        ["five_hour", 18, "2026-11-24T12:00:00.000Z"],
        ["seven_day", 42.5, "2026-11-28T09:00:00.000Z"],
      ]);
      expect(res.snapshot.pools[1]?.label).toBe("Fable");
      // Credentials file is strictly read-only and token never leaks into returned DTO.
      expect(await readFile(credsPath, "utf8")).toBe(originalBytes);
      expect(JSON.stringify(res)).not.toContain("synthetic-token-123");
      expect(JSON.stringify(res)).not.toContain("never-used");
    } finally {
      await adapter.destroy();
    }
  });

  it("reads macOS Keychain via scoped service name and skips Keychain for isolated temp homes", async () => {
    const home = await tempHome();
    // Isolated temp HOME without explicit readKeychain never touches the real system Keychain.
    expect(await readClaudeOAuthToken({ HOME: home }, { platform: "darwin", systemHome: "/Users/example" })).toBeNull();

    // Scoped CLAUDE_CONFIG_DIR queries the hashed Keychain service name.
    const configDir = path.join(home, "profile-a");
    const queried: Array<[string, string]> = [];
    const token = await readClaudeOAuthToken(
      { HOME: home, CLAUDE_CONFIG_DIR: configDir, USER: "example" },
      {
        platform: "darwin",
        systemHome: home,
        readKeychain: async (service, account) => {
          queried.push([service, account]);
          return JSON.stringify({ claudeAiOauth: { accessToken: "keychain-secret" } });
        },
      },
    );
    expect(token).toEqual({ token: "keychain-secret", source: "keychain" });
    expect(queried).toEqual([[claudeKeychainService(configDir), "example"]]);
    expect(claudeKeychainService()).toBe("Claude Code-credentials");
  });

  it("maps 401 and 429 cleanly without leaking tokens or refreshing credentials", async () => {
    const unauthorized = await fetchClaudeOAuthQuota({
      token: "expired-secret",
      fetchFn: (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch,
    });
    expect(unauthorized).toMatchObject({ state: "login_required", reason: "login_required" });
    expect(JSON.stringify(unauthorized)).not.toContain("expired-secret");

    const limited = await fetchClaudeOAuthQuota({
      token: "rate-secret",
      fetchFn: (async () => new Response("too many", { status: 429 })) as unknown as typeof fetch,
    });
    expect(limited).toMatchObject({ state: "unavailable", reason: "rate_limited" });
    expect(parseClaudeOAuthUsageResponse({ five_hour: { used_percentage: 33, resets_at: 1800000000 } }).pools[0]?.windows[0]).toMatchObject({
      id: "five_hour",
      usedPercent: 33,
    });
  });
});

describe("Gemini OAuth read-only quota reader (#96 Part B)", () => {
  it("reads non-expired oauth_creds.json and calls retrieveUserQuota without ever refreshing tokens", async () => {
    const home = await tempHome();
    const geminiDir = path.join(home, ".gemini");
    await mkdir(geminiDir, { recursive: true });
    const now = Date.parse("2026-11-24T08:00:00Z");
    await writeFile(path.join(geminiDir, "oauth_creds.json"), JSON.stringify({
      access_token: "gemini-live-token",
      refresh_token: "must-not-refresh",
      expiry_date: now + 3_600_000,
    }));
    await writeFile(path.join(geminiDir, "settings.json"), JSON.stringify({ cloudaicompanionProject: "proj-123" }));

    const stored = readGeminiStoredOAuth({ HOME: home }, now);
    expect(stored).toEqual({ accessToken: "gemini-live-token", projectId: "proj-123" });

    const seenUrls: string[] = [];
    const snapshot = await fetchGeminiOAuthQuota({
      accessToken: stored!.accessToken,
      projectId: stored!.projectId,
      now: () => now,
      fetchFn: (async (url: string | URL | Request) => {
        seenUrls.push(String(url));
        return new Response(JSON.stringify({
          buckets: [
            { modelId: "gemini-2.5-pro", remainingFraction: 0.72, resetTime: "2026-11-25T08:00:00Z" },
            { modelId: "gemini-2.5-flash", remainingFraction: 0.95, resetTime: "2026-11-24T13:00:00Z" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    expect(seenUrls).toEqual(["https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"]);
    expect(snapshot.state).toBe("ready");
    expect(snapshot.pools.map(p => [p.label, p.windows[0]?.metric === "percent" ? p.windows[0].usedPercent : null])).toEqual([
      ["gemini-2.5-pro", 28],
      ["gemini-2.5-flash", 5],
    ]);

    // Expired access_token returns null and never triggers a token refresh.
    await writeFile(path.join(geminiDir, "oauth_creds.json"), JSON.stringify({
      access_token: "gemini-expired-token",
      refresh_token: "must-not-refresh",
      expiry_date: now - 1000,
    }));
    expect(readGeminiStoredOAuth({ HOME: home }, now)).toBeNull();
    expect(parseGeminiUserQuotaResponse({ buckets: [] }, now).state).toBe("unknown");
  });
});

describe("Accurate reset time countdown (#96 Part A)", () => {
  it("computes remaining duration from reset timestamp rather than window length", () => {
    const now = Date.parse("2026-11-24T08:00:00Z");
    const in3d17h = new Date(now + (3 * 24 + 17) * 3_600_000).toISOString();
    expect(formatTimeRemaining(in3d17h, now, "en")).toBe("3d 17h");
    expect(formatTimeRemaining(in3d17h, now, "zh")).toBe("3 天 17 小时");

    const in4d23h = new Date(now + (4 * 24 + 23) * 3_600_000).toISOString();
    expect(formatTimeRemaining(in4d23h, now, "en")).toBe("4d 23h");
    expect(formatTimeRemaining(in4d23h, now, "zh")).toBe("4 天 23 小时");

    const in2h15m = new Date(now + (2 * 60 + 15) * 60_000).toISOString();
    expect(formatTimeRemaining(in2h15m, now, "en")).toBe("2h 15m");
    expect(formatTimeRemaining(in2h15m, now, "zh")).toBe("2 小时 15 分钟");

    const in12m = new Date(now + 12 * 60_000).toISOString();
    expect(formatTimeRemaining(in12m, now, "en")).toBe("12m");
    expect(formatTimeRemaining(in12m, now, "zh")).toBe("12 分钟");

    expect(formatTimeRemaining(new Date(now - 1000).toISOString(), now, "en")).toBeNull();
  });
});
