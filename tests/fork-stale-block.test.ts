import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { CoreSideSessions } from "../src/core/side-sessions.js";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { historyReason } from "../client/src/conversation-history-state.js";

function fakeClaudeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.pid = 424242;
  proc.killed = false;
  proc.exitCode = null;
  proc.kill = vi.fn(() => { proc.killed = true; return true; });
  return proc;
}

describe("Issue #131: Fork stays disabled when Claude Bot has nothing running", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  it("does not leave Claude historyBlock stuck after an expired queued task notification or idle init frame", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "claude-131-"));
    dirs.push(dir);
    const proc = fakeClaudeProcess();
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: dir,
      taskNotificationStartGraceMs: 25,
      spawnFn: () => proc as never,
    });
    const sessionId = "11111111-1111-4111-8111-111111111111";

    // Start a real turn so a persistent worker exists for sessionId.
    const turnPromise = adapter.sendUserMessage(sessionId, {
      conversationKey: "gw:conv1",
      text: "hello",
      files: [],
      onEngineEvent: () => undefined,
    });
    await new Promise(r => setTimeout(r, 10));
    proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "assistant", session_id: sessionId, message: { id: "m1", content: [{ type: "text", text: "ok" }] } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, result: "ok" })}\n`);
    await turnPromise;

    // Reproduce 1: A review turn runs for task A while task B finishes and gets queued in queuedTaskNotifications.
    proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "taskA", description: "bg A" })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "task_started", session_id: sessionId, task_id: "taskB", description: "bg B" })}\n`);
    await new Promise(r => setTimeout(r, 10));
    // While tasks are genuinely running, fork MUST be blocked with "background_work".
    expect((adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId)).toBe("background_work");

    proc.stdout.write(`${JSON.stringify({ type: "user", origin: { kind: "task-notification" }, session_id: sessionId, message: { role: "user", content: "<task-notification><task-id>taskA</task-id><status>completed</status><summary>A done</summary></task-notification>" } })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "task_notification", session_id: sessionId, task_id: "taskB", status: "completed", summary: "B done" })}\n`);
    // Task A's review finishes; task B stays queued (reviewTurn: false).
    proc.stdout.write(`${JSON.stringify({ type: "result", session_id: sessionId, task_id: "taskA", result: "Reviewed A" })}\n`);

    // Wait past the grace window so NO background task or review is actually active anymore.
    await new Promise(r => setTimeout(r, 60));

    // Also emit an idle system/init frame (which should NOT re-stick nativeTurnOpen).
    proc.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
    await new Promise(r => setTimeout(r, 10));

    const blocked = (adapter as unknown as { historyBlock(id: string): string | undefined }).historyBlock(sessionId);
    expect(blocked).toBeUndefined();
    expect(adapter.hasPendingNativeWork()).toBe(false);

    await adapter.destroy();
  });

  it("scopes side-session busy checks to the requested conversation and reports side_session specifically", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "side-131-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh", approvalMode: "bypass" }));
    let releaseOpen!: () => void;
    const gate = new Promise<void>(resolve => { releaseOpen = resolve; });
    const side = new CoreSideSessions({
      open: async () => {
        await gate;
        return { ask: async () => ({ text: "ok" }), close: async () => undefined };
      },
      beforeAsk: async () => undefined,
      record: async () => undefined,
    });

    // Open a preparing side session on conversation A ONLY.
    side.open({ userId: "owner", deviceId: "dev1", conversationId: "convA" }, "req1", { supported: true, concurrent: true, liveContext: false, tools: "none" });
    expect(side.activeCount("convA")).toBe(1);
    expect(side.activeCount("convB")).toBe(0);

    const channel = {
      transport: {
        capabilities: ["conversations.history.v1"],
        requestLive: async () => ({ allowed: true }),
        enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve() }),
      },
      isConversationProcessing: () => false,
      canSteerConversation: async () => true,
    };
    const runtime = {
      chatQueue: { isBusy: () => false },
      activeRuns: new Map(),
      concurrentRuns: new Map(),
      pendingBatches: new Set(),
      pendingApprovals: new Map(),
    };
    const bridge = {
      getConversationHistory: async () => ({ supported: true, revision: "rev1", capabilities: { fork: true, anchoredFork: true, rewind: false } }),
    };

    const handler = gatewayConversationHistory(bridge as never, channel as never, runtime as never, dir, "bot1", (convId) => side.activeCount(convId) > 0);

    // Conversation B has NO side session -> MUST NOT be blocked!
    const snapB = await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convB" }) as { blocked?: string };
    expect(snapB.blocked).toBeUndefined();

    // Conversation A has an active side session -> MUST report specific "side_session" reason!
    const snapA = await handler("history.snapshot", { userId: "owner", botId: "bot1", conversationId: "convA" }) as { blocked?: string };
    expect(snapA.blocked).toBe("side_session");

    releaseOpen();
    await side.closeAll();
  });

  it("renders distinct user-facing messages for busy, background_work, and side_session", () => {
    const busyText = historyReason("busy");
    const bgText = historyReason("background_work");
    const sideText = historyReason("side_session");
    expect(busyText).not.toBe(bgText);
    expect(bgText).not.toBe(sideText);
    expect(busyText).not.toBe(sideText);
  });
});
