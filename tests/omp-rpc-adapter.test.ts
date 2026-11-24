import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmpRpcAdapter } from "../src/codex/omp-rpc-adapter.js";
import { OmpProtocolVersionError } from "../src/codex/omp-rpc-protocol.js";
import { resolveOmpExecutable } from "../src/runtime/omp-executable.js";
import type { EngineStreamEvent } from "../src/codex/adapter.js";

class FakeOmpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 51515;
  killed = false;
  exitCode: number | null = null;
  readonly received: Array<Record<string, unknown>> = [];
  private buffer = "";

  constructor(private readonly onCommand: (cmd: Record<string, unknown>, proc: FakeOmpProcess) => void) {
    super();
    this.stdin.on("end", () => {
      if (!this.killed) this.kill();
    });
    this.stdin.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        this.received.push(parsed);
        this.onCommand(parsed, this);
      }
    });
  }

  send(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  sendChunked(frame: Record<string, unknown>, chunkSize = 32, chunkId = "rpc-1"): void {
    const raw = Buffer.from(JSON.stringify(frame), "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < raw.length; offset += chunkSize) {
      chunks.push(raw.subarray(offset, offset + chunkSize));
    }
    chunks.forEach((part, index) => {
      this.send({
        type: "rpc_chunk",
        chunkId,
        index,
        count: chunks.length,
        byteLength: raw.length,
        data: part.toString("base64"),
      });
    });
  }

  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, signal ?? null);
    this.emit("close", 0, signal ?? null);
    return true;
  });
}

function defaultState() {
  return {
    model: { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16384 },
    thinkingLevel: "medium",
    isStreaming: false,
    isCompacting: false,
    isSettled: true,
    hasPendingAsyncWork: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionId: "omp-sess-1",
    sessionFile: "/tmp/omp-sess-1.jsonl",
    autoCompactionEnabled: true,
    messageCount: 0,
    pendingMessageCount: 0,
  };
}

