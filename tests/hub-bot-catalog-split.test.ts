import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BotCatalog } from "../src/client-protocol/bots.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HostManagement } from "../src/host-cli/management.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";

// The New Bot form reads which engines exist separately from each engine's
// models. A slow engine (here a fixture `agy models` that answers late) must
// not hold the engine list, another engine, or Bot creation that needs no list.
const hosts: { directory: string; hub: HubServer; closeControl: () => Promise<void>; trace: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { directory, hub, closeControl } of hosts.splice(0)) { await closeControl(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
async function host(agyDelayMs: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taro-catalog-")), trace = path.join(directory, "agy-trace");
  const hub = await HubServer.start({ stateDir: directory, managedBots: {
    entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"),
    env: { ...process.env, CODEX_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: path.resolve("tests/fixtures/agy-models-slow.mjs"), AGY_FIXTURE_DELAY_MS: String(agyDelayMs), AGY_FIXTURE_TRACE: trace },
    catalogDeadlinesMs: { passive: 300, refresh: 600 },
  } });
  const closeControl = await startHubControl(directory, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const result = { directory, hub, closeControl, trace }; hosts.push(result);
  const local = await LocalHostClient.connect(directory, { enroll: true });
  return { ...result, local, management: new HostManagement(local), runs: async () => (await readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).length };
}
const timed = async <T>(work: Promise<T>) => { const started = performance.now(); const value = await work; return { value, ms: performance.now() - started }; };
const engine = (local: LocalHostClient, id: string, extra = "") => local.request<BotCatalog>(`/api/bots/catalog?includePi=1&engine=${id}${extra}`);

it("offers installed engines at once and answers each engine's models on its own", async () => {
  const root = await host(1500);
  try {
    // Availability only checks files: no CLI starts, whatever the engines take.
    const { value: availability, ms } = await timed(root.management.engineAvailability());
    expect(ms).toBeLessThan(1000);
    expect(availability.modelsDeferred).toBe(true);
    expect(availability.engines.map(item => item.id).sort()).toEqual(["antigravity", "claude", "codex", "deepseek", "kimi", "pi"]);
    expect(availability.engines.find(item => item.id === "antigravity")).toMatchObject({ available: true, models: [] });
    expect(availability.engines.find(item => item.id === "codex")).toMatchObject({ available: true, models: [], defaultModel: "gpt-6-astra", permissions: { defaultChoice: "bypass" } });
    expect(await root.runs()).toBe(0);
    // The slow engine answers at its deadline with its fallback; Codex is not held by it.
    const [agy, codex] = await Promise.all([timed(engine(root.local, "antigravity")), timed(engine(root.local, "codex"))]);
    expect(agy.ms).toBeLessThan(1400);
    expect(agy.value).toMatchObject({ modelsDeferred: true, engines: [{ id: "antigravity", available: true, modelsTimedOut: true, models: [{ id: "", efforts: [""] }] }] });
    expect(codex.ms).toBeLessThan(1000);
    expect(codex.value.engines).toHaveLength(1);
    expect(codex.value.engines[0]).toMatchObject({ id: "codex", available: true });
    expect(codex.value.engines[0]!.models.length).toBeGreaterThan(1);
    // The read went on and filled the cache; the next request has the real list without another run.
    await vi.waitFor(async () => {
      const entry = (await engine(root.local, "antigravity")).engines[0]!;
      expect(entry.modelsTimedOut).toBeUndefined();
      expect(entry).toMatchObject({ defaultModel: "gemini-4-argon-medium", models: [{ id: "" }, { id: "gemini-4-argon-medium" }, { id: "gemini-3.8-flash-high" }] });
    }, { timeout: 5000, interval: 100 });
    expect(await root.runs()).toBe(1);
  } finally { root.local.close(); }
});

it("rereads an engine only on request, and keeps the complete catalog for older readers", async () => {
  const root = await host(0);
  try {
    await engine(root.local, "antigravity"); await engine(root.local, "antigravity");
    expect(await root.runs()).toBe(1);
    const reread = (await engine(root.local, "antigravity", "&refresh=1")).engines[0]!;
    expect(await root.runs()).toBe(2);
    expect(reread.readAt).toEqual(expect.any(Number));
    // An older App or the CLI: same request, same complete answer, no new fields.
    const legacy = await root.local.request<BotCatalog>("/api/bots/catalog");
    expect(legacy.modelsDeferred).toBeUndefined();
    expect(legacy.engines.map(item => item.id).sort()).toEqual(["antigravity", "claude", "codex", "deepseek", "kimi"]);
    for (const item of legacy.engines) expect(Object.keys(item).filter(key => ["readAt", "stale", "modelsTimedOut"].includes(key))).toEqual([]);
    const full = await root.management.catalog(), agy = full.engines.find(item => item.id === "antigravity")!;
    expect(agy).toMatchObject({ defaultModel: "gemini-4-argon-medium", models: [{ id: "" }, { id: "gemini-4-argon-medium" }, { id: "gemini-3.8-flash-high" }] });
    expect(full.engines.map(item => item.id).sort()).toEqual(["antigravity", "claude", "codex", "deepseek", "kimi", "pi"]);
    // Pi stays opt-in, and an unknown engine is refused.
    expect((await root.local.request<BotCatalog>("/api/bots/catalog?engine=pi")).engines).toEqual([]);
    await expect(root.local.request("/api/bots/catalog?includePi=1&engine=gemini")).rejects.toMatchObject({ status: 400 });
  } finally { root.local.close(); }
});

it("creates a Bot without reading any model list unless a check needs one", async () => {
  const root = await host(0);
  try {
    const read = vi.spyOn(BotManager.prototype, "engineCatalog");
    await root.management.createBot({ requestId: "codex_once", name: "Codex", engine: "codex", model: "gpt-6-astra", effort: "high", workspace: "" });
    await root.management.createBot({ requestId: "agy_default", name: "Default", engine: "antigravity", model: "", effort: "", workspace: "" });
    expect(read).not.toHaveBeenCalled(); expect(await root.runs()).toBe(0);
    // An Antigravity effort is validated against that engine's list, and only that one.
    await expect(root.management.createBot({ requestId: "agy_low", name: "Low", engine: "antigravity", model: "gemini-3.8-flash-high", effort: "low", workspace: "" })).rejects.toMatchObject({ code: "bot_effort_incompatible" });
    expect(read.mock.calls.map(call => call[0])).toEqual(["antigravity"]);
  } finally { root.local.close(); }
});
