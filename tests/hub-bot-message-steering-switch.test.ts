import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { botMessageSteeringProofPayload } from "../src/client-protocol/bot-message-delivery.js";

let root: string, hub: HubServer;
const guard = async () => undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-steering-switch-")); hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('codex','Codex',?,'codex'),('pi','Pi',?,'pi')", [hashSecret("secret-".repeat(8)), hashSecret("secret-".repeat(8))]);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,role,engine) VALUES('w','Worker','fixture','worker','codex')");
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

it("defaults on, persists an owner change with a one-use matching device proof, and refuses everyone else", async () => {
  const closeControl = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true });
  try {
    expect(await client.request("/api/bot-messages/steering?botId=codex")).toEqual({ botId: "codex", allowed: true, supported: true });
    expect(await client.request("/api/bot-messages/steering?botId=pi")).toEqual({ botId: "pi", allowed: true, supported: false });
    await expect(client.request("/api/bot-messages/steering?botId=w")).rejects.toThrow("bot_not_found");
    const off = { botId: "codex", allowed: false };
    await expect(client.request("/api/bot-messages/steering", "POST", { command: off })).rejects.toThrow();
    // A proof for another change (or a grant edit) never authorizes this one.
    const wrong = await client.deviceAction({ operation: "bot-message-grant", target: hashSecret(botMessageSteeringProofPayload({ botId: "codex", allowed: true })) });
    await expect(client.request("/api/bot-messages/steering", "POST", { command: off, proof: wrong })).rejects.toThrow("device_action_invalid");
    const good = await client.deviceAction({ operation: "bot-message-grant", target: hashSecret(botMessageSteeringProofPayload(off)) });
    expect(await client.request("/api/bot-messages/steering", "POST", { command: off, proof: good })).toEqual({ botId: "codex", allowed: false, supported: true });
    await expect(client.request("/api/bot-messages/steering", "POST", { command: off, proof: good })).rejects.toThrow();
    const bot = await fetch(hub.instanceUrl + "/api/bot-messages/steering", { method: "POST", headers: { Authorization: `Instance codex:${"secret-".repeat(8)}` }, body: JSON.stringify({ command: { botId: "codex", allowed: true }, proof: good }) });
    expect(bot.ok).toBe(false);
    expect((await fetch(hub.url + "/api/bot-messages/steering?botId=codex")).ok).toBe(false);
    const audit = await hub.store.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='bot-message.steering-updated'");
    expect(audit.map(row => JSON.parse(row.detail_json))).toEqual([{ botId: "codex", allowed: false, previous: true }]);
  } finally { client.close(); await closeControl(); }
  // Persisted with the Host.
  await hub.close(); hub = await HubServer.start({ stateDir: root });
  expect(await hub.botMessages.readSteering("owner", "codex", guard)).toEqual({ botId: "codex", allowed: false, supported: true });
  await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
  await expect(hub.botMessages.readSteering("member", "codex", guard)).rejects.toThrow();
  await expect(hub.botMessages.setSteering("member", { botId: "codex", allowed: true }, guard, guard, "member")).rejects.toThrow();
});
