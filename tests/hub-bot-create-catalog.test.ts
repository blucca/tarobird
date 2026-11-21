import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalHostClient } from "../src/host-cli/client.js";
import { HostManagement } from "../src/host-cli/management.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";

// Bot creation reads a model list only when a check needs it, and then only
// the chosen engine's (here a fixture `agy models` that records each run).
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
  } });
  const closeControl = await startHubControl(directory, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const result = { directory, hub, closeControl, trace }; hosts.push(result);
  const local = await LocalHostClient.connect(directory, { enroll: true });
  return { ...result, local, management: new HostManagement(local), runs: async () => (await readFile(trace, "utf8").catch(() => "")).split("\n").filter(Boolean).length };
}

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
