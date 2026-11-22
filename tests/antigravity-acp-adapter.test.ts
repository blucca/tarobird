import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  AntigravityAcpAdapter,
  type AgyAcpChildProcess,
  type SpawnAgyAcp,
} from "../src/codex/antigravity-acp-adapter.js";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not met in time");
}

async function settleWithin<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("did not settle in time")), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class FakeReadable extends EventEmitter {
  emitData(chunk: string): void { this.emit("data", chunk); }
  end(): void { this.emit("end"); }
}

class FakeWritable {
  ended = false;
  constructor(private readonly onWrite: (chunk: string) => void, private readonly onEnd: () => void) {}
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.onWrite(chunk.toString());
    callback?.(null);
    return true;
  }
  end(callback?: () => void): void { this.ended = true; this.onEnd(); callback?.(); }
  destroy(): void {}
}

const MODEL_OPTIONS = [
  { value: "gemini-4-neon", name: "Gemini 4 Neon" },
  { value: "gemini-4-argon", name: "Gemini 4 Argon" },
  { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
];
const LEVEL_OPTIONS = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra" },
];

class FakeAgyServer {
  readonly clientMessages: JsonRpcMessage[] = [];
  readonly clientResponses = new Map<number | string, JsonRpcMessage>();
  readonly prompts: JsonRpcMessage[] = [];
  readonly pendingPrompts = new Map<number | string, JsonRpcMessage>();
  answerClose = true;
  autoCancel = true;
  currentModeId = "default";
  configOptions: Array<Record<string, unknown>> = [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-4-neon", options: MODEL_OPTIONS },
    { id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: "high", options: LEVEL_OPTIONS },
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
  ];
  private inputBuffer = "";
  private nextServerRequestId = 1;

  constructor(private readonly stdout: FakeReadable, public sessionId: string, private readonly log: string[]) {}

  receive(chunk: string): void {
    this.inputBuffer += chunk;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.handle(JSON.parse(line) as JsonRpcMessage);
  }

  requests(method: string): JsonRpcMessage[] {
    return this.clientMessages.filter((message) => message.method === method);
  }

  sendUpdate(update: Record<string, unknown>, sessionId = this.sessionId): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  text(text: string): void { this.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }); }

  requestPermission(toolCallId = "call_1", toolInput: Record<string, unknown> = { CommandLine: "touch x" }): string {
    const id = String(this.nextServerRequestId++);
    this.send({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
      sessionId: this.sessionId,
      toolCall: { sessionUpdate: "tool_call", toolCallId, name: "run_command", status: "pending", kind: "execute", title: String(toolInput.CommandLine), rawInput: toolInput },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }],
    } });
    return id;
  }

  /** Answer one outstanding prompt; the newest by default. */
  respondPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }, which: "newest" | "oldest" = "newest"): void {
    const entries = [...this.pendingPrompts.entries()];
    const entry = which === "newest" ? entries.at(-1) : entries[0];
    if (!entry) throw new Error("No pending prompt");
    this.pendingPrompts.delete(entry[0]);
    this.send({ jsonrpc: "2.0", id: entry[0], result });
  }

  failPrompt(error: { code: number; message: string }, which: "newest" | "oldest" = "newest"): void {
    const entries = [...this.pendingPrompts.entries()];
    const entry = which === "newest" ? entries.at(-1) : entries[0];
    if (!entry) throw new Error("No pending prompt");
    this.pendingPrompts.delete(entry[0]);
    this.send({ jsonrpc: "2.0", id: entry[0], error });
  }

  private sessionResult(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      modes: { currentModeId: this.currentModeId, availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
      configOptions: this.configOptions,
    };
  }

  private handle(message: JsonRpcMessage): void {
    this.clientMessages.push(message);
    if (!message.method) {
      if (message.id !== undefined) this.clientResponses.set(message.id, message);
      return;
    }
    if (message.method === "initialize") {
      this.respond(message, {
        protocolVersion: 1,
        agentInfo: { name: "Fake Antigravity ACP Server", version: "test" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
        },
        authMethods: [],
      });
      return;
    }
    if (message.method === "session/new") { this.respond(message, this.sessionResult()); return; }
    if (message.method === "session/resume") {
      this.sessionId = String(message.params?.sessionId);
      this.respond(message, { ...this.sessionResult(), sessionId: undefined });
      return;
    }
    if (message.method === "session/load") {
      this.text("replayed history must never be shown");
      this.respond(message, this.sessionResult());
      return;
    }
    if (message.method === "session/set_config_option") {
      const configId = String(message.params?.configId);
      const value = String(message.params?.value);
      this.configOptions = this.configOptions.map((option) => option.id === configId ? { ...option, currentValue: value } : option);
      this.respond(message, { configOptions: this.configOptions });
      return;
    }
    if (message.method === "session/set_mode") {
      this.currentModeId = String(message.params?.modeId);
      this.respond(message, {});
      return;
    }
    if (message.method === "session/prompt") {
      this.prompts.push(message);
      this.pendingPrompts.set(message.id!, message);
      return;
    }
    if (message.method === "session/cancel") {
      this.log.push(`cancel:${String(message.params?.sessionId)}`);
      if (this.autoCancel && this.pendingPrompts.size) this.respondPrompt({ stopReason: "cancelled" });
      return;
    }
    if (message.method === "session/close") {
      this.log.push(`close:${String(message.params?.sessionId)}`);
      if (this.answerClose) this.respond(message, {});
      return;
    }
    if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }

  private respond(request: JsonRpcMessage, result: unknown): void {
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  private send(message: JsonRpcMessage): void {
    queueMicrotask(() => this.stdout.emitData(`${JSON.stringify(message)}\n`));
  }
}

class FakeAgyChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin: FakeWritable;
  readonly server: FakeAgyServer;
  constructor(readonly pid: number, sessionId: string, log: string[]) {
    super();
    this.server = new FakeAgyServer(this.stdout, sessionId, log);
    this.stdin = new FakeWritable((chunk) => this.server.receive(chunk), () => log.push(`stdin-end:${pid}`));
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.emit("close", code, signal);
  }
}

const SESSION_A = "3dc54fa6-0000-4000-8000-00000000000a";
const SESSION_B = "3dc54fa6-0000-4000-8000-00000000000b";

function createHarness(configure?: (server: FakeAgyServer, index: number) => void) {
  const log: string[] = [];
  const children: FakeAgyChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
  const spawnFn: SpawnAgyAcp = (command, args, options) => {
    const index = children.length;
    const child = new FakeAgyChild(900 + index, index === 0 ? SESSION_A : SESSION_B, log);
    configure?.(child.server, index);
    children.push(child);
    spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    return child as unknown as AgyAcpChildProcess;
  };
  const killProcessTreeFn = (pid: number | undefined) => {
    log.push(`kill:${pid}`);
    const child = children.find((candidate) => candidate.pid === pid);
    queueMicrotask(() => child?.exit(null, "SIGTERM"));
  };
  return { log, children, spawnCalls, spawnFn, killProcessTreeFn };
}

const tempRoots: string[] = [];
async function configFile(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-acp-test-"));
  tempRoots.push(root);
  const file = path.join(root, "config.json");
  await writeFile(file, JSON.stringify({ engine: "antigravity", ...config }));
  return file;
}

async function adapterFor(harness: ReturnType<typeof createHarness>, config: Record<string, unknown> = { approvalMode: "bypass" }, extra: Record<string, unknown> = {}) {
  return new AntigravityAcpAdapter("agy", {
    childEnv: { PATH: process.env.PATH },
    configPath: await configFile(config),
    workspacePath: "/tmp/agy-workspace",
    spawnFn: harness.spawnFn,
    killProcessTreeFn: harness.killProcessTreeFn,
    idleSweepIntervalMs: 0,
    closeTimeoutMs: 50,
    cancelGraceMs: 50,
    wakeQuietMs: 20,
    turnTimeoutMs: null,
    inactivityTimeoutMs: null,
    ...extra,
  });
}

const adapters: AntigravityAcpAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.destroy()));
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function track(adapter: AntigravityAcpAdapter): AntigravityAcpAdapter {
  adapters.push(adapter);
  return adapter;
}

function promptBlocks(server: FakeAgyServer, index = 0): Array<Record<string, unknown>> {
  return server.prompts[index]!.params!.prompt as Array<Record<string, unknown>>;
}

