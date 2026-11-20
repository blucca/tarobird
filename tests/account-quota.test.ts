import { describe, expect, it, vi } from "vitest";
import { quotaScopeSchema, quotaSnapshotSchema } from "../src/client-protocol/engine-quota.js";
import { applyClaudeQuotaEvent, parseCodexQuota, unavailableQuota } from "../src/codex/account-quota.js";
import { readCodexAccountQuota, type CodexQuotaRequest } from "../src/codex/codex-account-quota.js";

const now = Date.parse("2026-11-21T00:00:00Z");
// codex-cli 0.170.0 with experimentalApi returns workspaceRouting; the proof binds usage to it.
const account = { account: { type: "chatgpt", email: "private@example.invalid", planType: "pro", workspaceName: "Private workspace" }, userId: "private-user", requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: "private-account", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" } };
const limits = { accountId: "private-account", ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300 } } };
describe("account quota parsers", () => {
  it("prefers multiple pools over the legacy pool, does not expose account data", () => {
    const result = parseCodexQuota(account, { ...limits, rateLimitsByLimitId: {
      "private-id": { primary: { usedPercent: 120, windowDurationMins: 300 }, normalModelSlug: "gpt-5" },
      second: { secondary: { usedPercent: 0, resetsAt: now / 1000 + 60 } },
    } }, now);
    expect(result.pools).toHaveLength(2);
    expect(result.pools[0].windows[0]).toMatchObject({ usedPercent: 120, periodSeconds: 18000 });
    expect(result.pools[1].windows[0]).toMatchObject({ usedPercent: 0 });
    expect(JSON.stringify(result)).not.toMatch(/private|example|workspace/i);
    expect(quotaSnapshotSchema.safeParse(result).success).toBe(true);
  });
  it("keeps independent block reasons even when percent is low", () => {
    const result = parseCodexQuota(account, { ...limits, ordinaryUsageAllowed: false, rateLimits: {
      primary: { usedPercent: 2 }, spendControlReached: true,
      rateLimitReachedType: "workspace_member_credits_depleted",
      credits: { balance: "12.345", unlimited: false, hasCredits: true },
    } }, now);
    expect(result.availability).toBe("blocked");
    expect(result.constraints).toContainEqual({ code: "ordinary_usage_blocked", availability: "blocked" });
    expect(result.pools[0].constraints.map(c => c.code)).toEqual(["spend_control", "credits_depleted"]);
    expect(result.pools[0].balances[0]).toMatchObject({ amount: "12.345", unit: "credits" });
  });
  it.each([-1, NaN, Infinity, "40", 2.5])("rejects malformed Codex percent %s", value => {
    expect(() => parseCodexQuota(account, { ...limits, rateLimits: { primary: { usedPercent: value } } }, now)).toThrow("invalid_response");
  });
  it("missing and null values never become zero or unlimited", () => {
    const result = parseCodexQuota(account, { rateLimits: { primary: null, secondary: null, credits: null } }, now);
    expect(result.state).toBe("unknown");
    expect(result.availability).toBe("unknown");
    expect(result.pools[0].windows).toEqual([]);
    expect(result.pools[0].balances).toEqual([]);
  });
  it("does not turn bad balances into 0 or currency", () => {
    expect(() => parseCodexQuota(account, { rateLimits: { credits: { balance: "NaN USD", hasCredits: true, unlimited: false } } }, now)).toThrow("invalid_response");
  });
  it("keeps a native individual spending window without inventing its currency", () => {
    const result = parseCodexQuota(account, { rateLimits: { individualLimit: { remainingPercent: 25, used: "75", limit: "100", resetsAt: now / 1000 + 60 } } }, now);
    expect(result.pools[0].windows[0]).toMatchObject({ id: "individual", usedPercent: 75 });
    expect(result.pools[0].balances).toEqual([]);
  });
  it("returns a typed unsupported mode for API keys, not subscription quota", () => {
    expect(parseCodexQuota({ account: { type: "apiKey" }, requiresOpenaiAuth: false }, undefined, now)).toMatchObject({ state: "unsupported", authMode: "api_key", pools: [] });
  });
  it("separates Claude utilization fractions from usage report percents", () => {
    const event = applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 } }, now)!;
    expect(event.pools[0].windows[0]).toMatchObject({ usedPercent: 40 });
    const report = applyClaudeQuotaEvent(undefined, { type: "assistant", usage_report: { rate_limits: { limits: [
      { kind: "session", group: "session", percent: 0.4, resets_at: null, severity: "normal", is_active: true },
    ] } } }, now)!;
    expect(report.pools[0].windows[0]).toMatchObject({ usedPercent: 0.4 });
  });
  it("does not renew an old percent reading on sparse Claude updates", () => {
    const first = applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 } }, now)!;
    const next = applyClaudeQuotaEvent(first, { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }, now + 120000)!;
    expect(next.pools[0].windows[0]).toMatchObject({ usedPercent: 40, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), availability: "blocked" });
    expect(next.availability).toBe("blocked");
    expect(next.state).toBe("stale");
  });
  it("does not invent a five-hour window for an untyped native event", () => {
    const result = applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: { status: "rejected", utilization: 0.5 } }, now)!;
    expect(result.pools).toEqual([]);
    expect(result.availability).toBe("blocked");
  });
  it("reads the unifiedWindows emitted by the current native Claude stream", () => {
    const result = applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: {
      status: "allowed", isUsingOverage: false, unifiedWindows: {
        five_hour: { utilization: 0.4, resetsAt: now / 1000 + 3600, status: "allowed_warning" },
        seven_day: { utilization: 0.2, resetsAt: now / 1000 + 86400, status: "allowed" },
      },
    } }, now)!;
    expect(result.pools[0].windows.map(window => window.metric === "percent" ? window.usedPercent : null)).toEqual([40, 20]);
    expect(result.availability).toBe("warning");
  });
  it("rejects invalid Claude numbers and ignores unrelated messages", () => {
    expect(applyClaudeQuotaEvent(undefined, { type: "assistant", message: "hello" }, now)).toBeUndefined();
    expect(() => applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 40 } }, now)).toThrow("invalid_response");
  });
  it("does not guess report-meter identity or duplicate two different Claude quota sources", () => {
    const first = applyClaudeQuotaEvent(undefined, { type: "assistant", usage_report: { rate_limits: { limits: [
      { kind: "session", group: "session", percent: 40, resets_at: null, severity: "normal", is_active: true },
    ] } } }, now)!;
    const next = applyClaudeQuotaEvent(first, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.5 } }, now + 100)!;
    expect(next.pools[0].windows).toHaveLength(1);
    expect(next.pools[0].windows[0]).toMatchObject({ id: "five_hour", usedPercent: 50 });
  });
  it("does not clear another blocked Claude window on a sparse allowed event", () => {
    const first = applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day", utilization: 1 } }, now)!;
    const next = applyClaudeQuotaEvent(first, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.1 } }, now + 100)!;
    expect(next.availability).toBe("blocked");
  });
  it("cannot confuse an unknown window with an Object prototype member", () => {
    const result = applyClaudeQuotaEvent(undefined, { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "__proto__", utilization: 0.4 } }, now)!;
    expect(result.pools).toEqual([]);
  });
  it("does not expose private raw fields or accept them in public DTOs", () => {
    const result = unavailableQuota("kimi", "not_adapted", now);
    expect(result).toMatchObject({ state: "unsupported", pools: [], help: "kimi_usage" });
    expect(quotaSnapshotSchema.safeParse({ ...result, accountId: "secret" }).success).toBe(false);
    expect(quotaScopeSchema.safeParse({ ...result, id: "scope", revision: "v1", engine: "kimi", label: "Kimi", botIds: [], sharing: "unverified", proof: "secret" }).success).toBe(false);
  });
});

