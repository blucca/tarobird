import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexUserMessageInput } from "../src/codex/adapter.js";
import type { PiBridgeConnection, PiBridgeEndpoint } from "../src/codex/pi-bridge-host.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { MANAGED_SEARCH_MCP_NAME, type NativeSearchMcpPlan } from "../src/runtime/native-search-mcp.js";
import { fakePiSpawner } from "./helpers/pi-fake-rpc.js";

/**
 * After Pi's handshake a start can still wait on Pi: for the bridge
 * extension to connect (20 s), for get_state (30 s), for the search server
 * registration (300 s). A stop and a destroy end those waits.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });
const plan: NativeSearchMcpPlan = { name: MANAGED_SEARCH_MCP_NAME, command: "/synthetic/node", args: ["/synthetic/search-mcp.js"], envKeys: [], processEnv: {} };
const within = <T>(work: Promise<T>, ms = 1_000) => Promise.race([work.then(value => ({ value }), error => ({ error: error as Error })), new Promise<"still waiting">(resolve => setTimeout(() => resolve("still waiting"), ms))]);

async function rig(hold: { registration?: boolean; connection?: boolean }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-start-cancel-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  const spawner = fakePiSpawner({ onCommand: (command, process) => {
    if (command.type === "prompt" && String(command.message).startsWith("/tarobird-bridge ")) { process.respond(command, { disposition: "handled" }); return true; }
    return false;
  } });
  let registering = false;
  const never = new Promise<never>(() => {});
  const connection = {
    setGate: async () => {}, installTools: async () => ({ installed: [], skipped: [] }), setLabel: async () => {}, readSettings: async () => ({}),
    setMcpServers: async (servers: Array<{ name: string }>) => { registering = true; if (hold.registration) await never; return servers.map(server => server.name); },
    control: async () => ({}), closed: never, isOpen: true, close: () => {},
  } as unknown as PiBridgeConnection;
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: "/synthetic/dist/pi-bridge-extension.js",
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }), nativeSearchMcp: () => plan,
    openBridgeFn: async (): Promise<PiBridgeEndpoint> => ({ env: {}, connection: hold.connection ? never : Promise.resolve(connection), dispose: () => {} }),
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  const send = (signal?: AbortSignal) => adapter.sendUserMessage(sessionId, { text: "hi", authoredText: "hi", files: [], locale: "en", ...(signal ? { abortSignal: signal } : {}) } as unknown as CodexUserMessageInput);
  const waitFor = async (check: () => boolean) => { const deadline = Date.now() + 2_000; while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); expect(check()).toBe(true); };
  return { adapter, spawner, send, waitFor, registering: () => registering };
}

describe("a Pi start that waits on Pi after its handshake", () => {
  it("lets a stop end the wait for the search server registration", async () => {
    const r = await rig({ registration: true });
    const controller = new AbortController();
    const turn = r.send(controller.signal);
    await r.waitFor(r.registering);
    controller.abort();
    expect(await within(turn)).toMatchObject({ error: { name: "AbortError" } });
  });

  it("lets destroy end the wait for the search server registration and for the bridge to connect", async () => {
    for (const hold of [{ registration: true }, { connection: true }]) {
      const r = await rig(hold);
      const turn = r.send();
      await r.waitFor(() => r.spawner.processes.length === 1 && (hold.connection ? true : r.registering()));
      expect(await within(r.adapter.destroy())).toEqual({ value: undefined });
      expect(await within(turn)).toMatchObject({ error: { message: expect.stringMatching(/destroyed/) } });
    }
  });
});