describe("AntigravityAcpAdapter core", () => {
  it("starts agy acp with the approval flags and workspace, then streams one turn", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "full-auto" }));
    const events: EngineStreamEvent[] = [];
    const progress: string[] = [];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "hello", files: [], onEngineEvent: (event) => { events.push(event); }, onProgress: (text) => progress.push(text) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(harness.spawnCalls[0]).toMatchObject({ command: "agy", cwd: "/tmp/agy-workspace" });
    expect(harness.spawnCalls[0]!.args).toEqual(["acp", "--dangerously-skip-permissions", "--sandbox", "--add-dir", "/tmp/agy-workspace"]);
    expect(harness.spawnCalls[0]!.env?.AGY_CLI_HIDE_ACCOUNT_INFO).toBe("1");
    expect(server.requests("session/new")[0]!.params).toMatchObject({ cwd: "/tmp/agy-workspace", mcpServers: [] });
    expect(server.requests("session/load")).toHaveLength(0);
    expect(JSON.stringify(promptBlocks(server))).toContain("<user_message>\\nhello\\n</user_message>");

    server.sendUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_7", name: "run_command", kind: "execute", title: "ls", status: "in_progress", rawInput: { CommandLine: "ls" } });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_7", status: "completed", rawOutput: { output: "a.txt\n", exit_code: 0 } });
    server.text("Hel");
    server.text("lo!");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 1200, size: 1_048_576 });
    await waitFor(() => events.some((event) => event.type === "assistant_text" && event.text === "lo!"));
    server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30, thoughtTokens: 5, totalTokens: 155 } });

    await expect(settleWithin(reply)).resolves.toEqual({ text: "Hello!", sessionId: SESSION_A, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 30 } });
    expect(events).toEqual(expect.arrayContaining([
      { type: "session", sessionId: SESSION_A },
      { type: "thinking", text: "thinking", sessionId: SESSION_A },
      { type: "tool_use", toolName: "run_command", toolInput: { CommandLine: "ls" }, toolUseId: "call_7", sessionId: SESSION_A },
      { type: "tool_result", toolName: "run_command", toolUseId: "call_7", output: "a.txt\n", exitCode: 0, isError: false, sessionId: SESSION_A },
      { type: "assistant_text", text: "Hel", delta: true, sessionId: SESSION_A },
    ]));
    expect(progress.at(-1)).toBe("Hello!");
    await expect(adapter.getContextUsage(SESSION_A)).resolves.toEqual({ pressureTokens: 1200, contextWindow: 1_048_576 });
  });

  it("uses bypass flags only for bypass and no permission flags for normal approval", async () => {
    const bypass = createHarness();
    const bypassAdapter = track(await adapterFor(bypass, { approvalMode: "bypass" }));
    void bypassAdapter.sendUserMessage("tarobot-1", { text: "x", files: [] }).catch(() => undefined);
    await waitFor(() => bypass.spawnCalls.length === 1);
    expect(bypass.spawnCalls[0]!.args).toEqual(["acp", "--dangerously-skip-permissions", "--add-dir", "/tmp/agy-workspace"]);

    const normal = createHarness();
    const normalAdapter = track(await adapterFor(normal, { approvalMode: "normal" }));
    void normalAdapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: async () => ({ behavior: "deny" }) }).catch(() => undefined);
    await waitFor(() => normal.spawnCalls.length === 1);
    expect(normal.spawnCalls[0]!.args).toEqual(["acp", "--add-dir", "/tmp/agy-workspace"]);
    await expect(normalAdapter.sendUserMessage("tarobot-2", { text: "x", files: [] })).rejects.toThrow(/approval handler/);
  });

  it("resumes a saved conversation with session/resume and never replays it with session/load", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage(SESSION_A, { text: "again", files: [], onEngineEvent: (event) => { events.push(event); } });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(server.requests("session/resume")[0]!.params).toMatchObject({ sessionId: SESSION_A, cwd: "/tmp/agy-workspace" });
    expect(server.requests("session/load")).toHaveLength(0);
    expect(server.requests("session/new")).toHaveLength(0);
    server.text("resumed");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "resumed", sessionId: SESSION_A });
  });

  it("maps a concrete model preset onto the model and thought_level options and resets a non-default mode", async () => {
    const harness = createHarness((server) => { server.currentModeId = "plan"; });
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gemini-4-argon-medium" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    expect(server.requests("session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: SESSION_A, configId: "model", value: "gemini-4-argon" },
      { sessionId: SESSION_A, configId: "thought_level", value: "medium" },
    ]);
    expect(server.requests("session/set_mode")[0]!.params).toEqual({ sessionId: SESSION_A, modeId: "default" });
    server.text("ok");
    server.respondPrompt();
    await settleWithin(reply);

    // An exact option id is used as-is; an explicit effort is applied separately.
    const exact = createHarness();
    const exactAdapter = track(await adapterFor(exact, { approvalMode: "bypass", model: "gpt-oss-120b-medium", effort: "low" }));
    void exactAdapter.sendUserMessage("tarobot-1", { text: "x", files: [] }).catch(() => undefined);
    await waitFor(() => exact.children[0]?.server.prompts.length === 1);
    expect(exact.children[0]!.server.requests("session/set_config_option").map((message) => message.params)).toEqual([
      { sessionId: SESSION_A, configId: "model", value: "gpt-oss-120b-medium" },
      { sessionId: SESSION_A, configId: "thought_level", value: "low" },
    ]);
    expect(exact.children[0]!.server.requests("session/set_mode")).toHaveLength(0);
  });

  it("refuses an effort the CLI does not offer before sending the prompt", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass", model: "gemini-4-argon", effort: "max" }));
    await expect(adapter.sendUserMessage("tarobot-1", { text: "x", files: [] })).rejects.toThrow(
      'Invalid model selection: gemini-4-argon has no "max" effort (available: low, medium, high, xhigh)',
    );
    expect(harness.children[0]!.server.prompts).toHaveLength(0);
  });

  it("bridges session/request_permission to the turn's approval handler with allow_once and reject_once only", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const requests: EngineApprovalRequest[] = [];
    const decisions: Array<"allow" | "deny"> = ["allow", "deny"];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: async (request) => {
      requests.push(request);
      const behavior = decisions.shift()!;
      return behavior === "allow" ? { behavior, scope: "once" } : { behavior };
    } });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const first = server.requestPermission("call_1", { CommandLine: "touch a" });
    await waitFor(() => server.clientResponses.has(first));
    const second = server.requestPermission("call_2", { CommandLine: "touch b" });
    await waitFor(() => server.clientResponses.has(second));
    expect(server.clientResponses.get(first)!.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(server.clientResponses.get(second)!.result).toEqual({ outcome: { outcome: "selected", optionId: "deny" } });
    expect(requests[0]).toMatchObject({ engine: "antigravity", toolName: "run_command", toolInput: { CommandLine: "touch a" }, sessionId: SESSION_A, approvalScopes: { once: "once" } });
    server.text("done");
    server.respondPrompt();
    await settleWithin(reply);
  });

  it("sends images and text files natively and binary files only as paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-acp-files-"));
    tempRoots.push(root);
    const image = path.join(root, "red.png");
    const notes = path.join(root, "notes.txt");
    const binary = path.join(root, "data.bin");
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    await writeFile(notes, "CODEWORD=VIOLET");
    await writeFile(binary, Buffer.from([0, 1, 2, 3, 0, 255]));
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "look", files: [image, notes, binary] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const blocks = promptBlocks(harness.children[0]!.server);
    expect(blocks).toContainEqual({ type: "image", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64"), uri: expect.stringContaining("red.png") });
    expect(blocks).toContainEqual({ type: "resource", resource: { uri: expect.stringContaining("notes.txt"), mimeType: "text/plain", text: "CODEWORD=VIOLET" } });
    expect(JSON.stringify(blocks)).not.toContain("blob");
    expect(JSON.stringify(blocks)).toContain(`Attachment: ${binary}`);
    harness.children[0]!.server.text("seen");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(reply);
  });

  it("sends a native slash command as the first block, outside the user message wrapper", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    void adapter.sendUserMessage("tarobot-1", { text: "/compact now", files: [], instructions: "private rules" }).catch(() => undefined);
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const blocks = promptBlocks(harness.children[0]!.server);
    expect(blocks[0]).toEqual({ type: "text", text: "/compact now" });
    expect(JSON.stringify(blocks)).not.toContain("<user_message>");
    expect(JSON.stringify(blocks)).toContain("private rules");
  });

  it("stops with session/cancel and keeps the live session for the next turn", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const controller = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "long", files: [], abortSignal: controller.signal });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    controller.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual([`cancel:${SESSION_A}`]);
    const next = adapter.sendUserMessage(SESSION_A, { text: "next", files: [] });
    await waitFor(() => harness.children[0]!.server.prompts.length === 2);
    harness.children[0]!.server.text("fine");
    harness.children[0]!.server.respondPrompt();
    await expect(settleWithin(next)).resolves.toMatchObject({ text: "fine" });
    expect(harness.spawnCalls).toHaveLength(1);
  });

  it("closes the session before killing the process when a stop is not confirmed", async () => {
    const harness = createHarness((server) => { server.autoCancel = false; });
    const adapter = track(await adapterFor(harness));
    const controller = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "long", files: [], abortSignal: controller.signal });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    controller.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual([`cancel:${SESSION_A}`, `close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
  });

  it("reports a turn that ended without any answer as an error", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.respondPrompt({ stopReason: "end_turn" });
    await expect(settleWithin(reply)).rejects.toThrow("Antigravity completed without returning a response");
  });
});

describe("AntigravityAcpAdapter cleanup", () => {
  it("destroy closes every active session before ending stdin and killing the process tree", async () => {
    const harness = createHarness();
    const adapter = await adapterFor(harness);
    const first = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(first);
    const second = adapter.sendUserMessage("tarobot-2", { text: "b", files: [] }).catch((error: Error) => error);
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);

    await adapter.destroy();
    expect(harness.log.filter((entry) => entry.startsWith("close:")).sort()).toEqual([`close:${SESSION_A}`, `close:${SESSION_B}`]);
    for (const pid of [900, 901]) {
      const sessionId = pid === 900 ? SESSION_A : SESSION_B;
      expect(harness.log.indexOf(`close:${sessionId}`)).toBeLessThan(harness.log.indexOf(`kill:${pid}`));
      expect(harness.log.indexOf(`stdin-end:${pid}`)).toBeLessThan(harness.log.indexOf(`kill:${pid}`));
    }
    await expect(second).resolves.toBeInstanceOf(Error);
  });

  it("still kills the process after a short timeout when session/close never answers", async () => {
    const harness = createHarness((server) => { server.answerClose = false; });
    const adapter = await adapterFor(harness);
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(reply);
    await settleWithin(adapter.destroy());
    expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
  });

  it("recycles an idle session by closing it before the kill", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const harness = createHarness();
      const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, { idleWorkerTtlMs: 1_000, idleSweepIntervalMs: 500 }));
      const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      harness.children[0]!.server.text("a");
      harness.children[0]!.server.respondPrompt();
      await settleWithin(reply);
      vi.advanceTimersByTime(1_600);
      await waitFor(() => harness.log.includes("kill:900"));
      expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts for new launch flags only after closing the old session, then resumes it", async () => {
    const harness = createHarness();
    const configPath = await configFile({ approvalMode: "bypass" });
    const adapter = track(new AntigravityAcpAdapter("agy", {
      childEnv: {}, configPath, workspacePath: "/tmp/agy-workspace", spawnFn: harness.spawnFn, killProcessTreeFn: harness.killProcessTreeFn,
      idleSweepIntervalMs: 0, closeTimeoutMs: 50, cancelGraceMs: 50, wakeQuietMs: 20, turnTimeoutMs: null, inactivityTimeoutMs: null,
    }));
    const first = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.server.text("a");
    harness.children[0]!.server.respondPrompt();
    await settleWithin(first);

    await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "full-auto" }));
    const second = adapter.sendUserMessage(SESSION_A, { text: "b", files: [] });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    expect(harness.log.slice(0, 3)).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    expect(harness.spawnCalls[1]!.args).toContain("--sandbox");
    expect(harness.children[1]!.server.requests("session/resume")[0]!.params).toMatchObject({ sessionId: SESSION_A });
    harness.children[1]!.server.text("b");
    harness.children[1]!.server.respondPrompt();
    await settleWithin(second);
  });

  it("fails the turn when agy acp exits unexpectedly", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "a", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0]!.stderr.emitData("fatal: boom\n");
    harness.children[0]!.exit(2);
    await expect(settleWithin(reply)).rejects.toThrow(/exited with code 2/);
  });
});

describe("AntigravityAcpAdapter steering", () => {
  async function runningTurn(config: Record<string, unknown> = { approvalMode: "bypass" }, extra: Record<string, unknown> = {}) {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, config, extra));
    const events: EngineStreamEvent[] = [];
    let settled = false;
    const reply = adapter.sendUserMessage("tarobot-1", {
      text: "write the report", files: [], onEngineEvent: (event) => { events.push(event); },
      onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }),
    });
    void reply.then(() => { settled = true; }, () => { settled = true; });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    return { harness, adapter, events, reply, server: harness.children[0]!.server, isSettled: () => settled };
  }

  it("offers steering for a live session and refuses it without a running turn", async () => {
    const { adapter, server, reply } = await runningTurn();
    expect(adapter.inFlightSendBehavior).toBe("steer");
    expect(adapter.supportsSessionSteering(SESSION_A)).toBe(true);
    expect(adapter.supportsSessionSteering("tarobot-9")).toBe(false);
    server.text("done");
    server.respondPrompt();
    await settleWithin(reply);
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "late" })).resolves.toBe(false);
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "late", throwOnError: true })).rejects.toMatchObject({ name: "EngineSteeringRejectedError", reason: "stale" });
    expect(server.prompts).toHaveLength(1);
  });

  it("sends a second session/prompt and keeps the turn open past the first prompt's early end_turn", async () => {
    const { adapter, server, reply, events, isSettled } = await runningTurn();
    server.text("Part one. ");
    await waitFor(() => events.some((event) => event.type === "assistant_text"));
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "  also cover costs  ", throwOnError: true });
    await waitFor(() => server.prompts.length === 2);
    expect(server.prompts[1]!.params).toEqual({ sessionId: SESSION_A, prompt: [{ type: "text", text: "also cover costs" }] });
    // agy hands the run over: the earlier prompt returns end_turn at once.
    server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1, cachedReadTokens: 2 } }, "oldest");
    await expect(settleWithin(steer)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(isSettled()).toBe(false);
    server.text("Part two with costs.");
    server.respondPrompt({ stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7, cachedReadTokens: 3 } });
    await expect(settleWithin(reply)).resolves.toEqual({ text: "Part one. Part two with costs.", sessionId: SESSION_A, usage: { inputTokens: 15, outputTokens: 8, cachedTokens: 5 } });
    expect(events.filter((event) => event.type === "result")).toEqual([{ type: "result", text: "Part one. Part two with costs.", sessionId: SESSION_A }]);
  });

  it("chains two steers; only the newest prompt settles the turn", async () => {
    const { adapter, server, reply, isSettled } = await runningTurn();
    const first = adapter.steerActiveTurn(SESSION_A, { text: "alpha" });
    await waitFor(() => server.prompts.length === 2);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");
    await expect(settleWithin(first)).resolves.toBe(true);
    const second = adapter.steerActiveTurn(SESSION_A, { text: "beta" });
    await waitFor(() => server.prompts.length === 3);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");
    await expect(settleWithin(second)).resolves.toBe(true);
    expect(isSettled()).toBe(false);
    server.text("alpha and beta");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "alpha and beta" });
  });

  it("refuses to steer while an approval is unanswered instead of queueing it", async () => {
    let answer!: (decision: { behavior: "allow"; scope: "once" }) => void;
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "normal" }));
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], onApprovalRequest: () => new Promise((resolve) => { answer = resolve; }) });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const permission = server.requestPermission();
    await waitFor(() => Boolean(answer));
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "hurry", throwOnError: true })).rejects.toMatchObject({ reason: "not_ready" });
    await expect(adapter.steerActiveTurn(SESSION_A, { text: "hurry" })).resolves.toBe(false);
    expect(server.prompts).toHaveLength(1);
    answer({ behavior: "allow", scope: "once" });
    await waitFor(() => server.clientResponses.has(permission));
    server.text("ok");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "ok" });
  });

  it("reports agy's -32603 refusal truthfully and lets the earlier prompt finish the turn", async () => {
    const { adapter, server, reply } = await runningTurn();
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "extra", throwOnError: true });
    await waitFor(() => server.prompts.length === 2);
    server.failPrompt({ code: -32603, message: "Can't add this prompt to session: the running prompt is waiting for a permission or question answer" });
    await expect(settleWithin(steer)).rejects.toMatchObject({ name: "EngineSteeringRejectedError", reason: "not_ready" });
    server.text("original answer");
    server.respondPrompt();
    await expect(settleWithin(reply)).resolves.toMatchObject({ text: "original answer" });
  });

  it("stops a steered turn with session/cancel", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    const controller = new AbortController();
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [], abortSignal: controller.signal });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    const steer = adapter.steerActiveTurn(SESSION_A, { text: "more" });
    await waitFor(() => server.prompts.length === 2);
    server.respondPrompt({ stopReason: "end_turn" }, "oldest");
    await settleWithin(steer);
    controller.abort();
    await expect(settleWithin(reply)).rejects.toThrow("Task was stopped by user");
    expect(harness.log).toEqual([`cancel:${SESSION_A}`]);
  });
});

describe("AntigravityAcpAdapter idle wake-up", () => {
  async function finishedTurn(prepare: (server: FakeAgyServer) => void = () => undefined, extra: Record<string, unknown> = {}) {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness, { approvalMode: "bypass" }, extra));
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage("tarobot-1", { text: "start it", files: [], onEngineEvent: (event) => { events.push(event); } });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    prepare(server);
    server.text("STARTED");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 100, size: 1000 });
    server.respondPrompt();
    await settleWithin(reply);
    return { harness, adapter, events, server };
  }
  const backgroundCommand = (server: FakeAgyServer) => {
    server.sendUpdate({ sessionUpdate: "usage_update", used: 90, size: 1000 });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_bg", name: "run_command", kind: "execute", title: "sleep 10 && echo BG_OK", status: "in_progress", rawInput: { CommandLine: "sleep 10 && echo BG_OK", WaitMsBeforeAsync: 500 } });
  };
  const notifications = (events: EngineStreamEvent[]) => events.filter((event) => event.type === "task_notification");

  it("delivers output pushed to an idle session after a background command as a follow-up of the turn that started it", async () => {
    const { events, server } = await finishedTurn(backgroundCommand);
    const before = events.length;
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed", rawOutput: { output: "BG_OK\n", exit_code: 0 } });
    server.text("\n\nThe background command finished: ");
    server.text("BG_OK");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 140, size: 1000 });
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)).toEqual([{ type: "task_notification", text: "The background command finished: BG_OK", sessionId: SESSION_A, status: "completed", origin: "bound" }]);
    // Wake-up output is a separate follow-up, never more text of the finished reply.
    expect(events.slice(before).filter((event) => event.type !== "task_notification")).toEqual([]);
  });

  it("waits while a tool the wake-up started is still running", async () => {
    const { events, server } = await finishedTurn();
    server.text("Checking the result");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 120, size: 1000 });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_w", name: "run_command", kind: "execute", title: "cat out.txt", status: "in_progress", rawInput: { CommandLine: "cat out.txt" } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(notifications(events)).toHaveLength(0);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_w", status: "completed", rawOutput: { output: "ok" } });
    server.text(" - all good.");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 130, size: 1000 });
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)[0]).toMatchObject({ text: "Checking the result - all good.", origin: "unattributed" });
  });

  it("marks a wake-up it cannot tie to a request, such as a finished subagent, as unattributed", async () => {
    const { events, server } = await finishedTurn((s) => {
      s.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_sub", name: "invoke_subagent", kind: "other", title: "Run invoke_subagent", status: "in_progress", rawInput: { TypeName: "research" } });
      s.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_sub", status: "completed" });
    });
    server.text("The research subagent reported back.");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 150, size: 1000 });
    await waitFor(() => notifications(events).length === 1);
    expect(notifications(events)[0]).toEqual({ type: "task_notification", text: "The research subagent reported back.", sessionId: SESSION_A, status: "completed", origin: "unattributed" });
  });

  it("hands what already arrived to the App before a new message takes the session over", async () => {
    const { adapter, events, server } = await finishedTurn(backgroundCommand);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed", rawOutput: { output: "BG_OK" } });
    server.text("Partial wake-up text");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const nextEvents: EngineStreamEvent[] = [];
    const next = adapter.sendUserMessage(SESSION_A, { text: "new question", files: [], onEngineEvent: (event) => { nextEvents.push(event); } });
    await waitFor(() => server.prompts.length === 2);
    expect(notifications(events)).toEqual([expect.objectContaining({ text: "Partial wake-up text", origin: "bound" })]);
    server.text("Answer to the new question");
    server.respondPrompt();
    await expect(settleWithin(next)).resolves.toMatchObject({ text: "Answer to the new question" });
    expect(notifications(nextEvents)).toHaveLength(0);
  });

  it("delivers an open wake-up before destroy closes the session", async () => {
    const { adapter, events, server, harness } = await finishedTurn(undefined, { wakeQuietMs: 10_000 });
    server.text("Late report");
    server.sendUpdate({ sessionUpdate: "usage_update", used: 160, size: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.destroy();
    expect(notifications(events)).toEqual([expect.objectContaining({ text: "Late report" })]);
    expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
  });

  it("does not recycle an idle session whose background command is still running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const { harness } = await finishedTurn(backgroundCommand, { idleWorkerTtlMs: 1_000, idleSweepIntervalMs: 500 });
      vi.advanceTimersByTime(5_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(harness.log).toEqual([]);
      harness.children[0]!.server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      vi.advanceTimersByTime(5_000);
      await waitFor(() => harness.log.includes("kill:900"));
      expect(harness.log).toEqual([`close:${SESSION_A}`, "stdin-end:900", "kill:900"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AntigravityAcpAdapter tasks and native commands", () => {
  it("lists background commands still running as shell tasks that cannot be stopped one by one", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    await expect(adapter.listTasks("tarobot-1")).resolves.toEqual({ supported: true, tasks: [] });
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_fg", name: "run_command", kind: "execute", title: "sleep 2", status: "in_progress", rawInput: { CommandLine: "sleep 2" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A command the model is still waiting for is part of the reply, not a background task.
    await expect(adapter.listTasks(SESSION_A)).resolves.toEqual({ supported: true, tasks: [] });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_fg", status: "completed" });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_bg", name: "run_command", kind: "execute", title: "npm run build", status: "in_progress", rawInput: { CommandLine: "npm run build", WaitMsBeforeAsync: 500 } });
    server.sendUpdate({ sessionUpdate: "tool_call", toolCallId: "call_sub", name: "invoke_subagent", kind: "other", title: "Run invoke_subagent", status: "in_progress" });
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_sub", status: "completed" });
    server.sendUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 });
    server.text("started");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const running = await adapter.listTasks(SESSION_A);
    expect(running.tasks).toEqual([{
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/), label: "npm run build", kind: "shell", mode: "background", status: "running",
      canStop: false, startedAt: expect.any(Number), updatedAt: expect.any(Number), owner: "bound",
    }]);
    expect(running.tasks[0]!.id).not.toContain("call_bg");
    expect(adapter.stopTask).toBeUndefined();
    server.respondPrompt();
    await settleWithin(reply);
    expect((await adapter.listTasks(SESSION_A)).tasks.map((task) => task.label)).toEqual(["npm run build"]);
    server.sendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call_bg", status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(adapter.listTasks(SESSION_A)).resolves.toEqual({ supported: true, tasks: [] });
  });

  it("keeps the latest native command list from available_commands_update", async () => {
    const harness = createHarness();
    const adapter = track(await adapterFor(harness));
    expect(adapter.advertisedCommands()).toEqual([]);
    const reply = adapter.sendUserMessage("tarobot-1", { text: "x", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.sendUpdate({ sessionUpdate: "available_commands_update", availableCommands: [
      { name: "goal", description: "Run until the specified goal is completely finished." },
      { name: "grill-me", description: "Interview me to align on a plan." },
      { name: "bad name!", description: "ignored" },
      { name: "pr2-echo", description: "x".repeat(400) },
    ] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(adapter.advertisedCommands()).toEqual([
      { name: "goal", description: "Run until the specified goal is completely finished." },
      { name: "grill-me", description: "Interview me to align on a plan." },
      { name: "pr2-echo", description: "x".repeat(300) },
    ]);
    server.text("ok");
    server.respondPrompt();
    await settleWithin(reply);
  });
});
