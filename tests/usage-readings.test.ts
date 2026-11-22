import { describe, expect, it } from "vitest";
import type { QuotaScope, QuotaWindow } from "../src/client-protocol/engine-quota.js";
import { contextView, mayAskEngine, nextHeldQuota, poolCoversModel, quotaView, quotaViewEndsAt, shortTokens, usageTone, QUOTA_SHOWN_FOR_MS, QUOTA_SIGN_IN_RETRY_MS } from "../client/src/usage-readings.js";

const now = Date.parse("2026-11-22T10:00:00Z");
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const window = (id: string, usedPercent: number, extra: Partial<QuotaWindow> = {}): QuotaWindow =>
  ({ id, label: id, metric: "percent", usedPercent, availability: "unknown", observedAt: iso(-1), expiresAt: iso(0), resetsAt: iso(120), ...extra }) as QuotaWindow;
const scope = (engine: QuotaScope["engine"], pools: Array<{ label: string; models?: string[]; windows: QuotaWindow[]; constraints?: QuotaScope["constraints"] }>, extra: Partial<QuotaScope> = {}): QuotaScope => ({
  id: "bot", revision: "r", engine, label: engine, botIds: ["bot"], sharing: "unverified", authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown",
  observedAt: iso(-1), constraints: [], pools: pools.map((pool, index) => ({ id: `p${index}`, label: pool.label, ...(pool.models ? { models: pool.models } : {}), sharing: pool.models ? "model" : "shared", availability: "unknown", windows: pool.windows, balances: [], constraints: pool.constraints ?? [] })), ...extra });

describe("context left", () => {
  it("is the share of the window not in use, with the engine's compaction point", () => {
    expect(contextView({ supported: true, usedTokens: 76_000, windowTokens: 200_000, autoCompactTokens: 167_000 })).toEqual({ left: 62, usedTokens: 76_000, windowTokens: 200_000, compactAt: 84 });
    expect(contextView({ supported: true, usedTokens: 250_000, windowTokens: 200_000 })).toMatchObject({ left: 0 });
    expect(contextView({ supported: true, usedTokens: 0, windowTokens: 200_000 })).toEqual({ left: 100, usedTokens: 0, windowTokens: 200_000 });
  });
  it("is absent without a sample", () => {
    for (const usage of [undefined, { supported: false }, { supported: true }, { supported: true, usedTokens: 5 }, { supported: true, windowTokens: 5 }]) expect(contextView(usage)).toBeUndefined();
  });
});

