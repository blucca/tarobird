import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { KimiAcpAdapter, type KimiChildProcess } from "../src/codex/kimi-acp-adapter.js";
import type { CodexAdapter } from "../src/codex/adapter.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const transcript = (text: string) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kimi-history-"));
  vi.spyOn(os, "homedir").mockReturnValue(directory);
  const threads = new Map<string, unknown[]>([["source", [transcript("first")]]]);
  const requests: Array<{ method: string; params: any; process: number }> = [];
  const children: FakeChild[] = []; let fork = 0, holdLoad = false, omitFork = false, loseForkReply = false, failRestore = false, corruptFork = false, holdPrompt = false;
  const held: Array<() => void> = [];
  let holdKill = false; const requestedKills = new Set<number>();
  const preferences = new Map<string, string>([["model", "default-model"], ["mode", "default"]]);
  const allPreferences = new Map([["source", preferences]]);
  const prefsFor = (id: string) => { let prefs = allPreferences.get(id); if (!prefs) { prefs = new Map([["model", "default-model"], ["mode", "default"]]); allPreferences.set(id, prefs); } return prefs; };
  const configOptions = (sessionId = "source") => [...prefsFor(sessionId)].map(([id, currentValue]) => ({ id, name: id, category: id, type: "select", currentValue, options: [currentValue, id === "model" ? "chosen-model" : "auto"].map(value => ({ value, name: value })) }));
  const mcp = [{ name: "fixture", command: "fixture-mcp", args: [], env: [] }];
  class FakeChild extends EventEmitter {
    pid = children.length + 10000; stdout = new PassThrough(); stderr = new PassThrough(); dead = false;
    stdin = new Writable({ write: (chunk, _encoding, callback) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const input = JSON.parse(line); if (!input.method) continue;
        requests.push({ method: input.method, params: input.params, process: this.pid });
        const reply = (result: unknown) => queueMicrotask(() => { if (!this.dead) this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }) + "\n"); });
        const fail = () => queueMicrotask(() => this.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: input.id, error: { code: -32602, message: "Unknown sessionId" } }) + "\n"));
        const id = input.params?.sessionId;
        if (input.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {}, ...(omitFork ? {} : { fork: {} }) } }, authMethods: [] });
        else if (input.method === "session/list") reply({ sessions: [...threads.keys()].map(sessionId => ({ sessionId, cwd: directory, updatedAt: "2026-01-01T00:00:00Z" })), nextCursor: null });
        else if (input.method === "session/load") {
          const complete = () => { if (!threads.has(id)) { fail(); return; } for (const update of threads.get(id)!) this.update(id, update); prefsFor(id).set("model", "default-model"); prefsFor(id).set("mode", "default"); reply({ configOptions: configOptions(id) }); };
          if (holdLoad) held.push(complete); else complete();
        } else if (input.method === "session/fork") {
          if (!threads.has(id)) { fail(); continue; }
          const sessionId = `fork-${++fork}`; threads.set(sessionId, corruptFork ? [transcript("different")] : [...threads.get(id)!]);
          if (!loseForkReply) reply({ sessionId, configOptions: [] });
        } else if (input.method === "session/set_config_option") { if (failRestore) fail(); else { prefsFor(id).set(input.params.configId, input.params.value); reply({ configOptions: configOptions(id) }); } }
        else if (input.method === "session/close") reply({});
        else if (input.method === "session/prompt") {
          threads.get(id)!.push(transcript("later")); const complete = () => { this.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }); reply({ stopReason: "end_turn" }); }; if (holdPrompt) held.push(complete); else complete();
        } else reply({});
      }
      callback();
    } });
    update(sessionId: string, update: unknown) { queueMicrotask(() => { if (!this.dead) this.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }) + "\n"); }); }
    close() { if (this.dead) return; this.dead = true; this.stdout.end(); this.stderr.end(); this.emit("close", 0); }
  }
  const sync = vi.fn(async (_workspace: string, text: string | null) => text ?? "");
  const adapter = new KimiAcpAdapter("fixture", { workspacePath: directory, childEnv: { HOME: directory }, hookRelayEnabled: false, initializeTimeoutMs: 100,
    mcpServers: mcp, idleWorkerTtlMs: 0, syncWorkspaceInstructionsFn: sync, spawnFn: () => { const child = new FakeChild(); children.push(child); return child as unknown as KimiChildProcess; },
    killProcessTreeFn: pid => { if (pid !== undefined) requestedKills.add(pid); if (!holdKill) children.find(child => child.pid === pid)?.close(); } });
  cleanup.push(async () => { holdKill = false; children.filter(child => requestedKills.has(child.pid)).forEach(child => child.close()); await adapter.destroy(); await rm(directory, { recursive: true, force: true }); });
  const history = adapter as CodexAdapter;
  return { adapter, history, directory, threads, requests, children, requestedKills, holdKill: () => { holdKill = true; }, releaseKills: () => { holdKill = false; children.filter(child => requestedKills.has(child.pid)).forEach(child => child.close()); }, sync, preferences, mcp, configOptions, failRestore: () => { failRestore = true; }, corruptFork: () => { corruptFork = true; }, holdPrompt: () => { holdPrompt = true; }, hold: () => { holdLoad = true; }, release: () => { holdLoad = false; holdPrompt = false; held.splice(0).forEach(fn => fn()); }, omitFork: () => { omitFork = true; }, loseForkReply: () => { loseForkReply = true; } };
}

