import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EngineStreamEvent, NativeHistoryAnchor } from "../src/codex/adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { fakePiDisk, fakePiSpawner, type FakePiOptions, type FakePiProcess } from "./helpers/pi-fake-rpc.js";

/**
 * Native history on Pi. A fork made for a new conversation must leave its
 * source alone, and Pi's own `fork` / `clone` move the process that runs them.
 * So the fork runs in a second, short-lived Pi on the same session file.
 *
 * Pi here is the in-process fake with sessions shared through files, following
 * what Pi 1.6.0's source does: the file appears with the first assistant
 * message, `fork` ends before the chosen user message, `clone` copies to the
 * leaf, and a move in the tree changes the leaf without writing anything.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

async function stack(pi: FakePiOptions | ((index: number, args: string[]) => FakePiOptions) = {}, startupTimeoutMs = 500) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-history-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  const disk = fakePiDisk(path.join(root, "unused"));
  const spawner = fakePiSpawner((index, args) => ({ disk, ...(typeof pi === "function" ? pi(index, args) : pi) }));
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: null,
    // Every fake process has the same pid. A kill ends the second processes; the source ends when its stdin closes.
    spawnFn: spawner.spawn, killProcessTreeFn: pid => { for (const process of spawner.processes.slice(1)) if (process.pid === pid) process.exit(null, "SIGKILL"); },
    queryCatalogFn: async () => ({ models: [] }),
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs, turnTimeoutMs: null, inactivityTimeoutMs: null,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  const say = async (text: string, session = sessionId) => {
    const events: EngineStreamEvent[] = [];
    const reply = await adapter.sendUserMessage(session, { text, files: [], onEngineEvent: event => { events.push(event); } });
    return { reply, events };
  };
  const got = (process: FakePiProcess, type: string) => process.received.filter(command => command.type === type);
  const userEntries = (process: FakePiProcess) => process.entries.filter(entry => (entry.message as { role?: string } | undefined)?.role === "user").map(entry => entry.id as string);
  /** A place the caller names itself; the adapter offers none. */
  const before = (inputId: string, extra: Partial<NativeHistoryAnchor> = {}): NativeHistoryAnchor => ({ sessionId, inputId, rewind: false, fork: true, forkBoundary: "before-input", ...extra });
  return { adapter, spawner, sessionId, say, got, userEntries, before, disk };
}

describe("a Pi turn and places in its history", () => {
  it("offers none: Pi does not say which entry a prompt became, and an extension can add a user entry first", async () => {
    const { say, spawner, got } = await stack({ onPrompt: run => {
      // What an input hook or an extension's own sendUserMessage does between the prompt and its entry.
      run.process.appendEntry({ type: "message", message: { role: "user", content: "extension input before the owner's" } });
      run.reply("ok"); run.finish();
    } });
    const first = await say("first question");
    const second = await say("second question");

    expect([...first.events, ...second.events].filter(event => event.type === "history_anchor")).toEqual([]);
    // And nothing is asked of Pi for it.
    expect(got(spawner.last(), "get_fork_messages")).toEqual([]);
    expect(got(spawner.last(), "get_entries")).toEqual([]);
  });
});

describe("what a Pi session's history can do now", () => {
  it("can be forked whole; forking from a message and rewinding are not offered", async () => {
    const { adapter, say, sessionId, spawner } = await stack();
    await say("first question");
    const state = await adapter.getHistoryState(sessionId);

    expect(state).toEqual({ fork: { whole: true, anchored: false }, head: spawner.last().entries.at(-1)!.id });
    expect(state).not.toHaveProperty("rewind");
    expect(adapter).not.toHaveProperty("rewindHistory");
  });

  it("cannot be forked whole while its position in Pi's tree is not the one Pi has written", async () => {
    const { adapter, say, sessionId, spawner } = await stack();
    await say("first question");
    await say("second question");
    const source = spawner.last(), moved = source.entries[1]!.id as string;
    source.leafOverride = moved;

    expect(await adapter.getHistoryState(sessionId)).toEqual({ fork: { whole: false, anchored: false }, head: moved });
    expect(await adapter.forkHistory(sessionId)).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(spawner.processes.length).toBe(1);
  });

  it("does not start Pi for a session it has no file for, which would create that session", async () => {
    const { adapter, spawner } = await stack();
    expect(await adapter.getHistoryState("0199a1b2-0000-7000-8000-00000000dead")).toEqual({ head: null, blocked: "source_missing" });
    expect(await adapter.forkHistory("0199a1b2-0000-7000-8000-00000000dead")).toMatchObject({ outcome: "rejected", reason: "source_missing" });
    expect(spawner.processes.length).toBe(0);
  });
});

