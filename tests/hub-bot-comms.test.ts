import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { BotMessages } from "../src/hub/bot-messages.js";
import { hashSecret } from "../src/hub/auth.js";
import { networkId } from "../src/hub/private-network.js";
import { networkManifestSchema } from "../src/client-protocol/private-network.js";
import { CONVERSATION_BOT_COMMS_CAPABILITY, conversationBotCommsSchema } from "../src/client-protocol/workspace-comms.js";
import { SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import { bootstrapTrusted, deviceFields, loginFor, testDevice } from "./helpers/pairing-invite.js";

let root: string, hubA: HubServer, hubB: HubServer, crossBotMessages: BotMessages;
const guard = async () => undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-comms-"));
  hubA = await HubServer.start({ stateDir: path.join(root, "a") });
  hubB = await HubServer.start({ stateDir: path.join(root, "b") });
  await hubA.profile.update({ name: "ExampleHostA", revision: 0 });
  await hubB.profile.update({ name: "ExampleHostB", revision: 0 });
  for (const hub of [hubA, hubB]) {
    for (const [id, name] of [["bot_alpha", "Alpha"], ["bot_beta", "Beta"]]) {
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'codex')", [id!, name!, hashSecret("test-".repeat(10))]);
    }
  }
  const nonce = randomBytes(32).toString("base64url");
  const manifest = networkManifestSchema.parse({
    v: 2,
    id: networkId(hubA.auth.publicKey, nonce),
    name: "ExampleNet",
    authorityKey: hubA.auth.publicKey,
    genesisNonce: nonce,
    revision: 1,
    hosts: [hubA, hubB].map((hub, index) => ({
      publicKey: hub.auth.publicKey,
      name: index ? "ExampleHostB" : "ExampleHostA",
      routes: [],
      protocol: 2,
      state: "active",
      revoked: false,
    })),
    devices: [],
    revokedMembers: [],
    blockedBindings: [],
  });
  const membership = { manifest, signature: hubA.auth.signNetworkManifest(manifest) };
  for (const hub of [hubA, hubB]) {
    await hub.store.db.run(
      "INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
      [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })],
    );
  }
  await hubA.botMessages.grant({ sourceHost: "ExampleHostA", sourceBot: "bot_alpha", targetBot: "bot_beta" }, guard);
  await hubB.botMessages.grant({ sourceHost: "ExampleHostA", sourceBot: "bot_alpha", targetBot: "bot_beta" }, guard);
  crossBotMessages = new BotMessages(
    hubA.store,
    hubA.auth,
    hubA.network,
    hubA.attachments,
    async (_host, signed, body) => hubB.botMessages.receive(signed, signed.passport.method, signed.passport.path, body),
  );
});

afterEach(async () => {
  await hubA.close();
  await hubB.close();
  await rm(root, { recursive: true, force: true });
});

async function startActiveContextTurn(hub: HubServer, botId: string) {
  const conv = await hub.store.createConversation("owner", [botId], "Main Workspace Chat", `act_${randomUUID()}`);
  const { message } = await hub.store.sendMessage("owner", {
    conversationId: conv.id,
    clientMsgId: `cm_${randomUUID()}`,
    text: "Please coordinate with Beta",
    attachments: [],
    mentions: [botId],
    previewUrl: null,
  });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [message.id, botId]);
  return { conv, message };
}

