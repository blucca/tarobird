import { describe, expect, it, vi } from "vitest";

import type { NativeHistoryResult, NativeHistoryState } from "../src/codex/adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";

/**
 * `codex exec` has no history interface. The process adapter asks a temporary
 * app-server, as it does for goals. Here that app-server is a stub: what is
 * under test is what this adapter adds and withholds around it.
 */
function adapter(state: NativeHistoryState, forked: NativeHistoryResult = { outcome: "applied", sessionId: "fork-1", head: "turn-3", boundary: "whole" }) {
  const process = new ProcessCodexAdapter("codex");
  const appServer = { getHistoryState: vi.fn(async () => state), forkHistory: vi.fn(async () => forked), destroy: vi.fn() };
  const create = vi.spyOn(process as unknown as { createGoalAppServerAdapter(workspace?: string): unknown }, "createGoalAppServerAdapter").mockReturnValue(appServer);
  return { process, appServer, create, running: process as unknown as { runningTurns: number } };
}
const IDLE: NativeHistoryState = { fork: { whole: true, anchored: true }, rewind: true, head: "turn-3" };

describe("native history through the Codex process adapter", () => {
  it("offers the whole thread to fork and nothing that needs a turn it cannot name", async () => {
    const a = adapter(IDLE);

    expect(await a.process.getHistoryState("thread-1", { workspaceOverride: "/srv/ws" })).toEqual({ head: "turn-3", fork: { whole: true, anchored: false } });
    expect(a.process).not.toHaveProperty("rewindHistory");
    expect(a.create).toHaveBeenCalledWith("/srv/ws", expect.any(Function));
    expect(a.appServer.destroy).toHaveBeenCalledTimes(1);
  });

  it("passes on what the app-server could not offer or was blocked by", async () => {
    expect(await adapter({ head: null, blocked: "source_missing" }).process.getHistoryState("thread-1")).toEqual({ head: null, blocked: "source_missing" });
    expect(await adapter({ head: null }).process.getHistoryState("thread-1")).toEqual({ head: null });
    expect(await adapter({ ...IDLE, blocked: "goal_active" }).process.getHistoryState("thread-1")).toMatchObject({ blocked: "goal_active" });
  });

  it("forks the whole thread through the app-server and ends that app-server", async () => {
    const a = adapter(IDLE);

    expect(await a.process.forkHistory("thread-1", { expectedHead: "turn-3" })).toEqual({ outcome: "applied", sessionId: "fork-1", head: "turn-3", boundary: "whole" });
    expect(a.appServer.forkHistory).toHaveBeenCalledWith("thread-1", { expectedHead: "turn-3", signal: expect.any(AbortSignal) });
    expect(a.appServer.destroy).toHaveBeenCalledTimes(1);
  });

  it("refuses a fork at a turn without starting an app-server", async () => {
    const a = adapter(IDLE);
    expect(await a.process.forkHistory("thread-1", { anchor: { sessionId: "thread-1", inputId: "turn-2", rewind: true, fork: true, forkBoundary: "after-turn" } })).toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(a.create).not.toHaveBeenCalled();
  });

  it("is busy while one of its own exec turns runs, which the app-server could not see", async () => {
    const a = adapter(IDLE);
    a.running.runningTurns = 1;

    expect(await a.process.getHistoryState("thread-1")).toMatchObject({ head: null, blocked: "busy" });
    expect(await a.process.forkHistory("thread-1")).toEqual({ outcome: "rejected", reason: "busy" });
    expect(a.appServer.forkHistory).not.toHaveBeenCalled();
  });

  it("counts a turn as running from before it starts until it has ended, however it ends", async () => {
    const a = adapter(IDLE);
    let seenDuring = -1;
    vi.spyOn(a.process as unknown as { runUserMessage(): Promise<unknown> }, "runUserMessage").mockImplementation(async () => { seenDuring = a.running.runningTurns; throw new Error("exec failed"); });

    await expect(a.process.sendUserMessage("thread-1", { text: "hello", files: [] })).rejects.toThrow("exec failed");
    expect(seenDuring).toBe(1);
    expect(a.running.runningTurns).toBe(0);
  });
});

// The history app-server itself is real; only its child transport is scripted.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { CodexAdapter } from "../src/codex/adapter.js";

