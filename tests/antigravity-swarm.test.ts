import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  AntigravityAcpAdapter,
  type AgyAcpChildProcess,
  type SpawnAgyAcp,
} from "../src/codex/antigravity-acp-adapter.js";
import { antigravityVersionSupportsSwarm } from "../src/codex/antigravity-acp-support.js";
import {
  extractWorkerAttribution,
  mergeSwarmSnapshots,
  readSwarmBoardFiles,
  renderSwarmBoardSummary,
  swarmMembersToEngineTasks,
} from "../src/codex/antigravity-swarm.js";
import { renderCoreApprovalCard } from "../src/core/card-renderer.js";
import { requestCoreApproval } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { attachGateway } from "../src/gateway/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

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

class FakeSwarmAgyServer {
  readonly clientMessages: JsonRpcMessage[] = [];
  readonly clientResponses = new Map<number | string, JsonRpcMessage>();
  readonly prompts: JsonRpcMessage[] = [];
  readonly pendingPrompts = new Map<number | string, JsonRpcMessage>();
  availableCommands: Array<{ name: string; description: string }> = [
    { name: "compact", description: "Compact conversation" },
    { name: "swarm", description: "Start a multi-agent swarm (Preview & Quota Heavy)" },
  ];
  private inputBuffer = "";
  private nextRequestId = 1;

  constructor(private readonly stdout: FakeReadable, public sessionId: string, private readonly log: string[]) {}

  receive(chunk: string): void {
    this.inputBuffer += chunk;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) this.handle(JSON.parse(line) as JsonRpcMessage);
  }

  sendUpdate(update: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: this.sessionId, update } });
  }

  text(text: string): void {
    this.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  advertiseCommands(): void {
    this.sendUpdate({ sessionUpdate: "available_commands_update", availableCommands: this.availableCommands });
  }

  requestPermission(opts: { toolCallId?: string; command?: string; workerName?: string; _meta?: Record<string, unknown> } = {}): string {
    const id = String(this.nextRequestId++);
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: this.sessionId,
        ...(opts._meta ? { _meta: opts._meta } : {}),
        toolCall: {
          sessionUpdate: "tool_call",
          toolCallId: opts.toolCallId ?? "call_perm_1",
          name: "run_command",
          status: "pending",
          kind: "execute",
          title: opts.command ?? "npm test",
          rawInput: { CommandLine: opts.command ?? "npm test", ...(opts.workerName ? { workerName: opts.workerName } : {}) },
          ...(opts.workerName ? { _meta: { workerName: opts.workerName } } : {}),
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    return id;
  }

  requestElicitation(opts: { workerName?: string; message?: string } = {}): string {
    const id = String(this.nextRequestId++);
    this.send({
      jsonrpc: "2.0",
      id,
      method: "elicitation/create",
      params: {
        sessionId: this.sessionId,
        mode: "form",
        message: opts.message ?? "Pick a database engine for auth",
        requestedSchema: {
          type: "object",
          required: ["db"],
          properties: {
            db: {
              type: "string",
              title: "Database",
              oneOf: [
                { const: "sqlite", title: "SQLite" },
                { const: "postgres", title: "PostgreSQL" },
              ],
            },
          },
        },
        ...(opts.workerName ? { _meta: { workerName: opts.workerName } } : {}),
      },
    });
    return id;
  }

  respondPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }): void {
    const entry = [...this.pendingPrompts.entries()].at(-1);
    if (!entry) throw new Error("No pending prompt");
    this.pendingPrompts.delete(entry[0]);
    this.send({ jsonrpc: "2.0", id: entry[0], result });
  }

  private handle(message: JsonRpcMessage): void {
    this.clientMessages.push(message);
    if (!message.method) {
      if (message.id !== undefined) this.clientResponses.set(message.id, message);
      return;
    }
    if (message.method === "initialize") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "Fake Swarm AGY ACP", version: "1.5.17" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
          },
          authMethods: [],
        },
      });
      return;
    }
    if (message.method === "session/new") {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: this.sessionId, modes: { currentModeId: "default", availableModes: [] }, configOptions: [] },
      });
      return;
    }
    if (message.method === "session/prompt") {
      this.prompts.push(message);
      this.pendingPrompts.set(message.id!, message);
      return;
    }
    if (message.method === "session/cancel") {
      this.log.push(`cancel:${String(message.params?.sessionId)}`);
      if (this.pendingPrompts.size) this.respondPrompt({ stopReason: "cancelled" });
      return;
    }
    if (message.method === "session/close") {
      this.log.push(`close:${String(message.params?.sessionId)}`);
      this.send({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
  }

  private send(payload: Record<string, unknown>): void {
    this.stdout.emitData(`${JSON.stringify(payload)}\n`);
  }
}

function createSwarmHarness(configure?: (server: FakeSwarmAgyServer) => void) {
  const log: string[] = [];
  const children: Array<{ pid: number; server: FakeSwarmAgyServer }> = [];
  let nextPid = 5000;
  const spawnFn: SpawnAgyAcp = (() => {
    const stdout = new FakeReadable();
    const stderr = new FakeReadable();
    const child = new EventEmitter() as EventEmitter & AgyAcpChildProcess & { pid: number };
    child.pid = nextPid++;
    const server = new FakeSwarmAgyServer(stdout, "swarm-sess-1", log);
    configure?.(server);
    const stdin = new FakeWritable((chunk) => server.receive(chunk), () => { log.push(`stdin-end:${child.pid}`); });
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
    children.push({ pid: child.pid, server });
    return child;
  }) as SpawnAgyAcp;
  const killProcessTreeFn = (pid: number | undefined) => {
    log.push(`kill:${pid}`);
    const entry = children.find((c) => c.pid === pid);
    if (entry) {
      // Child close runs via microtask.
    }
  };
  return { log, children, spawnFn, killProcessTreeFn };
}

const tempRoots: string[] = [];
const adapters: AntigravityAcpAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.destroy()));
  await Promise.all(tempRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function setupEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-swarm-test-"));
  tempRoots.push(root);
  const configPath = path.join(root, "config.json");
  const brainDir = path.join(root, "brain");
  const workspacePath = path.join(root, "workspace");
  await mkdir(brainDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "normal", antigravityRuntime: "acp" }));
  return { root, configPath, brainDir, workspacePath };
}

