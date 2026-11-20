import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAdapter, type AppServerSpawnCodex } from "../src/codex/app-server-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { AdapterQuotaCache } from "../src/codex/adapter-account-quota.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const account = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" }, requiresOpenaiAuth: true, userId: "fixture-user" };
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); methods: string[] = []; killCount = 0; closed = false;
  hold = new Set<string>(); closeDelayMs = 20; accounts: unknown[] = []; limits?: unknown;
  stdin = { write: (line: string, callback?: (error?: Error | null) => void) => {
    const request = JSON.parse(line); this.methods.push(request.method);
    if (request.id != null && !this.hold.has(request.method)) queueMicrotask(() => this.reply(request.id,
      request.method === "account/read" ? this.accounts.length ? this.accounts.shift() : account : request.method === "account/rateLimits/read" ? this.limits ?? { accountId: "fixture-account", rateLimits: { primary: { usedPercent: 25 } } } : {}));
    callback?.(null); return true;
  }, end: () => undefined, on: () => undefined };
  reply(id: unknown, result: unknown) { this.stdout.emit("data", JSON.stringify({ id, result }) + "\n"); }
  event(value: unknown) { this.stdout.emit("data", JSON.stringify(value) + "\n"); }
  kill() { this.killCount++; if (!this.closed) setTimeout(() => { if (this.closed) return; this.closed = true; this.emit("close", 0); }, this.closeDelayMs); }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-scope-")); roots.push(root);
  const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-fixture", account_id: "fixture-account" } }));
  return { root, home, codexHome, env: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH } };
}
it("cached quota reads never spawn; active Process reads close the owned child before resolving", async () => {
  const f = await fixture(), children: Child[] = [];
  const spawn = vi.fn(() => { const child = new Child(); children.push(child); return child; });
  const adapter = new ProcessCodexAdapter("codex", f.env, spawn, undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  const cached = await adapter.getAccountQuota({ refresh: false }); expect(spawn).not.toHaveBeenCalled();
  expect(cached.snapshot).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
  const result = await adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision });
  expect(result.snapshot.state).toBe("ready");
  expect(children[0].closed).toBe(true);
  expect(children[0].methods.filter(method => !["initialize", "initialized"].includes(method))).toEqual(["account/read", "account/rateLimits/read", "account/read"]);
  expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0].windows[0]).toMatchObject({ usedPercent: 25 });
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("a quota read timeout cannot kill an existing app-server", async () => {
  const f = await fixture(), child = new Child();
  const adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  child.hold.add("account/rateLimits/read");
  const result = await adapter.getAccountQuota({ refresh: true, timeoutMs: 30 });
  expect(result.snapshot.reason).toBe("timeout"); expect(child.killCount).toBe(0);
  await expect((adapter as any).request("config/read", {}, { timeoutMs: 100 })).resolves.toEqual({});
  expect(child.killCount).toBe(0);
});
it("changing credential bytes invalidates the cache and rejects the old revision", async () => {
  const f = await fixture(), adapter = new ProcessCodexAdapter("codex", f.env, () => new Child(), undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  const first = await adapter.getAccountQuota({ refresh: true });
  await writeFile(path.join(f.codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "different-fixture", account_id: "other-fixture" } }));
  const next = await adapter.getAccountQuota({ refresh: false, expectedRevision: first.revision });
  expect(next.revision).not.toBe(first.revision); expect(next.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
});
it("an external login switch cannot attribute a live old worker to new on-disk credentials", async () => {
  const f = await fixture(), child = new Child(), adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  await writeFile(path.join(f.codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "changed", account_id: "other" } }));
  const result = await adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot.reason).toBe("auth_changed"); expect(child.methods).not.toContain("account/read"); expect(child.killCount).toBe(0);
});
it("destroy during a quota helper's initialize cancels it and waits for its actual close", async () => {
  const f = await fixture(), child = new Child(); child.hold.add("initialize"); child.closeDelayMs = 60;
  const adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
  const read = adapter.getAccountQuota({ refresh: true });
  const stopped = adapter.destroy();
  expect(child.closed).toBe(false);
  await stopped;
  expect(child.closed).toBe(true);
  expect((await read).snapshot.reason).toBe("cancelled");
  expect(child.methods).not.toContain("account/read");
});
it("Claude quota refresh is passive, and rejects late events from a changed credential source", async () => {
  const f = await fixture(), child = new Child();
  const env = { HOME: f.home, CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth" };
  const spawn = vi.fn(() => child);
  const adapter = new ClaudeStreamAdapter("claude", { childEnv: env, spawnFn: spawn, workspacePath: f.root, idleSweepIntervalMs: 0 });
  disposals.push(() => adapter.destroy());
  expect((await adapter.getAccountQuota({ refresh: true })).snapshot.reason).toBe("no_passive_event"); expect(spawn).not.toHaveBeenCalled();
  const worker = await (adapter as any).getOrCreateWorker("tarobot-fixture", null, null, "normal", f.root);
  const event = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.25 } };
  child.event(event);
  const first = await adapter.getAccountQuota({ refresh: true });
  expect(first.snapshot.pools[0].windows[0]).toMatchObject({ usedPercent: 25 });
  expect(child.methods).toEqual([]);
  env.CLAUDE_CODE_OAUTH_TOKEN = "other-synthetic-oauth";
  child.event(event);
  expect((await adapter.getAccountQuota({ refresh: true })).snapshot.pools).toEqual([]);
  expect(child.methods).toEqual([]);
  worker.retired = true; child.event(event);
  expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools).toEqual([]);
});
it("does not treat opaque native Keychain or dynamic helpers as proof of a stable account", async () => {
  const f = await fixture();
  await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  const cache = new AdapterQuotaCache("codex", "codex", f.env, f.root);
  expect(cache.capture("live").verifiable).toBe(false);
  const claude = new AdapterQuotaCache("claude", "claude", { HOME: f.home }, f.root);
  expect(claude.capture("live").verifiable).toBe(false);
});
it("does not read an oversized credential file into an unbounded buffer", async () => {
  const f = await fixture();
  await writeFile(path.join(f.codexHome, "auth.json"), " ".repeat(1024 * 1024 + 1));
  const cache = new AdapterQuotaCache("codex", "codex", f.env, f.root);
  expect(cache.capture("live").verifiable).toBe(false);
});

