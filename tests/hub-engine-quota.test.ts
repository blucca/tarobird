import { expect, it, vi } from "vitest";
import { hubEngineQuotas } from "../src/hub/engine-quota.js";
import { HubError } from "../src/hub/errors.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import { engineQuotaCommand, engineQuotaGuidance, engineQuotaNotes, QUOTA_CLAUDE_UNVERIFIABLE_TEXT, QUOTA_EXPIRED_TEXT, QUOTA_REASON_TEXT, QUOTA_STATE_TEXT } from "../src/host-cli/engine-quota.js";
import { ENGINE_QUOTA_CAPABILITY, quotaHelpSchema, quotaReasonSchema, quotaStateSchema } from "../src/client-protocol/engine-quota.js";

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

// Fable Q4: headless users see the same status/reason wording as the App, not only a reason code.
it("CLI status and reason text is the App's own wording in both languages", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../client/src/EngineQuota.tsx", import.meta.url), "utf8");
  const en = JSON.parse(await readFile(new URL("../client/src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
  const pairs = [...Object.values(QUOTA_STATE_TEXT), ...Object.values(QUOTA_REASON_TEXT), QUOTA_CLAUDE_UNVERIFIABLE_TEXT, QUOTA_EXPIRED_TEXT];
  for (const [zh, english] of pairs) { expect(app).toContain(`t("${zh}")`); expect(en[zh]).toBe(english); }
  expect(Object.keys(QUOTA_REASON_TEXT).sort()).toEqual([...quotaReasonSchema.options].sort());
  expect(Object.keys(QUOTA_STATE_TEXT).sort()).toEqual([...quotaStateSchema.options].sort());
});

it("CLI notes explain why each Bot has no current reading, how to refresh it and where to look", () => {
  const scope = (id: string, engine: "codex" | "claude" | "kimi", snapshot: ReturnType<typeof unavailableQuota>) =>
    ({ ...snapshot, id, revision: `${id}_rev`, engine, label: `${id} Bot`, botIds: [id], sharing: "unverified" as const });
  const ready = { ...unavailableQuota("codex", "not_loaded", 1000), state: "ready" as const, reason: undefined, capability: { mode: "active" as const }, observedAt: new Date(1000).toISOString() };
  const directory = { generatedAt: new Date(1000).toISOString(), scopes: [
    scope("current", "codex", ready),
    scope("expired", "codex", { ...ready, observedAt: new Date(-100_000).toISOString() }),
    scope("signin", "codex", unavailableQuota("codex", "login_required")),
    scope("apikey", "codex", unavailableQuota("codex", "mode_not_supported", 1000, "api_key")),
    scope("keyring", "codex", { ...unavailableQuota("codex", "scope_unverifiable"), nextRefreshAt: new Date(50_000).toISOString() }),
    scope("keychain", "claude", unavailableQuota("claude", "scope_unverifiable")),
    scope("kimi", "kimi", unavailableQuota("kimi", "not_adapted")),
  ] };
  const notes = engineQuotaNotes(directory, 2000), text = notes.join("\n");
  expect(text).not.toMatch(/current Bot/);
  expect(notes).toContain("expired Bot（Codex）：待更新 — 已过期，需重新读取 / Awaiting update — Expired; refresh required");
  expect(notes).toContain("signin Bot（Codex）：需要登录 — 请先在运行主机上完成引擎登录，再刷新。 / Sign-in required — Sign in to the engine on the Host, then refresh.");
  expect(notes).toContain("apikey Bot（Codex）：暂不支持 — 此授权方式不提供可读取的原生额度。 / Not supported — This authorization mode does not provide readable native quotas.");
  expect(text).toContain(`keyring Bot（Codex）：尚无数据 — ${QUOTA_REASON_TEXT.scope_unverifiable[0]}`);
  expect(text).toContain(`keychain Bot（Claude Code）：尚无数据 — ${QUOTA_CLAUDE_UNVERIFIABLE_TEXT[0]}`);
  // Refresh commands only for active readers that can refresh, with the App's cooldown.
  expect(notes).toContain("  刷新 / Refresh: tarobird engines quota --bot signin --refresh --revision signin_rev");
  expect(notes).toContain(`  刷新 / Refresh（${new Date(50_000).toISOString()} 后 / after ${new Date(50_000).toISOString()}）: tarobird engines quota --bot keyring --refresh --revision keyring_rev`);
  expect(text).not.toMatch(/--bot (apikey|keychain|kimi) /);
  expect(notes.filter(line => line.includes("官方查看")).length).toBeGreaterThan(0);
  expect(notes.at(-1)).toMatch(/^kimi Bot: 官方查看/);
});
