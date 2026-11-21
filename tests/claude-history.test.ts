import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { EngineStreamEvent, NativeHistoryAnchor } from "../src/codex/adapter.js";
import {
  claudeForkHistory, claudeHistoryState, parseClaudeHistoryReply, spawnClaudeHistoryHelper,
  type ClaudeHistoryHelper, type ClaudeHistoryHelperOutcome, type ClaudeHistoryMessage, type ClaudeHistoryRequest,
} from "../src/codex/claude-history.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";

/**
 * Claude's native history goes through a helper process built from
 * Anthropic's SDK. Here the helper is scripted after the real one's protocol
 * and codes (src/codex/claude-history-native-helper.ts): `inspect` lists the
 * chain with a head, `fork` validates again, forks, and returns the new id
 * without reading it back; a fork gives every message a new uuid.
 */

const SOURCE = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "/srv/claude-history-fixture";
const ENV = { CLAUDE_CONFIG_DIR: "/srv/claude-config-fixture" };
const u = (n: number): ClaudeHistoryMessage => ({ uuid: `00000000-0000-4000-8000-0000000000u${n}`, type: "user" });
const a = (n: number): ClaudeHistoryMessage => ({ uuid: `00000000-0000-4000-8000-0000000000a${n}`, type: "assistant" });
const SYSTEM: ClaudeHistoryMessage = { uuid: "00000000-0000-4000-8000-0000000000s1", type: "system" };

function scripted(options: { messages?: ClaudeHistoryMessage[]; override?: (request: ClaudeHistoryRequest, call: number) => ClaudeHistoryHelperOutcome | undefined } = {}) {
  const sessions = new Map<string, ClaudeHistoryMessage[]>([[SOURCE, options.messages ?? [u(1), a(1), u(2), a(2), u(3), a(3)]]]);
  const calls: Array<{ request: ClaudeHistoryRequest; env: NodeJS.ProcessEnv }> = [];
  let forks = 0;
  const head = (id: string) => `head-${id.slice(0, 8)}-${sessions.get(id)!.length}`;
  const refuse = (phase: "validate" | "inspect" | "fork", code: string): ClaudeHistoryHelperOutcome => ({ kind: "reply", reply: { v: 1, ok: false, phase, error: { code, message: "Native session history operation could not be confirmed." } } });
  const helper: ClaudeHistoryHelper = async (request, context) => {
    calls.push({ request, env: context.env });
    const overridden = options.override?.(request, calls.length);
    if (overridden) return overridden;
    const messages = sessions.get(request.sessionId);
    // The real helper cannot tell a session that is not there from one it could not read.
    if (!messages) return refuse("inspect", "session_unreadable");
    if (request.operation === "inspect") return { kind: "reply", reply: { v: 1, ok: true, sessionId: request.sessionId, messages, head: head(request.sessionId) } };
    if (request.expectedHead !== undefined && request.expectedHead !== head(request.sessionId)) return refuse("validate", "source_changed");
    const end = request.upToMessageId ? messages.findIndex(message => message.uuid === request.upToMessageId) : messages.length - 1;
    if (end < 0) return refuse("validate", "anchor_missing");
    const forked = `22222222-2222-4222-8222-00000000000${++forks}`;
    // New uuids for every message; system entries are not part of what the copy must hold.
    sessions.set(forked, messages.slice(0, end + 1).filter(message => message.type !== "system").map((message, index) => ({ uuid: `${forked.slice(0, 24)}${String(index).padStart(12, "0")}`, type: message.type })));
    return { kind: "reply", reply: { v: 1, ok: true, sessionId: forked } };
  };
  const base = { helper, env: ENV, sessionId: SOURCE, workspace: WORKSPACE, blocked: () => undefined };
  const through = (turn: number, extra: Partial<NativeHistoryAnchor> = {}): NativeHistoryAnchor => ({ sessionId: SOURCE, inputId: u(turn).uuid, rewind: false, fork: true, forkBoundary: "after-turn", data: { lastMessageId: a(turn).uuid }, ...extra });
  const asked = (operation: string) => calls.filter(call => call.request.operation === operation).map(call => call.request);
  return { helper, base, calls, asked, sessions, head, refuse, through };
}

