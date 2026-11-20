import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerAdapter, type AppServerSpawnCodex } from "../src/codex/app-server-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { AdapterQuotaCache } from "../src/codex/adapter-account-quota.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const account = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" }, requiresOpenaiAuth: true, userId: "fixture-user" };
class Child extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); methods: string[] = []; killCount = 0; closed = false;
  hold = new Set<string>(); closeDelayMs = 20;
  stdin = { write: (line: string, callback?: (error?: Error | null) => void) => {
    const request = JSON.parse(line); this.methods.push(request.method);
    if (request.id != null && !this.hold.has(request.method)) queueMicrotask(() => this.reply(request.id,
      request.method === "account/read" ? account : request.method === "account/rateLimits/read" ? { accountId: "fixture-account", rateLimits: { primary: { usedPercent: 25 } } } : {}));
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
