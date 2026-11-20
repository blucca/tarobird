import { afterEach, describe, expect, it } from "vitest";

import type { EngineStreamEvent, NativeHistoryAnchor } from "../src/codex/adapter.js";
import { DeepSeekHarnessAdapter, type DeepSeekHarnessGateway } from "../src/codex/deepseek-harness-adapter.js";
import { DeepSeekHarnessRpcError } from "../src/codex/deepseek-harness-protocol.js";

/**
 * Native history on DeepSeek Harness: the remote `session/fork`.
 *
 * The gateway here is scripted. Its rules and refusal sentences are those a
 * real dsh 0.2.2-rc.5 gave in an isolated run: a fork copies an event prefix
 * into an independent session and appends one closing entry; the event log
 * only grows; a list row says whether the session's Agent is running and which
 * directory it lives in; a history snapshot carries the goal (null when there
 * is none), the queued input and the open questions.
 */

const SOURCE = "session-11111111-1111-4111-8111-111111111111";
const MISSING = "session-00000000-0000-4000-8000-00000000dead";
const WORKSPACE = "/srv/dsh-history-fixture";
const IDLE = { goal: null, inbox: { "next-turn": [], "next-step": [] }, userQuestions: { active: [], settled: [] }, agentTeam: { enabled: false, tasks: [] }, subagent: null };
const ACTIVE_GOAL = { goal: { id: "goal-1", revision: 1, objective: "Finish", phase: "active", maxGoalRounds: 10 }, roundsStarted: 1, createdAt: 1, updatedAt: 2 };

const adapters: DeepSeekHarnessAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.destroy().catch(() => {}); });

type Call = { method: string; payload: Record<string, unknown> };
function harness(options: { head?: number; running?: boolean; blank?: boolean; cwd?: string; forkCwd?: string; values?: Record<string, unknown> | null; override?: (call: Call, calls: Call[]) => unknown } = {}) {
  const heads = new Map<string, number>([[SOURCE, options.head ?? 38]]);
  const calls: Call[] = [];
  let forks = 0;
  const gateway: DeepSeekHarnessGateway = {
    connect: async () => {},
    respond: async () => ({ accepted: true }),
    respondError: async () => ({ accepted: true }),
    close: async () => {},
    request: async (method, payload) => {
      const call = { method, payload: (payload ?? {}) as Record<string, unknown> };
      calls.push(call);
      const overridden = options.override?.(call, calls);
      if (overridden !== undefined) { if (overridden instanceof Error) throw overridden; return overridden; }
      const id = String(call.payload.sessionId ?? "");
      switch (method) {
        case "session.list": return { items: [...heads.keys()].map(sessionId => ({
          sessionId, updatedAt: 1, running: sessionId === SOURCE && options.running === true, blank: sessionId === SOURCE && options.blank === true,
          // A fork lives where its source lives, unless a test says otherwise.
          cwd: sessionId === SOURCE ? options.cwd ?? WORKSPACE : options.forkCwd ?? options.cwd ?? WORKSPACE,
        })) };
        case "session.history": {
          const head = heads.get(id);
          if (head === undefined) throw new DeepSeekHarnessRpcError({ code: "not_found", message: `session "${id}" not found` });
          const values = id === SOURCE && options.values !== undefined ? options.values : IDLE;
          return { events: [{ event: { seq: head, type: "turn/end", data: {} } }], hasMore: head > 0, projections: { asOfSeq: head, ...(values ? { values } : {}) } };
        }
        case "session.fork": {
          const head = heads.get(id);
          if (head === undefined) throw new DeepSeekHarnessRpcError({ code: "not_found", message: `session "${id}" not found` });
          const cut = typeof call.payload.atSeq === "number" ? call.payload.atSeq : head;
          if (cut > head) throw new DeepSeekHarnessRpcError({ code: "bad_request", message: `event ${cut} does not exist in session "${id}" (last seq: ${head})` });
          const forked = `session-22222222-2222-4222-8222-00000000000${++forks}`;
          heads.set(forked, cut + 1);
          return { sessionId: forked };
        }
        default: return {};
      }
    },
  };
  const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: WORKSPACE });
  adapters.push(adapter);
  const sent = (method: string) => calls.filter(call => call.method === method).map(call => call.payload);
  const through = (turnEndSeq: number, extra: Partial<NativeHistoryAnchor> = {}): NativeHistoryAnchor => ({ sessionId: SOURCE, inputId: "request-1", rewind: false, fork: true, forkBoundary: "after-turn", data: { inputSeq: turnEndSeq - 3, turnEndSeq }, ...extra });
  const inner = adapter as unknown as { pendingTurns: Map<string, unknown>; goalWatchers: Map<string, unknown>; jobsBySession: Map<string, Map<string, unknown>> };
  return { adapter, calls, sent, through, heads, inner };
}
const reason = (result: { outcome: string; reason?: string }) => result.outcome === "rejected" ? result.reason : result.outcome;

