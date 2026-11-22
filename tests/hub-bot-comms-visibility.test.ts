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
import type { BotMessageSteeringHooks } from "../src/hub/bot-message-steering.js";

/** Who may read what in the workspace rail's Bot-comms list, and when a quoted reply must disappear. */
let root: string, hubA: HubServer, hubB: HubServer, crossBotMessages: BotMessages;
const guard = async () => undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bot-comms-visibility-"));
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
    v: 2, id: networkId(hubA.auth.publicKey, nonce), name: "ExampleNet", authorityKey: hubA.auth.publicKey, genesisNonce: nonce, revision: 1,
    hosts: [hubA, hubB].map((hub, index) => ({ publicKey: hub.auth.publicKey, name: index ? "ExampleHostB" : "ExampleHostA", routes: [], protocol: 2, state: "active", revoked: false })),
    devices: [], revokedMembers: [], blockedBindings: [],
  });
  const membership = { manifest, signature: hubA.auth.signNetworkManifest(manifest) };
  for (const hub of [hubA, hubB]) {
    await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
      [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  }
  await hubA.botMessages.grant({ sourceHost: "ExampleHostA", sourceBot: "bot_alpha", targetBot: "bot_beta" }, guard);
  await hubB.botMessages.grant({ sourceHost: "ExampleHostA", sourceBot: "bot_alpha", targetBot: "bot_beta" }, guard);
  crossBotMessages = new BotMessages(hubA.store, hubA.auth, hubA.network, hubA.attachments,
    async (_host, signed, body) => hubB.botMessages.receive(signed, signed.passport.method, signed.passport.path, body));
});

afterEach(async () => {
  await hubA.close();
  await hubB.close();
  await rm(root, { recursive: true, force: true });
});