async function writeSwarmFiles(brainDir: string, sessionId: string, opts: { members?: unknown; boardLines?: string[] }) {
  const dir = path.join(brainDir, sessionId, ".system_generated", "swarm");
  await mkdir(dir, { recursive: true });
  if (opts.members !== undefined) {
    await writeFile(path.join(dir, "members.json"), typeof opts.members === "string" ? opts.members : JSON.stringify(opts.members));
  }
  if (opts.boardLines !== undefined) {
    await writeFile(path.join(dir, "board.jsonl"), opts.boardLines.join("\n"));
  }
}

describe("antigravity swarm parser & helpers", () => {
  it("checks antigravity CLI swarm support version threshold (>= 1.5.5)", () => {
    expect(antigravityVersionSupportsSwarm("antigravity 1.5.4")).toBe(false);
    expect(antigravityVersionSupportsSwarm("antigravity 1.5.5")).toBe(true);
    expect(antigravityVersionSupportsSwarm("antigravity 1.5.17")).toBe(true);
    expect(antigravityVersionSupportsSwarm("invalid output")).toBe(false);
  });

  it("parses members.json + board.jsonl, groups monitor/narrator helpers, and flags unknown formats", async () => {
    const { brainDir } = await setupEnv();
    await writeSwarmFiles(brainDir, "sess-board", {
      members: {
        title: "Refactor auth & tests",
        members: [
          { name: "auth-fix", role: "worker", state: "working", model: "gemini-4-neon", latestActivity: "Fixing token verification" },
          { name: "ui-check", role: "worker", state: "waiting", model: "gemini-4-argon" },
          { name: "monitor", role: "monitor", state: "working", model: "gemini-4-flash", latestActivity: "Watching test board" },
          { name: "narrator", role: "narrator", state: "waiting", latestActivity: "Summarizing progress" },
        ],
      },
      boardLines: [
        JSON.stringify({ id: "p1", author: "auth-fix", content: "Found bug in JWT check. @ui-check please verify login redirect.", createdAt: 1700000001000 }),
        JSON.stringify({ id: "p2", author: "ui-check", title: "Redirect check", content: "Verified login redirect flow.", createdAt: 1700000002000 }),
      ],
    });

    const parsed = await readSwarmBoardFiles(brainDir, "sess-board");
    expect(parsed.found).toBe(true);
    expect(parsed.active).toBe(true);
    expect(parsed.formatUnknown).toBe(false);
    expect(parsed.title).toBe("Refactor auth & tests");
    expect(parsed.members).toHaveLength(4);
    expect(parsed.members.find((m) => m.name === "ui-check")?.latestActivity).toContain("Redirect check");
    expect(parsed.posts[0]?.mentions).toEqual(["ui-check"]);

    const snapshot = mergeSwarmSnapshots(undefined, parsed, { sessionId: "sess-board" })!;
    const tasks = swarmMembersToEngineTasks("sess-board", snapshot);
    expect(tasks.find((t) => t.label === "auth-fix")).toMatchObject({ swarmState: "working", model: "gemini-4-neon" });
    expect(tasks.find((t) => t.label === "auth-fix")?.helper).toBeUndefined();
    expect(tasks.find((t) => t.label === "monitor")).toMatchObject({ helper: true, role: "monitor", swarmState: "working" });
    expect(tasks.find((t) => t.label === "narrator")).toMatchObject({ helper: true, role: "narrator", swarmState: "waiting" });

    expect(renderSwarmBoardSummary(snapshot, "en")).toContain("Refactor auth & tests");

    // Malformed / unknown format degrades safely.
    await writeSwarmFiles(brainDir, "sess-bad", {
      members: "{bad json",
      boardLines: ["not json line"],
    });
    const bad = await readSwarmBoardFiles(brainDir, "sess-bad");
    expect(bad.found).toBe(true);
    expect(bad.formatUnknown).toBe(true);
    expect(bad.members).toEqual([]);
  });

  it("extracts worker attribution from ACP metadata, rawInput, and prefixed titles", () => {
    expect(extractWorkerAttribution({ _meta: { workerName: "auth-fix" } })).toBe("auth-fix");
    expect(extractWorkerAttribution({ toolCall: { rawInput: { memberName: "@ui-check" } } })).toBe("ui-check");
    expect(extractWorkerAttribution({ toolCall: { title: "[reviewer] npm test" } })).toBe("reviewer");
    expect(extractWorkerAttribution({ _meta: { sender: "system" } })).toBeUndefined();
  });
});

