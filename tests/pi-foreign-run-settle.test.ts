import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexUserMessageInput } from "../src/codex/adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { fakePiSpawner, type FakePiOptions } from "./helpers/pi-fake-rpc.js";

/**
 * A run an extension started on its own can still be going when the owner
 * sends a message. Pi 1.6.0 defers a prompt that arrives while it is emitting
 * agent_settled (agent-session.js prompt(): `_isEmittingAgentSettled`), so the
 * other run's agent_settled reaches the adapter before the prompt's answer,
 * and the prompt then starts a run of its own. That earlier settle is not the
 * end of the owner's turn.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {}); });

async function rig(pi: FakePiOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-foreign-")), stateDir = path.join(root, "state"), workspace = path.join(root, "ws");
  await mkdir(stateDir, { recursive: true }); await mkdir(workspace, { recursive: true });
  const configPath = path.join(stateDir, "config.json");
  await writeFile(configPath, JSON.stringify({ engine: "pi", approvalMode: "bypass" }));
  const spawner = fakePiSpawner(pi);
  const adapter = new PiRpcAdapter({
    launch: { command: "pi", args: [] }, workspacePath: workspace, stateDir, configPath, childEnv: {}, bridgeExtensionPath: null,
    spawnFn: spawner.spawn, killProcessTreeFn: () => {}, queryCatalogFn: async () => ({ models: [] }),
    idleSweepIntervalMs: 0, cancelGraceMs: 80, startupTimeoutMs: 500, turnTimeoutMs: 5_000, inactivityTimeoutMs: null,
  });
  cleanups.push(async () => { await adapter.destroy(); await rm(root, { recursive: true, force: true }); });
  const { sessionId } = await adapter.createSession(1);
  const send = (text: string) => adapter.sendUserMessage(sessionId, { text, authoredText: text, files: [], locale: "en" } as unknown as CodexUserMessageInput);
  return { adapter, spawner, sessionId, send };
}

describe("a run the turn did not start settles first", () => {
  it("waits for the run its own prompt started and returns that answer", async () => {
    const { spawner, send } = await rig({
      onPrompt: run => { setTimeout(() => { run.reply("the owner's answer"); run.finish(); }, 20); },
      onCommand: (command, process) => {
        if (command.type !== "prompt" || !process.state.isStreaming) return false;
        // The extension's run ends while the prompt waits; Pi then runs the prompt itself.
        process.state.isStreaming = false;
        process.send({ type: "agent_end", messages: [], willRetry: false });
        process.send({ type: "agent_settled", aborted: false });
        return false;
      },
    });
    // An extension's own run is going when the owner writes.
    await send("warm up");
    const process = spawner.last();
    process.state.isStreaming = true;
    process.send({ type: "agent_start" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const result = await send("question");
    expect(result.text).toBe("the owner's answer");
  });
});
