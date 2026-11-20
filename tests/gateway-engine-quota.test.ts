import { expect, it, vi } from "vitest";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import type { EngineQuotaReadResult } from "../src/codex/adapter.js";

const snapshot = () => ({ ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, pools: [{
  id: "pool", label: "Codex", sharing: "shared" as const, availability: "unknown" as const, balances: [], constraints: [],
  windows: [{ id: "short", label: "5 hours", metric: "percent" as const, usedPercent: 25, availability: "unknown" as const,
    observedAt: new Date(1000).toISOString(), expiresAt: new Date(61_000).toISOString(), resetsAt: new Date(50_000).toISOString() }],
}] });

it("reads cached native quotas without refreshing and omits private account proof", async () => {
  const read = vi.fn(async () => ({ revision: "one", snapshot: snapshot(), proof: { engine: "codex" as const, scopeStamp: "private", accountKey: "private" } }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const result = await run({ scopeId: "bot", refresh: false });
  expect(read).toHaveBeenCalledOnce(); expect(read.mock.calls[0]?.[0]).toMatchObject({ refresh: false });
  expect(result.value).toMatchObject({ botIds: ["bot"], sharing: "unverified", revision: "one" });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("coalesces explicit refresh and does not repeat it within the cooldown", async () => {
  let resolve!: (value: EngineQuotaReadResult) => void;
  const read = vi.fn((options: { refresh: boolean }) => options.refresh
    ? new Promise<EngineQuotaReadResult>(done => { resolve = done; }) : Promise.resolve({ revision: "one", snapshot: snapshot() }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const first = run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  const second = run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  resolve({ revision: "one", snapshot: snapshot() });
  const results = await Promise.all([first, second]);
  expect(results).toEqual([results[0], results[0]]);
  await run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  expect(read.mock.calls.filter(([options]) => options.refresh)).toHaveLength(1);
});

it("does not refresh or retain a previous account value after revision changed", async () => {
  const read = vi.fn(async () => ({ revision: "new", snapshot: snapshot() }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const result = await run({ scopeId: "bot", expectedRevision: "old", refresh: true });
  expect(result.value).toMatchObject({ revision: "new", reason: "auth_changed", pools: [] });
  expect(read).toHaveBeenCalledOnce();
});

it("does not attach an old in-flight refresh to a new account", async () => {
  let revision = "one", resolve!: (value: EngineQuotaReadResult) => void;
  const read = vi.fn((options: { refresh: boolean }) => options.refresh
    ? new Promise<EngineQuotaReadResult>(done => { resolve = done; }) : Promise.resolve({ revision, snapshot: unavailableQuota("codex", "not_loaded") }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read, now: () => 2000 });
  const first = run({ scopeId: "bot", expectedRevision: "one", refresh: true });
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  revision = "two";
  const second = await run({ scopeId: "bot", expectedRevision: "two", refresh: true });
  expect(second.value).toMatchObject({ revision: "two", pools: [] });
  resolve({ revision: "two", snapshot: unavailableQuota("codex", "auth_changed") }); await first;
});

it.each([50_000, 70_000])("marks elapsed reset or TTL stale without inventing a refill (%s)", async now => {
  const result = await gatewayEngineQuota({ botId: "bot", engine: "codex", read: async () => ({ revision: "one", snapshot: snapshot() }), now: () => now })({ scopeId: "bot", refresh: false });
  expect(result.value.state).toBe("stale");
  expect(result.value.pools[0]?.windows[0]).toMatchObject({ usedPercent: 25 });
});

it("keeps unsupported and passive engines read only", async () => {
  const missing = await gatewayEngineQuota({ botId: "bot", engine: "pi" })({ scopeId: "bot", refresh: false });
  expect(missing.value).toMatchObject({ state: "unsupported", pools: [] });
  const read = vi.fn(async () => ({ revision: "one", snapshot: unavailableQuota("claude", "no_passive_event") }));
  const run = gatewayEngineQuota({ botId: "bot", engine: "claude", read });
  await run({ scopeId: "bot", refresh: true, expectedRevision: "one" });
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]?.[0]).toMatchObject({ refresh: false });
});

it("rejects cross-Bot and unversioned refresh requests before reading", async () => {
  const read = vi.fn(); const run = gatewayEngineQuota({ botId: "bot", engine: "codex", read });
  await expect(run({ scopeId: "other", refresh: false })).rejects.toThrow();
  await expect(run({ scopeId: "bot", refresh: true })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