it("hashes native replay rather than unchanged timestamps and forks persistent whole history", async () => {
  const f = await fixture(), first = await f.history.getHistoryState!("source");
  expect(first).toMatchObject({ fork: { whole: true, anchored: false } });
  f.threads.get("source")!.push(transcript("second"));
  const next = await f.history.getHistoryState!("source"); expect(next!.head).not.toBe(first!.head);
  expect(await f.history.forkHistory!("source", { expectedHead: first!.head })).toMatchObject({ outcome: "rejected", reason: "source_changed" });
  expect(await f.history.forkHistory!("source", { expectedHead: next!.head })).toMatchObject({ outcome: "applied", sessionId: "fork-1", boundary: "whole", head: next!.head });
  expect(f.requests.filter(request => request.method === "session/fork")).toHaveLength(1);
  expect(f.requests.filter(request => request.method === "session/close").map(request => request.params.sessionId)).toContain("fork-1");
  expect(f.requests.some(request => ["session/new", "session/delete", "session/prompt"].includes(request.method))).toBe(false);
  expect(f.children.every(child => child.dead)).toBe(true); expect(f.sync).not.toHaveBeenCalled();
});
it("uses the live idle worker without killing, rebinding or leaking replay into App events", async () => {
  const f = await fixture(), events = vi.fn();
  await f.adapter.sendUserMessage("source", { text: "hello", files: [], onEngineEvent: events });
  const count = events.mock.calls.length, workers = f.children.length;
  const snapshot = await f.history.getHistoryState!("source");
  expect(await f.history.forkHistory!("source", { expectedHead: snapshot!.head })).toMatchObject({ outcome: "applied" });
  expect(events).toHaveBeenCalledTimes(count); expect(f.children).toHaveLength(workers); expect(f.children[0]!.dead).toBe(false);
  expect(f.requests.filter(request => request.method === "session/close").every(request => request.params.sessionId !== "source")).toBe(true);
  await f.adapter.sendUserMessage("source", { text: "still source", files: [], onEngineEvent: events });
});
it("never creates a missing source, omits absent native capability, and rejects point forks", async () => {
  const f = await fixture();
  expect(await f.history.forkHistory!("missing")).toMatchObject({ outcome: "rejected", reason: "source_missing" });
  expect(await f.history.forkHistory!("source", { workspaceOverride: path.join(f.directory, "foreign") })).toMatchObject({ outcome: "rejected", reason: "source_changed" });
  expect(await f.history.forkHistory!("source", { anchor: { sessionId: "source", inputId: "point", fork: true, rewind: false, forkBoundary: "after-turn" } })).toMatchObject({ outcome: "rejected", reason: "unsupported" });
  f.omitFork(); expect((await f.history.getHistoryState!("source"))?.fork?.whole).not.toBe(true);
  expect(f.requests.some(request => ["session/new", "session/fork", "session/delete"].includes(request.method))).toBe(false);
});
it("keeps a lost fork response unknown and tracks helper shutdown without repeating or deleting it", async () => {
  const f = await fixture(); f.loseForkReply();
  expect(await f.history.forkHistory!("source")).toMatchObject({ outcome: "unknown" });
  expect(f.requests.filter(request => request.method === "session/fork")).toHaveLength(1);
  expect(f.requests.some(request => request.method === "session/delete")).toBe(false);
  expect(f.children.every(child => child.dead)).toBe(true);
});
it("holds live replay reservation past timeout and queues a direct turn until replay settles", async () => {
  const f = await fixture(); await f.adapter.sendUserMessage("source", { text: "hello", files: [] }); f.hold();
  expect(await f.history.getHistoryState!("source")).toMatchObject({ head: null, blocked: "not_ready" });
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  let sent = false; const turn = f.adapter.sendUserMessage("source", { text: "racing", files: [] }).then(result => { sent = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 10)); expect(sent).toBe(false);
  expect(f.requests.filter(request => request.method === "session/prompt")).toHaveLength(1);
  f.release(); await turn;
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
  expect(f.requests.filter(request => request.method === "session/prompt")).toHaveLength(2);
});

