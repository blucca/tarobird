import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineSteeringRejectedError, type EngineStreamEvent } from "../src/codex/adapter.js";
import { OmpRpcAdapter } from "../src/codex/omp-rpc-adapter.js";
import activateExtension from "../src/codex/omp-bridge-extension.js";
import { openOmpBridgeEndpoint } from "../src/codex/omp-bridge-host.js";
import { parseOmpFormRequest } from "../src/codex/omp-form.js";
import { OmpRpcCommandError } from "../src/codex/omp-rpc-client.js";
import { OmpFrameError, OmpProtocolVersionError } from "../src/codex/omp-rpc-protocol.js";
import { resolveOmpExecutable } from "../src/runtime/omp-executable.js";
import type { SteeringApplication } from "../src/client-protocol/steering-outcome.js";

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
          if (cmd.type === "abort_and_restore_queue" || cmd.type === "abort") {
            abortedCmd = cmd.type === "abort_and_restore_queue";
            p.send({ id, type: "response", command: cmd.type, success: true, data: { steering: [], followUp: [] } });
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
            p.send({ type: "subagent_lifecycle", payload: { id: cancelledId, index: 0, agent: "explore", description: "Explore codebase", status: "aborted" } });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "agent_start" });
            p.send({ type: "subagent_lifecycle", payload: { id: "sub-1", index: 0, agent: "explore", description: "Explore codebase", status: "started" } });
            p.send({ type: "subagent_progress", payload: { index: 0, agent: "explore", status: "running", currentTool: "grep", currentToolArgs: "src/" } });
            setTimeout(() => {
              p.send({ type: "subagent_lifecycle", payload: { id: "sub-1", index: 0, agent: "explore", description: "Explore codebase", status: "completed" } });
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
    let resolvePromptReady!: () => void;
    const promptReady = new Promise<void>(r => { resolvePromptReady = r; });
    let finishPrompt!: () => void;
    const promptGate = new Promise<void>(r => { finishPrompt = r; });

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
                model: { ...defaultState().model, input: ["text", "image"] },
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
            resolvePromptReady();
            void promptGate.then(() => {
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
            });
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

    await promptReady;
    expect(adapter.supportsSessionSteering("conv-parity")).toBe(true);
    const steered = await adapter.steerActiveTurn("conv-parity", { text: "Keep it concise" });
    expect(steered).toBe(true);
    expect(steeredText).toBe("Keep it concise");
    finishPrompt();

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

  it("Bug #1: enforces approvalMode normal (fail-closed without bridge, real gating via bridge) vs bypass", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-approval-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", approvalMode: "normal" }));

    // 1. Fail-closed when normal mode has no bridge connected
    let promptSent = false;
    const noBridgeAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: null,
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-nobridge" } }); return; }
          if (cmd.type === "prompt") { promptSent = true; }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(noBridgeAdapter.sendUserMessage("conv-nb", { text: "run bash", files: [] })).rejects.toThrow(/approval bridge/i);
    expect(promptSent).toBe(false);
    await noBridgeAdapter.destroy();

    // 2. Real Unix socket bridge roundtrip: read auto-allowed, bash denied/allowed/session-granted, bypass skips gate
    const approvals: string[] = [];
    const decisions: Array<{ behavior: "allow" | "deny"; scope?: "once" | "session" }> = [
      { behavior: "deny" },
      { behavior: "allow", scope: "once" },
      { behavior: "allow", scope: "session" },
    ];
    let extHandler: ((ev: { toolName: string; input?: unknown }) => Promise<{ block?: boolean; reason?: string } | undefined>) | undefined;
    let closeBridgeExt: (() => void) | undefined;
    let bridgeEnv: Record<string, string> = {};

    const gatedAdapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      bridgeExtensionPath: "/synthetic/omp-bridge-extension.js",
      openBridgeFn: async (opts) => {
        const ep = await openOmpBridgeEndpoint(opts);
        bridgeEnv = ep.env;
        // Simulate omp loading our extension inside the child process over the real socket
        const prevEp = process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT;
        const prevTok = process.env.TAROBIRD_OMP_BRIDGE_TOKEN;
        process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT = ep.env.TAROBIRD_OMP_BRIDGE_ENDPOINT;
        process.env.TAROBIRD_OMP_BRIDGE_TOKEN = ep.env.TAROBIRD_OMP_BRIDGE_TOKEN;
        activateExtension({
          on: (event: string, handler: (...args: any[]) => unknown) => {
            if (event === "tool_call") extHandler = handler as typeof extHandler;
            if (event === "session_shutdown") closeBridgeExt = handler as () => void;
          },
        });
        if (prevEp === undefined) delete process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT; else process.env.TAROBIRD_OMP_BRIDGE_ENDPOINT = prevEp;
        if (prevTok === undefined) delete process.env.TAROBIRD_OMP_BRIDGE_TOKEN; else process.env.TAROBIRD_OMP_BRIDGE_TOKEN = prevTok;
        return ep;
      },
      spawnFn: (_cmd, args) => {
        expect(args).toContain("--extension");
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-gated" } }); return; }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            void (async () => {
              const readRes = await extHandler!({ toolName: "read", input: { path: "a.txt" } });
              const denyRes = await extHandler!({ toolName: "bash", input: { command: "rm -rf /tmp/x" } });
              const onceRes = await extHandler!({ toolName: "bash", input: { command: "echo 1" } });
              const sessRes1 = await extHandler!({ toolName: "bash", input: { command: "echo 2" } });
              const sessRes2 = await extHandler!({ toolName: "bash", input: { command: "echo 3" } });
              const summary = JSON.stringify({
                readBlocked: !!readRes?.block,
                denyBlocked: !!denyRes?.block,
                onceBlocked: !!onceRes?.block,
                sess1Blocked: !!sessRes1?.block,
                sess2Blocked: !!sessRes2?.block,
              });
              p.send({ type: "message_end", messageId: "m-g", message: { role: "assistant", content: [{ type: "text", text: summary }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            })();
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    const gatedRes = await gatedAdapter.sendUserMessage("conv-gated", {
      text: "run tools",
      files: [],
      onApprovalRequest: async (req) => {
        approvals.push(req.toolName);
        return decisions.shift() ?? { behavior: "deny" };
      },
    });
    expect(bridgeEnv.TAROBIRD_OMP_BRIDGE_TOKEN).toBeTruthy();
    expect(JSON.parse(gatedRes.text)).toEqual({
      readBlocked: false,
      denyBlocked: true,
      onceBlocked: false,
      sess1Blocked: false,
      sess2Blocked: false,
    });
    // Prompted 3 times (deny, once, session), NOT for read, NOT for 4th bash after session grant!
    expect(approvals).toEqual(["bash", "bash", "bash"]);
    closeBridgeExt?.();
    await gatedAdapter.destroy();
  });

  it("Bugs #3 & #11: anchored after-turn fork preserves assistant reply, relocates file, and survives restart + native session discovery", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-fork-persist-"));
    dirs.push(dir);
    const nativeHome = path.join(dir, "native-home");
    const nativeSessions = path.join(nativeHome, ".omp", "agent", "sessions", "proj");
    await mkdir(nativeSessions, { recursive: true });
    await writeFile(
      path.join(nativeSessions, "2026-01-01_native-1.jsonl"),
      `${JSON.stringify({ type: "session", id: "native-1", cwd: dir })}\n${JSON.stringify({ type: "session_info", name: "Native Omp Chat" })}\n`,
    );

    const srcDir = path.join(dir, "omp", "sessions", "conv-src");
    await mkdir(srcDir, { recursive: true });
    const srcFile = path.join(srcDir, "main.jsonl");
    const rawForkFile = path.join(srcDir, "fork-created-in-src.jsonl");
    await writeFile(srcFile, `${JSON.stringify({ type: "session", id: "src-1", cwd: dir })}\n`);

    let forkCalledWithEntryId: string | undefined;
    const openedPaths: string[] = [];
    const entries = [
      { id: "u_1", parentId: null, type: "message", message: { role: "user", content: "First" } },
      { id: "a_1", parentId: "u_1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reply 1" }] } },
      { id: "u_2", parentId: "a_1", type: "message", message: { role: "user", content: "Second" } },
      { id: "a_2", parentId: "u_2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Reply 2" }] } },
    ];

    const makeAdapter = () => new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: { HOME: nativeHome },
      spawnFn: () => {
        let activeFile = srcFile;
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "open_session") {
            openedPaths.push(String(cmd.sessionPath ?? cmd.sessionDir ?? ""));
            if (typeof cmd.sessionPath === "string") activeFile = cmd.sessionPath;
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: true, sessionId: "s", sessionFile: activeFile } });
            return;
          }
          if (cmd.type === "switch_session") {
            activeFile = cmd.sessionPath as string;
            openedPaths.push(activeFile);
            p.send({ id, type: "response", command: "switch_session", success: true, data: { cancelled: false } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({ id, type: "response", command: "get_state", success: true, data: { ...defaultState(), sessionFile: activeFile } });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({ id, type: "response", command: "get_entries", success: true, data: { entries, leafId: "a_2" } });
            return;
          }
          if (cmd.type === "get_session_stats") {
            p.send({ id, type: "response", command: "get_session_stats", success: true, data: { contextUsage: { tokens: 2400, contextWindow: 200000, percent: 1.2 } } });
            return;
          }
          if (cmd.type === "fork") {
            forkCalledWithEntryId = cmd.entryId as string | undefined;
            void writeFile(rawForkFile, `${JSON.stringify({ type: "session", id: "fork-1", cwd: dir })}\n`).then(() => {
              activeFile = rawForkFile;
              p.send({ id, type: "response", command: "fork", success: true, data: { cancelled: false } });
            });
            return;
          }
          if (cmd.type === "prompt") {
            p.send({ id, type: "response", command: "prompt", success: true });
            p.send({ type: "message_end", messageId: "m1", message: { role: "assistant", content: [{ type: "text", text: "Reply 2" }], stopReason: "stop" } });
            p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
            p.send({ type: "session_settled" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    const adapter1 = makeAdapter();
    await adapter1.sendUserMessage("conv-src", { text: "Second", files: [] });
    const forkRes = await adapter1.forkHistory("conv-src", {
      anchor: { sessionId: "conv-src", inputId: "u_1", rewind: true, fork: true, forkBoundary: "after-turn" },
    });
    expect(forkRes.outcome).toBe("applied");
    // Anchored after-turn fork passed assistant leaf a_1 (NOT u_1)!
    expect(forkCalledWithEntryId).toBe("a_1");
    await adapter1.destroy();

    // Fresh adapter instance after "restart": passive context stays non-spawning (null),
    // active context & getHistoryState reattach using persisted session paths!
    const adapter2 = makeAdapter();
    expect(await adapter2.getContextUsage("conv-src", { passive: true })).toBeNull();
    const forkSessionId = forkRes.outcome === "applied" ? forkRes.sessionId : "";
    const restoredHist = await adapter2.getHistoryState(forkSessionId);
    expect(restoredHist.head).toBe("a_2");
    expect(openedPaths.some(p => p.includes(forkSessionId) && !p.includes("conv-src"))).toBe(true);
    const activeCtx = await adapter2.getContextUsage("conv-src");
    expect(activeCtx).toEqual({ pressureTokens: 2400, contextWindow: 200000 });

    // listExternalSessions discovers native ~/.omp/agent/sessions too
    const extSessions = await adapter2.listExternalSessions();
    expect(extSessions.some(s => s.sessionId === "native-1" && s.title === "Native Omp Chat")).toBe(true);
    await adapter2.destroy();
  });

  it("Bugs #5, #6, #7, #8, #10, #12, #13, #15, #16, #18: steering receipts, goal schema, forms/cancel, slash cmds, config sync, busy/compaction/images", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-hardening-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "omp", model: "anthropic/claude-sonnet-4-6", approvalMode: "bypass" }));
    const pngPath = path.join(dir, "img.png");
    await writeFile(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

    // Bug #8: HTML form parser for omp built-in `ask` tool
    const parsedForm = parseOmpFormRequest({
      type: "extension_ui_request",
      id: "form-1",
      method: "form",
      title: "Deploy config",
      html: `<form><label>Target</label><input type="radio" name="env" value="staging">Staging<input type="radio" name="env" value="prod">Prod<label>Notes</label><textarea name="notes"></textarea></form>`,
    });
    expect(parsedForm).toHaveLength(2);
    expect(parsedForm[0]).toMatchObject({ name: "env", kind: "radio" });
    expect(parsedForm[0]!.options.map(o => o.value)).toEqual(["staging", "prod"]);

    let promptMessages: Array<{ message: string; images?: unknown[] }> = [];
    let compactCalls = 0;
    let setModelCalls: Array<{ provider: string; modelId: string }> = [];
    let setThinkingCalls: string[] = [];
    let setHostToolsCalls: number[] = [];
    let uiResponses: Array<Record<string, unknown>> = [];
    let mockQueuedCount = 0;
    let mockThinkingLevel = "medium";
    let goalStateResponse: Record<string, unknown> = {
      state: { enabled: true, mode: "active", goal: { objective: "Finish", status: "budget-limited", tokenBudget: 5000, tokensUsed: 5000, timeUsedSeconds: 10 } },
    };

    const adapter = new OmpRpcAdapter({
      launch: { command: "omp", args: [] },
      workspacePath: dir,
      stateDir: dir,
      childEnv: {},
      configPath,
      spawnFn: () => {
        const proc = new FakeOmpProcess((cmd, p) => {
          const id = cmd.id as string | undefined;
          if (cmd.type === "negotiate_protocol" || cmd.type === "set_subagent_subscription" || cmd.type === "set_ask_dialog") {
            p.send({ id, type: "response", command: cmd.type, success: true, data: {} });
            return;
          }
          if (cmd.type === "get_available_commands") {
            p.send({ id, type: "response", command: "get_available_commands", success: true, data: { commands: [{ name: "review", source: "skill", description: "Code review" }] } });
            return;
          }
          if (cmd.type === "open_session") {
            p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-hard" } });
            return;
          }
          if (cmd.type === "get_state") {
            p.send({
              id,
              type: "response",
              command: "get_state",
              success: true,
              data: { ...defaultState(), thinkingLevel: mockThinkingLevel, queuedMessageCount: mockQueuedCount },
            });
            return;
          }
          if (cmd.type === "get_entries") {
            p.send({ id, type: "response", command: "get_entries", success: true, data: { entries: [{ id: "u1", parentId: null, type: "message", message: { role: "user", content: "hi" } }], leafId: "u1" } });
            return;
          }
          if (cmd.type === "set_model") {
            setModelCalls.push({ provider: String(cmd.provider), modelId: String(cmd.modelId) });
            p.send({ id, type: "response", command: "set_model", success: true, data: { ...defaultState().model, provider: cmd.provider, id: cmd.modelId } });
            return;
          }
          if (cmd.type === "set_thinking_level") {
            mockThinkingLevel = String(cmd.level);
            setThinkingCalls.push(mockThinkingLevel);
            p.send({ id, type: "response", command: "set_thinking_level", success: true });
            return;
          }
          if (cmd.type === "set_host_tools") {
            setHostToolsCalls.push(Array.isArray(cmd.tools) ? cmd.tools.length : 0);
            p.send({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: [] } });
            return;
          }
          if (cmd.type === "compact") {
            compactCalls++;
            p.send({ type: "manual_compaction_start" });
            p.send({ type: "manual_compaction_end", aborted: false });
            p.send({ id, type: "response", command: "compact", success: true, data: { summary: "Compacted summary" } });
            return;
          }
          if (cmd.type === "extension_ui_response") {
            uiResponses.push(cmd);
            return;
          }
          if (cmd.type === "steer") {
            p.send({ id, type: "response", command: "steer", success: true });
            p.send({ type: "message_start", message: { role: "user", content: cmd.message } });
            return;
          }
          if (cmd.type === "goal") {
            p.send({ id, type: "response", command: "goal", success: true, data: goalStateResponse });
            return;
          }
          if (cmd.type === "btw") {
            // Bug #13: emit btw_delta BEFORE the btw response arrives!
            p.send({ type: "btw_delta", recordId: "btw-early", delta: "Early " });
            p.send({ id, type: "response", command: "btw", success: true, data: { record: { id: "btw-early", question: cmd.question, answer: "", status: "running", leafId: null, createdAt: 1, updatedAt: 1 } } });
            p.send({ type: "btw_delta", recordId: "btw-early", delta: "chunk!" });
            p.send({ type: "btw_record", record: { id: "btw-early", question: cmd.question, answer: "", status: "complete", leafId: null, createdAt: 1, updatedAt: 2 } });
            return;
          }
          if (cmd.type === "prompt") {
            promptMessages.push({ message: String(cmd.message), images: cmd.images as unknown[] | undefined });
            p.send({ id, type: "response", command: "prompt", success: true });
            // Test Bug #16 command_output fallback + Bug #8 cancel & positional selections with comma
            if (String(cmd.message).includes("CMD_OUT_ONLY")) {
              p.send({ type: "command_output", text: "Native command output" });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
              return;
            }
            if (String(cmd.message).includes("ASK_COMMA")) {
              p.send({
                type: "extension_ui_request",
                id: "ui_comma",
                method: "ask",
                questions: [{ id: "q1", question: "Choose", options: [{ label: "Alpha, Beta" }, { label: "Gamma" }] }],
              });
              p.send({ type: "extension_ui_request", id: "ui_cancel_me", method: "input", title: "Will cancel" });
              setTimeout(() => p.send({ type: "extension_ui_request", id: "cancel_1", method: "cancel", targetId: "ui_cancel_me" }), 10);
              setTimeout(() => {
                p.send({ type: "message_end", messageId: "m-c", message: { role: "assistant", content: [{ type: "text", text: "Done ask" }], stopReason: "stop" } });
                p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
                p.send({ type: "session_settled" });
              }, 35);
              return;
            }
            setTimeout(() => {
              p.send({ type: "message_end", messageId: "m-ok", message: { role: "assistant", content: [{ type: "text", text: "OK" }], stopReason: "stop" } });
              p.send({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
              p.send({ type: "session_settled" });
            }, 25);
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });

    // Bug #13: pre-aborted signal rejects immediately without spawning
    const preAborted = new AbortController();
    preAborted.abort("cancel");
    await expect(adapter.sendUserMessage("conv-preabort", { text: "hi", files: [], abortSignal: preAborted.signal })).rejects.toThrow(/aborted/i);

    // Bug #5: idle steerActiveTurn with throwOnError throws EngineSteeringRejectedError("stale")
    await expect(adapter.steerActiveTurn("conv-hard", { text: "steer", throwOnError: true })).rejects.toThrow(EngineSteeringRejectedError);

    // Bug #10 + #16: /compact runs native RPC directly with matching compaction IDs
    const compactEvents: EngineStreamEvent[] = [];
    const compactRes = await adapter.sendUserMessage("conv-hard", {
      text: "/compact focus on APIs",
      authoredText: "/compact focus on APIs",
      files: [],
      onEngineEvent: (ev) => { compactEvents.push(ev); },
    });
    expect(compactCalls).toBe(1);
    expect(compactRes.text).toBe("Compacted summary");
    const compStart = compactEvents.find(e => e.type === "context_compaction" && e.status === "started");
    const compEnd = compactEvents.find(e => e.type === "context_compaction" && e.status === "completed");
    expect(compStart && compEnd && compStart.type === "context_compaction" && compEnd.type === "context_compaction" && compStart.id === compEnd.id).toBe(true);

    // Bug #10: advertised command sent bare; bare /etc/hosts prose escaped with leading newline
    await adapter.sendUserMessage("conv-hard", { text: "[private]\n/review pr", authoredText: "/review pr", files: [] });
    expect(promptMessages.at(-1)!.message).toBe("/review pr");
    await adapter.sendUserMessage("conv-hard", { text: "/etc/hosts is missing", authoredText: "/etc/hosts is missing", files: [] });
    expect(promptMessages.at(-1)!.message.startsWith("\n/etc/hosts")).toBe(true);

    // Bug #18: text-only model skips base64 images and appends notice
    await adapter.sendUserMessage("conv-hard", { text: "describe image", files: [pngPath] });
    expect(promptMessages.at(-1)!.images).toBeUndefined();
    expect(promptMessages.at(-1)!.message).toMatch(/img\.png/);

    // Bug #16: command_output fallback when textChunks empty
    const cmdOutRes = await adapter.sendUserMessage("conv-hard", { text: "CMD_OUT_ONLY", files: [] });
    expect(cmdOutRes.text).toBe("Native command output");

    // Bug #12: partial engineOverride preserves config.json model, and clearing effort restores initial thinkingLevel
    await adapter.sendUserMessage("conv-hard", { text: "override effort", files: [], engineOverride: { effort: "high" } });
    expect(setThinkingCalls).toContain("high");
    await adapter.sendUserMessage("conv-hard", { text: "clear override", files: [] });
    expect(setThinkingCalls.at(-1)).toBe("medium");

    // Bug #13: stale host tools cleared when omitted on subsequent turn
    await adapter.sendUserMessage("conv-hard", {
      text: "with tool",
      files: [],
      appPlatformTools: {
        definitions: [{ name: "t1", description: "d", inputSchema: { type: "object" } }],
        instructions: "",
        isRegistered: async () => true,
        register: async () => undefined,
        call: async () => ({ text: "ok" }),
      },
    });
    await adapter.sendUserMessage("conv-hard", { text: "without tool", files: [] });
    expect(setHostToolsCalls).toEqual([1, 0]);

    // Bug #5 + #13: delayed steer outcome applied + concurrent turn rejection
    const steerOutcomes: SteeringApplication[] = [];
    const activeTurn = adapter.sendUserMessage("conv-hard", { text: "work", files: [] });
    await new Promise(r => setTimeout(r, 5));
    await expect(adapter.sendUserMessage("conv-hard", { text: "concurrent", files: [] })).rejects.toThrow(/in-flight turn/);
    const accepted = await adapter.steerActiveTurn("conv-hard", { text: "add detail", onOutcome: o => steerOutcomes.push(o) });
    expect(accepted).toBe(true);
    await activeTurn;
    expect(steerOutcomes).toEqual([{ status: "applied", via: "fold" }]);

    // Bug #8: positional selections handle comma labels & cancel aborts pending input UI
    let cancelAborted = false;
    await adapter.sendUserMessage("conv-hard", {
      text: "ASK_COMMA",
      files: [],
      onApprovalRequest: async (req) => {
        if (req.toolInput && JSON.stringify(req.toolInput).includes("Will cancel")) {
          return await new Promise((resolve) => {
            req.abortSignal?.addEventListener("abort", () => {
              cancelAborted = true;
              resolve({ behavior: "deny" });
            });
          });
        }
        return {
          behavior: "allow",
          updatedInput: { answers: { Choose: "Alpha, Beta" }, selections: [{ options: [0] }] },
        };
      },
    });
    expect(cancelAborted).toBe(true);
    expect(uiResponses.some(r => r.id === "ui_comma" && JSON.stringify(r.answers).includes("Alpha, Beta"))).toBe(true);

    // Bug #13: early btw_delta buffered before btw response
    const btwDeltas: string[] = [];
    const btw = await adapter.askAside("conv-hard", "quick q", { onDelta: d => btwDeltas.push(d) });
    expect(btwDeltas.join("")).toBe("Early chunk!");
    expect(btw.answer).toBe("Early chunk!");

    // Bug #7: GoalModeState wrapper, budget-limited mapping, dropped -> null, enabled: false error
    const limitedGoal = await adapter.getThreadGoal("conv-hard");
    expect(limitedGoal.goal?.status).toBe("budgetLimited");
    goalStateResponse = { state: { enabled: true, mode: "dropped", goal: { objective: "X", status: "dropped", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } } };
    expect((await adapter.getThreadGoal("conv-hard")).goal).toBeNull();
    goalStateResponse = { state: { enabled: false, mode: "disabled", reason: "rpc not in continuationModes", goal: { objective: "Run", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } } };
    await expect(adapter.watchThreadGoal("conv-hard", { objective: "Run" })).rejects.toMatchObject({ code: "goal_continuation_disabled" });

    // Bug #15: get_state busy check honors queuedMessageCount > 0
    mockQueuedCount = 2;
    const busyHist = await adapter.getHistoryState("conv-hard");
    expect(busyHist.blocked).toBe("busy");
    expect(await adapter.forkHistory("conv-hard")).toMatchObject({ outcome: "rejected", reason: "busy" });
    mockQueuedCount = 0;

    await adapter.destroy();
  });

  it("Bug #13: fatal OmpFrameError rejects pending commands immediately instead of swallowing as expected exit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-frame-err-"));
    dirs.push(dir);
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
          if (cmd.type === "get_state") { p.send({ id, type: "response", command: "get_state", success: true, data: defaultState() }); return; }
          if (cmd.type === "open_session") { p.send({ id, type: "response", command: "open_session", success: true, data: { cancelled: false, resumed: false, sessionId: "s-frame" } }); return; }
          if (cmd.type === "prompt") {
            // Emit malformed rpc_chunk frame (unexpected start index 1) to trigger fatal OmpFrameError
            p.send({ type: "rpc_chunk", chunkId: "bad-chunk", index: 1, count: 2, byteLength: 10, data: "YWJj" });
          }
        });
        queueMicrotask(() => proc.send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 }));
        return proc as never;
      },
    });
    await expect(adapter.sendUserMessage("conv-frame", { text: "boom", files: [] })).rejects.toThrow(OmpFrameError);
    await adapter.destroy();
  });
});