describe("what a DeepSeek Harness session's history can do now", () => {
  it("can be forked, whole or through a turn; its head is the last event; there is no rewind", async () => {
    const h = harness();
    expect(await h.adapter.getHistoryState(SOURCE)).toEqual({ fork: { whole: true, anchored: true }, head: "38" });
    expect(h.adapter).not.toHaveProperty("rewindHistory");
    expect(h.sent("session.fork")).toEqual([]);
  });

  it("says why nothing can be done, and never asks Harness about a session it does not list", async () => {
    const h = harness();
    expect(await h.adapter.getHistoryState(MISSING)).toEqual({ head: null, blocked: "source_missing" });
    expect(h.sent("session.history")).toEqual([]);
    expect(h.sent("session.create")).toEqual([]);

    h.inner.pendingTurns.set(SOURCE, {});
    expect((await h.adapter.getHistoryState(SOURCE)).blocked).toBe("busy");
    h.inner.pendingTurns.delete(SOURCE);
    h.inner.goalWatchers.set(SOURCE, {});
    expect((await h.adapter.getHistoryState(SOURCE)).blocked).toBe("goal_active");
    h.inner.goalWatchers.delete(SOURCE);

    const unreadable = harness({ override: call => call.method === "session.history" ? new Error("transport failure") : undefined });
    expect(await unreadable.adapter.getHistoryState(SOURCE)).toEqual({ head: null, blocked: "not_ready" });

    // A run this adapter did not start: only Harness's own list shows it.
    const elsewhere = harness({ running: true });
    expect(await elsewhere.adapter.getHistoryState(SOURCE)).toMatchObject({ head: "38", blocked: "busy" });
    expect(reason(await elsewhere.adapter.forkHistory(SOURCE))).toBe("busy");
    expect(elsewhere.sent("session.fork")).toEqual([]);
  });

  it.each([
    ["a goal Harness is pursuing", { ...IDLE, goal: ACTIVE_GOAL }, "goal_active"],
    ["input queued for the next turn", { ...IDLE, inbox: { "next-turn": [{ id: "queued" }], "next-step": [] } }, "busy"],
    ["input queued for the next step", { ...IDLE, inbox: { "next-turn": [], "next-step": [{ id: "queued" }] } }, "busy"],
    ["a question waiting for an answer", { ...IDLE, userQuestions: { active: [{ id: "q" }], settled: [] } }, "busy"],
    ["a team task in progress", { ...IDLE, agentTeam: { enabled: true, tasks: [{ id: "t1", status: "completed" }, { id: "t2", status: "in_progress" }] } }, "background_work"],
    ["a team task in a state it does not know", { ...IDLE, agentTeam: { enabled: true, tasks: [{ id: "t", status: "reviewing" }] } }, "background_work"],
  ])("is blocked by what Harness itself reports: %s", async (_label, values, expected) => {
    const h = harness({ values });
    expect((await h.adapter.getHistoryState(SOURCE)).blocked).toBe(expected);
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe(expected);
    expect(h.sent("session.fork")).toEqual([]);
  });

  it("is not blocked for good by what a session once did", async () => {
    // Team tasks are kept after they end; `subagent` names what kind of session this is, not something running in it.
    const h = harness({ values: { ...IDLE, subagent: { mode: "continuable", label: "helper", seq: 3 },
      agentTeam: { enabled: true, tasks: [{ id: "t1", status: "completed" }, { id: "t2", status: "deleted" }, { id: "t3", status: "pending" }] } } });
    expect((await h.adapter.getHistoryState(SOURCE)).blocked).toBeUndefined();
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("applied");
  });

  it.each(["session.list", "session.history"])("stops when its caller gives up during %s, and sends no fork", async during => {
    const caller = new AbortController();
    // The list answers normally after the caller has already given up; the history read fails with the cancellation.
    const h = harness({ override: call => { if (call.method !== during) return undefined; caller.abort(); return during === "session.history" ? new Error("aborted") : undefined; } });
    expect(await h.adapter.forkHistory(SOURCE, { signal: caller.signal })).toMatchObject({ outcome: "rejected", reason: "cancelled" });
    expect(h.sent("session.fork")).toEqual([]);
    if (during === "session.list") expect(h.sent("session.history")).toEqual([]);
  });

  it("hands its caller's signal to every read it makes of Harness", async () => {
    const signals: Array<[string, AbortSignal | undefined]> = [];
    const h = harness();
    const original = (h.adapter as unknown as { gateway: { request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> } }).gateway;
    const request = original.request.bind(original);
    original.request = (method, payload, signal) => { signals.push([method, signal]); return request(method, payload, signal); };
    const caller = new AbortController();
    await h.adapter.getHistoryState(SOURCE, { signal: caller.signal });
    expect(signals.filter(([method]) => method === "session.list" || method === "session.history").map(([, signal]) => signal === caller.signal)).toEqual([true, true]);
  });

  it("is blocked by a job of the session that is still running", async () => {
    const h = harness();
    h.inner.jobsBySession.set(SOURCE, new Map([["job-1", { id: "job-1", kind: "bash", label: "build", status: "running", startedAt: 1 }]]));
    expect((await h.adapter.getHistoryState(SOURCE)).blocked).toBe("background_work");
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("background_work");
    h.inner.jobsBySession.set(SOURCE, new Map([["job-1", { id: "job-1", kind: "bash", label: "build", status: "completed", startedAt: 1, finishedAt: 2 }]]));
    expect((await h.adapter.getHistoryState(SOURCE)).blocked).toBeUndefined();
  });

  it.each([
    ["no snapshot at all", null],
    ["a snapshot without the goal", { inbox: IDLE.inbox }],
    ["a snapshot without the queue", { goal: null }],
    ["a goal it cannot read", { ...IDLE, goal: { goal: { id: "goal-1" }, somethingNew: true } }],
  ])("does not take %s for a session with nothing going on", async (_label, values) => {
    const h = harness({ values });
    expect(await h.adapter.getHistoryState(SOURCE)).toEqual({ head: null, blocked: "not_ready" });
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("not_ready");
    expect(h.sent("session.fork")).toEqual([]);
  });

  it("offers nothing for a session that lives in another directory", async () => {
    const h = harness({ cwd: "/srv/some-other-workspace" });
    expect(await h.adapter.getHistoryState(SOURCE)).toEqual({ head: null, blocked: "not_ready" });
    expect(await h.adapter.forkHistory(SOURCE)).toEqual({ outcome: "rejected", reason: "source_changed", detail: "The session belongs to another workspace" });
    // The caller's own directory for this conversation is what counts.
    expect(reason(await h.adapter.forkHistory(SOURCE, { workspaceOverride: "/srv/some-other-workspace" }))).toBe("applied");
  });

  it("has nothing to fork whole in a session without a turn", async () => {
    const h = harness({ blank: true, head: 2 });
    expect(await h.adapter.getHistoryState(SOURCE)).toEqual({ fork: { whole: false, anchored: true }, head: "2" });
    expect(await h.adapter.forkHistory(SOURCE)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(h.sent("session.fork")).toEqual([]);
  });
});

describe("forking a DeepSeek Harness session", () => {
  it("forks the whole session up to exactly the head it read, not whatever is there when Harness gets to it", async () => {
    const h = harness();
    const result = await h.adapter.forkHistory(SOURCE, { expectedHead: "38" });

    expect(result).toEqual({ outcome: "applied", sessionId: "session-22222222-2222-4222-8222-000000000001", head: "39", boundary: "whole" });
    expect(h.sent("session.fork")).toEqual([{ sessionId: SOURCE, atSeq: 38 }]);
    expect(h.heads.get(SOURCE)).toBe(38);
  });

  it("forks through the anchored turn's own end", async () => {
    const h = harness();
    expect(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30) })).toEqual({ outcome: "applied", sessionId: "session-22222222-2222-4222-8222-000000000001", head: "31", boundary: "after-turn" });
    expect(h.sent("session.fork")).toEqual([{ sessionId: SOURCE, atSeq: 30 }]);
  });

  it("refuses before Harness is asked to fork", async () => {
    const h = harness();
    const aborted = new AbortController(); aborted.abort();

    expect(reason(await h.adapter.forkHistory(SOURCE, { signal: aborted.signal }))).toBe("cancelled");
    expect(reason(await h.adapter.forkHistory(MISSING))).toBe("source_missing");
    expect(reason(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30, { sessionId: "session-elsewhere" }) }))).toBe("anchor_unavailable");
    expect(reason(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30, { fork: false }) }))).toBe("anchor_unavailable");
    expect(reason(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30, { forkBoundary: "before-input" }) }))).toBe("anchor_unavailable");
    expect(reason(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30, { data: { inputSeq: 27 } }) }))).toBe("anchor_unavailable");
    expect(reason(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30, { data: { turnEndSeq: 30.5 } }) }))).toBe("anchor_unavailable");
    // Beyond the head: the log only grows, so that event never existed in this session.
    expect(reason(await h.adapter.forkHistory(SOURCE, { anchor: h.through(99) }))).toBe("anchor_unavailable");
    expect(reason(await h.adapter.forkHistory(SOURCE, { expectedHead: "30" }))).toBe("source_changed");
    h.inner.goalWatchers.set(SOURCE, {});
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("goal_active");
    h.inner.goalWatchers.delete(SOURCE);
    h.inner.pendingTurns.set(SOURCE, {});
    // Known to be busy: Harness is not even asked what the session looks like.
    const asked = h.calls.length;
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("busy");
    expect(h.calls.length).toBe(asked);
    h.inner.pendingTurns.delete(SOURCE);
    expect(h.sent("session.fork")).toEqual([]);

    // A turn that started while the head was being read.
    const racing = harness({ override: (call) => { if (call.method === "session.history") racing.inner.pendingTurns.set(SOURCE, {}); return undefined; } });
    expect(reason(await racing.adapter.forkHistory(SOURCE))).toBe("busy");
    expect(racing.sent("session.fork")).toEqual([]);
  });

  it.each([
    [`session "${SOURCE}" not found`, "source_missing"],
    [`event 30 does not exist in session "${SOURCE}" (last seq: 22)`, "anchor_unavailable"],
    [`session "${SOURCE}" has no completed turn to fork from`, "not_ready"],
  ])("takes Harness's own refusal as a refusal: %s", async (message, expected) => {
    const h = harness({ override: call => call.method === "session.fork" ? new DeepSeekHarnessRpcError({ code: "refused", message }) : undefined });
    expect(await h.adapter.forkHistory(SOURCE, { anchor: h.through(30) })).toEqual({ outcome: "rejected", reason: expected, detail: message });
    expect(h.sent("session.fork").length).toBe(1);
  });

  it.each([
    ["the request is lost in transport", (call: Call) => call.method === "session.fork" ? new Error("DeepSeek Harness transport failure for /rpc: HTTP 502") : undefined, undefined],
    ["Harness returns the source's own id", (call: Call) => call.method === "session.fork" ? { sessionId: SOURCE } : undefined, undefined],
    ["Harness returns no id", (call: Call) => call.method === "session.fork" ? {} : undefined, undefined],
    ["the new session is not listed", (call: Call, calls: Call[]) => call.method === "session.list" && calls.some(earlier => earlier.method === "session.fork") ? { items: [{ sessionId: SOURCE, updatedAt: 1, cwd: WORKSPACE }] } : undefined, "session-22222222-2222-4222-8222-000000000001"],
    ["the new session cannot be read back", (call: Call) => call.method === "session.history" && call.payload.sessionId !== SOURCE ? new Error("transport failure") : undefined, "session-22222222-2222-4222-8222-000000000001"],
    ["the new session ends somewhere else", (call: Call) => call.method === "session.history" && call.payload.sessionId !== SOURCE ? { events: [{ event: { seq: 12 } }], projections: { asOfSeq: 12, values: IDLE } } : undefined, "session-22222222-2222-4222-8222-000000000001"],
  ])("does not know the outcome when %s, and does not ask again", async (_label, override, candidate) => {
    const h = harness({ override });
    const result = await h.adapter.forkHistory(SOURCE, { anchor: h.through(30) });

    expect(result.outcome).toBe("unknown");
    expect((result as { candidateSessionId?: string }).candidateSessionId).toBe(candidate);
    expect(h.sent("session.fork").length).toBe(1);
  });

  it("does not call a fork done when it landed in another directory", async () => {
    const h = harness({ forkCwd: "/srv/some-other-workspace" });
    expect(await h.adapter.forkHistory(SOURCE)).toMatchObject({ outcome: "unknown", candidateSessionId: "session-22222222-2222-4222-8222-000000000001" });
  });

  it("does not send a fork when the adapter was destroyed while the session was being read", async () => {
    const h = harness({ override: call => { if (call.method === "session.history") void h.adapter.destroy(); return undefined; } });
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("not_ready");
    expect(h.sent("session.fork")).toEqual([]);
  });

  it("starts nothing once the adapter has been destroyed", async () => {
    const h = harness();
    await h.adapter.destroy();
    expect(await h.adapter.getHistoryState(SOURCE)).toEqual({ head: null, blocked: "not_ready" });
    expect(reason(await h.adapter.forkHistory(SOURCE))).toBe("not_ready");
    expect(h.sent("session.fork")).toEqual([]);
  });
});