it("joins both quota and history helpers on Process adapter destruction", async () => {
  const f = await fixture(), children: Child[] = [];
  const adapter = new ProcessCodexAdapter("codex", f.env, () => {
    const child = new Child(); child.hold.add("initialize"); child.closeDelayMs = 30; children.push(child); return child;
  }, undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  const quota = adapter.getAccountQuota({ refresh: true });
  const history = adapter.getHistoryState("thread-fixture");
  await vi.waitFor(() => expect(children).toHaveLength(2));
  expect(children.every(child => !child.closed)).toBe(true);
  await adapter.destroy();
  expect(children.every(child => child.closed)).toBe(true);
  expect((await quota).snapshot.reason).toBe("cancelled");
  expect(await history).toMatchObject({ blocked: "not_ready" });
  expect(children.flatMap(child => child.methods)).not.toContain("thread/fork");
  expect(adapter.hasPendingNativeWork()).toBe(false);
});

// #47-B: Codex's public account/read separates "not signed in" from "credential source cannot be verified".
// Synthetic identities only; nothing here reads a real login, Keychain item or browser state.
async function opaqueFixture(kind: "missing" | "keyring") {
  const f = await fixture();
  if (kind === "missing") await rm(path.join(f.codexHome, "auth.json"));
  else { await rm(path.join(f.codexHome, "auth.json")); await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n'); }
  const children: Child[] = [], accounts: unknown[][] = [];
  const limits: unknown[] = [];
  const spawn = vi.fn(() => { const child = new Child(); child.accounts = accounts.shift() ?? []; child.limits = limits.shift(); children.push(child); return child; });
  const adapter = new ProcessCodexAdapter("codex", f.env, spawn, undefined, undefined, undefined, f.root);
  disposals.push(() => adapter.destroy());
  return { adapter, spawn, children, accounts, limits };
}
const methodsOf = (child: Child) => child.methods.filter(method => !["initialize", "initialized"].includes(method));
it("an explicit refresh lets native Codex report that no account is signed in", async () => {
  const f = await opaqueFixture("missing");
  const cached = await f.adapter.getAccountQuota({ refresh: false });
  expect(cached.snapshot).toMatchObject({ state: "unknown", reason: "scope_unverifiable", pools: [] }); expect(f.spawn).not.toHaveBeenCalled();
  f.accounts.push([{ account: null, requiresOpenaiAuth: true }]);
  const result = await f.adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision });
  expect(result.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "codex_usage" });
  expect(methodsOf(f.children[0]!)).toEqual(["account/read"]); expect(f.children[0]!.closed).toBe(true);
});
it("a keyring login is read once through native identity checks and never retained", async () => {
  const f = await opaqueFixture("keyring");
  const first = await f.adapter.getAccountQuota({ refresh: false });
  expect(first.snapshot.reason).toBe("scope_unverifiable");
  const result = await f.adapter.getAccountQuota({ refresh: true, expectedRevision: first.revision });
  expect(result.snapshot).toMatchObject({ state: "ready", authMode: "subscription" }); expect(result.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 25 });
  expect(result).not.toHaveProperty("proof");
  expect(methodsOf(f.children[0]!)).toEqual(["account/read", "account/rateLimits/read", "account/read"]);
  // Later cache reads cannot prove the keyring still holds that account.
  expect((await f.adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  expect(f.spawn).toHaveBeenCalledOnce();
});
it("a keyring account switch during the read is rejected without values", async () => {
  const f = await opaqueFixture("keyring");
  f.accounts.push([account, { ...account, account: { ...account.account, email: "second@example.invalid" }, userId: "second-user" }]);
  const result = await f.adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot).toMatchObject({ reason: "auth_changed", pools: [] });
});
it("a native API-key answer stays unsupported and never reads subscription limits", async () => {
  const f = await opaqueFixture("missing");
  f.accounts.push([{ account: { type: "apiKey" }, requiresOpenaiAuth: false }]);
  const result = await f.adapter.getAccountQuota({ refresh: true });
  expect(result.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key", pools: [] });
  expect(methodsOf(f.children[0]!)).toEqual(["account/read"]);
});
it("a live keyring worker answers one explicit Gateway refresh without being stopped or cached", async () => {
  const f = await fixture(), child = new Child();
  await rm(path.join(f.codexHome, "auth.json")); await writeFile(path.join(f.codexHome, "config.toml"), 'cli_auth_credentials_store = "auto"\n');
  const adapter = new CodexAppServerAdapter("codex", f.root, f.env, () => child);
  disposals.push(() => adapter.destroy());
  await (adapter as any).startChildAndInitialize(["app-server"]);
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read: options => adapter.getAccountQuota(options) });
  const listed = await run({ scopeId: "bot", refresh: false });
  expect(listed.value).toMatchObject({ reason: "scope_unverifiable", capability: { mode: "active" } }); expect(child.methods).not.toContain("account/read");
  const refreshed = await run({ scopeId: "bot", refresh: true, expectedRevision: listed.revision });
  expect(refreshed.value).toMatchObject({ state: "ready", sharing: "unverified" }); expect(child.killCount).toBe(0);
  expect((await run({ scopeId: "bot", refresh: false })).value).toMatchObject({ reason: "scope_unverifiable", pools: [] });
});
it("Claude's unverifiable passive source stays hidden even on an explicit refresh", async () => {
  const f = await fixture();
  const cache = new AdapterQuotaCache("claude", "claude", { HOME: f.home }, f.root);
  const scope = cache.capture("live");
  expect(scope.verifiable).toBe(false);
  expect(cache.response(scope, { refresh: true })?.snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
});
// Real-CLI acceptance, opt-in: TAROBIRD_QUOTA_REAL_CODEX=/path/to/codex. Empty isolated home, file credential
// store, no API key: no real login, Keychain item or network account is consulted, and no thread is created.
it.skipIf(!process.env.TAROBIRD_QUOTA_REAL_CODEX)("real Codex CLI reports no sign-in for an empty isolated home without starting a turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-real-codex-")); roots.push(root);
  const home = path.join(root, "home"), codexHome = path.join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  const env = { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH };
  const adapter = new ProcessCodexAdapter(process.env.TAROBIRD_QUOTA_REAL_CODEX!, env, undefined, undefined, undefined, undefined, root);
  disposals.push(() => adapter.destroy());
  const cached = await adapter.getAccountQuota({ refresh: false });
  expect(cached.snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  const result = await adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision, timeoutMs: 7000 });
  expect(result.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "codex_usage" });
  expect((await adapter.getAccountQuota({ refresh: false })).snapshot.reason).toBe("scope_unverifiable");
  expect(adapter.hasPendingNativeWork()).toBe(false);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(codexHome)).not.toContain("sessions");
  expect(await readdir(codexHome)).not.toContain("auth.json");
}, 30_000);

