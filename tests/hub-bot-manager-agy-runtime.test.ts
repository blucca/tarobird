import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityVersionSupportsAcp } from "../src/codex/antigravity-acp-support.js";
import { BotManager } from "../src/hub/bot-manager.js";
import { HubServer } from "../src/hub/server.js";
import { updateInstanceConfig } from "../src/state/instance-config.js";

describe("the runtime a new Antigravity Bot gets", () => {
  let root: string, hub: HubServer, manager: BotManager;
  const spec = { name: "研究助手", engine: "antigravity" as const, model: "", effort: "" as const, workspace: "" };
  /** A stand-in for `agy`: answers `--version` and `models`, starts nothing. `version` undefined: no answer. */
  async function agy(version: string | undefined) {
    const file = path.join(root, `agy-${version ?? "silent"}.mjs`);
    await writeFile(file, `#!/usr/bin/env node
if (process.argv[2] === "--version") { ${version === undefined ? "process.exit(2);" : `process.stdout.write(${JSON.stringify(version + "\n")}); process.exit(0);`} }
if (process.argv[2] !== "models") process.exit(2);
process.stdout.write("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n");
`);
    await chmod(file, 0o755);
    return file;
  }
  const start = async (executable: string) => {
    manager = new BotManager(hub.store, root, { entrypoint: path.resolve("tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CLAUDE_EXECUTABLE: process.execPath, ANTIGRAVITY_EXECUTABLE: executable } }, () => hub.instanceUrl, async () => {});
  };
  const saved = async (botId: string) => JSON.parse(await readFile(path.join(root, "bots", botId, "config.json"), "utf8")) as Record<string, unknown>;
  const normalChoice = async () => (await manager.catalog()).engines.find(engine => engine.id === "antigravity")?.permissions?.choices.find(choice => choice.id === "normal")?.label;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "hub-bots-agy-")); hub = await HubServer.start({ stateDir: root }); });
  afterEach(async () => { await manager?.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });

  it("reads the version the way agy prints it", () => {
    expect(["1.5.10", "1.5.14\n", "v1.6.0", "agy 2.0.1"].map(antigravityVersionSupportsAcp)).toEqual([true, true, true, true]);
    expect(["1.5.9", "1.4.30", "0.9.99", "", "unknown"].map(antigravityVersionSupportsAcp)).toEqual([false, false, false, false, false]);
  });

  it("is ACP when the installed agy is new enough, and the creation dialog describes that runtime", async () => {
    await start(await agy("1.5.14"));
    expect(await normalChoice()).toBe("普通审批 · 逐项确认");
    const bot = await manager.create("owner", { ...spec, requestId: "new_enough" });
    expect(await saved(bot.id)).toMatchObject({ engine: "antigravity", antigravityRuntime: "acp" });
  });

  it.each([["an older agy", "1.5.9"], ["an agy that does not answer", undefined]])("stays the print runtime with %s", async (_label, version) => {
    await start(await agy(version));
    expect(await normalChoice()).toBe("每轮批准 · 终端沙箱");
    const bot = await manager.create("owner", { ...spec, requestId: "older" });
    expect(await saved(bot.id)).not.toHaveProperty("antigravityRuntime");
  });

  it("leaves a saved Bot on the runtime it has when the Host starts again", async () => {
    await start(await agy("1.5.9"));
    const print = await manager.create("owner", { ...spec, requestId: "saved_print" });
    await manager.close();
    await start(await agy("1.5.14")); await manager.restore();
    expect(await saved(print.id)).not.toHaveProperty("antigravityRuntime");
    const acp = await manager.create("owner", { ...spec, requestId: "saved_acp" });
    await updateInstanceConfig(path.join(root, "bots", acp.id), config => { config.model = "gemini-3.8-flash-high"; });
    await manager.close();
    await start(await agy("1.5.9")); await manager.restore();
    expect(await saved(acp.id)).toMatchObject({ antigravityRuntime: "acp", model: "gemini-3.8-flash-high" });
  });

  it("keeps a dispatcher and the workers it starts on the print runtime", async () => {
    await start(await agy("1.5.14"));
    const dispatcher = await manager.create("owner", { ...spec, requestId: "dispatcher", role: "dispatcher" });
    expect(await saved(dispatcher.id)).not.toHaveProperty("antigravityRuntime");
    const worker = await manager.dispatchWorker(dispatcher.id, "antigravity");
    expect(await saved(worker)).toMatchObject({ engine: "antigravity" });
    expect(await saved(worker)).not.toHaveProperty("antigravityRuntime");
  });
});