describe("what a Claude session's history can do now", () => {
  it("can be forked, whole or through a turn, and is never offered a rewind", async () => {
    const h = scripted();
    expect(await claudeHistoryState(h.base)).toEqual({ fork: { whole: true, anchored: true }, head: h.head(SOURCE) });
    // The helper got the Bot's Claude environment, and only an inspection.
    expect(h.calls.map(call => [call.request.operation, call.env])).toEqual([["inspect", ENV]]);
  });

  it("says why nothing can be done", async () => {
    const h = scripted();
    expect(await claudeHistoryState({ ...h.base, blocked: () => "background_work" })).toMatchObject({ head: h.head(SOURCE), blocked: "background_work" });
    // Unreadable is not the same as missing; only a helper that says "missing" is believed to mean it.
    expect(await claudeHistoryState({ ...h.base, sessionId: "33333333-3333-4333-8333-333333333333" })).toEqual({ head: null, blocked: "not_ready" });
    const missing = scripted({ override: () => ({ kind: "reply", reply: { v: 1, ok: false, phase: "inspect", error: { code: "session_missing", message: "x" } } }) });
    expect(await claudeHistoryState(missing.base)).toEqual({ head: null, blocked: "source_missing" });
    const lost = scripted({ override: () => ({ kind: "lost", detail: "no answer" }) });
    expect(await claudeHistoryState(lost.base)).toEqual({ head: null, blocked: "not_ready" });
    const none = scripted({ override: () => ({ kind: "not-started", detail: "no helper" }) });
    expect(await claudeHistoryState(none.base)).toEqual({ head: null, blocked: "not_ready" });
  });
  it("writes why the helper failed to the Bot log, and nothing when it answered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const h = scripted();
      await claudeHistoryState(h.base);
      expect(warn).not.toHaveBeenCalled();
      await claudeHistoryState({ ...h.base, sessionId: "33333333-3333-4333-8333-333333333333" });
      expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/Claude history helper inspect of session 33333333 refused at inspect: session_unreadable$/));
      await claudeHistoryState(scripted({ override: () => ({ kind: "lost", detail: "no answer" }) }).base);
      expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/inspect of session 11111111 gave no answer \(no answer\)$/));
      const lostFork = scripted({ override: request => request.operation === "fork" ? { kind: "lost", detail: "killed" } : undefined });
      expect(await claudeForkHistory(lostFork.base)).toMatchObject({ outcome: "unknown" });
      expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/fork of session 11111111 gave no answer \(killed\)$/));
      expect(warn).toHaveBeenCalledTimes(3);
    } finally { warn.mockRestore(); }
  });
});