it("restores exact live configuration and MCP after native load resets model and mode", async () => {
  const f = await fixture();
  const input = { text: "hello", files: [], engineOverride: { model: "chosen-model", approvalMode: "full-auto" as const } };
  await f.adapter.sendUserMessage("source", input);
  f.preferences.set("mode", "auto"); f.children[0]!.update("source", { sessionUpdate: "config_option_update", configOptions: f.configOptions() });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(Object.fromEntries(f.preferences)).toEqual({ model: "chosen-model", mode: "auto" });
  const before = f.requests.length;
  const snapshot = await f.history.getHistoryState!("source");
  expect(Object.fromEntries(f.preferences)).toEqual({ model: "chosen-model", mode: "auto" });
  expect(await f.history.forkHistory!("source", { expectedHead: snapshot!.head })).toMatchObject({ outcome: "applied" });
  expect(Object.fromEntries(f.preferences)).toEqual({ model: "chosen-model", mode: "auto" });
  // Fork replay has its own settings; only source loads must preserve its MCP.
  const sourceLoads = f.requests.slice(before).filter(r => r.method === "session/load" && r.params.sessionId === "source");
  expect(sourceLoads.length).toBeGreaterThan(0); for (const load of sourceLoads) expect(load.params.mcpServers).toEqual(f.mcp);
});
it("accepts a physical workspace alias and stops a live control helper before destroy returns", async () => {
  const f = await fixture(), alias = `${f.directory}-alias`; await symlink(f.directory, alias); cleanup.push(() => rm(alias));
  expect(await f.history.getHistoryState!("source", { workspaceOverride: alias })).toMatchObject({ fork: { whole: true } });
  f.hold(); const state = f.history.getHistoryState!("source");
  await vi.waitFor(() => expect(f.adapter.hasPendingNativeWork()).toBe(true));
  await f.adapter.destroy(); expect(f.children.every(child => child.dead)).toBe(true);
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
  expect(await state).toMatchObject({ head: null });
  f.release(); expect(f.requests.some(r => r.method === "session/fork")).toBe(false);
});

it("never admits a fork while a turn or confirmed background work is active", async () => {
  const f = await fixture(); f.holdPrompt(); const turn = f.adapter.sendUserMessage("source", { text: "held", files: [] });
  await vi.waitFor(() => expect(f.requests.some(r => r.method === "session/prompt")).toBe(true));
  expect(await f.history.getHistoryState!("source")).toMatchObject({ head: null, blocked: "busy" });
  expect(await f.history.forkHistory!("source")).toEqual({ outcome: "rejected", reason: "busy" });
  f.release(); await turn;
  const worker = [...(f.adapter as any).workers.values()][0];
  worker.backgroundContinuations.set("fixture", {});
  expect(await f.history.getHistoryState!("source")).toMatchObject({ blocked: "background_work" });
  worker.backgroundContinuations.clear();
  expect(f.requests.some(r => r.method === "session/fork")).toBe(false);
});
it("fails closed after source preference restoration fails, before any fork or next prompt", async () => {
  const f = await fixture(); await f.adapter.sendUserMessage("source", { text: "hello", files: [], engineOverride: { model: "chosen-model" } });
  f.failRestore(); expect(await f.history.forkHistory!("source")).toMatchObject({ outcome: "rejected" });
  const prompts = f.requests.filter(r => r.method === "session/prompt").length;
  await expect(f.adapter.sendUserMessage("source", { text: "unsafe changed config", files: [] })).rejects.toThrow(/not_ready/);
  expect(f.requests.filter(r => r.method === "session/prompt")).toHaveLength(prompts);
  expect(f.requests.some(r => r.method === "session/fork")).toBe(false);
});
it("retains a distinct but unverifiable native fork as unknown without deleting it", async () => {
  const f = await fixture(); f.corruptFork();
  expect(await f.history.forkHistory!("source")).toEqual({ outcome: "unknown", candidateSessionId: "fork-1" });
  expect(f.threads.has("fork-1")).toBe(true);
  expect(f.requests.some(r => r.method === "session/delete")).toBe(false);
  expect(f.requests.filter(r => r.method === "session/close").map(r => r.params.sessionId)).toEqual(["fork-1"]);
});