async function insertBotMessage(hub: HubServer, botId: string, conversationId: string, replyTo: string, blocks: unknown[], status = "streaming") {
  const id = `bm_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = Date.now();
  await hub.store.db.run(
    "INSERT INTO messages(id,conversation_id,author_type,author_id,reply_to,blocks_json,status,version,created_at) VALUES(?,?,'bot',?,?,?,?,1,?)",
    [id, conversationId, botId, replyTo, JSON.stringify(blocks), status, now],
  );
  return { id };
}

describe("conversation bot-comms tracking", () => {
  it("advertises conversations.bot-comms.v1 in SERVER_CAPABILITIES", () => {
    expect(SERVER_CAPABILITIES).toContain(CONVERSATION_BOT_COMMS_CAPABILITY);
  });

  it("tracks same-host Bot-to-Bot delegation through queued, running, needs_approval, and replied + incoming view", async () => {
    const { conv, message } = await startActiveContextTurn(hubA, "bot_alpha");
    const target = await hubA.botMessages.local(
      { operation: "resolve", host: "ExampleHostA", bot: "bot_beta", requestId: randomUUID(), contextMessage: message.id, data: {} },
      "bot_alpha",
      guard,
    ) as { conversationId: string };
    const sent = await hubA.botMessages.local(
      { operation: "send", host: "ExampleHostA", bot: "bot_beta", conversation: target.conversationId, requestId: "req-same-1", contextMessage: message.id, data: { text: "Run the regression suite" } },
      "bot_alpha",
      guard,
    ) as { messageId: string; conversationId: string };

    // 1. Initially queued on target bot.
    const queued = await hubA.botMessages.listConversationComms("owner", conv.id, guard);
    expect(queued.summary).toEqual({ total: 1, active: 1, needsApproval: 0 });
    expect(queued.items[0]).toMatchObject({
      kind: "outgoing_bot_message",
      direction: "outgoing",
      sourceBotName: "Alpha",
      targetBotName: "Beta",
      crossHost: false,
      status: "queued",
      targetConversationId: target.conversationId,
      canJumpToTarget: true,
      sentExcerpt: "Run the regression suite",
    });

    // 2. Target bot claims delivery -> running.
    await hubA.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [sent.messageId, "bot_beta"]);
    const running = await hubA.botMessages.listConversationComms("owner", conv.id, guard);
    expect(running.items[0]?.status).toBe("running");

    // 3. Target bot posts an interactive approval card -> needs_approval with pendingApproval summary.
    const approvalMsg = await insertBotMessage(hubA, "bot_beta", target.conversationId, sent.messageId, [{
      type: "card",
      title: "Permission required",
      elements: [
        { type: "markdown", text: "Allow running `npm test` in workspace?" },
        { type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId: "perm-1", decision: "allow_once" } },
      ],
    }]);
    const waitingApproval = await hubA.botMessages.listConversationComms("owner", conv.id, guard);
    expect(waitingApproval.summary).toEqual({ total: 1, active: 1, needsApproval: 1 });
    expect(waitingApproval.items[0]?.status).toBe("needs_approval");
    expect(waitingApproval.items[0]?.pendingApproval?.messageId).toBe(approvalMsg.id);
    expect(waitingApproval.items[0]?.pendingApproval?.title).toBe("Permission required");

    // Incoming view inside the collaboration conversation also reflects the incoming Bot message.
    const incoming = await hubA.botMessages.listConversationComms("owner", target.conversationId, guard);
    expect(incoming.items).toHaveLength(1);
    expect(incoming.items[0]).toMatchObject({
      kind: "incoming_bot_message",
      direction: "incoming",
      sourceBotName: "Alpha",
      targetBotName: "Beta",
      status: "needs_approval",
      canJumpToTarget: false,
    });

    // 4. Approval card is resolved (button disabled) and bot finishes reply -> replied with replyExcerpt.
    await hubA.store.db.run(
      "UPDATE messages SET blocks_json=?, status='complete' WHERE id=?",
      [JSON.stringify([{ type: "card", title: "Permission required", elements: [{ type: "markdown", text: "Approved." }, { type: "button", text: "Allow once", actionId: "act_allow", disabled: true, value: { cctb_lark: "approval", requestId: "perm-1", decision: "allow_once" } }] }]), approvalMsg.id],
    );
    const replyMsg = await insertBotMessage(hubA, "bot_beta", target.conversationId, sent.messageId, [{ type: "text", text: "All 42 regression tests passed." }], "complete");
    await hubA.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [sent.messageId, "bot_beta"]);

    const replied = await hubA.botMessages.listConversationComms("owner", conv.id, guard);
    expect(replied.summary).toEqual({ total: 1, active: 0, needsApproval: 0 });
    expect(replied.items[0]?.status).toBe("replied");
    expect(replied.items[0]?.replyExcerpt).toContain("All 42 regression tests passed.");
  });

  it("tracks cross-host Bot-to-Bot delegations and updates reply excerpt when wait completes", async () => {
    const { conv, message } = await startActiveContextTurn(hubA, "bot_alpha");
    const target = await crossBotMessages.local(
      { operation: "resolve", host: "ExampleHostB", bot: "bot_beta", requestId: randomUUID(), contextMessage: message.id, data: {} },
      "bot_alpha",
      guard,
    ) as { conversationId: string };
    const sent = await crossBotMessages.local(
      { operation: "send", host: "ExampleHostB", bot: "bot_beta", conversation: target.conversationId, requestId: "req-cross-1", contextMessage: message.id, data: { text: "Check Windows build" } },
      "bot_alpha",
      guard,
    ) as { messageId: string; conversationId: string };

    const initial = await crossBotMessages.listConversationComms("owner", conv.id, guard);
    expect(initial.items[0]).toMatchObject({
      crossHost: true,
      targetHostName: "ExampleHostB",
      targetBotName: "Beta",
      canJumpToTarget: false,
      status: "queued",
      sentExcerpt: "Check Windows build",
    });

    // Complete delivery on Hub B, then call wait from Hub A.
    await insertBotMessage(hubB, "bot_beta", target.conversationId, sent.messageId, [{ type: "text", text: "Windows build is green." }], "complete");
    await hubB.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [sent.messageId, "bot_beta"]);

    await crossBotMessages.local(
      { operation: "wait", host: "ExampleHostB", bot: "bot_beta", conversation: target.conversationId, requestId: randomUUID(), data: { messageId: sent.messageId } },
      "bot_alpha",
      guard,
    );

    const updated = await crossBotMessages.listConversationComms("owner", conv.id, guard);
    expect(updated.items[0]?.status).toBe("replied");
    expect(updated.items[0]?.replyExcerpt).toContain("Windows build is green.");
    expect(updated.items[0]?.canJumpToTarget).toBe(false);
  });

  it("includes Agent Bus runs and stages linked to the conversation and serves GET /api/conversations/:id/bot-comms with auth", async () => {
    const { conv } = await startActiveContextTurn(hubA, "bot_alpha");
    const stageConv = await hubA.store.createConversation("owner", ["bot_beta"], "Research Crew · Beta", `act_${randomUUID()}`);
    const now = Date.now();
    await hubA.store.db.run(
      "INSERT INTO agent_buses(id,owner_id,revision,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      ["ab_1", "owner", "rev_1", JSON.stringify({ name: "Research Crew", mode: "ask" }), now, now],
    );
    await hubA.store.db.run(
      "INSERT INTO agent_bus_runs(id,workspace_id,owner_id,coordinator_id,conversation_id,message_id,snapshot_json,text,status,error,stop_requested,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ["run_1", "ab_1", "owner", "bot_alpha", conv.id, "msg_run_1", JSON.stringify({ name: "Research Crew", mode: "ask" }), "Compare benchmarks", "running", null, 0, now, now, null],
    );
    await hubA.store.db.run(
      "INSERT INTO agent_bus_stages(run_id,id,bot_id,conversation_id,status,message_id,started_at,finished_at,error,seq) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ["run_1", "stage_1", "bot_beta", stageConv.id, "running", null, now, null, null, 1],
    );

    // HTTP endpoint returns validated payload for owner session and rejects unauthenticated requests.
    const unauth = await fetch(`${hubA.url}/api/conversations/${conv.id}/bot-comms`);
    expect(unauth.status).toBe(401);

    const dev = testDevice("device-comms");
    await bootstrapTrusted(hubA.auth, deviceFields(dev));
    const { token: sessionToken } = await loginFor(hubA.auth, dev);
    const res = await fetch(`${hubA.url}/api/conversations/${conv.id}/bot-comms`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.status).toBe(200);
    const body = conversationBotCommsSchema.parse(await res.json());
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      kind: "agent_bus_stage",
      direction: "outgoing",
      workspaceName: "Research Crew",
      sourceBotName: "Alpha",
      targetBotName: "Beta",
      status: "running",
      targetConversationId: stageConv.id,
      canJumpToTarget: true,
    });

    // Non-member conversation returns 403.
    const forbidden = await fetch(`${hubA.url}/api/conversations/nonexistent_conv/bot-comms`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect([403, 404]).toContain(forbidden.status);
  });
});