describe("quota left for one Bot", () => {
  it("shows the tightest window of a pool that names no models", () => {
    const view = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { periodSeconds: 18000 }), window("secondary", 10, { periodSeconds: 604800 })] }]), "gpt-6.1-sol", now)!;
    expect(view.left).toBe(80);
    expect(view.windows.map(item => [item.pool, item.left, item.periodSeconds])).toEqual([["Codex", 80, 18000], ["Codex", 90, 604800]]);
  });
  // The three groups agy 1.5.14 reports, with the model names of `agy models`.
  const agy = scope("antigravity", [
    { label: "Gemini Models", models: ["Gemini 4 Neon", "Gemini 4 Hydrogen", "Orchestrator (Neon)", "Gemini 3.8 Flash"], windows: [window("gemini-weekly", 37), window("gemini-5h", 6)] },
    { label: "Claude and GPT models", models: ["Claude Opus 5.5", "Claude Sonnet 5.5", "GPT-OSS 120B"], windows: [window("3p-weekly", 55), window("3p-5h", 0)] },
    { label: "Gemini 4 Argon", models: ["Gemini 4 Argon"], windows: [window("gemini-argon-wtu-weekly", 100)] },
  ]);
  it.each([["gemini-4-neon-high", "Gemini Models", 63], ["gemini-3.8-flash-low", "Gemini Models", 63], ["claude-opus-5-5-medium", "Claude and GPT models", 45], ["gpt-oss-120b-medium", "Claude and GPT models", 45], ["gemini-4-argon-medium", "Gemini 4 Argon", 0]])(
    "counts only the group of the Bot's model (%s)", (model, pool, left) => {
      const view = quotaView(agy, model, now)!;
      expect(view.left).toBe(left); expect(new Set(view.windows.map(item => item.pool))).toEqual(new Set([pool]));
    });
  it("shows nothing when the Bot's group cannot be told, instead of another group's alarm", () => {
    for (const model of ["", "gemini-pro-orchestrator-g1-pro", "some-future-model"]) expect(quotaView(agy, model, now)).toBeUndefined();
  });
  it("matches a model name only as a whole", () => {
    expect(poolCoversModel(["Gemini 4 Neon"], "gemini-4-neon")).toBe(true);
    expect(poolCoversModel(["Gemini 4 Neon"], "gemini-4-neon-xhigh")).toBe(true);
    expect(poolCoversModel(["gpt-5.3-codex-spark"], "gpt-5.3-codex-spark")).toBe(true);
    expect(poolCoversModel(["Gemini 4"], "gemini-4-neon-high")).toBe(false);
    expect(poolCoversModel(["Gemini 4 Neon"], "gemini-4-neon-preview-high")).toBe(false);
    expect(poolCoversModel(["()", ""], "gemini-4-neon")).toBe(false);
  });
  it("counts Claude's per-model weekly window only for a Bot on that model, and never extra usage", () => {
    const claude = scope("claude", [{ label: "Claude", windows: [window("five_hour", 12), window("seven_day", 40), window("seven_day_opus", 100), window("seven_day_sonnet", 70), window("overage", 100), window("seven_day_overage_included", 99)] }]);
    expect(quotaView(claude, "sonnet", now)!.windows.map(item => item.label)).toEqual(["five_hour", "seven_day", "seven_day_sonnet"]);
    expect(quotaView(claude, "claude-opus-5-5", now)!.left).toBe(0);
    expect(quotaView(claude, "", now)).toMatchObject({ left: 60, windows: [{ label: "five_hour" }, { label: "seven_day" }] });
  });
  it("counts a Claude model's own weekly pool only for a Bot on that model family", () => {
    const claude = scope("claude", [{ label: "Claude", windows: [window("seven_day", 31)] }, { label: "Fable", models: ["Fable"], windows: [window("seven_day", 64)] }]);
    for (const model of ["claude-fable-5-2", "fable", "Fable[1m]"]) expect(quotaView(claude, model, now)).toMatchObject({ left: 36, windows: [{ pool: "Claude", left: 69 }, { pool: "Fable", left: 36 }] });
    for (const model of ["opus", "claude-sonnet-5-5", ""]) expect(quotaView(claude, model, now)).toMatchObject({ left: 69, windows: [{ pool: "Claude" }] });
    // Another engine's pool is never matched by a part of a name.
    expect(quotaView(scope("antigravity", [{ label: "Fable", models: ["Fable"], windows: [window("weekly", 64)] }]), "claude-fable-5-2", now)).toBeUndefined();
  });
  it("leaves out a window past its reset time and a window without a number", () => {
    const view = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 99, { resetsAt: iso(-1) }), window("secondary", 30), { ...window("other", 0), metric: "unknown" } as QuotaWindow] }]), "", now)!;
    expect(view).toMatchObject({ left: 70, windows: [{ label: "secondary" }] });
    expect(quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 99, { resetsAt: iso(-1) })] }]), "", now)).toBeUndefined();
  });
  it("keeps a stale reading for half an hour and no longer", () => {
    const pools = [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(600) })] }];
    expect(quotaView(scope("codex", pools, { state: "stale", observedAt: iso(-29) }), "", now)).toMatchObject({ left: 80 });
    expect(quotaView(scope("codex", pools, { state: "stale", observedAt: iso(-30) }), "", now)).toBeUndefined();
    for (const state of ["unknown", "login_required", "offline", "unavailable", "unsupported"] as const) expect(quotaView(scope("codex", pools, { state }), "", now)).toBeUndefined();
    expect(quotaView(scope("codex", pools, { observedAt: undefined }), "", now)).toBeUndefined();
    expect(quotaView(undefined, "", now)).toBeUndefined();
  });
  it("does not count an Antigravity group that names no models (an older Host), instead of alarming every Bot", () => {
    const old = scope("antigravity", [{ label: "Gemini Models", windows: [window("gemini-weekly", 37)] }, { label: "Gemini 4 Argon", windows: [window("argon-weekly", 100)] }]);
    for (const model of ["gemini-4-neon-high", "gemini-4-argon-medium", ""]) expect(quotaView(old, model, now)).toBeUndefined();
  });
  it("shows nothing left when the engine refuses ordinary use, whatever the windows say", () => {
    const blocked = (code: QuotaScope["constraints"][number]["code"], extra: Partial<QuotaScope["constraints"][number]> = {}) => [{ code, availability: "blocked" as const, ...extra }];
    const codex = (constraints: QuotaScope["constraints"], pool: QuotaScope["constraints"] = []) => scope("codex", [{ label: "Codex", windows: [window("primary", 40)], constraints: pool }], { constraints });
    expect(quotaView(codex(blocked("ordinary_usage_blocked")), "", now)).toMatchObject({ left: 0, blocked: ["ordinary_usage_blocked"], windows: [{ left: 60 }] });
    expect(quotaView(codex([], [...blocked("spend_control"), ...blocked("credits_depleted")]), "", now)).toMatchObject({ left: 0, blocked: ["spend_control", "credits_depleted"] });
    // Disabled extra usage, a warning, or a block whose own reset has passed is not a refusal.
    expect(quotaView(codex(blocked("overage_disabled")), "", now)).toMatchObject({ left: 60, blocked: [] });
    expect(quotaView(codex([{ code: "spend_control", availability: "warning" }]), "", now)).toMatchObject({ left: 60, blocked: [] });
    expect(quotaView(codex(blocked("credits_depleted", { resetsAt: iso(-1) })), "", now)).toMatchObject({ left: 60, blocked: [] });
    // A block without any window is still a reading; a block on another model's pool is not this Bot's.
    expect(quotaView(scope("codex", [], { constraints: blocked("ordinary_usage_blocked") }), "", now)).toMatchObject({ left: 0, windows: [], blocked: ["ordinary_usage_blocked"] });
    const other = scope("antigravity", [{ label: "Gemini Models", models: ["Gemini 4 Neon"], windows: [window("weekly", 10)] }, { label: "Gemini 4 Argon", models: ["Gemini 4 Argon"], windows: [], constraints: blocked("other_native_limit") }]);
    expect(quotaView(other, "gemini-4-neon-high", now)).toMatchObject({ left: 90, blocked: [] });
    expect(quotaView(other, "gemini-4-argon-low", now)).toMatchObject({ left: 0, blocked: ["other_native_limit"] });
  });
  it("clamps an overdrawn window to nothing left", () => {
    expect(quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 140)] }]), "", now)!.left).toBe(0);
  });
  it("ends at the earlier of its age limit and its next reset", () => {
    const soon = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(5) })] }]), "", now)!;
    expect(quotaViewEndsAt(soon)).toBe(Date.parse(iso(5)));
    const later = quotaView(scope("codex", [{ label: "Codex", windows: [window("primary", 20, { resetsAt: iso(600) })] }]), "", now)!;
    expect(quotaViewEndsAt(later)).toBe(Date.parse(iso(-1)) + QUOTA_SHOWN_FOR_MS);
  });
});