async function startActiveContextTurn(hub: HubServer, botId: string) {
  const conv = await hub.store.createConversation("owner", [botId], "Main Workspace Chat", `act_${randomUUID()}`);
  const { message } = await hub.store.sendMessage("owner", { conversationId: conv.id, clientMsgId: `cm_${randomUUID()}`, text: "Please coordinate with Beta", attachments: [], mentions: [botId], previewUrl: null });
  await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [message.id, botId]);
  return { conv, message };
}
async function insertBotMessage(hub: HubServer, botId: string, conversationId: string, replyTo: string | null, blocks: unknown[], status = "complete", createdAt = Date.now()) {
  const id = `bm_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await hub.store.db.run("INSERT INTO messages(id,conversation_id,author_type,author_id,reply_to,blocks_json,status,version,created_at) VALUES(?,?,'bot',?,?,?,?,1,?)",
    [id, conversationId, botId, replyTo, JSON.stringify(blocks), status, createdAt]);
  return { id };
}
/** A second Hub user who shares the source chat (a member, not the owner). */
async function addMember(hub: HubServer, conversationId: string) {
  await hub.store.db.run("INSERT OR IGNORE INTO users(id,name,role) VALUES('usr_member','Member','member')");
  await hub.store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'user','usr_member')", [conversationId]);
  return "usr_member";
}
const approvalCard = (requestId: string) => [{ type: "card", title: "Permission required", elements: [{ type: "markdown", text: "Allow running tests?" },
  { type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId, decision: "allow_once" } }] }];

/** One same-host delegation from Alpha's chat to Beta, optionally answered. */
async function delegate(requestId: string, data: Record<string, unknown> = { text: "Run the regression suite" }) {
  const { conv, message } = await startActiveContextTurn(hubA, "bot_alpha");
  const target = await hubA.botMessages.local({ operation: "resolve", host: "ExampleHostA", bot: "bot_beta", requestId: randomUUID(), contextMessage: message.id, data: {} }, "bot_alpha", guard) as { conversationId: string };
  const sent = await hubA.botMessages.local({ operation: "send", host: "ExampleHostA", bot: "bot_beta", conversation: target.conversationId, requestId, contextMessage: message.id, data }, "bot_alpha", guard) as { messageId: string; conversationId: string };
  const answer = async (reply: string) => {
    const row = await insertBotMessage(hubA, "bot_beta", target.conversationId, sent.messageId, [{ type: "text", text: reply }]);
    await hubA.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [sent.messageId, "bot_beta"]);
    return row;
  };
  return { conv, message, target, sent, answer, list: () => hubA.botMessages.listConversationComms("owner", conv.id, guard), incoming: () => hubA.botMessages.listConversationComms("owner", target.conversationId, guard) };
}

describe("Bot-comms visibility", () => {
  it("shows a cross-host exchange's remote chat, ids and text only to the Hub owner, not to a member of the source chat", async () => {
    const { conv, message } = await startActiveContextTurn(hubA, "bot_alpha");
    const target = await crossBotMessages.local({ operation: "resolve", host: "ExampleHostB", bot: "bot_beta", requestId: randomUUID(), contextMessage: message.id, data: {} }, "bot_alpha", guard) as { conversationId: string };
    const sent = await crossBotMessages.local({ operation: "send", host: "ExampleHostB", bot: "bot_beta", conversation: target.conversationId, requestId: "req-cross-private", contextMessage: message.id, data: { text: "Private instruction for the other host" } }, "bot_alpha", guard) as { messageId: string };
    await insertBotMessage(hubB, "bot_beta", target.conversationId, sent.messageId, [{ type: "text", text: "Private reply on the other host" }]);
    await hubB.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [sent.messageId, "bot_beta"]);
    await crossBotMessages.local({ operation: "wait", host: "ExampleHostB", bot: "bot_beta", conversation: target.conversationId, requestId: randomUUID(), data: { messageId: sent.messageId } }, "bot_alpha", guard);

    const owner = await crossBotMessages.listConversationComms("owner", conv.id, guard);
    expect(owner.items[0]).toMatchObject({ crossHost: true, status: "replied", targetConversationId: target.conversationId, targetMessageId: sent.messageId, sentExcerpt: "Private instruction for the other host" });
    expect(owner.items[0]?.replyExcerpt).toContain("Private reply");

    const member = await addMember(hubA, conv.id);
    const listed = await crossBotMessages.listConversationComms(member, conv.id, guard);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ kind: "outgoing_bot_message", crossHost: true, status: "replied", targetHostName: "ExampleHostB", targetBotName: "Beta", canJumpToTarget: false });
    for (const field of ["sentExcerpt", "replyExcerpt", "pendingApproval", "targetConversationId", "targetConversationTitle", "targetMessageId"] as const) expect(listed.items[0]?.[field]).toBeUndefined();
    expect(JSON.stringify(listed)).not.toMatch(/Private|collaboration|协作/);
  });

  it("stops quoting a finished exchange's reply once the Bot recalls or edits it", async () => {
    const d = await delegate("req-recalled");
    const reply = await d.answer("Secret build log line");
    // Read once: this exchange is now settled in the Hub's memory.
    expect((await d.list()).items[0]).toMatchObject({ status: "replied", replyExcerpt: "Secret build log line" });
    expect((await d.incoming()).items[0]).toMatchObject({ status: "replied", replyExcerpt: "Secret build log line" });
    await hubA.store.db.run("UPDATE messages SET blocks_json=?, version=version+1 WHERE id=?", [JSON.stringify([{ type: "text", text: "Corrected build log line" }]), reply.id]);
    expect((await d.list()).items[0]?.replyExcerpt).toBe("Corrected build log line");
    // A recall marks the reply deleted for everyone.
    await hubA.store.db.run("UPDATE messages SET status='deleted', blocks_json='[]', version=version+1 WHERE id=?", [reply.id]);
    for (const listed of [await d.list(), await d.incoming()]) {
      expect(listed.items).toHaveLength(1);
      expect(JSON.stringify(listed)).not.toMatch(/build log/);
    }
  });

  it("keeps the outgoing chat's fallback reason after the target chat's view was read first", async () => {
    // No worker can take a steer: the message is queued and the receipt says why.
    const d = await delegate("req-fallback", { text: "Run the regression suite", delivery: "steer" });
    expect(await hubA.store.db.get("SELECT 1 FROM deliveries WHERE message_id=?", [d.sent.messageId])).toBeTruthy();
    await d.answer("Done.");
    expect((await d.incoming()).items[0]).toMatchObject({ status: "replied" });
    expect((await d.list()).items[0]).toMatchObject({ status: "replied", delivery: "fell_back_to_queue", deliveryReason: "bot_offline" });
  });

  it("drops an approval card the user removed, also one that answers no particular message", async () => {
    const { conv } = await startActiveContextTurn(hubA, "bot_alpha");
    const stageConv = await hubA.store.createConversation("owner", ["bot_beta"], "Research Crew · Beta", `act_${randomUUID()}`);
    const now = Date.now();
    await hubA.store.db.run("INSERT INTO agent_buses(id,owner_id,revision,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?)", ["ab_1", "owner", "rev_1", JSON.stringify({ name: "Research Crew", mode: "ask" }), now, now]);
    await hubA.store.db.run("INSERT INTO agent_bus_runs(id,workspace_id,owner_id,coordinator_id,conversation_id,message_id,snapshot_json,text,status,error,stop_requested,created_at,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ["run_1", "ab_1", "owner", "bot_alpha", conv.id, "msg_run_1", JSON.stringify({ name: "Research Crew", mode: "ask" }), "Compare benchmarks", "running", null, 0, now, now, null]);
    await hubA.store.db.run("INSERT INTO agent_bus_stages(run_id,id,bot_id,conversation_id,status,message_id,started_at,finished_at,error,seq) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ["run_1", "stage_1", "bot_beta", stageConv.id, "running", null, now, null, null, 1]);
    const card = await insertBotMessage(hubA, "bot_beta", stageConv.id, null, approvalCard("perm-bus"), "streaming", now + 5);
    expect((await hubA.botMessages.listConversationComms("owner", conv.id, guard)).items[0]).toMatchObject({ status: "needs_approval", pendingApproval: { messageId: card.id, title: "Permission required" } });
    expect((await hubA.botMessages.listConversationComms("owner", stageConv.id, guard)).items[0]).toMatchObject({ status: "needs_approval", pendingApproval: { messageId: card.id } });
    await hubA.store.db.run("INSERT INTO message_deletions VALUES(?,?,?)", ["owner", card.id, Date.now()]);
    for (const id of [conv.id, stageConv.id]) {
      const listed = await hubA.botMessages.listConversationComms("owner", id, guard);
      expect(listed.items[0]?.pendingApproval).toBeUndefined();
      expect(JSON.stringify(listed)).not.toContain("Permission required");
    }
  });

  describe("a Bot message merged into a live turn", () => {
    /** Alpha's queued message starts Beta's turn; a second message from Alpha steers into it. */
    async function steeredExchange() {
      const d = await delegate("req-turn", { text: "Start the long task" });
      await hubA.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [d.sent.messageId]);
      hubA.botMessages.steering = {
        capable: () => true,
        status: async () => ({ supported: true, targetId: "run_live", sourceMessageId: d.sent.messageId, receiptEpoch: "rs_fixture_store" }),
        steer: async () => ({ outcome: "accepted", sourceMessageId: d.sent.messageId }),
        reconcile: async () => ({ outcome: "unknown", reason: "uncertain" }),
        dispatch: () => undefined,
      } satisfies BotMessageSteeringHooks;
      const steer = await hubA.botMessages.local({ operation: "send", host: "ExampleHostA", bot: "bot_beta", conversation: d.target.conversationId, requestId: "req-steer", contextMessage: d.message.id, data: { text: "Also check the flaky test", delivery: "steer" } }, "bot_alpha", guard) as { messageId: string; delivery: { actual: string } };
      expect(steer.delivery.actual).toBe("steered");
      const steerRow = (await hubA.store.db.get<{ created_at: number }>("SELECT created_at FROM messages WHERE id=?", [steer.messageId]))!;
      return { ...d, steer, steerAt: steerRow.created_at };
    }
    const steerItem = async (d: Awaited<ReturnType<typeof steeredExchange>>, userId = "owner") =>
      (await hubA.botMessages.listConversationComms(userId, d.target.conversationId, guard)).items.find(item => item.targetMessageId === d.steer.messageId);

    it("quotes the reply of the turn it joined, not other replies near it in time", async () => {
      const d = await steeredExchange();
      // The turn's reply began streaming before the steer arrived; a later, unrelated turn answers afterwards.
      const reply = await insertBotMessage(hubA, "bot_beta", d.target.conversationId, d.sent.messageId, [{ type: "text", text: "Long task done, flaky test checked." }], "complete", d.steerAt - 5_000);
      await hubA.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id='bot_beta'", [d.sent.messageId]);
      const later = await hubA.store.sendMessage("owner", { conversationId: d.target.conversationId, clientMsgId: `cm_${randomUUID()}`, text: "Unrelated question", attachments: [], mentions: ["bot_beta"], previewUrl: null });
      await insertBotMessage(hubA, "bot_beta", d.target.conversationId, later.message.id, [{ type: "text", text: "Unrelated later answer" }], "complete", d.steerAt + 5_000);
      await hubA.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [later.message.id]);
      const item = await steerItem(d);
      expect(item).toMatchObject({ kind: "incoming_bot_message", status: "replied", delivery: "steered" });
      expect(item?.replyExcerpt).toContain("Long task done");
      expect(item?.replyExcerpt).not.toContain("Unrelated");
      // The user removes that reply for themselves: it is no longer quoted.
      await hubA.store.db.run("INSERT INTO message_deletions VALUES(?,?,?)", ["owner", reply.id, Date.now()]);
      expect((await steerItem(d))?.replyExcerpt).toBeUndefined();
      expect(JSON.stringify(await hubA.botMessages.listConversationComms("owner", d.target.conversationId, guard))).not.toContain("Long task done");
    });
  });
});