// Codex 0.170.0 schema: GetAccountResponse.userId is "when available", ChatgptAccount.email may be null and
// GetAccountRateLimitsResponse.accountId is "when supplied by the backend". Upstream guarantees no identity, so a
// one-shot read of an opaque credential source must carry a stable user and billed account itself.
describe("one-shot opaque Codex reads require a distinguishable native account", () => {
  const limitsB = { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 60 } }, accountId: "workspace-B" };
  const chatgpt = (extra: Record<string, unknown> = {}, accountExtra: Record<string, unknown> = {}) => ({ requiresOpenaiAuth: true, account: { type: "chatgpt", ...accountExtra }, ...extra });
  const rejected = async (account: unknown, limits: unknown = limitsB) => {
    const f = await opaqueFixture("keyring");
    f.accounts.push([account, account]); f.limits.push(limits);
    const result = await f.adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot).toMatchObject({ pools: [], constraints: [], availability: "unknown" });
    expect(result.snapshot.state).not.toBe("ready"); expect(result).not.toHaveProperty("proof");
    return result.snapshot.reason;
  };
  it("rejects the reported counterexample: type only, no user, no billed-account link", async () => {
    expect(await rejected(chatgpt())).toBe("scope_unverifiable");
  });
  it.each([
    ["plan only", chatgpt({}, { planType: "pro" })],
    ["email and plan without a user id", chatgpt({}, { email: "fixture@example.invalid", planType: "pro" })],
    ["empty user id", chatgpt({ userId: "" }, { planType: "pro" })],
    ["whitespace user id", chatgpt({ userId: "   " }, { planType: "pro" })],
    ["user id with inner space", chatgpt({ userId: "user one" }, { planType: "pro" })],
    ["over-long user id", chatgpt({ userId: "u".repeat(513) }, { planType: "pro" })],
  ])("rejects an unidentifiable account (%s)", async (_label, account) => {
    expect(await rejected(account)).toBe("scope_unverifiable");
  });
  it("rejects a native user id beyond the native identity bound as an invalid response", async () => {
    expect(await rejected(chatgpt({ userId: "u".repeat(4097) }))).toBe("invalid_response");
  });
  it.each([
    ["missing", { rateLimits: { primary: { usedPercent: 30 } } }],
    ["empty", { rateLimits: { primary: { usedPercent: 30 } }, accountId: "" }],
    ["over-long", { rateLimits: { primary: { usedPercent: 30 } }, accountId: "a".repeat(513) }],
  ])("rejects a user without a %s billed account id", async (_label, limits) => {
    expect(await rejected(chatgpt({ userId: "fixture-user" }, { planType: "pro" }), limits)).toBe("scope_unverifiable");
  });
  it("still shows a one-shot reading when the native user and billed account are both identified", async () => {
    const f = await opaqueFixture("keyring");
    const account = chatgpt({ userId: "fixture-user" }, { planType: "pro", email: null });
    f.accounts.push([account, account]); f.limits.push(limitsB);
    const result = await f.adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot).toMatchObject({ state: "ready" }); expect(result.snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 30 });
    expect((await f.adapter.getAccountQuota({ refresh: false })).snapshot).toMatchObject({ reason: "scope_unverifiable", pools: [] });
  });
  it("keeps native not-signed-in and API-key answers without requiring an account id", async () => {
    const missing = await opaqueFixture("keyring"); missing.accounts.push([{ account: null, requiresOpenaiAuth: true }]);
    expect((await missing.adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ state: "login_required", pools: [] });
    const key = await opaqueFixture("keyring"); key.accounts.push([{ account: { type: "apiKey" }, requiresOpenaiAuth: false }]);
    expect((await key.adapter.getAccountQuota({ refresh: true })).snapshot).toMatchObject({ reason: "mode_not_supported", authMode: "api_key", pools: [] });
  });
  it("keeps a file-verified login readable even when native identity fields are absent", async () => {
    const f = await fixture(), child = new Child();
    child.accounts = [chatgpt({}, { planType: "pro" }), chatgpt({}, { planType: "pro" })]; child.limits = limitsB;
    const adapter = new ProcessCodexAdapter("codex", f.env, () => child, undefined, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());
    const result = await adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot).toMatchObject({ state: "ready" });
    expect((await adapter.getAccountQuota({ refresh: false })).snapshot.pools[0]?.windows[0]).toMatchObject({ usedPercent: 30 });
  });
});
