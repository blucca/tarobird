import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/process-tree.js", () => ({ killProcessTree: vi.fn() }));

import { CodexAppServerAdapter, CodexThreadMissingError } from "../src/codex/app-server-adapter.js";

/**
 * Operations on a goal that already exists read or change one native thread.
 * When that thread is gone they say so. They never start another thread: a
 * thread started for a status query is bound to nothing and stays in Codex's
 * history, and its empty goal would be reported as "this chat has no goal".
 *
 * The app-server here is scripted: it answers by method. It is not Codex.
 */

type Request = { id: number; method: string; params: Record<string, unknown> };
type Reply = { result: unknown } | { error: string };

const GONE = "0199a1b2-0000-7000-8000-00000000dead";
const LIVE = "0199a1b2-0000-7000-8000-00000000beef";
const UNBOUND = "tarobot-42-3f6c1c1e-6a53-4d4e-9d55-0d1f0a5a7e10";
const GOAL = { threadId: LIVE, objective: "Finish the fixture", status: "paused", tokenBudget: 500, tokensUsed: 120, timeUsedSeconds: 4, createdAt: 1, updatedAt: 2 };

const adapters: CodexAppServerAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.destroy(); vi.restoreAllMocks(); });

function appServer(notFound = (threadId: string) => `thread not found: ${threadId}`) {
  const requests: Request[] = [];
  let started = 0;
  const answer = (request: Request): Reply => {
    const threadId = String(request.params?.threadId ?? "");
    switch (request.method) {
      case "initialize": return { result: {} };
      case "thread/resume": return threadId === LIVE ? { result: { thread: { id: LIVE } } } : { error: notFound(threadId) };
      case "thread/start": return { result: { thread: { id: `started-${++started}` } } };
      case "thread/goal/get": return { result: { goal: threadId === LIVE ? GOAL : null } };
      case "thread/goal/set": return { result: { goal: { ...GOAL, ...request.params } } };
      case "thread/goal/clear": return { result: { cleared: threadId === LIVE } };
      default: return { result: {} };
    }
  };
  const stdout = new EventEmitter(), stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined, stdout, stderr, kill() {},
    stdin: {
      write(chunk: string | Buffer, callback?: (error?: Error | null) => void): boolean {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Partial<Request>;
          // Notifications carry no id and get no answer.
          if (typeof message.id !== "number" || typeof message.method !== "string") continue;
          const request = { id: message.id, method: message.method, params: message.params ?? {} };
          requests.push(request);
          const reply = answer(request);
          queueMicrotask(() => stdout.emit("data", `${JSON.stringify("error" in reply ? { id: request.id, error: { message: reply.error } } : { id: request.id, result: reply.result })}\n`));
        }
        callback?.(null);
        return true;
      },
    },
  });
  const adapter = new CodexAppServerAdapter("codex", "/srv/goal-missing-fixture", (() => child) as never);
  adapters.push(adapter);
  const sent = (method: string) => requests.filter(request => request.method === method);
  return { adapter, requests, sent };
}

