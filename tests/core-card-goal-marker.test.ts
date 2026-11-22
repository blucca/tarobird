import { expect, it } from "vitest";
import { applyCoreEngineEvent, cleanCardText, initialCoreRunState, renderCoreRunCard } from "../src/core/card-renderer.js";

// Recorded from agy 1.5.14 on 2026-11-22: the reply of a finished native /goal ends with this comment.
const reply = "已在当前目录创建并确认文件，内容确认为单行 `goal-ok`。 <!-- GOAL_COMPLETE -->";

it("leaves agy's goal marker out of the card, and does not repeat the answer in the process", () => {
  expect(cleanCardText(reply, "zh")).toBe("已在当前目录创建并确认文件，内容确认为单行 `goal-ok`。");
  let state = initialCoreRunState("chat");
  state = applyCoreEngineEvent(state, { type: "tool_use", toolName: "write_file", toolUseId: "t1", toolInput: {} });
  state = applyCoreEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "ok" });
  state = applyCoreEngineEvent(state, { type: "assistant_text", text: reply, delta: true });
  state = applyCoreEngineEvent(state, { type: "result", text: reply });
  const card = JSON.stringify(renderCoreRunCard(state, "zh"));
  expect(card).not.toContain("GOAL_COMPLETE");
  expect(card.split("内容确认为单行").length - 1).toBe(2); // the summary line and the answer, not the process
});

it("keeps the same words when they are not the end of the reply", () => {
  const text = "agy 在目标完成时会输出 `<!-- GOAL_COMPLETE -->` 这个标记，App 不显示它。";
  expect(cleanCardText(text, "zh")).toBe(text);
});