it("keeps a successful helper read pending until the child has actually closed", async () => {
  const f = await fixture(); f.holdKill(); let settled = false;
  const state = f.history.getHistoryState!("source").finally(() => { settled = true; });
  await vi.waitFor(() => expect(f.requestedKills.size).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(settled).toBe(false); expect(f.children[0]!.dead).toBe(false);
  expect(f.adapter.hasPendingNativeWork()).toBe(true);
  f.releaseKills(); expect(await state).toMatchObject({ fork: { whole: true } });
  expect(f.adapter.hasPendingNativeWork()).toBe(false);
});
it("does not finish destroy while an interrupted history helper is still exiting", async () => {
  const f = await fixture(); f.hold(); f.holdKill();
  const state = f.history.getHistoryState!("source");
  await vi.waitFor(() => expect(f.requests.some(request => request.method === "session/load")).toBe(true));
  let destroyed = false; const destruction = f.adapter.destroy().then(() => { destroyed = true; });
  await vi.waitFor(() => expect(f.requestedKills.size).toBe(1));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(destroyed).toBe(false); expect(f.children[0]!.dead).toBe(false);
  f.releaseKills(); await destruction;
  expect(await state).toMatchObject({ head: null }); expect(f.adapter.hasPendingNativeWork()).toBe(false);
  f.release(); expect(f.requests.some(request => request.method === "session/fork")).toBe(false);
});

it("keeps an acknowledged fork unknown when shutdown interrupts helper cleanup", async () => {
  const f = await fixture(); f.holdKill(); let settled = false;
  const fork = f.history.forkHistory!("source").finally(() => { settled = true; });
  await vi.waitFor(() => expect(f.requestedKills.size).toBe(1));
  expect(f.threads.has("fork-1")).toBe(true); expect(settled).toBe(false);
  const destruction = f.adapter.destroy(); f.releaseKills(); await destruction;
  expect(await fork).toEqual({ outcome: "unknown", candidateSessionId: "fork-1" });
  expect(f.requests.filter(request => request.method === "session/fork")).toHaveLength(1);
  expect(f.requests.some(request => request.method === "session/delete")).toBe(false);
});

it("cancels only the queued turn while keeping late replay captured", async () => {
  const f = await fixture(); await f.adapter.sendUserMessage("source", { text: "warm", files: [] }); f.hold();
  await f.history.getHistoryState!("source"); const controller = new AbortController();
  const turn = f.adapter.sendUserMessage("source", { text: "cancelled", files: [], abortSignal: controller.signal });
  const rejected = expect(turn).rejects.toThrow("user cancelled"); controller.abort(new Error("user cancelled")); await rejected;
  expect(f.adapter.hasPendingNativeWork()).toBe(true); f.release(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.requests.filter(request => request.method === "session/prompt")).toHaveLength(1);
});
it("stops queued read waiters on adapter destruction without sending or replaying input", async () => {
  const f = await fixture(); await f.adapter.sendUserMessage("source", { text: "warm", files: [] }); f.hold();
  await f.history.getHistoryState!("source");
  const turn = f.adapter.sendUserMessage("source", { text: "never send", files: [] });
  const rejected = expect(turn).rejects.toThrow("Adapter destroyed"); await f.adapter.destroy(); await rejected;
  f.release(); expect(f.requests.filter(request => request.method === "session/prompt")).toHaveLength(1);
});
it("does not queue sends behind a timed-out fork or release its uncertain mutation", async () => {
  const f = await fixture(); await f.adapter.sendUserMessage("source", { text: "warm", files: [] }); f.loseForkReply();
  expect(await f.history.forkHistory!("source")).toMatchObject({ outcome: "unknown" });
  await expect(f.adapter.sendUserMessage("source", { text: "never replay", files: [] })).rejects.toThrow(/busy/i);
  expect(f.requests.filter(request => request.method === "session/prompt")).toHaveLength(1);
  expect(f.requests.filter(request => request.method === "session/fork")).toHaveLength(1);
});
