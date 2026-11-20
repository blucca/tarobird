import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/process-tree.js", () => ({ killProcessTree: vi.fn() }));

import type { EngineStreamEvent, NativeHistoryAnchor } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

/**
 * Native history on Codex: persistent `thread/fork` and `thread/revert`.
 *
 * The app-server here is scripted. Its rules and its error sentences are the
 * ones a real codex-cli 0.170.0 app-server showed in an isolated run: a fork
 * keeps the source's turn ids, `lastTurnId` is inclusive, and `thread/revert`
 * does NOT refuse a thread whose turn is running, it interrupts that turn.
 * The last point is why "is the source idle" is the adapter's own decision.
 */

type Request = { id: number; method: string; params: Record<string, unknown> };
type Reply = { result: unknown } | { error: string } | "silent";
type Turn = { id: string; status: "completed" | "interrupted" | "failed" | "inProgress" };

const SOURCE = "0199a1b2-0000-7000-8000-00000000aaaa";
const GONE = "0199a1b2-0000-7000-8000-00000000dead";
const UNBOUND = "tarobot-42-3f6c1c1e-6a53-4d4e-9d55-0d1f0a5a7e10";
const turn = (n: number): Turn => ({ id: `turn-${String(n).padStart(4, "0")}`, status: "completed" });

const adapters: CodexAppServerAdapter[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.destroy(); vi.restoreAllMocks(); });

function appServer(options: { turns?: number; override?: (request: Request) => Reply | undefined } = {}) {
  const threads = new Map<string, Turn[]>([[SOURCE, Array.from({ length: options.turns ?? 3 }, (_, index) => turn(index + 1))]]);
  const goals = new Map<string, unknown>();
  const requests: Request[] = [];
  let forks = 0, started = 0;
  const answer = (request: Request): Reply => {
    const overridden = options.override?.(request);
    if (overridden) return overridden;
    const threadId = String(request.params?.threadId ?? ""), turns = threads.get(threadId);
    switch (request.method) {
      case "initialize": return { result: {} };
      case "thread/start": { const id = `started-${++started}`; threads.set(id, []); return { result: { thread: { id, ephemeral: false } } }; }
      case "thread/resume": return turns ? { result: { thread: { id: threadId } } } : { error: `no rollout found for thread id ${threadId}` };
      case "thread/turns/list": {
        if (!turns) return { error: `thread not loaded: ${threadId}` };
        const from = request.params.cursor ? Number(request.params.cursor) : 0, limit = Number(request.params.limit ?? 25);
        const page = turns.slice(from, from + limit);
        return { result: { data: page, nextCursor: from + limit < turns.length ? String(from + limit) : null, backwardsCursor: null } };
      }
      case "thread/goal/get": return { result: { goal: goals.get(threadId) ?? null } };
      case "thread/fork": {
        if (!turns) return { error: `no rollout found for thread id ${threadId}` };
        const last = request.params.lastTurnId as string | undefined, end = last ? turns.findIndex(item => item.id === last) : turns.length - 1;
        if (last && end < 0) return { error: `turn not found: ${last}` };
        if (last && turns[end]!.status === "inProgress") return { error: `lastTurnId '${last}' identifies an in-progress turn` };
        const id = `fork-${++forks}`;
        threads.set(id, turns.slice(0, end + 1).map(item => ({ ...item })));
        return { result: { thread: { id, ephemeral: request.params.ephemeral === true, forkedFromId: threadId } } };
      }
      case "thread/revert": {
        if (!turns) return { error: `thread not loaded: ${threadId}` };
        const index = turns.findIndex(item => item.id === request.params.beforeTurnId);
        if (index < 0) return { error: `turn not found: ${String(request.params.beforeTurnId)}` };
        turns.splice(index);
        return { result: { thread: { id: threadId }, turnsBackwardsCursor: null, itemsBackwardsCursor: null } };
      }
      case "turn/start": { const id = `turn-live-${turns?.length ?? 0}`; turns?.push({ id, status: "inProgress" }); return { result: { turn: { id } } }; }
      default: return { result: {} };
    }
  };
  const stdout = new EventEmitter(), stderr = new EventEmitter();
  const emit = (message: unknown) => stdout.emit("data", `${JSON.stringify(message)}\n`);
  const child = Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined, stdout, stderr, kill() {},
    stdin: {
      write(chunk: string | Buffer, callback?: (error?: Error | null) => void): boolean {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Partial<Request>;
          if (typeof message.id !== "number" || typeof message.method !== "string") continue;
          const request = { id: message.id, method: message.method, params: message.params ?? {} };
          requests.push(request);
          const reply = answer(request);
          if (reply !== "silent") queueMicrotask(() => emit("error" in reply ? { id: request.id, error: { message: reply.error } } : { id: request.id, result: reply.result }));
        }
        callback?.(null);
        return true;
      },
    },
  });
  const adapter = new CodexAppServerAdapter("codex", "/srv/history-fixture", (() => child) as never);
  adapters.push(adapter);
  const sent = (method: string) => requests.filter(request => request.method === method);
  const anchorAt = (n: number, extra: Partial<NativeHistoryAnchor> = {}): NativeHistoryAnchor => ({ sessionId: SOURCE, inputId: turn(n).id, rewind: true, fork: true, forkBoundary: "after-turn", ...extra });
  /** A user turn that the engine has accepted and not finished. */
  const runningTurn = async () => {
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage(SOURCE, { text: "still working", files: [], onEngineEvent: event => { events.push(event); } });
    void reply.catch(() => {});
    await vi.waitFor(() => expect(events.some(event => event.type === "history_anchor")).toBe(true), { timeout: 2000, interval: 5 });
    const finish = async () => {
      const live = threads.get(SOURCE)!.at(-1)!; live.status = "completed";
      emit({ method: "item/completed", params: { threadId: SOURCE, turnId: live.id, item: { type: "agentMessage", text: "done" } } });
      emit({ method: "turn/completed", params: { threadId: SOURCE, turn: { id: live.id, items: [], status: "completed", error: null } } });
      return await reply;
    };
    return { events, finish };
  };
  const ids = (threadId: string) => threads.get(threadId)?.map(item => item.id);
  return { adapter, child, requests, sent, anchorAt, runningTurn, ids, goals, threads };
}