describe("Codex read-only quota reader", () => {
  const proofKey = Buffer.alloc(32, 7);
  it("uses only fixed account reads, never a turn or refresh-token write", async () => {
    const calls: unknown[] = [];
    const result = await readCodexAccountQuota({ request: async (method, params) => { calls.push([method, params]); return method === "account/read" ? account : limits; }, captureScope: () => "scope-v1", proofKey, now: () => now });
    expect(calls).toEqual([
      ["account/read", { refreshToken: false }],
      ["account/rateLimits/read", { excludeResetCreditDetails: true }],
      ["account/read", { refreshToken: false }],
    ]);
    expect(result.snapshot.state).toBe("ready");
    expect(result.proof).toMatchObject({ scopeStamp: "scope-v1", engine: "codex" });
    expect(JSON.stringify(result)).not.toMatch(/private-user|private-account|example/);
    // Without a routed workspace to compare, the usage account alone yields no proof (values still parse).
    const { workspaceRouting: _omit, ...unrouted } = account;
    const bare = await readCodexAccountQuota({ request: async method => method === "account/read" ? unrouted : limits, captureScope: () => "scope-v1", proofKey, now: () => now });
    expect(bare.snapshot.state).toBe("ready"); expect(bare.proof).toBeUndefined();
  });
  it("fails closed after an identity or scope change", async () => {
    let calls = 0;
    const result = await readCodexAccountQuota({ request: async method => { calls++; return method === "account/read" ? calls === 3 ? { ...account, userId: "another" } : account : limits; }, captureScope: () => "scope-v1", proofKey, now: () => now });
    expect(result).toMatchObject({ snapshot: { state: "unknown", reason: "auth_changed", pools: [] } });
    expect(result.proof).toBeUndefined();
    let stamp = "v1";
    const switched = await readCodexAccountQuota({ request: async () => { stamp = "v2"; return account; }, captureScope: () => stamp, proofKey });
    expect(switched.snapshot.reason).toBe("auth_changed");
  });
  it("cannot merge accounts without sufficient private native proof", async () => {
    const result = await readCodexAccountQuota({ request: async method => method === "account/read" ? { ...account, userId: null } : limits, captureScope: () => "v1", proofKey });
    expect(result.snapshot.state).toBe("ready");
    expect(result.proof).toBeUndefined();
  });
  it("rejects limits from a different native selected workspace even for the same user", async () => {
    const result = await readCodexAccountQuota({ request: async method => method === "account/read" ? { ...account, workspaceRouting: { chatgptAccountId: "workspace-a" } } : { ...limits, accountId: "workspace-b" }, captureScope: () => "v1", proofKey });
    expect(result.snapshot).toMatchObject({ reason: "auth_changed", pools: [] }); expect(result.proof).toBeUndefined();
  });
  it("uses one total deadline and ignores late responses without destroying the worker", async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn<CodexQuotaRequest>(async () => new Promise(() => {}));
      const pending = readCodexAccountQuota({ request, captureScope: () => "v1", proofKey, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(101);
      expect((await pending).snapshot.reason).toBe("timeout");
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][2].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("honors a caller abort without additional RPCs", async () => {
    const controller = new AbortController(); controller.abort();
    const request = vi.fn();
    const result = await readCodexAccountQuota({ request, captureScope: () => "v1", proofKey, signal: controller.signal });
    expect(result.snapshot.reason).toBe("cancelled"); expect(request).not.toHaveBeenCalled();
  });
  it("cancels late readings and never returns stale proof after a deadline", async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: unknown) => void;
      let calls = 0;
      const resultPromise = readCodexAccountQuota({ request: async method => {
        calls++;
        if (method === "account/rateLimits/read") return new Promise(resolve => { release = resolve; });
        return account;
      }, captureScope: () => "v1", proofKey, timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(101);
      const result = await resultPromise;
      expect(result.snapshot.reason).toBe("timeout"); expect(result.proof).toBeUndefined();
      release(limits); await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});
