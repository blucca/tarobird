import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubServer } from "../src/hub/server.js";
import { ModelCatalogCache } from "../src/hub/model-catalog-cache.js";
import type { ModelCatalogRead } from "../src/runtime/model-catalog.js";

/** Creating a Pi Bot checks the chosen model against Pi's own list, with or without an effort. */
let root: string, hub: HubServer, manager: BotManager, status: ModelCatalogRead["status"], reads: number;
const spec = { requestId: "pi_model", name: "Pi", engine: "pi" as const, model: "", effort: "" as const, workspace: "" };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hub-pi-model-")); hub = await HubServer.start({ stateDir: root }); status = "ready"; reads = 0;
  manager = new BotManager(hub.store, root, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, PI_EXECUTABLE: process.execPath } }, () => hub.instanceUrl, async () => {});
  (manager as unknown as { catalogCache: ModelCatalogCache }).catalogCache = new ModelCatalogCache({}, async () => {
    reads++;
    return { choices: [{ id: "", efforts: [""] }, { id: "one/listed", efforts: ["", "off", "high"] }], status, answered: status !== "unavailable" };
  });
});
afterEach(async () => { await manager.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });

it("names a model Pi does not list as unavailable, with an effort or without one", async () => {
  await expect(manager.create("owner", { ...spec, requestId: "with_effort", model: "one/missing", effort: "high" })).rejects.toThrow("model_unavailable");
  await expect(manager.create("owner", { ...spec, requestId: "without_effort", model: "one/missing" })).rejects.toThrow("model_unavailable");
  // A listed model keeps the precise effort error.
  await expect(manager.create("owner", { ...spec, requestId: "bad_effort", model: "one/listed", effort: "max" })).rejects.toThrow("bot_effort_incompatible");
});

it("does not read Pi's list for a Bot that follows Pi's defaults, and cannot refuse a model it could not check", async () => {
  const bot = await manager.create("owner", { ...spec, requestId: "defaults" });
  expect(bot.id).toBeTruthy(); expect(reads).toBe(0);
  status = "unavailable";
  const unchecked = await manager.create("owner", { ...spec, requestId: "unchecked", model: "one/missing" });
  expect(unchecked.id).toBeTruthy();
});
