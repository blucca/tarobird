import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AppPlatformTools, EngineStreamEvent } from "../src/codex/adapter.js";
import { EngineHistoryUnconfirmedError } from "../src/codex/adapter.js";
import { CodexAppServerAdapter, readCodexHistoryTurn, resolveCodexHistoryAnchor, type CodexHistoryTurn } from "../src/codex/app-server-adapter.js";

// Scripted app-server peer; no Codex process, synthetic ids and text only.
class FakeStream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean { const text = chunk.toString().trim(); if (text) this.lines.push(text); callback?.(null); return true; }
}
class FakeChild extends EventEmitter {
  stdin = new FakeWritable(); stdout = new FakeStream(); stderr = new FakeStream();
  kill() { return true; }
}
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 0)); }
  throw new Error("Condition was not met in time");
}
/** For requests that come only after a real timer (a call timeout). */
async function respondSlow(respond: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { return await respond(); } catch (error) { if (attempt >= 100) throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
}
type Frame = { id?: number | string; method?: string; params?: Record<string, unknown> };
function harness() {
  const children: FakeChild[] = [];
  const adapter = new CodexAppServerAdapter("codex", "/tmp/history-fixture", (() => { const child = new FakeChild(); children.push(child); return child; }) as never);
  const frames = () => (children.at(-1)?.stdin.lines ?? []).map((line) => JSON.parse(line) as Frame);
  const requests = (method: string) => frames().filter((frame) => frame.method === method);
  const respond = async (method: string, result: unknown, nth = 1) => {
    await waitFor(() => requests(method).length >= nth);
    children.at(-1)!.stdout.emitData(JSON.stringify({ id: requests(method)[nth - 1]!.id, result }) + "\n");
  };
  const fail = async (method: string, message: string, code = -32600, nth = 1) => {
    await waitFor(() => requests(method).length >= nth);
    children.at(-1)!.stdout.emitData(JSON.stringify({ id: requests(method)[nth - 1]!.id, error: { code, message } }) + "\n");
  };
  const emit = (method: string, params: Record<string, unknown>) => children.at(-1)!.stdout.emitData(JSON.stringify({ method, params }) + "\n");
  return { adapter, children, frames, requests, respond, fail, emit };
}
const OURS = { historyMode: "paginated", originator: "tarocub" };
const turn = (id: string, startedAt: number, user?: { text: string; clientId?: string | null }) => ({
  id, rootTurnId: null, status: "completed", error: null, startedAt, completedAt: startedAt + 1, durationMs: 1000, itemsView: "summary",
  items: user ? [{ type: "userMessage", id: `${id}-u`, clientId: user.clientId ?? null, content: [{ type: "text", text: user.text, text_elements: [] }] }, { type: "agentMessage", id: `${id}-a`, text: "answer" }] : [{ type: "agentMessage", id: `${id}-a`, text: "goal work" }],
});
const page = (...turns: unknown[]) => ({ data: turns, nextCursor: null, backwardsCursor: null });

describe("Codex history: turn anchors (#53)", () => {
  it("sends the Hub message id only as the run's client message id and reports every foreground turn", async () => {
    const h = harness();
    try {
      const events: EngineStreamEvent[] = [];
      const first = h.adapter.sendUserMessage("tarobot-1", { text: "hello", files: [], sourceMessageId: "msg_a", onEngineEvent: (event) => { events.push(event); } });
      await h.respond("initialize", {});
      await h.respond("thread/start", { thread: { id: "thr-1", ...OURS } });
      await h.respond("turn/start", { turn: { id: "turn-1" } });
      h.emit("turn/completed", { threadId: "thr-1", turn: { id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "one" }] } });
      await expect(first).resolves.toMatchObject({ text: "one", sessionId: "thr-1" });
      expect(h.requests("turn/start")[0]!.params).toMatchObject({ threadId: "thr-1", clientUserMessageId: "msg_a" });

      // A later turn of the same run (recovery, repair) carries no client id.
      const second = h.adapter.sendUserMessage("thr-1", { text: "continue", files: [], onEngineEvent: (event) => { events.push(event); } });
      await h.respond("turn/start", { turn: { id: "turn-2" } }, 2);
      h.emit("turn/completed", { threadId: "thr-1", turn: { id: "turn-2", status: "completed", items: [{ type: "agentMessage", text: "two" }] } });
      await second;
      expect(h.requests("turn/start")[1]!.params).not.toHaveProperty("clientUserMessageId");
      await waitFor(() => events.filter(event => event.type === "turn_anchor").length === 2);
      expect(events.filter(event => event.type === "turn_anchor")).toEqual([
        { type: "turn_anchor", sessionId: "thr-1", turnId: "turn-1" },
        { type: "turn_anchor", sessionId: "thr-1", turnId: "turn-2" },
      ]);
    } finally { h.adapter.destroy(); }
  });

  it("gives an ephemeral side turn neither a client id nor an anchor", async () => {
    const h = harness();
    try {
      const opened = h.adapter.openSideSession({ sourceSessionId: "thr-1", tools: "inherited" });
      await h.respond("initialize", {});
      await h.respond("thread/fork", { thread: { id: "side-1", ephemeral: true } });
      await h.respond("thread/inject_items", {});
      const side = await opened;
      const events: EngineStreamEvent[] = [];
      const answer = side.send({ text: "q", onEngineEvent: (event) => { events.push(event); }, abortSignal: new AbortController().signal });
      await h.respond("turn/start", { turn: { id: "side-turn" } });
      h.emit("turn/completed", { threadId: "side-1", turn: { id: "side-turn", status: "completed", items: [{ type: "agentMessage", text: "a" }] } });
      await answer;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.requests("turn/start")[0]!.params).not.toHaveProperty("clientUserMessageId");
      expect(events.some(event => event.type === "turn_anchor")).toBe(false);
      await side.dispose();
    } finally { h.adapter.destroy(); }
  });
});