it("turns amber at a fifth left and red at a twentieth", () => {
  expect([100, 21, 20, 6, 5, 0].map(usageTone)).toEqual(["ok", "ok", "low", "low", "empty", "empty"]);
});
it("shortens token counts", () => {
  expect([0, 999, 1000, 1240, 9949, 76_000, 199_600, 1_000_000, 1_250_000].map(shortTokens)).toEqual(["0", "999", "1k", "1.2k", "9.9k", "76k", "200k", "1M", "1.3M"]);
});

describe("what the App holds and when it asks the engine", () => {
  const reading = (minutes: number, extra: Partial<QuotaScope> = {}) => scope("codex", [{ label: "Codex", windows: [window("primary", 20)] }], { observedAt: iso(minutes), ...extra });
  const without = (reason: QuotaScope["reason"], extra: Partial<QuotaScope> = {}): QuotaScope => ({ ...scope("codex", [], { observedAt: undefined, state: "unknown" }), reason, ...extra });
  it("keeps the held reading when the Hub answers for a worker that did not", () => {
    const held = reading(-2);
    for (const reason of ["offline", "timeout", "invalid_response", "host_upgrade_required"] as const) expect(nextHeldQuota(held, without(reason, { revision: reason, state: "unavailable" }))).toBe(held);
    // The worker's own timeout carries its real revision: nothing new, the reading stays.
    expect(nextHeldQuota(held, without("timeout", { state: "unavailable" }))).toBe(held);
    expect(nextHeldQuota(held, without("not_loaded"))).toBe(held);
  });
  it("drops the held reading for another login or a login without quota", () => {
    const held = reading(-2);
    expect(nextHeldQuota(held, without("not_loaded", { revision: "other" }))).toBeUndefined();
    for (const reason of ["auth_changed", "login_required", "mode_not_supported", "not_adapted"] as const) expect(nextHeldQuota(held, without(reason))).toBeUndefined();
    expect(nextHeldQuota(undefined, without("not_loaded"))).toBeUndefined();
  });
  it("never replaces a reading with the same login's older one", () => {
    const newer = reading(-1), older = reading(-25);
    expect(nextHeldQuota(newer, older)).toBe(newer); expect(nextHeldQuota(older, newer)).toBe(newer); expect(nextHeldQuota(undefined, older)).toBe(older);
    // Another login's reading is about another account, however old.
    const other = reading(-25, { revision: "other" });
    expect(nextHeldQuota(newer, other)).toBe(other);
  });
  it("asks the engine only when nothing fresh is held and the last attempt is not recent", () => {
    const idle = without("not_loaded"), minute = 60_000, five = 5 * minute;
    expect(mayAskEngine(idle, undefined, undefined, now, five)).toBe(true);
    expect(mayAskEngine(idle, reading(-4), undefined, now, five)).toBe(false);
    expect(mayAskEngine(idle, reading(-6), undefined, now, five)).toBe(true);
    expect(mayAskEngine(idle, reading(-4), undefined, now, minute)).toBe(true);
    // A reading of another login does not excuse this one.
    expect(mayAskEngine(idle, reading(-1, { revision: "other" }), undefined, now, five)).toBe(true);
    // A read that just failed is not repeated at once; a new login may be asked at once.
    expect(mayAskEngine(idle, undefined, { revision: "r", at: now - 4 * minute, signIn: false }, now, five)).toBe(false);
    expect(mayAskEngine(idle, undefined, { revision: "r", at: now - 6 * minute, signIn: false }, now, five)).toBe(true);
    expect(mayAskEngine(idle, undefined, { revision: "before", at: now - minute, signIn: true }, now, five)).toBe(true);
  });
  it("leaves an engine that asked for a sign-in alone for half an hour, also from the details", () => {
    const idle = without("not_loaded"), attempt = (ago: number) => ({ revision: "r", at: now - ago, signIn: true });
    for (const olderThan of [60_000, 5 * 60_000]) {
      expect(mayAskEngine(idle, undefined, attempt(QUOTA_SIGN_IN_RETRY_MS - 1000), now, olderThan)).toBe(false);
      expect(mayAskEngine(idle, undefined, attempt(QUOTA_SIGN_IN_RETRY_MS + 1000), now, olderThan)).toBe(true);
    }
    expect(mayAskEngine(without("login_required", { state: "login_required" }), undefined, undefined, now, 60_000)).toBe(false);
  });
  it("never asks through a Hub fallback, a passive source or an unsupported one", () => {
    expect(mayAskEngine(without("offline", { revision: "offline", state: "offline" }), undefined, undefined, now, 60_000)).toBe(false);
    expect(mayAskEngine({ ...without("no_passive_event"), capability: { mode: "passive" } }, undefined, undefined, now, 60_000)).toBe(false);
    expect(mayAskEngine({ ...without("mode_not_supported", { state: "unsupported" }), capability: { mode: "unsupported" } }, undefined, undefined, now, 60_000)).toBe(false);
  });
});