const writes = (server: ReturnType<typeof appServer>) => [...server.sent("thread/fork"), ...server.sent("thread/revert"), ...server.sent("thread/start")];

describe("the place in history a Codex turn offers", () => {
  it("is the turn id from the answer to this input's own turn/start, offered once", async () => {
    const server = appServer();
    const { events, finish } = await server.runningTurn();
    await finish();

    expect(events.filter(event => event.type === "history_anchor")).toEqual([{
      type: "history_anchor",
      anchor: { sessionId: SOURCE, inputId: "turn-live-3", rewind: true, fork: true, forkBoundary: "after-turn" },
    }]);
  });
});

describe("what a Codex thread's history can do now", () => {
  it("reports fork, rewind and the last turn as head for an idle thread, and changes nothing", async () => {
    const server = appServer();
    expect(await server.adapter.getHistoryState(SOURCE)).toEqual({ fork: { whole: true, anchored: true }, rewind: true, head: turn(3).id });
    expect(writes(server)).toEqual([]);
  });

  it("lists a long thread to its end", async () => {
    const server = appServer({ turns: 250 });
    expect((await server.adapter.getHistoryState(SOURCE)).head).toBe(turn(250).id);
    expect(server.sent("thread/turns/list").length).toBe(3);
  });

  it("says why nothing can be done, without starting or replacing anything", async () => {
    const server = appServer();
    expect(await server.adapter.getHistoryState(UNBOUND)).toEqual({ head: null, blocked: "not_ready" });
    expect(server.requests).toEqual([]);

    expect(await server.adapter.getHistoryState(GONE)).toEqual({ head: null, blocked: "source_missing" });

    server.goals.set(SOURCE, { threadId: SOURCE, objective: "Finish", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 });
    expect((await server.adapter.getHistoryState(SOURCE)).blocked).toBe("goal_active");
    server.goals.delete(SOURCE);

    const { finish } = await server.runningTurn();
    expect((await server.adapter.getHistoryState(SOURCE)).blocked).toBe("busy");
    await finish();
    expect((await server.adapter.getHistoryState(SOURCE)).blocked).toBeUndefined();
    expect(writes(server)).toEqual([]);
  });

  it("offers nothing on an app-server that cannot list turns", async () => {
    const server = appServer({ override: request => request.method === "thread/turns/list" ? { error: "Invalid request: unknown variant `thread/turns/list`" } : undefined });
    expect(await server.adapter.getHistoryState(SOURCE)).toEqual({ head: null });
  });
});