describe("Codex history: capability", () => {
  it("answers a conversation without a thread statically, without starting Codex", async () => {
    const h = harness();
    expect(await h.adapter.historyCapability("tarobot-7")).toEqual({ rewind: "turn", fork: "turn" });
    expect(h.children).toHaveLength(0);
  });
  it("rewinds only paginated threads this host created; forks any thread", async () => {
    const h = harness();
    try {
      const ours = h.adapter.historyCapability("thr-1");
      await h.respond("initialize", {});
      await h.respond("thread/read", { thread: { id: "thr-1", ...OURS } });
      expect(await ours).toEqual({ rewind: "turn", fork: "turn" });
      expect(h.requests("thread/read")[0]!.params).toEqual({ threadId: "thr-1", includeTurns: false });
      expect(await h.adapter.historyCapability("thr-1")).toEqual({ rewind: "turn", fork: "turn" }); // cached
      const legacy = h.adapter.historyCapability("thr-old");
      await h.respond("thread/read", { thread: { id: "thr-old", historyMode: "legacy", originator: null } }, 2);
      expect(await legacy).toEqual({ rewind: "none", fork: "turn", reason: "legacy_history" });
      const desktop = h.adapter.historyCapability("thr-desk");
      await h.respond("thread/read", { thread: { id: "thr-desk", historyMode: "paginated", originator: "Codex Desktop" } }, 3);
      expect(await desktop).toEqual({ rewind: "none", fork: "turn", reason: "external_session" });
      expect(h.requests("thread/read")).toHaveLength(3);
    } finally { h.adapter.destroy(); }
  });
});

