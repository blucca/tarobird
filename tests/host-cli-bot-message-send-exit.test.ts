import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { hashSecret } from "../src/hub/auth.js";
import type { BotMessageSteeringHooks } from "../src/hub/bot-message-steering.js";

let root: string, hub: HubServer, control: (() => Promise<void>) | undefined;
const secret = "secret-".repeat(8);
let steered: unknown[], steerResult: unknown;
beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "bot-cli-send-exit-")); await initializeHost(root, "Local"); hub = await HubServer.start({ stateDir: root });
  for (const id of ["sender", "receiver"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id, id, hashSecret(secret)]);
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true }); client.close();
  await runBotMessagesCommand(root, "allow", { from: "Local/sender", bot: "receiver" });
  await writeFile(path.join(root, "task.txt"), "Process this file.");
  steered = []; steerResult = undefined;
});
afterEach(async () => { process.exitCode = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); await control?.(); control = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });
const options = () => ({ to: "Local/receiver", "source-bot": "sender", "text-file": path.join(root, "task.txt") });
async function liveTurn() {
  const task: any = await runBotMessagesCommand(root, "send", options());
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
  hub.botMessages.steering = {
    capable: () => true,
    status: async () => ({ supported: true, targetId: "run_live", sourceMessageId: task.messageId, receiptEpoch: "rs_fixture_store" }),
    steer: async (_bot, call) => { steered.push(call); return steerResult ?? { outcome: "accepted", sourceMessageId: task.messageId }; },
    reconcile: async () => ({ outcome: "unknown", reason: "uncertain" }),
    dispatch: () => undefined,
  } satisfies BotMessageSteeringHooks;
  return task;
}

it("exits 1 with a reason when a steer request ended neither merged nor queued, and 0 otherwise", async () => {
  await liveTurn();
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const steered: any = await runBotMessagesCommand(root, "send", { ...options(), delivery: "steer" });
  expect(steered.delivery.actual).toBe("steered"); expect(process.exitCode).toBeUndefined();
  // The receiving Gateway cannot tell whether the engine took it: final, never queued.
  steerResult = { outcome: "unknown", reason: "uncertain" };
  const uncertain: any = await runBotMessagesCommand(root, "send", { ...options(), delivery: "steer" });
  expect(uncertain.delivery.actual).toBe("steer_uncertain");
  expect(process.exitCode).toBe(1);
  expect(stderr.mock.calls.flat().join("\n")).toMatch(/steer_uncertain/);
  process.exitCode = undefined;
  // A queued fallback is a delivery: exit 0.
  await hub.botMessages.setSteering("owner", { botId: "receiver", allowed: false }, async () => undefined, async () => undefined, "test");
  const queued: any = await runBotMessagesCommand(root, "send", { ...options(), delivery: "steer" });
  expect(queued.delivery).toMatchObject({ actual: "fell_back_to_queue", reason: "steering_disabled" });
  expect(process.exitCode).toBeUndefined();
});