function historyPeer(hold?: string | ((request: { method: string; params: any }) => boolean)) {
  const requests: Array<{ method: string; params: any }> = [], held: Array<() => void> = [];
  const children: Peer[] = []; let delayExit = false, kills = 0;
  class Peer extends EventEmitter {
    stdout = new PassThrough(); stderr = new PassThrough(); closed = false;
    stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const request = JSON.parse(line); if (!request.id) continue; requests.push(request);
        let result: unknown = {};
        if (request.method === "thread/resume") result = { thread: { id: request.params.threadId } };
        if (request.method === "thread/turns/list") result = { data: [{ id: "turn-1", status: "completed" }], nextCursor: null };
        if (request.method === "thread/goal/get") result = { goal: null };
        if (request.method === "thread/fork") result = { thread: { id: "fork-1", ephemeral: false } };
        const reply = () => queueMicrotask(() => { if (!this.closed) this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"); });
        if (typeof hold === "function" ? hold(request) : request.method === hold) held.push(reply); else reply();
      }
      callback();
    } });
    kill() { kills++; if (!delayExit) this.close(); }
    close() { if (this.closed) return; this.closed = true; this.stdout.end(); this.stderr.end(); this.emit("close", 0); }
  }
  const process = new ProcessCodexAdapter("fixture", {}, () => { const child = new Peer(); children.push(child); return child; }, undefined, undefined, undefined, "/srv/fixture");
  const release = () => { held.splice(0).forEach(reply => reply()); };
  return { process, history: process as CodexAdapter, requests, children, release, delayExit: () => { delayExit = true; }, kills: () => kills,
    releaseExits: () => { delayExit = false; children.forEach(child => child.close()); } };
}

it("cancels a pending history read without returning a ready snapshot", async () => {
  const f = historyPeer("thread/turns/list"), controller = new AbortController(); let settled = false;
  const pending = f.process.getHistoryState("source", { signal: controller.signal }).finally(() => { settled = true; });
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/turns/list")).toBe(true));
  controller.abort(); await new Promise(resolve => setTimeout(resolve, 10)); const beforeRelease = settled;
  f.release(); const state = await pending; f.releaseExits();
  expect(beforeRelease).toBe(true); expect(state.head).toBeNull(); expect(f.requests.some(r => r.method === "thread/goal/get")).toBe(false);
});
it("waits for an actual helper close before delivering history state", async () => {
  const f = historyPeer(); f.delayExit(); let settled = false;
  const pending = f.process.getHistoryState("source").finally(() => { settled = true; });
  await vi.waitFor(() => expect(f.kills()).toBeGreaterThan(0));
  const beforeClose = settled; f.releaseExits(); const state = await pending;
  expect(beforeClose).toBe(false); expect(state.head).toBe("turn-1");
});
it("stops an unsubmitted fork on adapter destruction and never dispatches it late", async () => {
  const f = historyPeer("thread/goal/get"); const pending = f.process.forkHistory("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/goal/get")).toBe(true));
  const destruction = f.history.destroy?.(); f.release(); const result = await pending; await destruction; f.releaseExits();
  expect(result).toMatchObject({ outcome: "rejected" }); expect(f.requests.some(r => r.method === "thread/fork")).toBe(false);
});
it("does not start an exec turn once a fork operation owns the adapter", async () => {
  const f = historyPeer("thread/goal/get"); const pending = f.process.forkHistory("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/goal/get")).toBe(true));
  const run = vi.spyOn(f.process as unknown as { runUserMessage(): Promise<unknown> }, "runUserMessage").mockResolvedValue({ text: "unexpected" });
  const result = await f.process.sendUserMessage("source", { text: "racing", files: [] }).then(() => "sent", () => "rejected");
  f.release(); await pending; f.releaseExits(); expect(result).toBe("rejected"); expect(run).not.toHaveBeenCalled();
});

