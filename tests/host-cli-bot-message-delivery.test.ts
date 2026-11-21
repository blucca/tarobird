import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { HOST_CLI_HELP, runHostCli } from "../src/host-cli/cli.js";
import { hashSecret } from "../src/hub/auth.js";
import type { BotMessageSteeringHooks } from "../src/hub/bot-message-steering.js";

let root: string, hub: HubServer, control: (() => Promise<void>) | undefined;
const secret = "secret-".repeat(8);
let steered: unknown[];
beforeEach(async () => {
  for (const key of ["TAROBOT_ACTIVE_INSTANCE", "TAROBOT_INSTANCE", "TAROBOT_ACTIVE_STATE_DIR", "TAROBOT_STATE_DIR", "TAROBOT_MESSAGE_ID"]) vi.stubEnv(key, undefined);
  root = await mkdtemp(path.join(os.tmpdir(), "bot-cli-delivery-")); await initializeHost(root, "Local"); hub = await HubServer.start({ stateDir: root });
  for (const id of ["sender", "receiver"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id, id, hashSecret(secret)]);
  control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true }); client.close();
  await runBotMessagesCommand(root, "allow", { from: "Local/sender", bot: "receiver" });
  await writeFile(path.join(root, "task.txt"), "Process this file.");
  steered = [];
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await control?.(); control = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });
const options = () => ({ to: "Local/receiver", "source-bot": "sender", "text-file": path.join(root, "task.txt") });
async function liveTurn() {
  const task: any = await runBotMessagesCommand(root, "send", options());
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
  hub.botMessages.steering = {
    capable: () => true,
    status: async () => ({ supported: true, targetId: "run_live", sourceMessageId: task.messageId }),
    steer: async (_bot, call) => { steered.push(call); return { outcome: "accepted", sourceMessageId: task.messageId }; },
    reconcile: async () => ({ outcome: "unknown", reason: "uncertain" }),
  } satisfies BotMessageSteeringHooks;
  return task;
}

it("sends --delivery steer, keeps the default and --delivery queue on the legacy wire, and rejects other values", async () => {
  const task = await liveTurn();
  const plain: any = await runBotMessagesCommand(root, "send", options());
  expect(plain).not.toHaveProperty("delivery"); expect(plain.status).toBe("queued");
  const queued: any = await runBotMessagesCommand(root, "send", { ...options(), delivery: "queue" });
  expect(queued).toMatchObject({ status: "queued", delivery: { requested: "queue", actual: "queued" } });
  expect(steered).toEqual([]);
  const steer: any = await runBotMessagesCommand(root, "send", { ...options(), delivery: "steer" });
  expect(steer).toMatchObject({ status: "steered", delivery: { requested: "steer", actual: "steered", turn: { messageId: task.messageId } } });
  expect(steered).toHaveLength(1);
  const to = `${steer.hostId}/${steer.botId}/${steer.conversationId}`;
  expect(await runBotMessagesCommand(root, "wait", { to, message: steer.messageId, "source-bot": "sender", timeout: "0" })).toMatchObject({ status: "timeout", delivery: { actual: "steered" }, reply: { kind: "merged_turn" } });
  await expect(runBotMessagesCommand(root, "send", { ...options(), delivery: "interrupt" })).rejects.toThrow("delivery_must_be_queue_or_steer");
  await expect(runBotMessagesCommand(root, "wait", { to, message: steer.messageId, "source-bot": "sender", delivery: "steer" })).rejects.toThrow("unsupported_option_delivery");
});

it("reads and changes the receiving owner's switch, and refuses it inside a Bot", async () => {
  expect(await runBotMessagesCommand(root, "steering", { bot: "receiver" })).toEqual({ botId: "receiver", allowed: true, supported: true });
  expect(await runBotMessagesCommand(root, "steering", { bot: "receiver", enabled: "off" })).toEqual({ botId: "receiver", allowed: false, supported: true });
  expect(await hub.botMessages.readSteering("owner", "receiver", async () => undefined)).toMatchObject({ allowed: false });
  await liveTurn();
  expect(await runBotMessagesCommand(root, "send", { ...options(), delivery: "steer" })).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "steering_disabled" } });
  expect(await runBotMessagesCommand(root, "steering", { bot: "receiver", enabled: "on" })).toMatchObject({ allowed: true });
  await expect(runBotMessagesCommand(root, "steering", { bot: "receiver", enabled: "maybe" })).rejects.toThrow("enabled_must_be_on_or_off");
  await expect(runBotMessagesCommand(root, "steering", { bot: "nobody" })).rejects.toThrow();
  vi.stubEnv("TAROBOT_INSTANCE", "receiver");
  await expect(runBotMessagesCommand(root, "steering", { bot: "receiver", enabled: "off" })).rejects.toThrow("bot_message_steering_requires_owner_controller");
  expect(await hub.botMessages.readSteering("owner", "receiver", async () => undefined)).toMatchObject({ allowed: true });
});

it("documents delivery, its engines and its worst-case wait in the CLI help, and parses only where it applies", async () => {
  expect(HOST_CLI_HELP).toMatch(/messages send [^\n]*\[--delivery queue\|steer\]/);
  expect(HOST_CLI_HELP).toContain("messages steering --bot BOT [--enabled on|off]");
  expect(HOST_CLI_HELP).toMatch(/Codex/); expect(HOST_CLI_HELP).toMatch(/13 秒/); expect(HOST_CLI_HELP).toMatch(/30 秒/);
  await expect(runHostCli(["messages", "list", "x", "--delivery", "steer"])).rejects.toThrow("--delivery 仅支持 messages send");
  await expect(runHostCli(["messages", "grants", "--enabled", "on"])).rejects.toThrow("--enabled");
});
