import { expect, it, vi } from "vitest";
import { hubEngineQuotas } from "../src/hub/engine-quota.js";
import { HubError } from "../src/hub/errors.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import { engineQuotaCommand, engineQuotaGuidance } from "../src/host-cli/engine-quota.js";
import { ENGINE_QUOTA_CAPABILITY, quotaHelpSchema } from "../src/client-protocol/engine-quota.js";

function fixture() {
  let key = {}, visible = true, authorized = true;
  const call = vi.fn(async (_bot: string, _request: unknown) => ({ scopeId: "bot", revision: "rev", value: {
    ...unavailableQuota("codex", "not_loaded"), id: "bot", revision: "rev", engine: "codex", label: "untrusted label", botIds: ["bot"], sharing: "unverified",
  } }));
  const validate = vi.fn(async () => { if (!authorized) throw new HubError("device_revoked", 403); });
  const quotas = hubEngineQuotas({ bots: async () => visible ? [{ id: "bot", name: "My Bot", engine: "codex" }, { id: "worker", name: "Internal", engine: "codex", role: "worker" }] : [],
    connection: () => ({ key, supported: true, ready: true }), call, validate });
  return { call, quotas, replace: () => { key = {}; }, revoke: () => { authorized = false; }, remove: () => { visible = false; } };
}
it("keeps internal workers out, uses the owner directory label and only cached reads", async () => {
  const f = fixture(), result = await f.quotas.directory();
  expect(result.scopes).toHaveLength(1); expect(result.scopes[0]?.label).toBe("My Bot");
  expect(f.call).toHaveBeenCalledExactlyOnceWith("bot", { scopeId: "bot", refresh: false });
});
it("drops a reply when the worker was replaced during the read", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); f.replace(); return result; });
  expect(await f.quotas.scope("bot", false)).toMatchObject({ state: "offline", pools: [] });
});
it("rechecks earlier directory results after waiting for other workers", async () => {
  let key = {};
  const secondKey = {};
  const quotas = hubEngineQuotas({
    bots: async () => [{ id: "first", name: "First", engine: "codex" }, { id: "second", name: "Second", engine: "codex" }],
    connection: id => ({ key: id === "first" ? key : secondKey, supported: true, ready: true }),
    validate: async () => undefined,
    call: async id => {
      if (id === "second") { await new Promise(resolve => setImmediate(resolve)); key = {}; }
      return { scopeId: id, revision: "rev", value: { ...unavailableQuota("codex", "not_loaded"), id, revision: "rev", engine: "codex", label: id, botIds: [id], sharing: "unverified" } };
    },
  });
  expect((await quotas.directory()).scopes[0]).toMatchObject({ reason: "offline", pools: [] });
});
it("does not return quota data after owner authorization is revoked", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); f.revoke(); return result; });
  await expect(f.quotas.directory()).rejects.toMatchObject({ status: 403 });
});
it("drops deleted scopes and validates a single scope after the await", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); f.remove(); return result; });
  await expect(f.quotas.scope("bot", false)).rejects.toMatchObject({ status: 404 });
});
it("rejects mismatched public identities instead of returning another Bot's value", async () => {
  const f = fixture(), original = f.call.getMockImplementation()!;
  f.call.mockImplementation(async (...args) => { const result = await original(...args); result.value.botIds = ["other"]; return result; });
  expect(await f.quotas.scope("bot", false)).toMatchObject({ reason: "invalid_response", pools: [] });
});
it("isolates old and offline workers without issuing a native request", async () => {
  const call = vi.fn();
  const quotas = hubEngineQuotas({ bots: async () => [{ id: "old", name: "Old", engine: "codex" }, { id: "offline", name: "Offline", engine: "claude" }],
    connection: id => id === "old" ? { key: {}, supported: false, ready: true } : undefined, call, validate: async () => {} });
  const result = await quotas.directory();
  expect(result.scopes.map(scope => scope.reason)).toEqual(["host_upgrade_required", "offline"]); expect(call).not.toHaveBeenCalled();
});
it("CLI refresh uses exactly the same versioned scope and never creates a turn", async () => {
  const f = fixture(), value = await f.quotas.scope("bot", false);
  const client = { ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY] }, request: vi.fn(async () => value) };
  await engineQuotaCommand(client as never, { bot: "bot", refresh: true, revision: "rev" });
  expect(client.request).toHaveBeenCalledExactlyOnceWith("/api/engine-quotas/bot?refresh=1&revision=rev");
  await expect(engineQuotaCommand(client as never, { refresh: true })).rejects.toThrow();
  expect(client.request).toHaveBeenCalledOnce();
});

// #47-C: the verified official viewing guidance reaches CLI users without changing the JSON contract.
it("CLI guidance names verified official views only for Bots without a current reading", () => {
  const scope = (id: string, engine: "codex" | "kimi" | "pi" | "claude", snapshot: ReturnType<typeof unavailableQuota>) =>
    ({ ...snapshot, id, revision: `${id}_rev`, engine, label: `${id} Bot`, botIds: [id], sharing: "unverified" as const });
  const ready = { ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, reason: undefined, observedAt: new Date(1000).toISOString(), constraints: [{ code: "ordinary_usage_blocked" as const, availability: "blocked" as const, resetsAt: new Date(20_000).toISOString() }] };
  const directory = { generatedAt: new Date(1000).toISOString(), scopes: [
    scope("current", "codex", ready), scope("kimi_a", "kimi", unavailableQuota("kimi", "not_adapted")),
    scope("kimi_b", "kimi", unavailableQuota("kimi", "not_adapted")), scope("pi", "pi", unavailableQuota("pi", "not_adapted")),
    scope("writer", "claude", unavailableQuota("claude", "scope_unverifiable")),
  ] };
  const lines = engineQuotaGuidance(directory, 2000);
  expect(lines).toEqual([expect.stringMatching(/^kimi_a Bot, kimi_b Bot: .*\/usage.*ACP/), expect.stringMatching(/^writer Bot: .*claude\.ai\/settings\/usage/)]);
  expect(lines.join("\n")).not.toMatch(/_rev|current/);
  // The same reading becomes guidance-worthy once its constraint reset passes.
  expect(engineQuotaGuidance(directory.scopes[0]!, 20_000)).toEqual([expect.stringContaining("Codex CLI")]);
  for (const help of quotaHelpSchema.options) expect(engineQuotaGuidance({ ...directory.scopes[1]!, help }, 2000)[0]).toMatch(/官方查看.+ \/ Official view/);
});
