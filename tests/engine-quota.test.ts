import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES } from "../src/client-protocol/index.js";
import { ENGINE_QUOTA_CAPABILITY, engineQuotaViewSchema } from "../src/client-protocol/engine-quota.js";
import { agyVersionSupported, epochMs, parseAgyUsage, parseCodexQuota, type QuotaReading } from "../src/runtime/engine-quota-readers.js";
import { claudeQuotaFromEvents, ENGINE_QUOTA_EVENTS_FILE, mergeClaudeRateLimit, readEngineQuotaEvents, recordClaudeRateLimit } from "../src/runtime/engine-quota-events.js";
import { HubEngineQuota, QUOTA_MIN_INTERVAL_MS, type QuotaSources } from "../src/hub/engine-quota.js";

// All values below are synthetic.
const NOW = 1_790_000_000_000;
const codexLimits = (used: number, extra: Record<string, unknown> = {}) => ({
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: "codex", primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1_790_003_600 } },
  rateLimitsByLimitId: { codex: { limitId: "codex", limitName: null, primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 1_790_003_600 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1_790_400_000 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "pro", rateLimitReachedType: null, ...extra } },
  accountId: "acct-should-never-leave",
});
const agyUsage = (fraction: number, turns = 0) => JSON.stringify({ status: "SUCCESS", num_turns: turns, command: { name: "usage", data: { groups: [
  { name: "Gemini Models", description: "Models within this group: Model A, Model B", buckets: [
    { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.86, reset_time: "2026-09-25T04:00:05Z" },
    { id: "gemini-5h", window: "5h", remaining_fraction: fraction, reset_time: "2026-09-21T19:43:50Z" },
  ] },
] } } });

describe("engine quota protocol", () => {
  it("is advertised so older Hubs can be told apart", () => {
    expect(CAPABILITIES).toContain(ENGINE_QUOTA_CAPABILITY);
  });
});