describe("a Codex goal operation on a thread that no longer exists", () => {
  it.each([
    ["thread not found", (id: string) => `thread not found: ${id}`],
    ["no rollout found", (id: string) => `no rollout found for thread id ${id}`],
  ])("status says the thread is gone (%s) instead of reporting no goal, and starts no thread", async (_label, notFound) => {
    const { adapter, sent } = appServer(notFound);

    for (let query = 0; query < 3; query++) {
      const read = adapter.getThreadGoal(GONE).then(value => ({ value }), (error: unknown) => ({ error }));
      const outcome = await read;
      expect(outcome).not.toHaveProperty("value");
      expect((outcome as { error: unknown }).error).toBeInstanceOf(CodexThreadMissingError);
      expect((outcome as { error: CodexThreadMissingError }).error.threadId).toBe(GONE);
    }

    expect(sent("thread/resume").length).toBe(3);
    expect(sent("thread/start")).toEqual([]);
    expect(sent("thread/goal/get")).toEqual([]);
  });

  it("clear, pause and edit fail the same way and send nothing to any other thread", async () => {
    const { adapter, sent } = appServer();

    await expect(adapter.clearThreadGoal(GONE)).rejects.toBeInstanceOf(CodexThreadMissingError);
    await expect(adapter.clearThreadGoal(GONE, { isCurrentSession: () => true })).rejects.toBeInstanceOf(CodexThreadMissingError);
    await expect(adapter.updateThreadGoal(GONE, { status: "paused" })).rejects.toBeInstanceOf(CodexThreadMissingError);
    await expect(adapter.updateThreadGoal(GONE, { objective: "Something else", isCurrentSession: () => true })).rejects.toBeInstanceOf(CodexThreadMissingError);

    expect(sent("thread/start")).toEqual([]);
    expect(sent("thread/goal/clear")).toEqual([]);
    expect(sent("thread/goal/set")).toEqual([]);
  });

  it.each(["resume", "observe"] as const)("%s of an existing goal fails the same way and starts no thread", async mode => {
    const { adapter, sent } = appServer();

    await expect(adapter.watchThreadGoal(GONE, { objective: GOAL.objective, mode })).rejects.toBeInstanceOf(CodexThreadMissingError);
    await expect(adapter.watchThreadGoal(GONE, { objective: GOAL.objective, mode, isCurrentSession: () => true })).rejects.toBeInstanceOf(CodexThreadMissingError);

    expect(sent("thread/start")).toEqual([]);
    expect(sent("thread/goal/set")).toEqual([]);
    expect(sent("thread/goal/get")).toEqual([]);
  });
});

describe("a Codex goal operation on a chat that has no native thread yet", () => {
  it("has no goal to read or clear, and asks Codex for nothing", async () => {
    const { adapter, requests } = appServer();

    expect(await adapter.getThreadGoal(UNBOUND)).toEqual({ goal: null });
    expect(await adapter.clearThreadGoal(UNBOUND)).toEqual({ cleared: false });

    expect(requests.map(request => request.method).filter(method => method !== "initialize")).toEqual([]);
  });

  it("has no goal to pause, edit, resume or observe, and starts no thread for it", async () => {
    const { adapter, sent } = appServer();

    await expect(adapter.updateThreadGoal(UNBOUND, { status: "paused" })).rejects.toThrow(/no Codex thread/i);
    await expect(adapter.watchThreadGoal(UNBOUND, { objective: GOAL.objective, mode: "resume" })).rejects.toThrow(/no Codex thread/i);
    await expect(adapter.watchThreadGoal(UNBOUND, { objective: GOAL.objective, mode: "observe" })).rejects.toThrow(/no Codex thread/i);

    expect(sent("thread/start")).toEqual([]);
    expect(sent("thread/goal/set")).toEqual([]);
  });
});

describe("what stays as it was", () => {
  it("reads and patches the goal of a thread that exists", async () => {
    const { adapter, sent } = appServer();

    expect(await adapter.getThreadGoal(LIVE)).toEqual({ goal: GOAL, sessionId: undefined });
    expect((await adapter.updateThreadGoal(LIVE, { status: "active" })).goal).toMatchObject({ threadId: LIVE, status: "active" });
    expect(await adapter.clearThreadGoal(LIVE)).toEqual({ cleared: true, sessionId: undefined });

    expect(sent("thread/resume").map(request => request.params.threadId)).toEqual([LIVE]);
    expect(sent("thread/start")).toEqual([]);
  });

  it("setting a new goal is setup: it may start the thread the goal will live on", async () => {
    const { adapter, sent } = appServer();

    const set = await adapter.setThreadGoal(UNBOUND, { objective: "A new goal" });
    expect(set.sessionId).toBe("started-1");
    expect(sent("thread/start").length).toBe(1);
    expect(sent("thread/goal/set").map(request => request.params.threadId)).toEqual(["started-1"]);
  });

  it("a failure to load the thread that is not 'gone' is reported as itself", async () => {
    const { adapter, sent } = appServer(() => "stream disconnected before completion");

    const outcome = await adapter.getThreadGoal(GONE).then(() => null, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(CodexThreadMissingError);
    expect((outcome as Error).message).toContain("stream disconnected");
    expect(sent("thread/start")).toEqual([]);
  });
});