describe("forking a Claude session", () => {
  it("forks the whole session and reads the new one back before calling it done", async () => {
    const h = scripted();
    const result = await claudeForkHistory({ ...h.base, expectedHead: h.head(SOURCE) });

    expect(result).toMatchObject({ outcome: "applied", boundary: "whole" });
    const forked = (result as { sessionId: string }).sessionId;
    expect(forked).not.toBe(SOURCE);
    expect((result as { head: string }).head).toBe(h.head(forked));
    expect(h.calls.map(call => [call.request.operation, call.request.sessionId])).toEqual([["inspect", SOURCE], ["fork", SOURCE], ["inspect", forked]]);
    // The fork is tied to the head that was inspected, and names no message.
    expect(h.asked("fork")[0]).toEqual({ v: 1, operation: "fork", sessionId: SOURCE, workspace: WORKSPACE, expectedHead: h.head(SOURCE) });
    expect(h.sessions.get(SOURCE)!.length).toBe(6);
  });

  it("forks through the anchored turn, ending with that turn's last answer", async () => {
    const h = scripted({ messages: [u(1), a(1), SYSTEM, u(2), a(2), u(3), a(3)] });
    const result = await claudeForkHistory({ ...h.base, anchor: h.through(2) });

    expect(result).toMatchObject({ outcome: "applied", boundary: "after-turn" });
    expect(h.asked("fork")[0]!.upToMessageId).toBe(a(2).uuid);
    // Two turns of conversation; the system entry between them is not counted on either side.
    expect(h.sessions.get((result as { sessionId: string }).sessionId)!.map(message => message.type)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("refuses before the helper is asked to fork", async () => {
    const h = scripted();
    const aborted = new AbortController(); aborted.abort();
    const refused = async (input: Partial<Parameters<typeof claudeForkHistory>[0]>) => {
      const result = await claudeForkHistory({ ...h.base, ...input });
      return result.outcome === "rejected" ? result.reason : result.outcome;
    };

    expect(await refused({ signal: aborted.signal })).toBe("cancelled");
    expect(await refused({ blocked: () => "busy" })).toBe("busy");
    expect(await refused({ blocked: () => "goal_active" })).toBe("goal_active");
    expect(await refused({ anchor: h.through(2, { sessionId: "another-session" }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: h.through(2, { fork: false }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: h.through(2, { forkBoundary: "before-input" }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: h.through(2, { data: {} }) })).toBe("anchor_unavailable");
    // Not on the chain, in the wrong order, or not the kinds of message they must be.
    expect(await refused({ anchor: h.through(2, { inputId: "00000000-0000-4000-8000-00000000dead" }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: h.through(2, { data: { lastMessageId: a(1).uuid } }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: h.through(2, { inputId: a(1).uuid }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: h.through(2, { data: { lastMessageId: u(3).uuid } }) })).toBe("anchor_unavailable");
    expect(await refused({ expectedHead: "an-older-head" })).toBe("source_changed");
    expect(await refused({ sessionId: "33333333-3333-4333-8333-333333333333" })).toBe("not_ready");
    // A turn that started while the session was being inspected.
    let asks = 0;
    expect(await refused({ blocked: () => ++asks > 1 ? "busy" : undefined })).toBe("busy");
    expect(h.asked("fork")).toEqual([]);
  });

  it("ties every helper run to its owner's lifetime, and the caller's own cancellation only to what comes before the fork", async () => {
    const h = scripted(), signals: Array<{ operation: string; signal?: AbortSignal }> = [];
    const recording: ClaudeHistoryHelper = (request, context) => { signals.push({ operation: request.operation, ...(context.signal ? { signal: context.signal } : {}) }); return h.helper(request, context); };
    const caller = new AbortController(), lifetime = new AbortController();

    expect((await claudeForkHistory({ ...h.base, helper: recording, signal: caller.signal, lifetime: lifetime.signal })).outcome).toBe("applied");
    expect(signals.map(run => run.operation)).toEqual(["inspect", "fork", "inspect"]);

    // The caller giving up reaches the first inspection only: a fork that was asked for is not cancelled by its caller.
    caller.abort();
    expect(signals.map(run => run.signal?.aborted)).toEqual([true, false, false]);
    // The owner ending reaches all of them.
    lifetime.abort();
    expect(signals.map(run => run.signal?.aborted)).toEqual([true, true, true]);

    // And reaches the first inspection by itself, with a caller that never gave up.
    signals.length = 0;
    const patient = new AbortController(), owner = new AbortController();
    await claudeForkHistory({ ...h.base, helper: recording, signal: patient.signal, lifetime: owner.signal });
    owner.abort();
    expect(signals.map(run => run.signal?.aborted)).toEqual([true, true, true]);

    // A state read is one inspection: either of the two ends it.
    for (const ends of ["caller", "owner"] as const) {
      signals.length = 0;
      const asking = new AbortController(), owning = new AbortController();
      await claudeHistoryState({ ...h.base, helper: recording, signal: asking.signal, lifetime: owning.signal });
      expect(signals.map(run => run.signal?.aborted)).toEqual([false]);
      (ends === "caller" ? asking : owning).abort();
      expect(signals.map(run => run.signal?.aborted)).toEqual([true]);
    }
  });

  it("has nothing to fork in a session without conversation", async () => {
    const h = scripted({ messages: [SYSTEM] });
    expect(await claudeForkHistory(h.base)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(h.asked("fork")).toEqual([]);
  });

  it("takes the helper's refusal before it wrote as a refusal", async () => {
    const changed = scripted({ override: request => request.operation === "fork" ? { kind: "reply", reply: { v: 1, ok: false, phase: "validate", error: { code: "source_changed", message: "m" } } } : undefined });
    expect(await claudeForkHistory(changed.base)).toMatchObject({ outcome: "rejected", reason: "source_changed" });
    const gone = scripted({ override: request => request.operation === "fork" ? { kind: "reply", reply: { v: 1, ok: false, phase: "validate", error: { code: "anchor_missing", message: "m" } } } : undefined });
    expect(await claudeForkHistory({ ...gone.base, anchor: gone.through(2) })).toMatchObject({ outcome: "rejected", reason: "anchor_unavailable" });
    const never = scripted({ override: request => request.operation === "fork" ? { kind: "not-started", detail: "spawn ENOENT" } : undefined });
    expect(await claudeForkHistory(never.base)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
  });

  it.each([
    ["the helper fails in its fork phase", (request: ClaudeHistoryRequest): ClaudeHistoryHelperOutcome | undefined => request.operation === "fork" ? { kind: "reply", reply: { v: 1, ok: false, phase: "fork", error: { code: "fork_unconfirmed", message: "m" } } } : undefined, undefined],
    ["the helper gives no answer to the fork", (request: ClaudeHistoryRequest): ClaudeHistoryHelperOutcome | undefined => request.operation === "fork" ? { kind: "lost", detail: "killed" } : undefined, undefined],
    ["the helper returns the source's own id", (request: ClaudeHistoryRequest): ClaudeHistoryHelperOutcome | undefined => request.operation === "fork" ? { kind: "reply", reply: { v: 1, ok: true, sessionId: SOURCE } } : undefined, undefined],
    ["the new session cannot be read back", (request: ClaudeHistoryRequest, call: number): ClaudeHistoryHelperOutcome | undefined => call === 3 ? { kind: "reply", reply: { v: 1, ok: false, phase: "inspect", error: { code: "session_unreadable", message: "m" } } } : undefined, "22222222-2222-4222-8222-000000000001"],
    ["reading the new session back gives no answer", (_request: ClaudeHistoryRequest, call: number): ClaudeHistoryHelperOutcome | undefined => call === 3 ? { kind: "lost", detail: "killed" } : undefined, "22222222-2222-4222-8222-000000000001"],
    ["the new session holds a different number of messages", (request: ClaudeHistoryRequest, call: number): ClaudeHistoryHelperOutcome | undefined => call === 3 ? { kind: "reply", reply: { v: 1, ok: true, sessionId: request.sessionId, messages: [u(1), a(1)], head: "h" } } : undefined, "22222222-2222-4222-8222-000000000001"],
  ])("does not know the outcome when %s, and does not ask again", async (_label, override, candidate) => {
    const h = scripted({ override });
    const result = await claudeForkHistory(h.base);

    expect(result.outcome).toBe("unknown");
    expect((result as { candidateSessionId?: string }).candidateSessionId).toBe(candidate);
    expect(h.asked("fork").length).toBe(1);
  });
});

describe("the helper's one record", () => {
  it("is read strictly", () => {
    const ok = { v: 1, ok: true, sessionId: SOURCE, messages: [u(1), a(1), SYSTEM], head: "h" };
    expect(parseClaudeHistoryReply(JSON.stringify(ok))).toEqual(ok);
    expect(parseClaudeHistoryReply(JSON.stringify({ v: 1, ok: false, phase: "fork", error: { code: "c", message: "m" } }))).toEqual({ v: 1, ok: false, phase: "fork", error: { code: "c", message: "m" } });
    for (const bad of [
      "", "not json", "[]", JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, sessionId: "" }), JSON.stringify({ ...ok, head: "" }),
      JSON.stringify({ ...ok, messages: [{ uuid: "", type: "user" }] }), JSON.stringify({ ...ok, messages: [{ uuid: "x", type: "tool" }] }), JSON.stringify({ ...ok, messages: "none" }),
      JSON.stringify({ v: 1, ok: false, phase: "later", error: { code: "c", message: "m" } }), JSON.stringify({ v: 1, ok: false, phase: "fork" }), JSON.stringify({ v: 1 }),
    ]) expect(parseClaudeHistoryReply(bad)).toBeUndefined();
  });
});

describe("running the helper as a process", () => {
  function child() {
    const stdout = Object.assign(new EventEmitter(), { setEncoding() {} }), stderr = Object.assign(new EventEmitter(), { resume() {} });
    const written: string[] = [];
    const process = Object.assign(new EventEmitter(), { stdout, stderr, kills: 0, kill() { process.kills += 1; return true; }, stdin: Object.assign(new EventEmitter(), { end(text: string) { written.push(text); } }) });
    return { process, written, stdout };
  }
  const REQUEST: ClaudeHistoryRequest = { v: 1, operation: "inspect", sessionId: SOURCE, workspace: WORKSPACE };

  it("writes one request, with the given environment and no other, and reads the record at close", async () => {
    const c = child(); const spawned: unknown[] = [];
    const helper = spawnClaudeHistoryHelper("/built/helper.js", { spawnFn: ((...args: unknown[]) => { spawned.push(args); return c.process; }) as never });
    const outcome = helper(REQUEST, { env: ENV });
    c.process.emit("spawn");
    c.stdout.emit("data", JSON.stringify({ v: 1, ok: true, sessionId: SOURCE, messages: [u(1)], head: "h" }));
    c.process.emit("close", 0);

    expect(await outcome).toEqual({ kind: "reply", reply: { v: 1, ok: true, sessionId: SOURCE, messages: [u(1)], head: "h" } });
    expect(c.written).toEqual([`${JSON.stringify(REQUEST)}\n`]);
    expect((spawned[0] as [string, string[], { env: unknown; cwd: string }])[1]).toEqual(["/built/helper.js"]);
    expect((spawned[0] as [string, string[], { env: unknown; cwd: string }])[2]).toMatchObject({ env: ENV, cwd: WORKSPACE });
  });

  it("knows a helper that never ran from one that ran and said nothing", async () => {
    const never = child();
    const notStarted = spawnClaudeHistoryHelper("/built/helper.js", { spawnFn: (() => never.process) as never })(REQUEST, { env: ENV });
    never.process.emit("error", new Error("spawn ENOENT"));
    expect(await notStarted).toEqual({ kind: "not-started", detail: "spawn ENOENT" });

    const silent = child();
    const lost = spawnClaudeHistoryHelper("/built/helper.js", { spawnFn: (() => silent.process) as never })(REQUEST, { env: ENV });
    silent.process.emit("spawn");
    silent.process.emit("close", 1);
    expect((await lost).kind).toBe("lost");
  });

  it("is not finished with a helper it killed until that process has closed", async () => {
    const c = child(); const stop = new AbortController();
    let settled = false;
    const outcome = spawnClaudeHistoryHelper("/built/helper.js", { spawnFn: (() => c.process) as never })(REQUEST, { env: ENV, signal: stop.signal });
    void outcome.then(() => { settled = true; });
    c.process.emit("spawn");
    // A complete record is already out when the helper is killed: whether it had finished is no longer known.
    c.stdout.emit("data", JSON.stringify({ v: 1, ok: true, sessionId: SOURCE }));
    stop.abort();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(c.process.kills).toBe(1);
    expect(settled).toBe(false);
    c.process.emit("close", null);
    expect((await outcome).kind).toBe("lost");
  });

  it("kills a helper that takes too long, and waits for it too", async () => {
    const c = child(); let settled = false;
    const outcome = spawnClaudeHistoryHelper("/built/helper.js", { timeoutMs: 20, spawnFn: (() => c.process) as never })(REQUEST, { env: ENV });
    void outcome.then(() => { settled = true; });
    c.process.emit("spawn");
    await vi.waitFor(() => expect(c.process.kills).toBe(1), { timeout: 2000, interval: 5 });
    expect(settled).toBe(false);
    c.process.emit("close", null);
    expect(await outcome).toMatchObject({ kind: "lost" });
  });
});

describe("the Claude adapter and native history", () => {
  class Stream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
  function harness() {
    const children: Array<EventEmitter & { stdin: { lines: string[]; write(chunk: string, callback?: (error?: Error | null) => void): boolean }; stdout: Stream; stderr: Stream; kill(): void }> = [];
    const spawnFn = () => {
      const lines: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        stdin: { lines, write(chunk: string, callback?: (error?: Error | null) => void) { const text = chunk.toString().trim(); if (text) lines.push(text); callback?.(null); return true; } },
        stdout: new Stream(), stderr: new Stream(), kill() {},
      });
      children.push(child);
      return child;
    };
    return { children, spawnFn };
  }
  const waitFor = (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2000, interval: 2 });
  const NATIVE = "44444444-4444-4444-8444-444444444444";

  async function turn(adapter: ClaudeStreamAdapter, h: ReturnType<typeof harness>, frames: (prompt: { uuid: string }) => object[]) {
    const events: EngineStreamEvent[] = [];
    const reply = adapter.sendUserMessage("tarobot-history-fixture", { text: "hello", files: [], onEngineEvent: event => { events.push(event); } });
    await waitFor(() => h.children[0]?.stdin.lines.length === 1);
    const prompt = JSON.parse(h.children[0]!.stdin.lines[0]!) as { uuid: string };
    const emit = (frame: object) => h.children[0]!.stdout.emitData(`${JSON.stringify({ session_id: NATIVE, ...frame })}\n`);
    return { events, reply, prompt, emit, run: () => { for (const frame of frames(prompt)) emit(frame); } };
  }
  const said = (uuid: string, text: string, extra: object = {}) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }] }, ...extra });

  it("offers the turn as a place to fork through: its own prompt uuid and Claude's last answer in the main conversation", async () => {
    const h = harness(), helper = scripted();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: h.spawnFn as never, workspacePath: WORKSPACE, historyHelper: helper.helper });
    try {
      const t = await turn(adapter, h, () => [
        { type: "system", subtype: "init" },
        said("aaaaaaaa-0000-4000-8000-000000000001", "working"),
        said("aaaaaaaa-0000-4000-8000-000000000002", "done"),
        // A subagent's message, arriving last, is not on this session's chain.
        said("aaaaaaaa-0000-4000-8000-0000000000ff", "from a subagent", { parent_tool_use_id: "toolu_1" }),
        { type: "result", result: "done" },
      ]);
      t.run();
      await expect(t.reply).resolves.toMatchObject({ text: "done", sessionId: NATIVE });

      const anchors = t.events.filter(event => event.type === "history_anchor");
      expect(anchors).toEqual([{ type: "history_anchor", anchor: {
        sessionId: NATIVE, inputId: t.prompt.uuid, rewind: false, fork: true, forkBoundary: "after-turn", data: { lastMessageId: "aaaaaaaa-0000-4000-8000-000000000002" },
      } }]);
      // Offered before the result that ends the turn.
      const kinds = t.events.map(event => event.type);
      expect(kinds.indexOf("history_anchor")).toBeLessThan(kinds.lastIndexOf("result"));
    } finally { await adapter.destroy(); }
  });

  it("offers nothing, and changes nothing about a turn, when there is no helper", async () => {
    const h = harness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: h.spawnFn as never, workspacePath: WORKSPACE, historyHelper: null });
    try {
      const t = await turn(adapter, h, () => [{ type: "system", subtype: "init" }, said("aaaaaaaa-0000-4000-8000-000000000001", "done"), { type: "result", result: "done" }]);
      t.run();
      await t.reply;

      expect(t.events.filter(event => event.type === "history_anchor")).toEqual([]);
      expect(await adapter.getHistoryState(NATIVE)).toEqual({ head: null });
      expect(await adapter.forkHistory(NATIVE)).toEqual({ outcome: "rejected", reason: "unsupported" });
    } finally { await adapter.destroy(); }
  });

  it("is busy while its own turn runs on the session, and asks the helper for no fork", async () => {
    const h = harness(), helper = scripted();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: h.spawnFn as never, workspacePath: WORKSPACE, historyHelper: helper.helper });
    try {
      const t = await turn(adapter, h, () => []);
      t.emit({ type: "system", subtype: "init" });
      t.emit(said("aaaaaaaa-0000-4000-8000-000000000001", "working"));

      expect(await adapter.forkHistory(NATIVE)).toEqual({ outcome: "rejected", reason: "busy" });
      expect(helper.asked("fork")).toEqual([]);
      t.emit({ type: "result", result: "done" });
      await t.reply;
    } finally { await adapter.destroy(); }
  });

  describe("once it has been destroyed", () => {
    /** A helper whose runs are held until released, and which, like the real runner, ends a run when its signal fires. */
    function held(inner: ClaudeHistoryHelper) {
      const waiting: Array<{ operation: string; release: () => void }> = [];
      const helper: ClaudeHistoryHelper = (request, context) => new Promise(resolve => {
        const release = () => { void inner(request, context).then(resolve); };
        context.signal?.addEventListener("abort", () => resolve({ kind: "lost", detail: "cancelled while the helper was running" }), { once: true });
        waiting.push({ operation: request.operation, release });
      });
      return { helper, waiting };
    }
    const make = (helper: ClaudeHistoryHelper) => new ClaudeStreamAdapter("claude", { spawnFn: harness().spawnFn as never, workspacePath: WORKSPACE, historyHelper: helper });

    it("starts nothing: no inspection and no fork", async () => {
      const h = scripted(), adapter = make(h.helper);
      await adapter.destroy();

      expect(await adapter.getHistoryState(NATIVE)).toEqual({ head: null, blocked: "not_ready" });
      expect(await adapter.forkHistory(NATIVE)).toEqual({ outcome: "rejected", reason: "not_ready" });
      expect(h.calls).toEqual([]);
    });

    it("ends a state read when its caller gives up, without waiting for the adapter to end", async () => {
      const h = scripted(), slow = held(h.helper), adapter = make(slow.helper);
      try {
        const caller = new AbortController();
        const reading = adapter.getHistoryState(SOURCE, { signal: caller.signal });
        await waitFor(() => slow.waiting.length === 1);
        expect(adapter.hasPendingNativeWork()).toBe(true);

        caller.abort();

        expect(await reading).toEqual({ head: null, blocked: "not_ready" });
        expect(adapter.hasPendingNativeWork()).toBe(false);
      } finally { await adapter.destroy(); }
    });

    it("ends a state read it was waiting on", async () => {
      const h = scripted(), slow = held(h.helper), adapter = make(slow.helper);
      const reading = adapter.getHistoryState(SOURCE);
      await waitFor(() => slow.waiting.length === 1);

      await adapter.destroy();

      expect(await reading).toEqual({ head: null, blocked: "not_ready" });
    });

    it("ends an inspection it was waiting on and does not go on to fork", async () => {
      const h = scripted(), slow = held(h.helper), adapter = make(slow.helper);
      const forking = adapter.forkHistory(SOURCE);
      await waitFor(() => slow.waiting.length === 1);

      await adapter.destroy();

      expect(await forking).toMatchObject({ outcome: "rejected", reason: "not_ready" });
      expect(slow.waiting.map(run => run.operation)).toEqual(["inspect"]);
      expect(h.asked("fork")).toEqual([]);
    });

    it("does not fork on an inspection that still answered while it was being destroyed", async () => {
      const h = scripted(), waiting: Array<() => void> = [];
      // This helper ignores cancellation: the answer arrives, and only the check before the fork can stop it.
      const stubborn: ClaudeHistoryHelper = (request, context) => new Promise(resolve => { waiting.push(() => { void h.helper(request, context).then(resolve); }); });
      const adapter = make(stubborn);
      const forking = adapter.forkHistory(SOURCE);
      await waitFor(() => waiting.length === 1);

      const destroying = adapter.destroy();
      waiting[0]!();
      await destroying;

      expect(await forking).toMatchObject({ outcome: "rejected", reason: "not_ready" });
      expect(h.asked("fork")).toEqual([]);
    });

    it("cuts a fork short, reports it unknown, and never asks again", async () => {
      const h = scripted(), slow = held(h.helper), adapter = make(slow.helper);
      const forking = adapter.forkHistory(SOURCE);
      await waitFor(() => slow.waiting.length === 1);
      slow.waiting[0]!.release();
      await waitFor(() => slow.waiting.length === 2);
      expect(slow.waiting[1]!.operation).toBe("fork");

      await adapter.destroy();

      expect((await forking).outcome).toBe("unknown");
      expect(slow.waiting.map(run => run.operation)).toEqual(["inspect", "fork"]);
    });
  });

  it("forks a turn that a missed steer continued through the continuation's answer, whichever of its inputs the anchor names", async () => {
    // Frames, order and uuid roles as Claude Code 2.1.329 wrote them in an isolated loopback run: the steer was
    // written while the prompt's request was in flight, missed the fold, and ran as its own native turn.
    const h = harness();
    let current: ClaudeHistoryHelper | undefined;
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: h.spawnFn as never, workspacePath: WORKSPACE, historyHelper: (request, context) => current!(request, context) });
    const A1 = "aaaaaaaa-0000-4000-8000-0000000000a1", A2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
    try {
      const events: EngineStreamEvent[] = [];
      const reply = adapter.sendUserMessage("tarobot-history-fixture", { text: "ALPHA", files: [], onEngineEvent: event => { events.push(event); } });
      await waitFor(() => h.children[0]?.stdin.lines.length === 1);
      const child = h.children[0]!;
      const emit = (frame: object) => child.stdout.emitData(`${JSON.stringify({ session_id: SOURCE, ...frame })}\n`);
      const lifecycle = (uuid: string, state: string) => emit({ type: "command_lifecycle", command_uuid: uuid, state });
      const prompt = (JSON.parse(child.stdin.lines[0]!) as { uuid: string }).uuid;
      emit({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "interrupt_send_now_v1", "interrupt_requeue_taken_v1", "msg_lifecycle_v1", "request_marker_lists_v1"] });
      lifecycle(prompt, "queued"); lifecycle(prompt, "started");
      const outcomes: unknown[] = [];
      const steering = adapter.steerActiveTurn(SOURCE, { text: "BETA", onOutcome: outcome => { outcomes.push(outcome); } });
      await waitFor(() => child.stdin.lines.length === 2);
      const steer = (JSON.parse(child.stdin.lines[1]!) as { uuid: string }).uuid;
      lifecycle(steer, "queued");
      expect(await steering).toBe(true);
      emit(said(A1, "REPLY_ALPHA", { user_message_uuid: prompt, user_message_uuids: [prompt] }));
      emit({ type: "result", subtype: "success", result: "REPLY_ALPHA", user_message_uuid: prompt, user_message_uuids: [prompt] });
      lifecycle(prompt, "completed"); lifecycle(steer, "started");
      emit(said(A2, "REPLY_BETA", { user_message_uuid: steer, user_message_uuids: [steer] }));
      emit({ type: "result", subtype: "success", result: "REPLY_BETA", user_message_uuid: steer, user_message_uuids: [steer] });
      lifecycle(steer, "completed");
      await expect(reply).resolves.toMatchObject({ text: "REPLY_ALPHA\nREPLY_BETA" });
      expect(outcomes).toEqual([{ status: "applied", via: "continuation" }]);

      const anchors = events.filter(event => event.type === "history_anchor").map(event => (event as { anchor: NativeHistoryAnchor }).anchor);
      expect(anchors).toHaveLength(1);
      // The host turn's reply holds both segments; its fork boundary is the continuation's answer.
      expect(anchors[0]!.data).toEqual({ lastMessageId: A2 });
      expect([prompt, steer]).toContain(anchors[0]!.inputId);

      // The session's chain afterwards, with one later ordinary turn.
      const later = "aaaaaaaa-0000-4000-8000-0000000000b3", laterAnswer = "aaaaaaaa-0000-4000-8000-0000000000a3";
      const h2 = scripted({ messages: [{ uuid: prompt, type: "user" }, { uuid: A1, type: "assistant" }, { uuid: steer, type: "user" }, { uuid: A2, type: "assistant" }, { uuid: later, type: "user" }, { uuid: laterAnswer, type: "assistant" }] });
      current = h2.helper;
      const asIs = await adapter.forkHistory(SOURCE, { anchor: anchors[0]! });
      // Control: the same anchor naming the App message's own prompt instead.
      const control = await adapter.forkHistory(SOURCE, { anchor: { ...anchors[0]!, inputId: prompt } });
      expect(asIs).toMatchObject({ outcome: "applied", boundary: "after-turn" });
      expect(control).toMatchObject({ outcome: "applied", boundary: "after-turn" });
      expect(h2.asked("fork").map(request => request.upToMessageId)).toEqual([A2, A2]);
      for (const result of [asIs, control]) {
        expect(h2.sessions.get((result as { sessionId: string }).sessionId)!.map(message => message.type)).toEqual(["user", "assistant", "user", "assistant"]);
      }
    } finally { await adapter.destroy(); }
  });

  it("has no native session to look at behind a chat that never started one", async () => {
    const h = harness(), helper = scripted();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn: h.spawnFn as never, workspacePath: WORKSPACE, historyHelper: helper.helper });
    try {
      expect(await adapter.getHistoryState("tarobot-1-0f6c1c1e")).toEqual({ head: null, blocked: "not_ready" });
      expect(await adapter.forkHistory("tarobot-1-0f6c1c1e")).toEqual({ outcome: "rejected", reason: "not_ready" });
      expect(helper.calls).toEqual([]);
      expect(adapter).not.toHaveProperty("rewindHistory");
    } finally { await adapter.destroy(); }
  });
});
