import { describe, expect, it } from "vitest";
import { applyCoreEngineEvent, initialCoreRunState, renderCoreRunCard } from "../src/core/card-renderer.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";

/** The finished card as text: the answer first, then the folded process. */
function finished(events: EngineStreamEvent[]) {
  let state = initialCoreRunState("chat");
  for (const event of events) state = applyCoreEngineEvent(state, event);
  const serialized = JSON.stringify(renderCoreRunCard(state, "zh"));
  const at = serialized.indexOf("过程");
  return { serialized, answer: at < 0 ? serialized : serialized.slice(0, at), process: at < 0 ? "" : serialized.slice(at) };
}
const tool = (id: string, name: string): EngineStreamEvent[] => [
  { type: "tool_use", toolName: name, toolUseId: id, toolInput: {} },
  { type: "tool_result", toolUseId: id, output: "ok" },
];

describe("the folded process of a finished reply", () => {
  it("does not repeat the closing text when the reply is every sentence of the turn joined together", () => {
    // Kimi's reply is all of the turn's assistant text: the sentence before the tools and the text after them.
    const { answer, process } = finished([
      { type: "thinking", text: "plan the work" },
      { type: "assistant_text", text: "我会先查看说明，再创建脚本并运行验证。", delta: true },
      ...tool("t1", "Read"), ...tool("t2", "Write"), ...tool("t3", "Bash"),
      { type: "assistant_text", text: "\n\n已创建并运行脚本，完整输出如下。[MARK]", delta: true },
      { type: "result", text: "我会先查看说明，再创建脚本并运行验证。\n\n已创建并运行脚本，完整输出如下。[MARK]" },
    ]);
    expect(answer).toContain("我会先查看说明"); expect(answer).toContain("[MARK]");
    expect(process).toContain("3 步"); expect(process).toContain("plan the work");
    expect(process).not.toContain("[MARK]");
    expect(process).not.toContain("我会先查看说明");
  });

  it("keeps a sentence said before the tools in the process when the reply is the closing text alone", () => {
    const { answer, process } = finished([
      { type: "assistant_text", text: "我先看一下文件。", delta: true },
      ...tool("t1", "Read"),
      { type: "assistant_text", text: "文件里有三行。", delta: true },
      { type: "result", text: "文件里有三行。" },
    ]);
    expect(answer).toContain("文件里有三行。"); expect(answer).not.toContain("我先看一下文件。");
    expect(process).toContain("我先看一下文件。"); expect(process).not.toContain("文件里有三行。");
  });

  it("keeps an earlier sentence in the process when the reply merely begins with the same words", () => {
    const { process } = finished([
      { type: "assistant_text", text: "好的。", delta: true },
      ...tool("t1", "Read"),
      { type: "assistant_text", text: "好的。文件里有三行。", delta: true },
      { type: "result", text: "好的。文件里有三行。" },
    ]);
    expect(process).toContain("好的。"); expect(process).not.toContain("文件里有三行。");
  });

  it("strips only what the reply covers from a closing block that was streamed in part", () => {
    const { process } = finished([
      { type: "assistant_text", text: "我先看一下文件。", delta: true },
      ...tool("t1", "Read"),
      { type: "assistant_text", text: "文件里有", delta: true },
      { type: "result", text: "文件里有三行，内容如下。" },
    ]);
    expect(process).toContain("我先看一下文件。"); expect(process).not.toContain("文件里有");
  });
});