describe("the place in history a DeepSeek Harness turn offers", () => {
  const offer = async (pending: Record<string, unknown>) => {
    const h = harness(), events: EngineStreamEvent[] = [];
    await (h.adapter as unknown as { offerHistoryAnchor(pending: unknown): Promise<void> }).offerHistoryAnchor({ sessionId: SOURCE, claimId: "request-1", abortController: new AbortController(), input: { onEngineEvent: (event: EngineStreamEvent) => { events.push(event); } }, ...pending });
    return events;
  };

  it("is named by the prompt's own request id and ends at that turn's turn/end event", async () => {
    expect(await offer({ historyInputSeq: 27, historyTurnEndSeq: 30 })).toEqual([{ type: "history_anchor", anchor: {
      sessionId: SOURCE, inputId: "request-1", rewind: false, fork: true, forkBoundary: "after-turn", data: { inputSeq: 27, turnEndSeq: 30 },
    } }]);
  });

  it("is not offered when Harness never showed the prompt's own entry or the turn's end", async () => {
    expect(await offer({ historyTurnEndSeq: 30 })).toEqual([]);
    expect(await offer({ historyInputSeq: 27 })).toEqual([]);
    expect(await offer({ historyInputSeq: 31, historyTurnEndSeq: 30 })).toEqual([]);
  });
});