describe("a read that fails before a change", () => {
  const unreadable = (method: string, error: string) => appServer({ turns: 3, override: request => request.method === method ? { error } : undefined });

  it("does not take a goal read that failed for a thread without a goal", async () => {
    const server = unreadable("thread/goal/get", "failed to read goal state: permission denied");

    expect(await server.adapter.getHistoryState(SOURCE)).toEqual({ head: null, blocked: "not_ready" });
    expect(await server.adapter.forkHistory(SOURCE)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) })).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(writes(server)).toEqual([]);
    expect(server.ids(SOURCE)).toEqual([turn(1).id, turn(2).id, turn(3).id]);
  });

  it("knows there is no goal only when the app-server has no goal interface at all", async () => {
    const server = unreadable("thread/goal/get", "Invalid request: unknown variant `thread/goal/get`, expected one of `initialize`, `thread/start`");

    expect(await server.adapter.getHistoryState(SOURCE)).toEqual({ fork: { whole: true, anchored: true }, rewind: true, head: turn(3).id });
    expect(await server.adapter.forkHistory(SOURCE)).toMatchObject({ outcome: "applied", boundary: "whole" });
  });

  it("does not change a thread whose turns could not be listed", async () => {
    const server = unreadable("thread/turns/list", "failed to read rollout: input/output error");

    expect(await server.adapter.getHistoryState(SOURCE)).toEqual({ head: null, blocked: "not_ready" });
    expect(await server.adapter.forkHistory(SOURCE)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) })).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(writes(server)).toEqual([]);
  });
});

describe("a state read the caller gave up on", () => {
  const READY = { fork: { whole: true, anchored: true }, rewind: true, head: turn(3).id };
  const answerLate = (server: ReturnType<typeof appServer>, request: Request, result: unknown) =>
    server.child.stdout.emit("data", `${JSON.stringify({ id: request.id, result })}\n`);
  const soon = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<"still waiting">(resolve => setTimeout(() => resolve("still waiting"), 300))]);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  it.each([
    ["thread/turns/list", { data: [turn(1)], nextCursor: null }],
    ["thread/goal/get", { goal: null }],
  ] as const)("stops waiting for %s, asks nothing more, and leaves the app-server to the next read", async (method, late) => {
    let hold = true;
    const server = appServer({ override: request => hold && request.method === method ? "silent" : undefined });
    const caller = new AbortController();
    const read = server.adapter.getHistoryState(SOURCE, { signal: caller.signal });
    await vi.waitFor(() => expect(server.sent(method)).toHaveLength(1), { timeout: 2000, interval: 5 });
    const asked = server.requests.length;

    caller.abort(new Error("the menu was closed"));
    expect(await soon(read)).toEqual({ head: null, blocked: "not_ready" });

    // The answer Codex was still preparing arrives afterwards and starts nothing.
    answerLate(server, server.sent(method)[0]!, late);
    await settle();
    expect(server.requests.length).toBe(asked);

    // Only this read was given up: the same app-server answers the next one.
    hold = false;
    expect(await server.adapter.getHistoryState(SOURCE)).toEqual(READY);
    expect(server.sent("initialize")).toHaveLength(1);
    expect(writes(server)).toEqual([]);
  });

  it("does not go on to the goal read once the caller gave up", async () => {
    const caller = new AbortController();
    const server = appServer({ override: request => { if (request.method === "thread/turns/list") caller.abort(); return undefined; } });

    expect(await soon(server.adapter.getHistoryState(SOURCE, { signal: caller.signal }))).toEqual({ head: null, blocked: "not_ready" });
    expect(server.sent("thread/turns/list")).toHaveLength(1);
    expect(server.sent("thread/goal/get")).toEqual([]);
  });

  it("asks Codex nothing when the caller had already given up", async () => {
    const server = appServer();

    expect(await server.adapter.getHistoryState(SOURCE, { signal: AbortSignal.abort() })).toEqual({ head: null, blocked: "not_ready" });
    expect(server.requests).toEqual([]);
  });

  it("lets a thread that is being loaded finish loading, then reads nothing", async () => {
    let hold = true;
    const server = appServer({ override: request => hold && request.method === "thread/resume" ? "silent" : undefined });
    const caller = new AbortController();
    const read = server.adapter.getHistoryState(SOURCE, { signal: caller.signal });
    await vi.waitFor(() => expect(server.sent("thread/resume")).toHaveLength(1), { timeout: 2000, interval: 5 });

    // Loading belongs to the shared app-server, not to this caller: it is not abandoned half-way.
    caller.abort();
    expect(await soon(read)).toBe("still waiting");
    hold = false;
    answerLate(server, server.sent("thread/resume")[0]!, { thread: { id: SOURCE } });

    expect(await soon(read)).toEqual({ head: null, blocked: "not_ready" });
    expect(server.sent("thread/turns/list")).toEqual([]);
    expect(await server.adapter.getHistoryState(SOURCE)).toEqual(READY);
    expect(server.sent("thread/resume")).toHaveLength(1);
  });
});

