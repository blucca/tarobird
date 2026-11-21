import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../client/src/i18n.js";
import { piEffortSettingsRejectionText, piModelSettingsRejectionText, piSessionRejectionText } from "../client/src/pi-rejection-text.js";

beforeEach(() => { vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } }); });
afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });
const rejected = (detail?: object) => ({ outcome: "rejected" as const, reason: "invalid" as const, ...(detail ? { detail } : {}) }) as Parameters<typeof piSessionRejectionText>[0];
const choices = [
  { id: "anthropic/claude-sonnet-5-5", provider: "anthropic", efforts: ["", "low", "medium", "high", "max"] },
  { id: "deepseek/deepseek-v4-pro", provider: "deepseek", efforts: ["", "off", "high", "max"] },
];

describe("Pi rejection reasons in the App", () => {
  it("names the reason a current Host gives for a refused conversation change, in both languages", () => {
    expect(piSessionRejectionText(rejected({ kind: "model_not_found" }), { action: "model", value: "anthropic/claude-nonexistent-9" }))
      .toBe("提供商 anthropic 已登录，但没有 anthropic/claude-nonexistent-9 这个模型。请重新读取后选择。");
    expect(piSessionRejectionText(rejected({ kind: "provider_unavailable" }), { action: "model", value: "google/gemini-3-pro" })).toContain("pi auth login google");
    expect(piSessionRejectionText(rejected({ kind: "thinking_unsupported", allowed: ["off", "high", "max"] }), { action: "thinking", value: "medium" }))
      .toBe("当前模型不支持这个思考强度。可选：off、high、max。");
    expect(piSessionRejectionText(rejected({ kind: "thinking_unsupported", allowed: ["low", "high"] }), { action: "thinking", value: null })).toContain("这个模型可选：low、high");
    expect(piSessionRejectionText(rejected({ kind: "model_invalid" }), { action: "model", value: "claude-sonnet-5-5" })).toContain("provider/model");
    setLocale("en");
    expect(piSessionRejectionText(rejected({ kind: "model_not_found" }), { action: "model", value: "anthropic/claude-nonexistent-9" }))
      .toBe("Provider anthropic is signed in but has no model anthropic/claude-nonexistent-9. Reload and choose again.");
    expect(piSessionRejectionText(rejected({ kind: "thinking_unsupported", allowed: ["off", "high", "max"] }), { action: "thinking", value: "medium" }))
      .toBe("The current model does not offer this thinking level. Available: off, high, max.");
  });

  it("leaves the existing sentence when the Host names no reason (an older Host) or the reason is already covered", () => {
    expect(piSessionRejectionText(rejected(), { action: "model", value: "a/b" })).toBeUndefined();
    expect(piSessionRejectionText(rejected({ kind: "default_unavailable" }), { action: "model", value: null })).toBeUndefined();
    expect(piSessionRejectionText(rejected({ kind: "thinking_unsupported" }), { action: "thinking", value: null })).toBeUndefined();
    expect(piSessionRejectionText({ outcome: "rejected", reason: "stale" }, { action: "model", value: "a/b" })).toBeUndefined();
  });

  it("explains a refused Bot default model from the catalog the dialog already read", () => {
    const pi = { engine: "pi", effort: "high", choices };
    expect(piModelSettingsRejectionText("model_unavailable", { ...pi, model: "deepseek/deepseek-v9-nonexistent" })).toContain("提供商 deepseek 已登录，但 Pi 的模型目录里没有 deepseek/deepseek-v9-nonexistent");
    expect(piModelSettingsRejectionText("model_unavailable", { ...pi, model: "google/gemini-3-pro" })).toContain("pi auth login google");
    expect(piModelSettingsRejectionText("model_effort_incompatible", { ...pi, model: "deepseek/deepseek-v4-pro", effort: "medium" })).toBe("deepseek/deepseek-v4-pro 不支持思考强度 medium。可选：off、high、max，或跟随默认。");
    // An older Host answered an unknown model with the effort code: no invented reason then.
    expect(piModelSettingsRejectionText("model_effort_incompatible", { ...pi, model: "deepseek/deepseek-v9-nonexistent" })).toBeUndefined();
    expect(piModelSettingsRejectionText("model_unavailable", { ...pi, engine: "deepseek", model: "x/y" })).toBeUndefined();
    expect(piEffortSettingsRejectionText("effort_incompatible", { engine: "pi", effort: "medium", choices: ["", "off", "high", "max"] })).toBe("当前模型不支持思考强度 medium。可选：off、high、max，或跟随默认。");
    expect(piEffortSettingsRejectionText("effort_incompatible", { engine: "codex", effort: "medium", choices: ["", "high"] })).toBeUndefined();
    // A listed level refused (the Host's catalog differs from the dialog's) is not offered back as available.
    expect(piModelSettingsRejectionText("model_effort_incompatible", { ...pi, model: "deepseek/deepseek-v4-pro", effort: "high" })).toBe("deepseek/deepseek-v4-pro 不支持思考强度 high。可选：off、max，或跟随默认。");
    expect(piEffortSettingsRejectionText("effort_incompatible", { engine: "pi", effort: "high", choices: ["", "off", "high", "max"] })).toBe("当前模型不支持思考强度 high。可选：off、max，或跟随默认。");
  });
});
