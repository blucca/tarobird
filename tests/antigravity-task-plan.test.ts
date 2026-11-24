import { describe, expect, it } from "vitest";
import { extractAntigravityTaskPlan, parseAntigravityTaskMarkdown } from "../src/codex/antigravity-task-plan.js";
import { publicPlanPreview, runPlanPreview } from "../src/client-protocol/run-plan.js";
import type { RunEntry, RunSummary } from "../src/client-protocol/run.js";

describe("Antigravity task.md to-do list parsing (#95)", () => {
  it("parses pending, in-progress, and completed Markdown checkboxes while ignoring fenced code blocks", () => {
    const markdown = [
      "# Task Plan",
      "",
      "- [x] 1. Read `a.txt` (`alpha`)",
      "- [/] 2. Update adapter and UI",
      "- [ ] 3. Run unit tests",
      "  * [X] Sub-item done",
      "```markdown",
      "- [ ] Should be ignored inside code fence",
      "```",
    ].join("\n");

    expect(parseAntigravityTaskMarkdown(markdown)).toEqual([
      { content: "1. Read `a.txt` (`alpha`)", status: "completed" },
      { content: "2. Update adapter and UI", status: "in_progress" },
      { content: "3. Run unit tests", status: "pending" },
      { content: "Sub-item done", status: "completed" },
    ]);
  });

  it("extracts task.md updates from ACP tool_call_update diff newText and write_file Content", () => {
    const sessionId = "61c53ef3-4e39-4398-8ead-b30e026ab601";
    const diffUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      kind: "edit",
      status: "completed",
      name: "edit_file",
      title: `File .../brain/${sessionId}/task.md`,
      content: [
        {
          type: "diff",
          path: `/srv/state/.gemini/antigravity-cli/brain/${sessionId}/task.md`,
          oldText: "- [ ] Step 1\n- [ ] Step 2\n",
          newText: "- [x] Step 1\n- [/] Step 2\n",
        },
      ],
      rawInput: {
        ArtifactMetadata: { UserFacing: true, RequestFeedback: false, Summary: "Progress" },
        Path: `/srv/state/.gemini/antigravity-cli/brain/${sessionId}/task.md`,
      },
    };
    const extracted = extractAntigravityTaskPlan(diffUpdate, sessionId);
    expect(extracted?.isTaskArtifact).toBe(true);
    expect(extracted?.todos).toEqual([
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "in_progress" },
    ]);

    // Non-task workspace files must NOT be treated as Antigravity's task plan.
    const normalEdit = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_2",
      kind: "edit",
      status: "completed",
      name: "write_file",
      content: [{ type: "diff", path: "/srv/workspace/README.md", newText: "- [ ] Checklist item\n" }],
    };
    expect(extractAntigravityTaskPlan(normalEdit, sessionId)).toBeUndefined();
  });

  it("builds a bounded nativeRunPlan preview from the latest foreground plan entry", () => {
    const run: RunSummary = {
      version: 1, id: "run_1", revision: 4, phase: "working",
      startedAt: 1000, updatedAt: 2000, count: 2, completed: 1, failed: 0, truncated: false,
    };
    const entries: RunEntry[] = [
      { seq: 1, revision: 1, kind: "plan", status: "done", at: 1100, name: "TodoWrite", input: JSON.stringify({ todos: [{ content: "Old", status: "pending" }] }) },
      { seq: 2, revision: 3, kind: "plan", status: "done", at: 1500, name: "TodoWrite", input: JSON.stringify({ todos: [{ content: "Read config", status: "completed" }, { content: "Build UI", status: "in_progress" }, { content: "Ship PR", status: "pending" }] }) },
      { seq: 3, revision: 4, kind: "plan", status: "done", at: 1800, name: "TodoWrite", scope: { id: "sub_1", kind: "subagent" }, input: JSON.stringify({ todos: [{ content: "Child task", status: "pending" }] }) },
    ];
    const preview = publicPlanPreview(entries, run);
    expect(preview).toEqual({
      version: 1,
      runId: "run_1",
      revision: 4,
      seq: 2,
      items: [
        { content: "Read config", status: "completed" },
        { content: "Build UI", status: "in_progress" },
        { content: "Ship PR", status: "pending" },
      ],
    });
    expect(runPlanPreview({ extra: { nativeRunPlan: preview } }, run)).toEqual(preview);
    expect(runPlanPreview({ extra: { nativeRunPlan: preview, scopedRun: run } }, run)).toBeUndefined();
  });
});