describe("forking a Codex thread", () => {
  it("forks the whole history into a new persistent thread and leaves the source as it was", async () => {
    const server = appServer();
    const result = await server.adapter.forkHistory(SOURCE, { expectedHead: turn(3).id });

    expect(result).toEqual({ outcome: "applied", sessionId: "fork-1", head: turn(3).id, boundary: "whole" });
    const [fork] = server.sent("thread/fork");
    expect(fork!.params).toMatchObject({ threadId: SOURCE, excludeTurns: true, approvalPolicy: "never" });
    expect(fork!.params).not.toHaveProperty("ephemeral");
    expect(fork!.params).not.toHaveProperty("lastTurnId");
    expect(fork!.params).not.toHaveProperty("beforeTurnId");
    expect(server.ids(SOURCE)).toEqual([turn(1).id, turn(2).id, turn(3).id]);
    expect(server.sent("thread/start")).toEqual([]);
  });

  it("forks through the anchored turn, inclusive", async () => {
    const server = appServer();
    const result = await server.adapter.forkHistory(SOURCE, { anchor: server.anchorAt(2) });

    expect(result).toEqual({ outcome: "applied", sessionId: "fork-1", head: turn(2).id, boundary: "after-turn" });
    expect(server.sent("thread/fork")[0]!.params.lastTurnId).toBe(turn(2).id);
    expect(server.ids("fork-1")).toEqual([turn(1).id, turn(2).id]);
  });

  it("uses the new thread for the next message without resuming it again", async () => {
    const server = appServer();
    const result = await server.adapter.forkHistory(SOURCE);
    expect(result.outcome).toBe("applied");
    expect(await server.adapter.getHistoryState("fork-1")).toMatchObject({ head: turn(3).id });
    expect(server.sent("thread/resume").map(request => request.params.threadId)).toEqual([SOURCE]);
  });

  it("refuses before asking Codex to fork", async () => {
    const server = appServer();
    const aborted = new AbortController(); aborted.abort();
    const refused = async (sessionId: string, input: Parameters<CodexAppServerAdapter["forkHistory"]>[1]) => {
      const result = await server.adapter.forkHistory(sessionId, input);
      return result.outcome === "rejected" ? result.reason : result.outcome;
    };

    expect(await refused(SOURCE, { signal: aborted.signal })).toBe("cancelled");
    expect(await refused(UNBOUND, {})).toBe("not_ready");
    expect(await refused(GONE, {})).toBe("source_missing");
    expect(await refused(SOURCE, { anchor: server.anchorAt(2, { sessionId: "another-thread" }) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { anchor: server.anchorAt(2, { fork: false }) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { anchor: server.anchorAt(2, { forkBoundary: "before-input" }) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { anchor: server.anchorAt(9) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { expectedHead: turn(2).id })).toBe("source_changed");

    server.goals.set(SOURCE, { threadId: SOURCE, objective: "Finish", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 });
    expect(await refused(SOURCE, {})).toBe("goal_active");
    server.goals.delete(SOURCE);

    const { finish } = await server.runningTurn();
    expect(await refused(SOURCE, {})).toBe("busy");
    expect(await refused(SOURCE, { anchor: server.anchorAt(1) })).toBe("busy");
    await finish();

    expect(writes(server)).toEqual([]);
  });

  it("has nothing to fork on a thread without turns", async () => {
    const server = appServer({ turns: 0 });
    expect(await server.adapter.forkHistory(SOURCE)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(server.sent("thread/fork")).toEqual([]);
  });

  it("reports Codex's own refusal as a refusal", async () => {
    const server = appServer({ override: request => request.method === "thread/fork" ? { error: "lastTurnId 'turn-0002' identifies an in-progress turn" } : undefined });
    expect(await server.adapter.forkHistory(SOURCE, { anchor: server.anchorAt(2) })).toEqual({
      outcome: "rejected", reason: "busy", detail: "lastTurnId 'turn-0002' identifies an in-progress turn",
    });
  });

  it("does not know the outcome when Codex goes away after the request, and does not ask again", async () => {
    const server = appServer({ override: request => request.method === "thread/fork" ? "silent" : undefined });
    const forking = server.adapter.forkHistory(SOURCE);
    await vi.waitFor(() => expect(server.sent("thread/fork").length).toBe(1), { timeout: 2000, interval: 5 });
    server.child.emit("close", 1);

    expect((await forking).outcome).toBe("unknown");
    expect(server.sent("thread/fork").length).toBe(1);
  });

  it.each([
    ["an ephemeral thread", { thread: { id: "fork-x", ephemeral: true } }, "fork-x"],
    ["a thread without the persistence flag", { thread: { id: "fork-x" } }, "fork-x"],
    ["the source's own id", { thread: { id: SOURCE, ephemeral: false } }, undefined],
    ["no thread", {}, undefined],
  ])("never presents %s as the new session", async (_label, reply, candidate) => {
    const server = appServer({ override: request => request.method === "thread/fork" ? { result: reply } : undefined });
    const result = await server.adapter.forkHistory(SOURCE);
    expect(result.outcome).toBe("unknown");
    expect((result as { candidateSessionId?: string }).candidateSessionId).toBe(candidate);
  });

  it("does not accept a fork that ends somewhere else than asked", async () => {
    const server = appServer({ override: request => request.method === "thread/fork" ? { result: { thread: { id: SOURCE.replace("aaaa", "bbbb"), ephemeral: false } } } : undefined });
    server.threads.set(SOURCE.replace("aaaa", "bbbb"), [turn(1), turn(2), turn(3)]);
    expect(await server.adapter.forkHistory(SOURCE, { anchor: server.anchorAt(2) })).toMatchObject({ outcome: "unknown", candidateSessionId: SOURCE.replace("aaaa", "bbbb") });
  });
});

describe("rewinding a Codex thread", () => {
  it("removes the anchored turn and everything after it, and names what it removed", async () => {
    const server = appServer({ turns: 5 });
    const result = await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(3), expectedHead: turn(5).id });

    expect(result).toEqual({
      outcome: "applied", sessionId: SOURCE, head: turn(2).id, boundary: "before-input",
      excludedInputIds: [turn(3).id, turn(4).id, turn(5).id],
    });
    expect(server.sent("thread/revert").map(request => request.params)).toEqual([{ threadId: SOURCE, beforeTurnId: turn(3).id }]);
    expect(server.ids(SOURCE)).toEqual([turn(1).id, turn(2).id]);
  });

  it("can remove the first turn, leaving an existing thread with no history", async () => {
    const server = appServer();
    const result = await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(1) });
    expect(result).toMatchObject({ outcome: "applied", head: "empty", excludedInputIds: [turn(1).id, turn(2).id, turn(3).id] });
    expect(await server.adapter.getHistoryState(SOURCE)).toEqual({ fork: { whole: false, anchored: true }, rewind: true, head: "empty" });
  });

  it("never reaches Codex while a turn runs: Codex would interrupt that turn instead of refusing", async () => {
    const server = appServer();
    const { finish } = await server.runningTurn();

    expect(await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) })).toEqual({ outcome: "rejected", reason: "busy" });
    expect(server.sent("thread/revert")).toEqual([]);
    expect((await finish()).text).toBe("done");
  });

  it("is busy from the moment an input is handed to Codex, before Codex has named its turn", async () => {
    const server = appServer({ override: request => request.method === "turn/start" ? "silent" : undefined });
    const reply = server.adapter.sendUserMessage(SOURCE, { text: "not acknowledged yet", files: [] });
    void reply.catch(() => {});
    await vi.waitFor(() => expect(server.sent("turn/start").length).toBe(1), { timeout: 2000, interval: 5 });
    // Codex's own list shows nothing running yet.
    expect(server.ids(SOURCE)).toEqual([turn(1).id, turn(2).id, turn(3).id]);

    expect(await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) })).toEqual({ outcome: "rejected", reason: "busy" });
    expect(await server.adapter.forkHistory(SOURCE)).toEqual({ outcome: "rejected", reason: "busy" });
    expect((await server.adapter.getHistoryState(SOURCE)).blocked).toBe("busy");
    expect(writes(server)).toEqual([]);
  });

  it("is busy when another client's turn is running on the thread", async () => {
    const server = appServer();
    server.threads.get(SOURCE)!.push({ id: "turn-elsewhere", status: "inProgress" });

    expect(await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) })).toEqual({ outcome: "rejected", reason: "busy" });
    expect(await server.adapter.forkHistory(SOURCE, { anchor: server.anchorAt(2) })).toEqual({ outcome: "rejected", reason: "busy" });
    expect((await server.adapter.getHistoryState(SOURCE)).blocked).toBe("busy");
    expect(writes(server)).toEqual([]);
  });

  it("refuses before asking Codex to revert", async () => {
    const server = appServer();
    const refused = async (sessionId: string, input: Parameters<CodexAppServerAdapter["rewindHistory"]>[1]) => {
      const result = await server.adapter.rewindHistory(sessionId, input);
      return result.outcome === "rejected" ? result.reason : result.outcome;
    };
    const aborted = new AbortController(); aborted.abort();

    expect(await refused(SOURCE, { anchor: server.anchorAt(2), signal: aborted.signal })).toBe("cancelled");
    expect(await refused(UNBOUND, { anchor: server.anchorAt(2) })).toBe("not_ready");
    expect(await refused(GONE, { anchor: server.anchorAt(2, { sessionId: GONE }) })).toBe("source_missing");
    expect(await refused(SOURCE, { anchor: server.anchorAt(2, { rewind: false }) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { anchor: server.anchorAt(2, { sessionId: "another-thread" }) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { anchor: server.anchorAt(9) })).toBe("anchor_unavailable");
    expect(await refused(SOURCE, { anchor: server.anchorAt(2), expectedHead: turn(2).id })).toBe("source_changed");
    server.goals.set(SOURCE, { threadId: SOURCE, objective: "Finish", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 });
    expect(await refused(SOURCE, { anchor: server.anchorAt(2) })).toBe("goal_active");

    expect(writes(server)).toEqual([]);
    expect(server.ids(SOURCE)).toEqual([turn(1).id, turn(2).id, turn(3).id]);
  });

  it("reports a refusal only after reading that the history is unchanged", async () => {
    const server = appServer({ override: request => request.method === "thread/revert" ? { error: "thread is not paginated" } : undefined });
    expect(await server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) })).toEqual({ outcome: "rejected", reason: "not_ready", detail: "thread is not paginated" });
    expect(server.sent("thread/turns/list").length).toBe(2);
  });

  it("reports what the history is when Codex's answer and the history disagree", async () => {
    // Refused in words, yet the turns are gone.
    const refusedButDone = appServer({ override: request => {
      if (request.method !== "thread/revert") return undefined;
      refusedButDone.threads.get(SOURCE)!.splice(1);
      return { error: "internal error while reloading the thread" };
    } });
    expect(await refusedButDone.adapter.rewindHistory(SOURCE, { anchor: refusedButDone.anchorAt(2) })).toMatchObject({
      outcome: "applied", head: turn(1).id, excludedInputIds: [turn(2).id, turn(3).id],
    });

    // Acknowledged, yet the turn is still there.
    const acknowledgedButNot = appServer({ override: request => request.method === "thread/revert" ? { result: { thread: { id: SOURCE } } } : undefined });
    expect((await acknowledgedButNot.adapter.rewindHistory(SOURCE, { anchor: acknowledgedButNot.anchorAt(2) })).outcome).toBe("unknown");
  });

  it("does not know the outcome when Codex goes away after the request, and does not ask again", async () => {
    const server = appServer({ override: request => request.method === "thread/revert" ? "silent" : undefined });
    const rewinding = server.adapter.rewindHistory(SOURCE, { anchor: server.anchorAt(2) });
    await vi.waitFor(() => expect(server.sent("thread/revert").length).toBe(1), { timeout: 2000, interval: 5 });
    server.child.emit("close", 1);

    expect((await rewinding).outcome).toBe("unknown");
    expect(server.sent("thread/revert").length).toBe(1);
  });
});
