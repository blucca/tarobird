import { describe, expect, it } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import {
  DeepSeekHarnessAdapter,
  type DeepSeekHarnessGateway,
} from "../src/codex/deepseek-harness-adapter.js";
import type {
  DeepSeekHarnessProtocolHandlers,
  DeepSeekHarnessServerRequest,
} from "../src/codex/deepseek-harness-protocol.js";
import { runToolAction } from "../src/client-protocol/run-tools.js";
import { runEntryTitle } from "../client/src/run-presentation.js";

class FakeSubagentGateway implements DeepSeekHarnessGateway {
  readonly calls: Array<{ method: string; payload: unknown }> = [];
  handlers: DeepSeekHarnessProtocolHandlers | undefined;
  private readonly lastPromptIds = new Map<string, string>();
  cancelOutcome: "cancelled" | "removed" = "cancelled";
  interruptHandler?: (childSessionId: string) => unknown | Promise<unknown>;

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.calls.push({ method, payload });
    if (method === "session.create") {
      return { sessionId: (payload as { sessionId: string }).sessionId, agentPreset: "standard" };
    }
    if (method === "commands/execute") {
      return { commandId: "cmd-1", result: { kind: "success", text: "ok" } };
    }
    if (method === "session.prompt") {
      const p = payload as { sessionId: string; requestId: string };
      this.lastPromptIds.set(p.sessionId, p.requestId);
      return { accepted: true };
    }
    if (method === "session.followSubagent") {
      return { ok: true };
    }
    if (method === "subagents.interruptByUser") {
      const childSessionId = (payload as { childSessionId: string }).childSessionId;
      if (this.interruptHandler) return await this.interruptHandler(childSessionId);
      return { accepted: true };
    }
    if (method === "session.history") {
      return { events: [], hasMore: false, projections: { asOfSeq: -1, values: {} } };
    }
    if (method === "session.list") {
      return { items: [] };
    }
    return {};
  }

  async cancelPrompt(sessionId: string, sourceRpcId: string) {
    this.calls.push({ method: "native.cancelPrompt", payload: { sessionId, sourceRpcId } });
    return { outcome: this.cancelOutcome };
  }

  async respond(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async respondError(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async close(): Promise<void> {}

  lastPromptId(sessionId: string): string | undefined {
    return this.lastPromptIds.get(sessionId);
  }

  async emitMux(payload: Record<string, unknown>): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId: `rpc-${Math.random()}`,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    await this.handlers?.onMuxFrame(frame);
  }

  async emitHost(payload: Record<string, unknown>): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId: `rpc-${Math.random()}`,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    await this.handlers?.onHostFrame(frame);
  }

  async emitEvent(sessionId: string, type: string, data: Record<string, unknown>, seq: number): Promise<void> {
    await this.emitMux({
      type: "session/event",
      sessionId,
      event: { type, seq, time: Date.now(), data },
    });
  }
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("DeepSeek Harness subagents (#74)", () => {
  it("isolates child text and tools into scoped events, records lifecycle receipts, and lists finished subagents", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({
      gateway,
      workspacePath: "/tmp/example-workspace",
      turnSettleDelayMs: 5,
      backgroundReviewGraceMs: 200,
    });
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-session-1";
    const childId = "child-subagent-1";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Delegate file read to a subagent",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });

    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    const rpcId = gateway.lastPromptId(sessionId)!;

    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Delegate file read to a subagent" }],
      source: { kind: "user", rpcId },
    }, 2);
    await gateway.emitEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-sub-1",
      name: "subagent",
      arguments: JSON.stringify({ name: "reader", description: "Read hello.txt", prompt: "Read hello.txt" }),
    }, 3);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3,
      childId,
      childCreatedAt: Date.now(),
      mode: "continuable",
      label: "Read hello.txt",
      name: "reader",
    }, 4);
    await gateway.emitEvent(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "call-sub-1",
        content: [{ type: "text", text: "started subagent reader" }],
        isError: false,
      },
    }, 5);

    // Must follow child session with durable parent address
    await waitFor(() => gateway.calls.some((c) => c.method === "session.followSubagent"));
    expect(gateway.calls.find((c) => c.method === "session.followSubagent")?.payload).toEqual({
      parentSessionId: sessionId,
      childSessionId: childId,
      mode: "continuable",
    });

    // Task panel lists running subagent with canStop: true
    const runningTasks = await adapter.listTasks(sessionId);
    expect(runningTasks.supported).toBe(true);
    expect(runningTasks.foregroundStopScope).toBe("subagents");
    expect(runningTasks.tasks).toHaveLength(1);
    expect(runningTasks.tasks[0]).toMatchObject({
      label: "Read hello.txt",
      kind: "subagent",
      mode: "background",
      status: "running",
      canStop: true,
      owner: "bound",
    });

    // Child internal thinking, tool call, tool result, and text must be scoped, NOT mixed into parent reply
    await gateway.emitEvent(childId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "session/assistant-stream",
      sessionId: childId,
      prefix: { turn: 1, step: 1, attemptId: "a1", text: "Reading hello.txt now.", reasoning: "Need to inspect hello.txt" },
    });
    await gateway.emitEvent(childId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "child-tool-1",
      name: "read_file",
      arguments: JSON.stringify({ path: "hello.txt" }),
    }, 2);
    await gateway.emitEvent(childId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "child-tool-1",
        content: [{ type: "text", text: "Hello from workspace" }],
        isError: false,
      },
    }, 3);
    await gateway.emitEvent(childId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Child report: Hello from workspace" }],
      },
    }, 4);
    await gateway.emitEvent(childId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 5);

    // Parent receives settlement notice and replies
    await gateway.emitEvent(sessionId, "user/message", {
      content: [
        { type: "text", text: "Background subagent reader finished and will do no further work unless you send it more." },
        { type: "text", text: "Its closing message:" },
        { type: "text", text: "Child report: Hello from workspace" },
      ],
      source: {
        kind: "subagent-settled",
        form: "notice",
        summary: "Background subagent reader finished and will do no further work unless you send it more.",
        stopReason: "completed",
        senderSessionId: childId,
      },
    }, 6);
    await gateway.emitHost({ type: "host/session-removed", sessionId: childId });
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Parent final answer: file says Hello from workspace." }],
      },
    }, 7);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 8);

    const response = await turnPromise;
    expect(response.text).toBe("Parent final answer: file says Hello from workspace.");

    // Unscoped assistant text must never include child's internal text
    const unscopedTexts = events
      .filter((e): e is Extract<EngineStreamEvent, { type: "assistant_text" }> => e.type === "assistant_text")
      .map((e) => e.text);
    expect(unscopedTexts.join("\n")).not.toContain("Reading hello.txt now.");
    expect(unscopedTexts.join("\n")).not.toContain("Child report:");

    // Scoped events must carry child thinking, tool_use, tool_result, result, and scope_status done
    const scopedEvents = events.filter((e): e is Extract<EngineStreamEvent, { type: "scoped" }> => e.type === "scoped");
    expect(scopedEvents.length).toBeGreaterThan(0);
    expect(scopedEvents.every((e) => e.detached === true && e.origin === "bound" && e.scope.kind === "subagent")).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "tool_use" && e.event.toolName === "read_file")).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "tool_result" && e.event.toolUseId === "child-tool-1")).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "result" && e.event.text.includes("Child report: Hello from workspace"))).toBe(true);
    expect(scopedEvents.some((e) => e.event.type === "scope_status" && e.event.status === "done")).toBe(true);

    // Parent lifecycle receipts recorded
    const activities = events.filter((e): e is Extract<EngineStreamEvent, { type: "subagent_activity" }> => e.type === "subagent_activity");
    expect(activities.map((a) => a.kind)).toEqual(["started", "completed"]);

    // Task panel retains recently finished subagent with canStop: false
    const finishedTasks = await adapter.listTasks(sessionId);
    expect(finishedTasks.tasks).toHaveLength(1);
    expect(finishedTasks.tasks[0]).toMatchObject({
      label: "Read hello.txt",
      status: "done",
      canStop: false,
    });
  });

  it("stops an individual running subagent via stopTask -> subagents.interruptByUser", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-session-2";
    const childId = "child-sleeper-1";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Run sleeper subagent",
      files: [],
      onEngineEvent: (event) => { events.push(event); },
    });

    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    const rpcId = gateway.lastPromptId(sessionId)!;

    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Run sleeper subagent" }],
      source: { kind: "user", rpcId },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3,
      childId,
      childCreatedAt: Date.now(),
      mode: "continuable",
      label: "Sleep 30s",
      name: "sleeper",
    }, 3);

    const snapshot = await adapter.listTasks(sessionId);
    expect(snapshot.tasks).toHaveLength(1);
    const taskId = snapshot.tasks[0]!.id;

    const stopResult = await adapter.stopTask(sessionId, { taskId });
    expect(stopResult).toEqual({ outcome: "accepted" });
    expect(gateway.calls.some((c) => c.method === "subagents.interruptByUser" && (c.payload as any).childSessionId === childId)).toBe(true);

    // Child aborts and settles
    await gateway.emitEvent(childId, "turn/end", { turn: 1, reason: { kind: "aborted" } }, 2);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Background subagent sleeper was stopped before it finished." }],
      source: {
        kind: "subagent-settled",
        form: "notice",
        summary: "Background subagent sleeper was stopped before it finished.",
        stopReason: "aborted",
        senderSessionId: childId,
      },
    }, 4);
    await gateway.emitEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: { role: "assistant", content: [{ type: "text", text: "Subagent was stopped." }] },
    }, 5);
    await gateway.emitEvent(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } }, 6);

    await turnPromise;
    expect(events.some((e) => e.type === "scoped" && e.event.type === "scope_status" && e.event.status === "stopped")).toBe(true);
    expect(events.some((e) => e.type === "subagent_activity" && e.kind === "interrupted")).toBe(true);

    // Stale stop after completion is rejected
    expect(await adapter.stopTask(sessionId, { taskId })).toEqual({ outcome: "rejected", reason: "stale" });
  });

  it("interrupts all active subagents when the main turn is stopped so no orphans remain", async () => {
    const gateway = new FakeSubagentGateway();
    const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: "/tmp/example-workspace", turnSettleDelayMs: 5 });
    const controller = new AbortController();
    const events: EngineStreamEvent[] = [];
    const sessionId = "parent-session-3";
    const childA = "child-orphan-a";
    const childB = "child-orphan-b";

    const turnPromise = adapter.sendUserMessage(sessionId, {
      text: "Start two subagents",
      files: [],
      abortSignal: controller.signal,
      onEngineEvent: (event) => { events.push(event); },
    });

    await waitFor(() => Boolean(gateway.lastPromptId(sessionId)));
    const rpcId = gateway.lastPromptId(sessionId)!;

    await gateway.emitEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitEvent(sessionId, "user/message", {
      content: [{ type: "text", text: "Start two subagents" }],
      source: { kind: "user", rpcId },
    }, 2);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: childA, childCreatedAt: Date.now(), mode: "continuable", label: "Worker A", name: "worker-a",
    }, 3);
    await gateway.emitEvent(sessionId, "subagent/catalog", {
      version: 3, childId: childB, childCreatedAt: Date.now(), mode: "continuable", label: "Worker B", name: "worker-b",
    }, 4);

    controller.abort();
    await expect(turnPromise).rejects.toThrow();

    const interrupted = gateway.calls
      .filter((c) => c.method === "subagents.interruptByUser")
      .map((c) => (c.payload as { childSessionId: string }).childSessionId)
      .sort();
    expect(interrupted).toEqual([childA, childB]);
    expect(events.filter((e) => e.type === "scoped" && e.event.type === "scope_status" && e.event.status === "stopped")).toHaveLength(2);
  });

  it("maps DSH subagent and control tools to delegate action and readable titles", () => {
    expect(runToolAction("subagent")).toBe("delegate");
    expect(runToolAction("wait_agent")).toBe("delegate");
    expect(runToolAction("send_message")).toBe("delegate");
    expect(runToolAction("interrupt_agent")).toBe("delegate");
    expect(runToolAction("list_agents")).toBe("delegate");

    const base = { seq: 1, revision: 1, at: Date.now(), kind: "tool" as const, status: "done" as const };
    expect(runEntryTitle({ ...base, name: "subagent", input: JSON.stringify({ name: "reader", description: "Read hello.txt" }) })).toContain("Read hello.txt");
    expect(runEntryTitle({ ...base, name: "wait_agent", input: "{}" })).toContain("等待子代理");
    expect(runEntryTitle({ ...base, name: "send_message", input: JSON.stringify({ agent: "reader" }) })).toContain("向子代理发送消息");
    expect(runEntryTitle({ ...base, name: "interrupt_agent", input: JSON.stringify({ agent: "sleeper" }) })).toContain("中断子代理");
    expect(runEntryTitle({ ...base, name: "list_agents", input: "{}" })).toContain("查看子代理");
  });
});