describe("forking a Pi session for a new conversation", () => {
  it("forks the whole session with Pi's clone in a second Pi, and the source's own Pi is not asked to", async () => {
    const { adapter, say, sessionId, spawner, got } = await stack();
    await say("first question");
    await say("second question");
    const source = spawner.last(), head = source.entries.at(-1)!.id as string;

    const result = await adapter.forkHistory(sessionId, { expectedHead: head });

    expect(result).toMatchObject({ outcome: "applied", boundary: "whole", head });
    const forked = (result as { sessionId: string }).sessionId;
    expect(forked).not.toBe(sessionId);
    // A second process, on the source's own file, without the owner's extensions; gone when the call returns.
    expect(spawner.processes.length).toBe(2);
    const helper = spawner.last();
    expect(helper.args).toEqual(expect.arrayContaining(["--session", source.state.sessionFile as string, "--no-extensions"]));
    expect(got(helper, "clone").length).toBe(1);
    expect(helper.exited).toBe(true);
    expect(adapter.hasPendingNativeWork()).toBe(false);
    // The source: same process, same session, never told to fork, still answering.
    expect(got(source, "fork")).toEqual([]);
    expect(got(source, "clone")).toEqual([]);
    expect(source.sessionId).toBe(sessionId);
    expect(source.exited).toBe(false);
    expect((await adapter.getHistoryState(sessionId)).head).toBe(head);
    expect((await say("third question")).reply.sessionId).toBe(sessionId);
    // The new session can be opened as any other.
    expect((await adapter.getHistoryState(forked)).head).toBe(head);
    expect((await say("on the fork", forked)).reply.sessionId).toBe(forked);
  });

  it("can fork from before a message the caller names, when that message is on the current branch", async () => {
    const { adapter, say, sessionId, spawner, got, userEntries, before } = await stack();
    await say("first question");
    await say("second question");
    const source = spawner.last(), second = userEntries(source)[1]!;

    const result = await adapter.forkHistory(sessionId, { anchor: before(second) });

    expect(result).toMatchObject({ outcome: "applied", boundary: "before-input" });
    expect(got(spawner.last(), "fork").map(command => command.entryId)).toEqual([second]);
    expect((result as { head: string }).head).toBe(source.entries[source.entries.findIndex(entry => entry.id === second) - 1]!.id);
    expect(got(source, "fork")).toEqual([]);
  });

  it("refuses before a second Pi is started", async () => {
    const { adapter, say, sessionId, spawner, userEntries, before } = await stack();
    await say("first question");
    await say("second question");
    const source = spawner.last(), [first, second] = userEntries(source) as [string, string];
    const aborted = new AbortController(); aborted.abort();
    const refused = async (input: Parameters<PiRpcAdapter["forkHistory"]>[1]) => {
      const result = await adapter.forkHistory(sessionId, input);
      return result.outcome === "rejected" ? result.reason : result.outcome;
    };

    expect(await refused({ signal: aborted.signal })).toBe("cancelled");
    expect(await refused({ anchor: before(second, { sessionId: "another-session" }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: before(second, { forkBoundary: "after-turn" }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: before(second, { fork: false }) })).toBe("anchor_unavailable");
    expect(await refused({ anchor: before("no-such-entry") })).toBe("anchor_unavailable");
    // Before the first message there is nothing Pi would write to disk.
    expect(await refused({ anchor: before(first) })).toBe("anchor_unavailable");
    expect(await refused({ expectedHead: "some-older-entry" })).toBe("source_changed");
    // In the file, but no longer on the branch the owner is on.
    source.leafOverride = source.entries[1]!.id as string;
    expect(await refused({ anchor: before(second) })).toBe("anchor_unavailable");
    expect(spawner.processes.length).toBe(1);
  });

  it("is busy while a turn runs on the source", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const { adapter, say, sessionId, spawner } = await stack({ onPrompt: async run => { if (run.process.entries.length > 2) await held; run.reply("ok"); run.finish(); } });
    await say("first question");
    const running = say("second question");
    await vi.waitFor(() => expect(spawner.last().received.filter(command => command.type === "prompt").length).toBe(2), { timeout: 2000, interval: 5 });

    expect(await adapter.forkHistory(sessionId)).toEqual({ outcome: "rejected", reason: "busy" });
    expect((await adapter.getHistoryState(sessionId)).blocked).toBe("busy");
    expect(spawner.processes.length).toBe(1);
    release();
    expect((await running).reply.text).toBe("ok");
  });

  it("reports Pi's own refusal of the fork as a refusal", async () => {
    const { adapter, say, sessionId, userEntries, before, spawner } = await stack(index => index === 0 ? {} : { onCommand: (command, process) => { if (command.type !== "fork") return false; process.fail(command, "Invalid entry ID for forking"); return true; } });
    await say("first question");
    await say("second question");
    expect(await adapter.forkHistory(sessionId, { anchor: before(userEntries(spawner.last())[1]!) })).toEqual({ outcome: "rejected", reason: "anchor_unavailable", detail: "Invalid entry ID for forking" });
  });

  it("does not know the outcome when the second Pi goes away after being asked, and does not ask again", async () => {
    const { adapter, say, sessionId, spawner } = await stack(index => index === 0 ? {} : { onCommand: (command, process) => { if (command.type !== "clone") return false; process.exit(1); return true; } });
    await say("first question");

    expect((await adapter.forkHistory(sessionId)).outcome).toBe("unknown");
    expect(spawner.processes.length).toBe(2);
    expect(spawner.processes[0]!.exited).toBe(false);
  });

  it("does not call a fork refused when Pi made it and then failed to say what it made", async () => {
    const { adapter, say, sessionId, spawner, got, disk } = await stack(index => index === 0 ? {} : { onCommand: (command, process) => {
      // Only the state lookup that comes after Pi has forked fails.
      if (command.type !== "get_state" || !process.received.some(earlier => earlier.type === "clone")) return false;
      process.fail(command, "synthetic state lookup failed after successful clone"); return true;
    } });
    await say("first question");
    const filesBefore = disk.byFile.size;

    const result = await adapter.forkHistory(sessionId);

    expect(result.outcome).toBe("unknown");
    expect(got(spawner.last(), "clone").length).toBe(1);
    // Pi did create the new session.
    expect(disk.byFile.size).toBe(filesBefore + 1);
  });

  it("knows of the second Pi from the moment it is spawned, and ends one that is still starting", async () => {
    // The second process never answers its first get_state; only the long startup limit would end the wait.
    const { adapter, say, sessionId, spawner } = await stack(index => index === 0 ? {} : { silent: true }, 30_000);
    await say("first question");

    const forking = adapter.forkHistory(sessionId);
    await vi.waitFor(() => expect(spawner.processes.length).toBe(2), { timeout: 2000, interval: 5 });
    const helper = spawner.last();
    expect(adapter.hasPendingNativeWork()).toBe(true);
    expect(helper.exited).toBe(false);

    const started = Date.now();
    await adapter.destroy();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(helper.exited).toBe(true);
    // It was never asked to fork: nothing happened, and that is known.
    expect(await forking).toMatchObject({ outcome: "rejected", reason: "not_ready" });
    expect(helper.received.filter(command => command.type === "clone")).toEqual([]);
  });

  it("does not return from destroy while a second Pi that was cancelled at startup is still dying", async () => {
    const { adapter, say, sessionId, spawner } = await stack(index => index === 0 ? {} : { silent: true }, 30_000);
    await say("first question");
    const forking = adapter.forkHistory(sessionId);
    await vi.waitFor(() => expect(spawner.processes.length).toBe(2), { timeout: 2000, interval: 5 });
    const helper = spawner.last();
    // It ignores the closed pipe and the first signal, and takes a while to die once killed.
    helper.stubborn = true;
    const exit = helper.exit.bind(helper);
    helper.exit = (code, signal) => { setTimeout(() => exit(code, signal), 200); };

    const started = Date.now();
    await adapter.destroy();

    // Cancelled at once, not after the grace period an orderly close would give it.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(helper.exited).toBe(true);
    expect(adapter.hasPendingNativeWork()).toBe(false);
    expect((await forking).outcome).toBe("rejected");
  });

  it("ends the second Pi when the adapter is destroyed, and reports the fork as unknown", async () => {
    let heldClone = false;
    const { adapter, say, sessionId, spawner } = await stack(index => index === 0 ? {} : { onCommand: command => { if (command.type !== "clone") return false; heldClone = true; return true; } });
    await say("first question");

    const forking = adapter.forkHistory(sessionId);
    await vi.waitFor(() => expect(heldClone).toBe(true), { timeout: 2000, interval: 5 });
    expect(adapter.hasPendingNativeWork()).toBe(true);
    const helper = spawner.last();
    expect(helper.exited).toBe(false);

    await adapter.destroy();

    expect(helper.exited).toBe(true);
    expect(spawner.processes[0]!.exited).toBe(true);
    expect((await forking).outcome).toBe("unknown");
  });
});
