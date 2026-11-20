import { expect, it } from "vitest";
import { deepSeekDefaultUnavailable } from "../src/client-protocol/model.js";

// Shapes recorded from real DSH 0.2.2-rc.5 through readModelCatalog (synthetic providers, no model call).
const concrete = { id: "provider-a/family/model", provider: "provider-a", modelId: "family/model", efforts: ["", "off", "medium"] };
const withDefault = [{ id: "", label: "provider-a / Shared model", provider: "provider-a", modelId: "family/model", efforts: ["", "off", "medium"] }, concrete];
const withoutDefault = [{ id: "", efforts: [""] }, concrete];

it("flags a ready DSH catalog whose follow-default choice has no resolved model", () => {
  expect(deepSeekDefaultUnavailable("deepseek", "ready", withoutDefault)).toBe(true);
});
it("keeps follow-default available once DSH reports a usable default again", () => {
  expect(deepSeekDefaultUnavailable("deepseek", "ready", withDefault)).toBe(false);
});
it.each([
  ["older Host without catalog status", "deepseek", undefined, withoutDefault],
  ["unavailable catalog", "deepseek", "unavailable", withoutDefault],
  ["catalog without models", "deepseek", "no-models", [{ id: "", efforts: [""] }]],
  ["ready catalog without any concrete model", "deepseek", "ready", [{ id: "", efforts: [""] }]],
  ["older manual DeepSeek ids", "deepseek", "ready", [{ id: "", efforts: [""] }, { id: "legacy/model", efforts: [""] }]],
  ["Pi", "pi", "ready", withoutDefault],
  ["Codex", "codex", "ready", withoutDefault],
  ["missing choices", "deepseek", "ready", undefined],
] as const)("never flags %s", (_label, engine, status, choices) => {
  expect(deepSeekDefaultUnavailable(engine, status, choices)).toBe(false);
});