describe("Codex history: rewind", () => {
  // Wrapped: an async function returning the promise itself would wait for it.
  async function loaded(h: ReturnType<typeof harness>, anchor: string, thread: Record<string, unknown> = OURS) {
    const rewind = h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: anchor } });
    rewind.catch(() => undefined);
    await h.respond("initialize", {});
    await h.respond("thread/resume", { thread: { id: "thr-1", ...thread } });
    return { rewind };
  }
  it("checks, reverts and verifies, in that order", async () => {
    const h = harness();
    try {
      const { rewind } = await loaded(h, "t2");
      await h.respond("thread/turns/list", page(turn("t3", 30), turn("t2", 20), turn("t1", 10)));
      await h.respond("thread/revert", { thread: { id: "thr-1", ...OURS, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      await h.respond("thread/turns/list", page(turn("t1", 10)), 2);
      await expect(rewind).resolves.toEqual({ sessionId: "thr-1", reverted: true });
      expect(h.frames().filter(frame => frame.method).map(frame => frame.method)).toEqual(["initialize", "thread/resume", "thread/turns/list", "thread/revert", "thread/turns/list"]);
      expect(h.requests("thread/turns/list")[0]!.params).toEqual({ threadId: "thr-1", sortDirection: "desc", limit: 50 });
      expect(h.requests("thread/revert")[0]!.params).toEqual({ threadId: "thr-1", beforeTurnId: "t2" });
    } finally { h.adapter.destroy(); }
  });
  it("is re-entrant: a target already gone succeeds without another revert, even after later turns", async () => {
    const h = harness();
    try {
      const { rewind } = await loaded(h, "t2");
      await h.respond("thread/turns/list", page(turn("t5", 50), turn("t4", 40), turn("t1", 10)));
      // Reported as not reverted now: where that earlier rewind ended is the caller's record.
      await expect(rewind).resolves.toEqual({ sessionId: "thr-1", reverted: false });
      expect(h.requests("thread/revert")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
  it("pages until it can prove absence", async () => {
    const h = harness();
    try {
      const { rewind } = await loaded(h, "t1");
      await h.respond("thread/turns/list", { data: [turn("t3", 30), turn("t2", 20)], nextCursor: "c1", backwardsCursor: null });
      await h.respond("thread/turns/list", page(turn("t1", 10)), 2);
      await h.respond("thread/revert", { thread: { id: "thr-1", ...OURS } });
      await h.respond("thread/turns/list", page(), 3);
      await expect(rewind).resolves.toEqual({ sessionId: "thr-1", reverted: true });
      expect(h.requests("thread/turns/list")[1]!.params).toMatchObject({ cursor: "c1" });
      expect(h.requests("thread/revert")[0]!.params).toEqual({ threadId: "thr-1", beforeTurnId: "t1" });
    } finally { h.adapter.destroy(); }
  });
  it("maps an unknown turn to turn_unresolved and accepts a revert whose reply was lost", async () => {
    const h = harness();
    try {
      const { rewind: unknown } = await loaded(h, "t2");
      await h.respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)));
      await h.fail("thread/revert", "turn not found");
      await h.respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)), 2);
      await expect(unknown).rejects.toThrow("turn_unresolved");

      const lost = h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t2" } });
      await h.respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)), 3);
      await h.fail("thread/revert", "connection reset", -32000, 2);
      await h.respond("thread/turns/list", page(turn("t1", 10)), 4);
      await expect(lost).resolves.toEqual({ sessionId: "thr-1", reverted: true });
    } finally { h.adapter.destroy(); }
  });
  it("runs the caller's record only once the turn is known present, and before the revert", async () => {
    const h = harness();
    try {
      const order: string[] = [];
      const rewind = h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t2" }, beforeRevert: async () => { order.push(`record:${h.requests("thread/revert").length}`); } });
      await h.respond("initialize", {});
      await h.respond("thread/resume", { thread: { id: "thr-1", ...OURS } });
      await h.respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)));
      await h.respond("thread/revert", { thread: { id: "thr-1", ...OURS } });
      await h.respond("thread/turns/list", page(turn("t1", 10)), 2);
      await expect(rewind).resolves.toEqual({ sessionId: "thr-1", reverted: true });
      expect(order).toEqual(["record:0"]);
      // Already gone: no record, no revert.
      const gone = h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t2" }, beforeRevert: async () => { order.push("again"); } });
      await h.respond("thread/turns/list", page(turn("t1", 10)), 3);
      await expect(gone).resolves.toEqual({ sessionId: "thr-1", reverted: false });
      // A record that cannot be written stops the revert.
      const refused = h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t1" }, beforeRevert: async () => { throw new Error("engine_failed"); } });
      await h.respond("thread/turns/list", page(turn("t1", 10)), 4);
      await expect(refused).rejects.toThrow("engine_failed");
      expect(order).toEqual(["record:0"]);
      expect(h.requests("thread/revert")).toHaveLength(1);
    } finally { h.adapter.destroy(); }
  });
  it("leaves a timed-out revert unconfirmed after looking again, and accepts one that landed late", async () => {
    const children: FakeChild[] = [];
    // A short engine call limit and immediate second looks; synthetic only.
    const adapter = new CodexAppServerAdapter("codex", "/tmp/history-fixture", (() => { const child = new FakeChild(); children.push(child); return child; }) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, 400, { historyRevertRecheckDelaysMs: [1, 1] });
    const frames = () => (children.at(-1)?.stdin.lines ?? []).map((line) => JSON.parse(line) as Frame);
    const requests = (method: string) => frames().filter((frame) => frame.method === method);
    const respond = async (method: string, result: unknown, nth = 1) => {
      await waitFor(() => requests(method).length >= nth);
      children.at(-1)!.stdout.emitData(JSON.stringify({ id: requests(method)[nth - 1]!.id, result }) + "\n");
    };
    try {
      const stuck = adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t2" } });
      stuck.catch(() => undefined);
      await respond("initialize", {});
      await respond("thread/resume", { thread: { id: "thr-1", ...OURS } });
      await respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)));
      await waitFor(() => requests("thread/revert").length === 1);
      // No answer to thread/revert; every later look still lists the turn.
      for (let nth = 2; nth <= 4; nth++) await respondSlow(() => respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)), nth));
      await expect(stuck).rejects.toBeInstanceOf(EngineHistoryUnconfirmedError);
      expect(requests("thread/turns/list")).toHaveLength(4);

      const late = adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t2" } });
      await respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)), 5);
      await waitFor(() => requests("thread/revert").length === 2);
      await respondSlow(() => respond("thread/turns/list", page(turn("t2", 20), turn("t1", 10)), 6));
      // The second look finds it gone: the revert landed after its timeout.
      await respondSlow(() => respond("thread/turns/list", page(turn("t1", 10)), 7));
      await expect(late).resolves.toEqual({ sessionId: "thr-1", reverted: true });
    } finally { adapter.destroy(); }
  });
  it("refuses a thread created by another client without listing or reverting", async () => {
    const h = harness();
    try {
      const { rewind } = await loaded(h, "t2", { historyMode: "paginated", originator: "Codex Desktop" });
      await expect(rewind).rejects.toThrow("unsupported");
      expect(h.requests("thread/turns/list")).toHaveLength(0);
      expect(h.requests("thread/revert")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
  it("treats a missing thread/revert as no rewind support for the process lifetime", async () => {
    const h = harness();
    try {
      const { rewind } = await loaded(h, "t2");
      await h.respond("thread/turns/list", page(turn("t2", 20)));
      await h.fail("thread/revert", "Method not found", -32601);
      await expect(rewind).rejects.toThrow("unsupported");
      const count = h.frames().length;
      expect(await h.adapter.historyCapability("thr-1")).toEqual({ rewind: "none", fork: "turn" });
      await expect(h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t2" } })).rejects.toThrow("unsupported");
      expect(h.frames()).toHaveLength(count);
    } finally { h.adapter.destroy(); }
  });
  it("refuses while a turn runs on the thread", async () => {
    const h = harness();
    try {
      const running = h.adapter.sendUserMessage("tarobot-1", { text: "work", files: [] });
      await h.respond("initialize", {});
      await h.respond("thread/start", { thread: { id: "thr-1", ...OURS } });
      await waitFor(() => h.requests("turn/start").length === 1);
      await expect(h.adapter.rewindSession("thr-1", { anchor: { firstTurnId: "t1" } })).rejects.toThrow("busy");
      await expect(h.adapter.forkSession("thr-1", {})).rejects.toThrow("busy");
      await h.respond("turn/start", { turn: { id: "t1" } });
      h.emit("turn/completed", { threadId: "thr-1", turn: { id: "t1", status: "completed", items: [{ type: "agentMessage", text: "done" }] } });
      await running;
    } finally { h.adapter.destroy(); }
  });
});

describe("Codex history: fork", () => {
  const goal = (status: string) => ({ goal: { threadId: "thr-fork", objective: "o", status, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
  it("forks through a turn persistently, carries the source's App tools and clears an inherited goal", async () => {
    const h = harness();
    try {
      const registered: string[] = [];
      const sourceTools = { register: vi.fn(async (id: string) => { registered.push(id); }) } as unknown as AppPlatformTools;
      const tools = { forSession: vi.fn(async (id: string) => id === "thr-1" ? sourceTools : undefined), isRegistered: vi.fn(), register: vi.fn() } as unknown as AppPlatformTools;
      const fork = h.adapter.forkSession("thr-1", { through: { lastTurnId: "t2" }, workspaceOverride: "/tmp/history-workspace", appPlatformTools: tools });
      await h.respond("initialize", {});
      await h.respond("thread/fork", { thread: { id: "thr-fork", ephemeral: false, ...OURS } });
      await h.respond("thread/goal/get", goal("paused"));
      await h.respond("thread/goal/clear", {});
      await expect(fork).resolves.toEqual({ sessionId: "thr-fork" });
      const params = h.requests("thread/fork")[0]!.params!;
      expect(params).toEqual({ threadId: "thr-1", lastTurnId: "t2", excludeTurns: true, cwd: "/tmp/history-workspace", approvalPolicy: "never" });
      expect(params).not.toHaveProperty("ephemeral");
      expect(params).not.toHaveProperty("beforeTurnId");
      expect(registered).toEqual(["thr-fork"]);
      expect(tools.register).not.toHaveBeenCalled();
      expect(h.requests("thread/goal/get")[0]!.params).toEqual({ threadId: "thr-fork" });
      expect(h.requests("thread/goal/clear")[0]!.params).toEqual({ threadId: "thr-fork", origin: "user" });
      // The fork is loaded: its first turn does not resume it again.
      const next = h.adapter.sendUserMessage("thr-fork", { text: "hi", files: [] });
      await h.respond("turn/start", { turn: { id: "f1" } });
      h.emit("turn/completed", { threadId: "thr-fork", turn: { id: "f1", status: "completed", items: [{ type: "agentMessage", text: "ok" }] } });
      await next;
      expect(h.requests("thread/resume")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
  it("forks the whole thread without a boundary and clears nothing when no goal was inherited", async () => {
    const h = harness();
    try {
      const fork = h.adapter.forkSession("thr-1", {});
      await h.respond("initialize", {});
      await h.respond("thread/fork", { thread: { id: "thr-fork", ...OURS } });
      await h.respond("thread/goal/get", { goal: null });
      await expect(fork).resolves.toEqual({ sessionId: "thr-fork" });
      expect(h.requests("thread/fork")[0]!.params).not.toHaveProperty("lastTurnId");
      expect(h.requests("thread/goal/clear")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
  it("never binds the source or an ephemeral copy", async () => {
    const h = harness();
    try {
      const same = h.adapter.forkSession("thr-1", {});
      await h.respond("initialize", {});
      await h.respond("thread/fork", { thread: { id: "thr-1" } });
      await expect(same).rejects.toThrow("engine_failed");
      const ephemeral = h.adapter.forkSession("thr-1", {});
      await h.respond("thread/fork", { thread: { id: "thr-x", ephemeral: true } }, 2);
      await expect(ephemeral).rejects.toThrow("engine_failed");
      expect(h.requests("thread/goal/get")).toHaveLength(0);
    } finally { h.adapter.destroy(); }
  });
  it("maps engine refusals", async () => {
    const h = harness();
    try {
      const unknown = h.adapter.forkSession("thr-1", { through: { lastTurnId: "nope" } });
      await h.respond("initialize", {});
      await h.fail("thread/fork", "turn not found");
      await expect(unknown).rejects.toThrow("turn_unresolved");
      const gone = h.adapter.forkSession("thr-gone", {});
      await h.fail("thread/fork", "thread not found: thr-gone", -32600, 2);
      await expect(gone).rejects.toThrow("no_main_session");
      await expect(h.adapter.forkSession("tarobot-1", {})).rejects.toThrow("no_main_session");
    } finally { h.adapter.destroy(); }
  });
});

describe("Codex history: older runs", () => {
  const T = 1_763_570_000; // seconds
  it("reads summary turns from thread/turns/list", () => {
    expect(readCodexHistoryTurn(turn("t1", T, { text: "hello", clientId: "msg_a" }))).toEqual({ id: "t1", startedAt: T, userMessage: true, clientId: "msg_a", text: "hello" });
    expect(readCodexHistoryTurn(turn("g1", T))).toEqual({ id: "g1", startedAt: T, userMessage: false, clientId: null, text: "" });
    expect(readCodexHistoryTurn({ items: [] })).toBeUndefined();
  });
  const turns: CodexHistoryTurn[] = [
    { id: "t1", startedAt: T, userMessage: true, clientId: null, text: "[private guidance]\nfix the build please\n[file:a.txt]" },
    { id: "t2", startedAt: T + 5, userMessage: true, clientId: null, text: "Continue from where you stopped." },
    { id: "g1", startedAt: T + 60, userMessage: false, clientId: null, text: "" },
    { id: "t3", startedAt: T + 120, userMessage: true, clientId: "msg_c", text: "and the tests" },
    { id: "t4", startedAt: T + 300, userMessage: true, clientId: null, text: "thanks" },
  ];
  it("matches by client id, then by a unique text-and-time hit; the fork boundary ends before the next run", () => {
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_c", text: "unrelated", startedAt: 0 })).toEqual({ firstTurnId: "t3", lastTurnId: "t4" });
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_a", text: "fix the  build please", startedAt: T * 1000 - 2_000,
      next: { sourceMessageId: "msg_c", text: "and the tests" } })).toEqual({ firstTurnId: "t1", lastTurnId: "g1" });
    // The latest run forks through the thread's last turn.
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_d", text: "thanks", startedAt: (T + 290) * 1000 })).toEqual({ firstTurnId: "t4", lastTurnId: "t4" });
    // A next run that cannot be matched leaves no fork boundary.
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_a", text: "fix the build", startedAt: T * 1000, next: { sourceMessageId: "msg_x", text: "missing", startedAt: (T + 100) * 1000 } })).toEqual({ firstTurnId: "t1" });
  });
  it("refuses ambiguous, absent and out-of-window matches", () => {
    const twice: CodexHistoryTurn[] = [...turns, { id: "t5", startedAt: T + 10, userMessage: true, clientId: null, text: "fix the build please" }];
    expect(resolveCodexHistoryAnchor(twice, { sourceMessageId: "msg_a", text: "fix the build please", startedAt: T * 1000 })).toBeUndefined();
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_a", text: "never sent", startedAt: T * 1000 })).toBeUndefined();
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_a", text: "fix the build please", startedAt: (T + 7200) * 1000 })).toBeUndefined();
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_a", text: "fix the build please" })).toBeUndefined();
    // Attachment-only input matches by time alone, and only when unique.
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_a", text: "", startedAt: T * 1000 })).toBeUndefined();
    expect(resolveCodexHistoryAnchor(turns, { sourceMessageId: "msg_d", text: "", startedAt: (T + 290) * 1000 })).toEqual({ firstTurnId: "t4", lastTurnId: "t4" });
  });
  it("lists the tail of the thread through the adapter", async () => {
    const h = harness();
    try {
      const resolved = h.adapter.resolveHistoryAnchor("thr-1", { sourceMessageId: "msg_a", text: "fix the build please", startedAt: T * 1000, next: { sourceMessageId: "msg_c", text: "and the tests" } });
      await h.respond("initialize", {});
      await h.respond("thread/turns/list", page(turn("t3", T + 120, { text: "and the tests", clientId: "msg_c" }), turn("t2", T + 5, { text: "Continue." }), turn("t1", T, { text: "fix the build please" })));
      await expect(resolved).resolves.toEqual({ firstTurnId: "t1", lastTurnId: "t2" });
      expect(await h.adapter.resolveHistoryAnchor("tarobot-1", { sourceMessageId: "msg_a", text: "x" })).toBeUndefined();
    } finally { h.adapter.destroy(); }
  });
});
