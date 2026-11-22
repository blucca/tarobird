import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import type { CodexUserMessageInput } from "../src/codex/adapter.js";
import type { PiBridgeConnection, PiBridgeEndpoint, PiBridgeHandler } from "../src/codex/pi-bridge-host.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { fakePiSpawner } from "./helpers/pi-fake-rpc.js";

/**
 * A prompt template or `/skill:` is sent bare so Pi dispatches it, so the
 * Host's private guidance for the turn cannot ride in front of it. It still
 * reaches the model, through the bridge's per-run system prompt.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

it("gives a prompt template's run the turn's private instructions without changing the line Pi dispatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-command-turn-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  let handler!: PiBridgeHandler, seen: string | undefined;
  const spawner = fakePiSpawner({
    commands: [{ name: "review", source: "prompt" }],
    onCommand: (command, process) => {
      if (command.type === "prompt" && String(command.message).startsWith("/tarobird-bridge ")) { process.respond(command, { disposition: "handled" }); return true; }
      return false;
    },
    onPrompt: async run => { seen = await handler.instructions(); run.reply("reviewed"); run.finish(); },
  });
  const never = new Promise<never>(() => {});
  const connection = {
    setGate: async () => {}, installTools: async () => ({ installed: [], skipped: [] }), setLabel: async () => {}, readSettings: async () => ({}),
    setMcpServers: async () => [], control: async () => ({}), closed: never, isOpen: true, close: () => {},
  } as unknown as PiBridgeConnection;
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: "/synthetic/dist/pi-bridge-extension.js",
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }),
    openBridgeFn: async (input): Promise<PiBridgeEndpoint> => { handler = input.handler; return { env: {}, connection: Promise.resolve(connection), dispose: () => {} }; },
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  const result = await adapter.sendUserMessage(sessionId, { text: "/review", authoredText: "/review", files: [], locale: "en", instructions: "stable rule", turnInstructions: "turn rule" } as unknown as CodexUserMessageInput);
  expect(result.text).toBe("reviewed");
  const prompts = spawner.last().received.filter(command => command.type === "prompt" && !String(command.message).startsWith("/tarobird-bridge "));
  expect(prompts.map(command => command.message)).toEqual(["/review"]);
  expect(seen).toContain("stable rule");
  expect(seen).toContain("turn rule");
});