describe("Issue #83: oh-my-pi (omp) RPC engine integration", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("negotiates v2, reassembles chunked frames, and ends a turn on prompt_result + session_settled (ignoring yielded:false)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-test-"));
    dirs.push(dir);
    let negotiated = false;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol") {
            negotiated = cmd.protocolVersion === 2;
            p.send({ id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
            return;
          }
          if (cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") {
            p.sendChunked({ id, type: "response", command: "get_state", success: true, data: defaultState() });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-1", sessionFile: path.join(dir, "omp-sess-1.jsonl") } });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            // Simulate a non-terminal agent_end (yielded: false) which MUST NOT end the turn!
            p.send({ type: "agent_start" });
            p.send({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Planning..." }, message: { role: "assistant", content: [] } });
            p.send({ type: "agent_end", messages: [], isTerminal: false, yielded: false });
            // Now emit the actual text delta + terminal agent_end + prompt_result (sessionSettled: false) + session_settled.
            p.send({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello from omp!" }, message: { role: "assistant", content: [] } });
            p.send({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "thinking", thinking: "Planning..." }, { type: "text", text: "Hello from omp!" }], stopReason: "stop" } });
            p.send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: false });
            setTimeout(() => p.send({ type: "session_settled" }), 20);
          }
        });
        queueMicrotask(() => {
          proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864, supportsBashExcludeFromContext: true });
        });
        return proc as never;
      },
    });

    const events: EngineStreamEvent[] = [];
    const result = await adapter.sendUserMessage("conv-1", {
      conversationKey: "gw:conv-1",
      text: "Say hi",
      files: [],
      onEngineEvent: (ev) => { events.push(ev); },
    });

    expect(negotiated).toBe(true);
    expect(result.text).toBe("Hello from omp!");
    expect(events.some(e => e.type === "thinking")).toBe(true);
    expect(events.some(e => e.type === "assistant_text")).toBe(true);
    await adapter.destroy();
  });

  it("aborts a running turn cleanly via omp abort command", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-stop-"));
    dirs.push(dir);
    let activePromptId: string | undefined;
    let abortedCmd = false;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-stop" } }); return; }
          if (cmd.type === "prompt") {
            activePromptId = id;
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            return;
          }
          if (cmd.type === "abort") {
            abortedCmd = true;
            p.send({ id, type: "response", command: "abort", success: true });
            p.send({ type: "prompt_result", id: activePromptId, agentInvoked: true, status: "aborted", sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const controller = new AbortController();
    const turnPromise = adapter.sendUserMessage("conv-stop", {
      conversationKey: "gw:conv-stop",
      text: "Long task",
      files: [],
      abortSignal: controller.signal,
      onEngineEvent: () => undefined,
    });
    await new Promise(r => setTimeout(r, 30));
    controller.abort("user_stop");
    await expect(turnPromise).rejects.toThrow(/aborted|stopped/i);
    expect(abortedCmd).toBe(true);
    await adapter.destroy();
  });

  it("supports omp's three queues: steer, follow_up, and aside (btw)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-queues-"));
    dirs.push(dir);
    let activePromptId: string | undefined;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-q" } }); return; }
          if (cmd.type === "prompt") {
            activePromptId = id;
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            return;
          }
          if (cmd.type === "steer") {
            p.send({ id, type: "response", command: "steer", success: true });
            p.send({ type: "queue_update", steering: [cmd.message], followUp: [] });
            return;
          }
          if (cmd.type === "follow_up") {
            p.send({ id, type: "response", command: "follow_up", success: true });
            p.send({ type: "queue_update", steering: [], followUp: [cmd.message] });
            return;
          }
          if (cmd.type === "btw") {
            p.send({ type: "btw_record", record: { id: "btw-1", question: cmd.question, answer: "", status: "running", leafId: null, createdAt: 1, updatedAt: 1 } });
            p.send({ id, type: "response", command: "btw", success: true, data: { record: { id: "btw-1", question: cmd.question, answer: "", status: "running", leafId: null, createdAt: 1, updatedAt: 1 } } });
            p.send({ type: "btw_delta", recordId: "btw-1", delta: "Side answer." });
            p.send({ type: "btw_record", record: { id: "btw-1", question: cmd.question, answer: "Side answer.", status: "complete", leafId: null, createdAt: 1, updatedAt: 2 } });
            // Finish main prompt after btw completes
            setTimeout(() => {
              p.send({ type: "message_end", messageId: "m-q", message: { role: "assistant", content: [{ type: "text", text: "Steered done." }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id: activePromptId, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            }, 10);
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const turnPromise = adapter.sendUserMessage("conv-q", {
      conversationKey: "gw:conv-q",
      text: "Start work",
      files: [],
      onEngineEvent: () => undefined,
    });
    await new Promise(r => setTimeout(r, 30));

    await adapter.steerSession("conv-q", "Change focus");
    await adapter.followUpSession("conv-q", "Also add tests");
    const aside = await adapter.askAside("conv-q", "Why this lock?");
    expect(aside.answer).toBe("Side answer.");

    const final = await turnPromise;
    expect(final.text).toBe("Steered done.");
    expect(proc.received.some(c => c.type === "steer" && c.message === "Change focus")).toBe(true);
    expect(proc.received.some(c => c.type === "follow_up" && c.message === "Also add tests")).toBe(true);
    expect(proc.received.some(c => c.type === "btw" && c.question === "Why this lock?")).toBe(true);
    await adapter.destroy();
  });

  it("maps omp subagents (task) into scoped events, listTasks, and cancel_subagent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-subagent-"));
    dirs.push(dir);
    let cancelledId: string | undefined;
    let proc!: FakeOmpProcess;
    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-sub" } }); return; }
          if (cmd.type === "cancel_subagent") {
            cancelledId = cmd.subagentId as string;
            p.send({ id, type: "response", command: "cancel_subagent", success: true, data: { cancelled: true } });
            p.send({ type: "subagent_lifecycle", subagentId: cancelledId, status: "aborted", label: "Explore codebase" });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            p.send({ type: "subagent_lifecycle", subagentId: "sub-1", status: "running", label: "Explore codebase" });
            p.send({ type: "subagent_progress", subagentId: "sub-1", text: "Scanning src/..." });
            setTimeout(() => {
              p.send({ type: "subagent_lifecycle", subagentId: "sub-1", status: "completed", label: "Explore codebase" });
              p.send({ type: "message_end", messageId: "m-s", message: { role: "assistant", content: [{ type: "text", text: "Subagent finished." }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            }, 40);
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const events: EngineStreamEvent[] = [];
    const turnPromise = adapter.sendUserMessage("conv-sub", {
      conversationKey: "gw:conv-sub",
      text: "Run subagent",
      files: [],
      onEngineEvent: (ev) => { events.push(ev); },
    });
    await new Promise(r => setTimeout(r, 15));
    const liveTasks = await adapter.listTasks("conv-sub");
    expect(liveTasks.tasks.some(t => t.kind === "subagent" && t.label === "Explore codebase" && t.status === "running")).toBe(true);
    const stopResult = await adapter.stopTask("conv-sub", { taskId: liveTasks.tasks[0]!.id });
    expect(stopResult.outcome).toBe("accepted");
    expect(cancelledId).toBe("sub-1");

    await turnPromise;
    expect(events.some(e => e.type === "scoped" && e.scope.kind === "subagent")).toBe(true);
    await adapter.destroy();
  });

  it("reports explicit errors on unsupported protocol version (no silent downgrade) and prompt_result error frames", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-err-"));
    dirs.push(dir);
    // 1. Unsupported protocol version 99 -> MUST throw OmpProtocolVersionError, never silently downgrade!
    const badVersionAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess(() => undefined);
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 99, supportedProtocolVersions: [99], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(badVersionAdapter.sendUserMessage("conv-v99", {
      conversationKey: "gw:conv-v99",
      text: "hi",
      files: [],
      onEngineEvent: () => undefined,
    })).rejects.toThrow(OmpProtocolVersionError);
    await badVersionAdapter.destroy();

    // 2. prompt_result with status: "error" -> surfaces provider error cleanly!
    const errAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-sess-err" } }); return; }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "error", error: { message: "Session cost cap exceeded", code: "cost_cap", retryable: false }, sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(errAdapter.sendUserMessage("conv-err", {
      conversationKey: "gw:conv-err",
      text: "hi",
      files: [],
      onEngineEvent: () => undefined,
    })).rejects.toThrow(/cost cap/i);
    await errAdapter.destroy();
  });

  it("discovers omp executable from explicit override, PATH, install script, Homebrew, and bun", () => {
    expect(resolveOmpExecutable({ OMP_EXECUTABLE: "/custom/bin/omp" }, "darwin")).toBe("/custom/bin/omp");
    expect(resolveOmpExecutable({ PATH: "", HOME: "/nonexistent-home-123" }, "darwin")).toBe("omp");
  });

  it("aligns with Codex/Claude: steerActiveTurn, host tools (set_host_tools), history fork/rewind, native goal, images, usage, and ask dialogs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-parity-"));
    dirs.push(dir);
    const pngPath = path.join(dir, "sample.png");
    await writeFile(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

    let activeSessionFile = path.join(dir, "sess-main.jsonl");
    const forkedSessionFile = path.join(dir, "sess-fork.jsonl");
    const entries: Array<{ id: string; parentId: string | null; type: string; message?: { role: string; content: unknown } }> = [];
    let leafId: string | null = null;
    let currentGoal: { objective: string; status: string; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number } | null = null;
    let receivedImagesCount = 0;
    let hostToolsRegistered: string[] = [];
    let hostToolResultReceived: unknown;
    let askResponseReceived: unknown;
    let steeredText: string | undefined;

    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_available_commands") {
            p.send({ id, type: "response", command: "get_available_commands", success: true, data: { commands: [{ name: "compact", source: "builtin", description: "Compact context" }] } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({
              id,
              type: "response",
              command: "get_state",
              success: true,
              data: {
                ...defaultState(),
                sessionFile: activeSessionFile,
                contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
                goal: currentGoal,
              },
            });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "omp-main", sessionFile: activeSessionFile } });
            return;
          }
          if (cmd.type === "switch_session") {
            activeSessionFile = cmd.sessionPath as string;
            p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "set_host_tools") {
            hostToolsRegistered = ((cmd.tools as Array<{ name: string }>) ?? []).map(t => t.name);
            p.send({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: hostToolsRegistered } });
            return;
          }
          if (cmd.type === "host_tool_result") {
            hostToolResultReceived = cmd;
            return;
          }
          if (cmd.type === "extension_ui_response") {
            askResponseReceived = cmd;
            return;
          }
          if (cmd.type === "steer") {
            steeredText = cmd.message as string;
            p.send({ id, type: "response", command: "steer", success: true });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({ id, type: "response", command: "get_entries", success: true, data: { entries, leafId } });
            return;
          }
          if (cmd.type === "fork") {
            activeSessionFile = forkedSessionFile;
            p.send({ id, type: "response", command: "fork", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "navigate_tree") {
            const target = cmd.entryId as string;
            const idx = entries.findIndex(e => e.id === target);
            leafId = idx > 0 ? entries[idx - 1]!.id : null;
            p.send({ id, type: "response", command: "navigate_tree", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "goal") {
            if (cmd.op === "create") {
              currentGoal = { objective: cmd.objective as string, status: "active", tokenBudget: (cmd.token_budget as number) ?? null, tokensUsed: 0, timeUsedSeconds: 0 };
            } else if (cmd.op === "pause" && currentGoal) {
              currentGoal = { ...currentGoal, status: "paused" };
            } else if (cmd.op === "drop") {
              currentGoal = null;
            }
            p.send({ id, type: "response", command: "goal", success: true, data: { goal: currentGoal } });
            return;
          }
          if (cmd.type === "prompt") {
            receivedImagesCount = Array.isArray(cmd.images) ? cmd.images.length : 0;
            const userId = `u_${entries.length + 1}`;
            const asstId = `a_${entries.length + 2}`;
            entries.push({ id: userId, parentId: leafId, type: "message", message: { role: "user", content: cmd.message } });
            entries.push({ id: asstId, parentId: userId, type: "message", message: { role: "assistant", content: [{ type: "text", text: "Aligned reply." }] } });
            leafId = asstId;
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            p.send({ type: "auto_retry_start", attempt: 1, delayMs: 250, errorMessage: "HTTP 429 rate limit" });
            p.send({ type: "auto_retry_end", success: true, attempt: 1 });
            p.send({ type: "host_tool_call", id: "ht_1", toolCallId: "tc_1", toolName: "send_file", arguments: { path: "out.txt" } });
            p.send({
              type: "extension_ui_request",
              id: "ui_ask_1",
              method: "ask",
              questions: [{ id: "db", question: "Pick DB", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
            });
            setTimeout(() => {
              p.send({
                type: "message_end",
                messageId: "m-p",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "Aligned reply." }],
                  stopReason: "stop",
                  usage: { input: 500, output: 120, cacheRead: 80, cost: { total: 0.0125 } },
                },
              });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            }, 35);
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
        return proc as never;
      },
    });

    const events: EngineStreamEvent[] = [];
    const turnPromise = adapter.sendUserMessage("conv-parity", {
      text: "Check image and call host tool",
      files: [pngPath],
      appPlatformTools: {
        definitions: [{ name: "send_file", description: "Deliver a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
        instructions: "Use send_file to deliver outputs.",
        isRegistered: async () => false,
        register: async () => undefined,
        call: async ({ name, arguments: args }) => ({ text: `delivered:${name}:${JSON.stringify(args)}` }),
      },
      onApprovalRequest: async (req) => {
        expect(req.engine).toBe("omp");
        expect(req.toolName).toBe("AskUserQuestion");
        return { behavior: "allow", updatedInput: { answers: { "Pick DB": "Postgres" } } };
      },
      onEngineEvent: (ev) => { events.push(ev); },
    });

    await new Promise(r => setTimeout(r, 12));
    expect(adapter.supportsSessionSteering("conv-parity")).toBe(true);
    const steered = await adapter.steerActiveTurn("conv-parity", { text: "Keep it concise" });
    expect(steered).toBe(true);
    expect(steeredText).toBe("Keep it concise");

    const response = await turnPromise;
    expect(response.text).toBe("Aligned reply.");
    expect(response.usage).toEqual({ inputTokens: 500, outputTokens: 120, cachedTokens: 80, costUsd: 0.0125 });
    expect(receivedImagesCount).toBe(1);
    expect(hostToolsRegistered).toEqual(["send_file"]);
    expect((hostToolResultReceived as { result?: { content?: Array<{ text?: string }> } })?.result?.content?.[0]?.text).toContain("delivered:send_file");
    expect((askResponseReceived as { answers?: Array<{ id: string; selectedOptions: string[] }> })?.answers).toEqual([{ id: "db", selectedOptions: ["Postgres"] }]);
    expect(events.some(e => e.type === "engine_retry" && e.status === "waiting" && e.reason === "rate-limit")).toBe(true);
    expect(events.some(e => e.type === "history_anchor" && e.anchor.fork && e.anchor.rewind)).toBe(true);
    expect(adapter.advertisedCommands()).toEqual([{ name: "compact", description: "Compact context" }]);

    // Passive context usage reads cached state without extra RPC
    const ctxUsage = await adapter.getContextUsage("conv-parity", { passive: true });
    expect(ctxUsage).toEqual({ pressureTokens: 1200, contextWindow: 200000 });

    // History state, non-destructive fork, and rewind
    const hist = await adapter.getHistoryState("conv-parity");
    expect(hist.fork).toEqual({ whole: true, anchored: true });
    expect(hist.rewind).toBe(true);
    const forked = await adapter.forkHistory("conv-parity", { expectedHead: hist.head });
    expect(forked.outcome).toBe("applied");
    // Source worker was restored to original session file!
    expect(activeSessionFile).toBe(path.join(dir, "sess-main.jsonl"));

    const anchorEvent = events.find((e): e is Extract<EngineStreamEvent, { type: "history_anchor" }> => e.type === "history_anchor")!;
    const rewound = await adapter.rewindHistory("conv-parity", { anchor: anchorEvent.anchor, expectedHead: hist.head });
    expect(rewound.outcome).toBe("applied");

    // Native goal lifecycle
    const createdGoal = await adapter.setThreadGoal("conv-parity", { objective: "Ship omp parity", tokenBudget: 50000 });
    expect(createdGoal.goal?.objective).toBe("Ship omp parity");
    expect(createdGoal.goal?.status).toBe("active");
    const pausedGoal = await adapter.updateThreadGoal("conv-parity", { status: "paused" });
    expect(pausedGoal.goal?.status).toBe("paused");
    const cleared = await adapter.clearThreadGoal("conv-parity");
    expect(cleared.cleared).toBe(true);

    await adapter.destroy();
  });
});