describe("Codex quota mapping", () => {
  it("maps every pool window, keeps the plan and never copies the account id", () => {
    const reading = parseCodexQuota({ account: { type: "chatgpt", planType: "pro" } }, codexLimits(42));
    expect(reading).toEqual({ status: "ok", plan: "pro", balances: [], windows: [
      { id: "codex:primary", windowMinutes: 300, usedPercent: 42, resetsAt: 1_790_003_600_000 },
      { id: "codex:secondary", windowMinutes: 10080, usedPercent: 12, resetsAt: 1_790_400_000_000 },
    ] });
    expect(JSON.stringify(reading)).not.toContain("acct-should-never-leave");
  });
  it("reports exhaustion from the upstream, not from a guess", () => {
    expect(parseCodexQuota({ account: { type: "chatgpt" } }, codexLimits(100)).status).toBe("exhausted");
    expect(parseCodexQuota({ account: { type: "chatgpt" } }, { ...codexLimits(10), ordinaryUsageAllowed: false }).status).toBe("exhausted");
    expect(parseCodexQuota({ account: { type: "chatgpt" } }, codexLimits(10, { rateLimitReachedType: "rate_limit_reached" })).status).toBe("exhausted");
  });
  it("separates login and API-key modes from real readings", () => {
    expect(parseCodexQuota({ account: null }, codexLimits(10)).status).toBe("login_required");
    expect(parseCodexQuota({ account: { type: "apiKey" } }, codexLimits(10)).status).toBe("unsupported");
    expect(parseCodexQuota({ account: { type: "chatgpt" } }, undefined)).toMatchObject({ status: "error", reason: "invalid_response" });
  });
  it("shows a credit balance only when the account has credits", () => {
    const reading = parseCodexQuota({ account: { type: "chatgpt" } }, codexLimits(10, { credits: { hasCredits: true, unlimited: false, balance: "12.5" } }));
    expect(reading.balances).toEqual([{ id: "credits", amount: "12.5", unit: "credits" }]);
  });
  it("treats a snapshot without numbers as unknown, not 0 %", () => {
    expect(parseCodexQuota({ account: { type: "chatgpt" } }, { rateLimitsByLimitId: { codex: { limitId: "codex", primary: null, secondary: null } } }).status).toBe("unknown");
  });
  it("normalises epoch seconds and refuses nonsense", () => {
    expect(epochMs(1_790_000_000)).toBe(1_790_000_000_000);
    expect(epochMs(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(epochMs(-1)).toBeUndefined();
    expect(epochMs(Number.NaN)).toBeUndefined();
  });
});

describe("Antigravity quota mapping", () => {
  it("maps groups and buckets with their shared models", () => {
    const credits = JSON.stringify({ status: "SUCCESS", num_turns: 0, command: { name: "credits", data: { remaining_credits: 0 } } });
    const reading = parseAgyUsage(agyUsage(0.95), credits);
    expect(reading.status).toBe("ok");
    expect(reading.windows).toEqual([
      { id: "gemini-weekly", label: "Gemini Models", windowMinutes: 10080, usedPercent: 14, resetsAt: Date.parse("2026-09-25T04:00:05Z"), models: ["Model A", "Model B"] },
      { id: "gemini-5h", label: "Gemini Models", windowMinutes: 300, usedPercent: 5, resetsAt: Date.parse("2026-09-21T19:43:50Z"), models: ["Model A", "Model B"] },
    ]);
    expect(reading.balances).toEqual([{ id: "credits", amount: "0", unit: "credits" }]);
  });
  it("marks an empty pool as exhausted", () => {
    expect(parseAgyUsage(agyUsage(0)).status).toBe("exhausted");
  });
  it("rejects any answer that started an agent turn", () => {
    expect(parseAgyUsage(agyUsage(0.5, 1))).toMatchObject({ status: "error", reason: "invalid_response" });
    expect(parseAgyUsage("not json")).toMatchObject({ status: "error", reason: "invalid_response" });
  });
  it("only trusts CLIs whose print mode answers /usage without a turn", () => {
    expect(agyVersionSupported("1.1.11")).toBe(true);
    expect(agyVersionSupported("1.5.12")).toBe(true);
    expect(agyVersionSupported("1.1.10")).toBe(false);
    expect(agyVersionSupported("0.9.99")).toBe(false);
    expect(agyVersionSupported(undefined)).toBe(false);
    expect(agyVersionSupported("garbage")).toBe(false);
  });
});

describe("Claude passive quota", () => {
  it("keeps the newest observation per window and only public fields", () => {
    let events = mergeClaudeRateLimit(undefined, { status: "allowed", rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1_790_003_600, unifiedWindows: { secret: 1 } } as never, NOW);
    events = mergeClaudeRateLimit(events, { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.81, resetsAt: 1_790_400_000 }, NOW + 1);
    expect(JSON.stringify(events)).not.toContain("unifiedWindows");
    const reading = claudeQuotaFromEvents([events], NOW + 2);
    expect(reading).toMatchObject({ status: "ok", updatedAt: NOW + 1 });
    expect(reading.windows).toEqual([
      { id: "five_hour", windowMinutes: 300, usedPercent: 40, resetsAt: 1_790_003_600_000 },
      { id: "seven_day", windowMinutes: 10080, usedPercent: 81, resetsAt: 1_790_400_000_000 },
    ]);
  });
  it("is unknown before the first event and drops windows whose reset passed", () => {
    expect(claudeQuotaFromEvents([undefined], NOW).status).toBe("unknown");
    const events = mergeClaudeRateLimit(undefined, { status: "allowed", rateLimitType: "five_hour", utilization: 0.9, resetsAt: Math.floor(NOW / 1000) - 10 }, NOW - 60_000);
    expect(claudeQuotaFromEvents([events], NOW)).toMatchObject({ status: "unknown", windows: [] });
  });
  it("reports a current refusal as exhausted", () => {
    const events = mergeClaudeRateLimit(undefined, { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(NOW / 1000) + 600 }, NOW);
    expect(claudeQuotaFromEvents([events], NOW + 1)).toMatchObject({ status: "exhausted", windows: [{ id: "five_hour", usedPercent: 100 }] });
  });
  it("merges several Bots by recency and ignores malformed events", () => {
    const older = mergeClaudeRateLimit(undefined, { status: "allowed", rateLimitType: "seven_day", utilization: 0.2 }, NOW);
    const newer = mergeClaudeRateLimit(undefined, { status: "allowed", rateLimitType: "seven_day", utilization: 0.3 }, NOW + 5);
    expect(claudeQuotaFromEvents([newer, older], NOW + 6).windows[0]!.usedPercent).toBe(30);
    expect(mergeClaudeRateLimit(undefined, { status: "weird" }, NOW)).toBeUndefined();
  });
});

describe("Hub quota view", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });
  const ok = (used: number): QuotaReading => ({ status: "ok", plan: "pro", windows: [{ id: "codex:primary", windowMinutes: 300, usedPercent: used }], balances: [] });
  function hub(overrides: Partial<QuotaSources> = {}, clock = { now: NOW }) {
    const calls = { codex: 0, antigravity: 0 };
    let next: QuotaReading = ok(10);
    const quota = new HubEngineQuota({
      engines: () => [{ id: "codex", executable: "/bin/codex" }, { id: "antigravity", executable: null }, { id: "claude", executable: "/bin/claude" }, { id: "kimi", executable: "/bin/kimi" }, { id: "deepseek", executable: null }],
      env: () => ({}),
      bots: async () => [{ id: "bot_a", name: "Writer", engine: "codex" }, { id: "bot_b", name: "Planner", engine: "claude" }, { id: "bot_c", name: "Analyst", engine: "antigravity" }],
      botStateDir: id => path.join(root ?? "/nonexistent", id),
      now: () => clock.now,
      readers: { codex: async () => { calls.codex++; return next; }, antigravity: async () => { calls.antigravity++; return ok(1); }, agyVersion: async () => "1.5.12" },
      ...overrides,
    });
    return { quota, calls, set: (reading: QuotaReading) => { next = reading; }, clock };
  }

  it("lists each engine with its Bots and an honest status", async () => {
    const { quota } = hub();
    const view = await quota.refresh();
    expect(engineQuotaViewSchema.safeParse(view).success).toBe(true);
    const byEngine = Object.fromEntries(view.entries.map(entry => [entry.engine, entry]));
    expect(byEngine.codex).toMatchObject({ id: "codex:default", status: "ok", source: "query", plan: "pro", updatedAt: NOW, bots: [{ id: "bot_a", name: "Writer" }] });
    expect(byEngine.antigravity).toMatchObject({ status: "engine_missing", bots: [{ id: "bot_c", name: "Analyst" }] });
    expect(byEngine.claude).toMatchObject({ status: "unknown", source: "event" });
    expect(byEngine.kimi).toMatchObject({ status: "not_adapted", bots: [] });
    expect(byEngine.deepseek).toBeUndefined();
  });

  it("shares one read between callers and throttles repeats", async () => {
    const { quota, calls, clock } = hub();
    await Promise.all([quota.refresh(), quota.refresh(), quota.view()]);
    expect(calls.codex).toBe(1);
    clock.now += QUOTA_MIN_INTERVAL_MS - 1;
    await quota.refresh();
    expect(calls.codex).toBe(1);
    clock.now += 1;
    await quota.refresh();
    expect(calls.codex).toBe(2);
  });

  it("keeps the last good numbers through a transient failure, but not through a logout", async () => {
    const { quota, set, clock } = hub();
    await quota.refresh();
    set({ status: "error", reason: "timeout", windows: [], balances: [] });
    clock.now += QUOTA_MIN_INTERVAL_MS;
    let codex = (await quota.refresh()).entries.find(entry => entry.engine === "codex")!;
    expect(codex).toMatchObject({ status: "error", reason: "timeout", updatedAt: NOW, checkedAt: NOW + QUOTA_MIN_INTERVAL_MS, windows: [{ usedPercent: 10 }] });
    set({ status: "login_required", windows: [], balances: [] });
    clock.now += QUOTA_MIN_INTERVAL_MS;
    codex = (await quota.refresh()).entries.find(entry => entry.engine === "codex")!;
    expect(codex).toMatchObject({ status: "login_required", windows: [] });
    expect(codex.updatedAt).toBeUndefined();
  });

  it("answers within the wait budget while a slow read continues", async () => {
    let release!: () => void;
    const { quota } = hub({ readers: { codex: () => new Promise<QuotaReading>(resolve => { release = () => resolve(ok(5)); }), antigravity: async () => ok(1), agyVersion: async () => undefined } });
    const view = await quota.refresh(5);
    expect(view.refreshing).toBe(true);
    expect(view.entries.find(entry => entry.engine === "codex")).toMatchObject({ status: "unknown" });
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await quota.refresh(0)).entries.find(entry => entry.engine === "codex")).toMatchObject({ status: "ok" });
  });

  it("reads Claude observations written by its Bots", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quota-"));
    await recordClaudeRateLimit(path.join(root, "bot_b"), { status: "allowed", rateLimitType: "seven_day", utilization: 0.5, resetsAt: Math.floor(NOW / 1000) + 3600 }, NOW - 1000);
    expect(await readEngineQuotaEvents(path.join(root, "bot_b"))).toBeDefined();
    const claude = (await hub().quota.view()).entries.find(entry => entry.engine === "claude")!;
    expect(claude).toMatchObject({ status: "ok", source: "event", updatedAt: NOW - 1000, windows: [{ id: "seven_day", usedPercent: 50 }] });
  });

  it("ignores a corrupt observation file instead of failing the view", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "quota-"));
    await mkdir(path.join(root, "bot_b"), { recursive: true });
    await writeFile(path.join(root, "bot_b", ENGINE_QUOTA_EVENTS_FILE), "{broken");
    expect((await hub().quota.view()).entries.find(entry => entry.engine === "claude")).toMatchObject({ status: "unknown" });
  });
});

