import { SessionHistoryPendingError } from "../src/state/session-history-error.js";
import { expect, it } from "vitest";
import { EngineHistoryBusyError, EngineIncompleteResponseError } from "../src/codex/adapter.js";
import { engineRetryReason } from "../src/codex/turn-retry.js";
import { renderCoreUserFacingError } from "../src/core/errors.js";
import { classifyFailure } from "../src/runtime/error-classification.js";

it.each(["en", "zh"] as const)("explains a native request rejection without guessing a damaged context (%s)", locale => {
  const error = new EngineIncompleteResponseError("private diagnostic", "interrupted", "invalid-argument");
  const text = renderCoreUserFacingError(error, "engine", locale);
  expect(text).toContain(locale === "en" ? "rejected the request as invalid" : "本次请求无效");
  expect(text).toContain(locale === "en" ? "selected model, settings and attachments" : "所选模型、设置和附件");
  expect(text).toContain(locale === "en" ? "does not establish" : "不能证明");
  expect(text).toContain(locale === "en" ? "may already have taken effect" : "可能已执行");
  expect(text).toContain(locale === "en" ? "preserved" : "保留");
  expect(text).toContain(locale === "en" ? "not automatically replayed" : "未自动重发");
  expect(text).not.toMatch(/private diagnostic|context limit|上下文上限|\/reset/);
  expect(classifyFailure(error)).toBe("engine-incomplete");
  expect(engineRetryReason(error)).toBeUndefined();
});

it.each(["en", "zh"] as const)("offers rewind only when the adapter's native history can drop the refused input (%s)", locale => {
  const rewind = locale === "en" ? "Rewind to before this message" : "回退到这条消息之前";
  const rewindable = renderCoreUserFacingError(new EngineIncompleteResponseError("private diagnostic", "interrupted", "invalid-argument", true), "engine", locale);
  expect(rewindable).toContain(rewind);
  expect(rewindable).toContain(locale === "en" ? "workspace files are not reverted" : "工作区文件不会回滚");
  expect(rewindable).toContain(locale === "en" ? "If later messages are refused too" : "若之后的消息也被拒收");
  expect(rewindable).toContain(locale === "en" ? "does not establish" : "不能证明");
  expect(rewindable).toContain(locale === "en" ? "not automatically replayed" : "未自动重发");
  expect(rewindable).not.toMatch(/private diagnostic/);
  // Without native rewind, or without a native refusal, nothing suggests rewinding.
  for (const error of [
    new EngineIncompleteResponseError("private diagnostic", "interrupted", "invalid-argument"),
    new EngineIncompleteResponseError("private diagnostic", "interrupted", "invalid-argument", false),
    new EngineIncompleteResponseError("private diagnostic", "interrupted", undefined, true),
  ]) expect(renderCoreUserFacingError(error, "engine", locale)).not.toContain(rewind);
  expect(classifyFailure(new EngineIncompleteResponseError("x", "interrupted", "invalid-argument", true))).toBe("engine-incomplete");
  expect(engineRetryReason(new EngineIncompleteResponseError("x", "interrupted", "invalid-argument", true))).toBeUndefined();
});

it.each([
  new Error("INVALID_ARGUMENT"),
  new EngineIncompleteResponseError("Tool output: INVALID_ARGUMENT", "interrupted"),
  new EngineIncompleteResponseError("Antigravity stderr: INVALID_ARGUMENT", "interrupted"),
  new EngineIncompleteResponseError('Antigravity turn failed: the answer is incomplete\n{"status":"INVALID_ARGUMENT"}', "interrupted"),
])("does not infer terminal provenance from diagnostic text (%#)", error => {
  expect(renderCoreUserFacingError(error, "engine", "en")).not.toContain("rejected the request as invalid");
});

it("explains a pending native history operation in both languages", () => {
  const error = new EngineHistoryBusyError();
  expect(classifyFailure(error)).toBe("engine-busy");
  expect(renderCoreUserFacingError(error, "engine", "en")).toContain("history operation");
  expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("会话历史操作");
});

it("explains an unresolved durable history result without suggesting replay", () => {
  const error = new SessionHistoryPendingError();
  expect(classifyFailure(error)).toBe("workflow-state");
  expect(renderCoreUserFacingError(error, "engine", "en")).toContain("not yet confirmed");
  expect(renderCoreUserFacingError(error, "engine", "zh")).toContain("尚未确认");
  expect(engineRetryReason(error)).toBeUndefined();
});