it("keeps a submitted fork uncertain when its owner shuts down, without resubmitting", async () => {
  const f = historyPeer("thread/fork"); const pending = f.process.forkHistory("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/fork")).toBe(true));
  await f.history.destroy!(); const result = await pending; f.release(); f.releaseExits();
  expect(result).toMatchObject({ outcome: "unknown" }); expect(f.requests.filter(r => r.method === "thread/fork")).toHaveLength(1);
});
it("retains the known candidate after shutdown interrupts fork readback", async () => {
  const f = historyPeer(r => r.method === "thread/turns/list" && r.params.threadId === "fork-1");
  const pending = f.process.forkHistory("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/turns/list" && r.params.threadId === "fork-1")).toBe(true));
  await f.history.destroy!(); const result = await pending; f.release(); f.releaseExits();
  expect(result).toEqual({ outcome: "unknown", candidateSessionId: "fork-1" });
});
it("keeps the native answer when only the caller cancels an already submitted fork", async () => {
  const f = historyPeer("thread/fork"), controller = new AbortController();
  const pending = f.process.forkHistory("source", { signal: controller.signal });
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/fork")).toBe(true));
  controller.abort(); f.release();
  expect(await pending).toMatchObject({ outcome: "applied", sessionId: "fork-1" }); f.releaseExits();
});
it("waits for helper exit during destroy and permits a later independent history operation", async () => {
  const f = historyPeer("thread/turns/list"); f.delayExit();
  const pending = f.process.getHistoryState("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/turns/list")).toBe(true));
  let destroyed = false; const destruction = f.history.destroy!().then(() => { destroyed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(destroyed).toBe(false); expect(f.history.hasPendingNativeWork!()).toBe(true);
  f.releaseExits(); await destruction; expect((await pending).head).toBeNull();
  const next = f.process.getHistoryState("source");
  await vi.waitFor(() => expect(f.requests.filter(r => r.method === "thread/turns/list")).toHaveLength(2));
  f.release(); expect((await next).head).toBe("turn-1");
});
it("queues ordinary input through a read and lets the caller cancel that wait", async () => {
  const f = historyPeer("thread/turns/list"), controller = new AbortController();
  const snapshot = f.process.getHistoryState("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/turns/list")).toBe(true));
  const run = vi.spyOn(f.process as unknown as { runUserMessage(): Promise<unknown> }, "runUserMessage").mockResolvedValue({ text: "sent once" });
  const cancelled = f.process.sendUserMessage("source", { text: "cancelled", files: [], abortSignal: controller.signal });
  const rejected = expect(cancelled).rejects.toThrow("caller stopped"); controller.abort(new Error("caller stopped")); await rejected;
  const queued = f.process.sendUserMessage("source", { text: "queued", files: [] }); expect(run).not.toHaveBeenCalled();
  f.release(); await snapshot; expect(await queued).toMatchObject({ text: "sent once" }); expect(run).toHaveBeenCalledTimes(1);
});

it("prevents a late helper spawn when destroy occurs during asynchronous startup", async () => {
  const { CodexAppServerAdapter } = await import("../src/codex/app-server-adapter.js");
  const proto = CodexAppServerAdapter.prototype as unknown as { loadRuntimeOptions(): Promise<unknown> };
  const original = proto.loadRuntimeOptions;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const load = vi.spyOn(proto, "loadRuntimeOptions").mockImplementationOnce(async function (this: typeof proto) { entered(); await gate; return original.call(this); });
  try {
    const f = historyPeer(); const pending = f.process.forkHistory("source"); await started;
    const destruction = f.history.destroy!(); release();
    expect(await pending).toMatchObject({ outcome: "rejected", reason: "not_ready" }); await destruction;
    expect(f.children).toHaveLength(0); expect(f.requests).toHaveLength(0); expect(f.history.hasPendingNativeWork!()).toBe(false);
  } finally { release(); load.mockRestore(); }
});

it("honors read cancellation while its helper is finishing cleanup", async () => {
  const f = historyPeer(), controller = new AbortController(); f.delayExit();
  const pending = f.process.getHistoryState("source", { signal: controller.signal });
  await vi.waitFor(() => expect(f.kills()).toBeGreaterThan(0)); controller.abort(); f.releaseExits();
  expect(await pending).toMatchObject({ head: null, blocked: "not_ready" });
});
it("does not release a waiting ordinary turn into a destroyed history lifetime", async () => {
  const f = historyPeer("thread/turns/list"); const snapshot = f.process.getHistoryState("source");
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "thread/turns/list")).toBe(true));
  const run = vi.spyOn(f.process as unknown as { runUserMessage(): Promise<unknown> }, "runUserMessage").mockResolvedValue({ text: "unexpected" });
  const queued = f.process.sendUserMessage("source", { text: "never send", files: [] });
  const rejected = expect(queued).rejects.toThrow("Codex history operation cancelled");
  await f.history.destroy!(); await snapshot; await rejected; expect(run).not.toHaveBeenCalled(); f.releaseExits();
});
