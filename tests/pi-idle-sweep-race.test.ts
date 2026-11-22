import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexUserMessageInput } from "../src/codex/adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { fakePiModel, fakePiSpawner } from "./helpers/pi-fake-rpc.js";

/**
 * The idle sweep asks Pi for its state before closing an expired worker. A
 * native control that begins while that question is out must keep the worker:
 * the sweep decides after the answer, so it looks again then.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function rig() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-sweep-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  // While `hold` is set, Pi answers get_state only when released: the sweep's question is out.
  const gate: { hold: boolean; release?: () => void } = { hold: false };
  const models = [fakePiModel("alpha", "one"), fakePiModel("alpha", "two")];
  const spawner = fakePiSpawner({ models, model: models[0], onCommand: (command, process) => {
    if (command.type !== "get_state" || !gate.hold) return false;
    gate.hold = false;
    gate.release = () => process.respond(command, { ...process.state, messageCount: process.messages.length, pendingMessageCount: 0 });
    return true;
  } });
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: null,
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }),
    idleSweepIntervalMs: 0, idleWorkerTtlMs: 40, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: null, inactivityTimeoutMs: null,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  await adapter.sendUserMessage(sessionId, { text: "hi", authoredText: "hi", files: [], locale: "en" } as unknown as CodexUserMessageInput);
  await sleep(60);
  const sweep = () => (adapter as unknown as { sweepIdleWorkers(): Promise<void> }).sweepIdleWorkers();
  const waitHeld = async () => { const deadline = Date.now() + 2_000; while (!gate.release && Date.now() < deadline) await sleep(2); expect(gate.release).toBeDefined(); };
  return { adapter, spawner, sessionId, gate, sweep, waitHeld };
}

describe("an idle sweep that meets a native control", () => {
  it("does not close the worker under a new session started while it asked Pi", async () => {
    const r = await rig();
    r.gate.hold = true;
    const swept = r.sweep();
    await r.waitHeld();
    const replaced = r.adapter.piNative.newSession(r.sessionId);
    await sleep(10);
    r.gate.release!();
    await swept;
    await expect(replaced).resolves.toMatchObject({ cancelled: false });
    expect(r.spawner.processes).toHaveLength(1);
    expect(r.spawner.last().exited).toBe(false);
  });

  it("does not close the worker under a model change made through a live session handle", async () => {
    const r = await rig();
    r.gate.hold = true;
    const swept = r.sweep();
    await r.waitHeld();
    const live = r.adapter.piNative.getLiveSession(r.sessionId)!;
    const changed = live.setModel({ provider: "alpha", modelId: "two" } as never, { isCurrent: async () => true });
    await sleep(10);
    r.gate.release!();
    await swept;
    await changed.catch(() => {});
    expect(r.spawner.last().exited).toBe(false);
  });
});