describe("AntigravityAcpAdapter /swarm lifecycle", () => {
  it("rejects /swarm when agy version < 1.5.5 or ACP session omits /swarm without sending prompt", async () => {
    const env = await setupEnv();
    const oldHarness = createSwarmHarness();
    const oldAdapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: oldHarness.spawnFn,
      killProcessTreeFn: oldHarness.killProcessTreeFn,
      supportsSwarmFn: async () => false,
    });
    adapters.push(oldAdapter);

    const oldReply = await oldAdapter.sendUserMessage("tarobot-1", { text: "/swarm audit code", files: [], locale: "en", onApprovalRequest: async () => ({ behavior: "deny" }) });
    expect(oldReply.text).toContain("1.5.5");
    expect(oldHarness.children).toHaveLength(0);

    const unadvertisedHarness = createSwarmHarness((server) => {
      server.availableCommands = [{ name: "compact", description: "Compact" }];
    });
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: unadvertisedHarness.spawnFn,
      killProcessTreeFn: unadvertisedHarness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
    });
    adapters.push(adapter);

    const first = adapter.sendUserMessage("tarobot-1", { text: "hello", files: [], onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }) });
    await waitFor(() => unadvertisedHarness.children[0]?.server.prompts.length === 1);
    const server = unadvertisedHarness.children[0]!.server;
    server.advertiseCommands();
    server.text("hi");
    server.respondPrompt();
    await first;

    const blocked = await adapter.sendUserMessage("swarm-sess-1", { text: "/swarm parallel check", files: [], locale: "zh", onApprovalRequest: async () => ({ behavior: "allow", scope: "once" }) });
    expect(blocked.text).toContain("未开放 `/swarm`");
    expect(server.prompts).toHaveLength(1);
  });

  it("suppresses inactivity & idle reaper timeouts while swarm workers are working/waiting, handles post-coordinator worker approvals + elicitation + wake-up + /swarm board + @worker + Stop", async () => {
    const env = await setupEnv();
    const harness = createSwarmHarness();
    const adapter = new AntigravityAcpAdapter("agy", {
      ...env,
      spawnFn: harness.spawnFn,
      killProcessTreeFn: harness.killProcessTreeFn,
      supportsSwarmFn: async () => true,
      idleWorkerTtlMs: 30,
      idleSweepIntervalMs: 10,
      inactivityTimeoutMs: 40,
      turnTimeoutMs: 60,
      wakeQuietMs: 10,
      closeTimeoutMs: 50,
      cancelGraceMs: 50,
    });
    adapters.push(adapter);

    const events: EngineStreamEvent[] = [];
    const approvals: EngineApprovalRequest[] = [];
    const pendingQuestions: Array<{ req: EngineApprovalRequest; resolve: (d: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny" }) => void }> = [];

    const turnReply = adapter.sendUserMessage("tarobot-1", {
      text: "/swarm parallel audit",
      files: [],
      locale: "en",
      onEngineEvent: (ev) => { events.push(ev); },
      onApprovalRequest: async (req) => {
        approvals.push(req);
        if (req.toolName === "AskUserQuestion") {
          return await new Promise((resolve) => { pendingQuestions.push({ req, resolve }); });
        }
        return { behavior: "allow", scope: "once" };
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0]!.server;
    server.advertiseCommands();
    await writeSwarmFiles(env.brainDir, "swarm-sess-1", {
      members: {
        title: "Parallel security audit",
        members: [
          { name: "auth-audit", role: "worker", state: "working", model: "gemini-4-neon", latestActivity: "Inspecting JWT middleware" },
          { name: "monitor", role: "monitor", state: "waiting", model: "gemini-4-flash" },
        ],
      },
      boardLines: [
        JSON.stringify({ id: "b1", author: "auth-audit", content: "Checking routes", createdAt: Date.now() }),
      ],
    });

    // Wait longer than both inactivityTimeoutMs (40ms) and turnTimeoutMs (60ms) while swarm is active: turn MUST stay open.
    await new Promise((r) => setTimeout(r, 100));
    server.text("Coordinator kicked off workers.");
    server.respondPrompt();
    await expect(turnReply).resolves.toMatchObject({ text: "Coordinator kicked off workers.", sessionId: "swarm-sess-1" });

    // Wait longer than idleWorkerTtlMs (30ms) + idleSweepIntervalMs (10ms): idle reaper MUST NOT close ACP session while workers active!
    await new Promise((r) => setTimeout(r, 80));
    expect(harness.log.some((entry) => entry.startsWith("close:"))).toBe(false);
    expect(adapter.hasPendingNativeWork()).toBe(true);

    // /swarm board stays local and returns a read-only summary without calling session/prompt.
    const boardReply = await adapter.sendUserMessage("swarm-sess-1", {
      text: "/swarm board",
      files: [],
      locale: "en",
      onApprovalRequest: async () => ({ behavior: "deny" }),
    });
    expect(boardReply.text).toContain("Parallel security audit");
    expect(boardReply.text).toContain("@auth-audit");
    expect(server.prompts).toHaveLength(1);

    // @worker message is sent unwrapped ahead of private context.
    const directMention = adapter.sendUserMessage("swarm-sess-1", {
      text: "@auth-audit prioritize OAuth callback",
      files: [],
      instructions: "Platform rules",
      onApprovalRequest: async (req) => {
        approvals.push(req);
        if (req.toolName === "AskUserQuestion") {
          return await new Promise((resolve) => { pendingQuestions.push({ req, resolve }); });
        }
        return { behavior: "allow", scope: "once" };
      },
    });
    await waitFor(() => server.prompts.length === 2);
    const mentionBlocks = server.prompts[1]!.params!.prompt as Array<{ text: string }>;
    expect(mentionBlocks[0]!.text).toBe("@auth-audit prioritize OAuth callback");
    server.text("Noted for @auth-audit.");
    server.respondPrompt();
    await directMention;

    // Post-coordinator worker approval request arrives AFTER coordinator turn finished: must be forwarded with workerName instead of auto-declined!
    const permId = server.requestPermission({ workerName: "auth-audit", command: "npx vitest auth" });
    await waitFor(() => server.clientResponses.has(permId));
    expect(approvals.at(-1)?.workerName).toBe("auth-audit");
    expect(server.clientResponses.get(permId)?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });

    // Post-coordinator elicitation/create maps cleanly to AskUserQuestion with workerName and returns accept content!
    const elicitId = server.requestElicitation({ workerName: "auth-audit" });
    await waitFor(() => pendingQuestions.length === 1);
    expect(pendingQuestions[0]!.req.workerName).toBe("auth-audit");
    pendingQuestions[0]!.resolve({ behavior: "allow", updatedInput: { answers: { "Pick a database engine for auth": "PostgreSQL" } } });
    await waitFor(() => server.clientResponses.has(elicitId));
    expect(server.clientResponses.get(elicitId)?.result).toEqual({ action: "accept", content: { db: "postgres" } });

    // Card renderer shows @worker attribution clearly.
    const card = renderCoreApprovalCard({ requestId: "r1", toolName: "run_command", workerName: "auth-audit", locale: "en" });
    expect(JSON.stringify(card)).toContain("@auth-audit");

    // listTasks merges members + board posts.
    const snap = await adapter.listTasks("swarm-sess-1");
    expect(snap.swarm?.active).toBe(true);
    expect(snap.tasks.find((t) => t.label === "auth-audit")?.swarmState).toBe("working");
    expect(snap.tasks.find((t) => t.label === "monitor")?.helper).toBe(true);

    // Post-coordinator wake-up output reaches conversation.
    server.text("Worker auth-audit finished checking JWT.");
    await waitFor(() => events.some((ev) => ev.type === "task_notification" && ev.origin === "bound" && ev.text.includes("finished checking JWT")));

    // Stop Swarm cancels via session/close and ends background work cleanly.
    const stopped = await adapter.stopBackgroundWork("swarm-sess-1", { locale: "en" });
    expect(stopped.stopped).toBe(true);
    expect(stopped.summary).toContain("Stopped the active swarm");
    expect(harness.log).toContain("close:swarm-sess-1");
    expect(adapter.hasPendingNativeWork()).toBe(false);
    const afterStop = await adapter.listTasks("swarm-sess-1");
    expect(afterStop.swarm?.active).toBe(false);
    expect(afterStop.swarm?.members.find((m) => m.name === "auth-audit")?.state).toBe("killed");
  });

  it("supports Antigravity AskUserQuestion approval cards with workerName attribution and Gateway tasks.stop swarm", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-swarm-gw-"));
    tempRoots.push(root);
    const stateDir = path.join(root, "bot");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity", antigravityRuntime: "acp", locale: "en" }));

    // Test AskUserQuestion support for antigravity + workerName in core card-actions.
    const runtime = createCoreServiceRuntime();
    const sent: Array<{ card?: Record<string, unknown>; text?: string }> = [];
    const fakeChannel = {
      send: vi.fn(async (_to: string, payload: { card?: Record<string, unknown>; text?: string }) => {
        sent.push(payload);
        return { messageId: `m_${sent.length}` };
      }),
      stream: vi.fn(),
      downloadResource: vi.fn(),
    } as never;
    const ac = new AbortController();
    const decisionPromise = requestCoreApproval({
      channel: fakeChannel,
      runtime,
      chatId: "conv-1",
      conversationKey: "lark:conv-1",
      locale: "en",
      abortSignal: ac.signal,
      request: {
        engine: "antigravity",
        toolName: "AskUserQuestion",
        workerName: "schema-migrator",
        toolInput: { questions: [{ question: "Apply migration?", header: "Migration", options: [{ label: "Yes" }, { label: "No" }] }] },
      },
    });
    await waitFor(() => sent.length === 1);
    expect(JSON.stringify(sent[0])).toContain("@schema-migrator");
    expect(JSON.stringify(sent[0])).toContain("Apply migration?");
    ac.abort();
    await expect(decisionPromise).resolves.toEqual({ behavior: "deny" });

    // Test gateway tasks.stop with taskId: "swarm".
    const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('agy-bot','AGY Bot',?)", [hashSecret(secret)]);
    const stopBackgroundWork = vi.fn(async () => ({ stopped: true, summary: "Stopped the active swarm and ended all running workers." }));
    const channel = await attachGateway({
      stateDir,
      url: hub.url.replace("http", "ws") + "/instance",
      botId: "agy-bot",
      secret,
      engine: "antigravity",
      bridge: {
        handleAuthorizedMessage: vi.fn(async () => ({ text: "ok" })),
        stopBackgroundWork,
      },
      runtime: createCoreServiceRuntime(),
    });
    try {
      const conv = await hub.store.createConversation("owner", ["agy-bot"], "Swarm Stop", "create");
      const stopResult = await channel.onCall!("tasks.stop", {
        conversationId: conv.id,
        userId: "owner",
        taskId: "swarm",
        requestId: "req-stop-swarm-1",
      });
      expect(stopResult).toEqual({ outcome: "accepted" });
      expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
      const snap = await hub.store.snapshot("owner", conv.id);
      expect(snap.messages.some((m) => JSON.stringify(m.blocks).includes("Stopped the active swarm"))).toBe(true);
    } finally {
      await channel.disconnect();
      await hub.close();
    }
  }, 20_000);
});