describe("Hub quota API", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

  it("serves the owner, shares the CLI path and refuses other roles", async () => {
    const { initializeHost } = await import("../src/host-cli/setup.js");
    const { HubServer } = await import("../src/hub/server.js");
    const { startHubControl } = await import("../src/hub/service.js");
    const { LocalHostClient } = await import("../src/host-cli/client.js");
    const { engineQuotaCommand } = await import("../src/host-cli/engine-quota.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "quota-api-")); await initializeHost(root, "Quota fixture");
    const hub = await HubServer.start({ stateDir: root });
    const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
    const client = await LocalHostClient.connect(root, { enroll: true });
    cleanup.push(async () => { client.close(); await control(); await hub.close(); await rm(root, { recursive: true, force: true }); });
    // Never run a real engine CLI from a test.
    let reads = 0;
    Object.assign(hub, { engineQuota: new HubEngineQuota({ engines: () => [{ id: "codex", executable: "/bin/codex" }], env: () => ({}), bots: async () => [], botStateDir: id => path.join(root, "bots", id),
      readers: { codex: async () => { reads++; return { status: "ok", windows: [{ id: "codex:primary", usedPercent: 25 }], balances: [] }; }, antigravity: async () => ({ status: "unknown", windows: [], balances: [] }), agyVersion: async () => undefined } }) });
    expect(client.ready.serverCapabilities).toContain(ENGINE_QUOTA_CAPABILITY);
    const refreshed = await engineQuotaCommand(client, { refresh: true });
    expect(refreshed.entries).toEqual([expect.objectContaining({ engine: "codex", status: "ok", windows: [{ id: "codex:primary", usedPercent: 25 }] })]);
    expect((await engineQuotaCommand(client, {})).entries[0]).toMatchObject({ status: "ok" });
    expect(reads).toBe(1);
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await expect(client.request("/api/engines/quota")).rejects.toMatchObject({ status: 403 });
    await expect(client.request("/api/engines/quota/refresh", "POST", {})).rejects.toMatchObject({ status: 403 });
    expect(reads).toBe(1);
  });
});
