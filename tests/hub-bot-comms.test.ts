import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

    // A conversation that exists but that this user is not in is refused, not just an unknown id.
    await hubA.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [stageConv.id]);
    const forbidden = await fetch(`${hubA.url}/api/conversations/${stageConv.id}/bot-comms`, { headers: { authorization: `Bearer ${sessionToken}` } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).not.toContain("Research Crew");
    // The coordinator's own stage is not a handoff: no "Alpha → Alpha" row.
    await hubA.store.db.run(
      "INSERT INTO agent_bus_stages(run_id,id,bot_id,conversation_id,status,message_id,started_at,finished_at,error,seq) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ["run_1", "stage_0", "bot_alpha", conv.id, "running", null, now, null, null, 0],
    );
    const again = conversationBotCommsSchema.parse(await (await fetch(`${hubA.url}/api/conversations/${conv.id}/bot-comms`, { headers: { authorization: `Bearer ${sessionToken}` } })).json());
    expect(again.items.map(item => [item.sourceBotName, item.targetBotName])).toEqual([["Alpha", "Beta"]]);
    // Without membership of the stage's chat there is no title, id or jump for it.
    expect(again.items[0]).toMatchObject({ canJumpToTarget: false });
    expect(again.items[0]?.targetConversationId).toBeUndefined(); expect(again.items[0]?.targetConversationTitle).toBeUndefined();
  });

  /** One same-host delegation from Alpha's chat to Beta, optionally answered. */
  async function delegate(requestId: string, text = "Run the regression suite") {
    const { conv, message } = await startActiveContextTurn(hubA, "bot_alpha");
    const target = await hubA.botMessages.local({ operation: "resolve", host: "ExampleHostA", bot: "bot_beta", requestId: randomUUID(), contextMessage: message.id, data: {} }, "bot_alpha", guard) as { conversationId: string };
    const sent = await hubA.botMessages.local({ operation: "send", host: "ExampleHostA", bot: "bot_beta", conversation: target.conversationId, requestId, contextMessage: message.id, data: { text } }, "bot_alpha", guard) as { messageId: string; conversationId: string };
    const answer = async (reply: string) => {
      const row = await insertBotMessage(hubA, "bot_beta", target.conversationId, sent.messageId, [{ type: "text", text: reply }], "complete");
      await hubA.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [sent.messageId, "bot_beta"]);
      return row;
    };
    return { conv, message, target, sent, answer, list: () => hubA.botMessages.listConversationComms("owner", conv.id, guard) };
  }

  it("shows a user who is not in the target chat no text, title or id of it", async () => {
    const d = await delegate("req-hidden-chat", "Private instruction for the other chat");
    await d.answer("Private reply in the other chat");
    await hubA.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [d.target.conversationId]);
    const listed = await d.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ kind: "outgoing_bot_message", sourceBotName: "Alpha", targetBotName: "Beta", canJumpToTarget: false });
    for (const field of ["sentExcerpt", "replyExcerpt", "pendingApproval", "targetConversationId", "targetConversationTitle", "targetMessageId"] as const) expect(listed.items[0]?.[field]).toBeUndefined();
    expect(JSON.stringify(listed)).not.toMatch(/Private|other chat/);
  });

  it("stops showing what the user has removed for themselves", async () => {
    const d = await delegate("req-removed");
    const reply = await d.answer("All 42 regression tests passed.");
    expect((await d.list()).items[0]).toMatchObject({ status: "replied", replyExcerpt: expect.stringContaining("42") });
    // The reply removed: the exchange stays, its quoted reply does not (also not from the stored copy).
    await hubA.store.db.run("INSERT INTO message_deletions VALUES(?,?,?)", ["owner", reply.id, Date.now()]);
    const withoutReply = (await d.list()).items[0];
    expect(withoutReply).toMatchObject({ status: "replied", sentExcerpt: "Run the regression suite" }); expect(withoutReply?.replyExcerpt).toBeUndefined();
    // The incoming view in the target chat follows the same rule.
    const incoming = await hubA.botMessages.listConversationComms("owner", d.target.conversationId, guard);
    expect(incoming.items).toHaveLength(1); expect(incoming.items[0]?.replyExcerpt).toBeUndefined();
    // The delivered message removed: the exchange is gone from both chats.
    await hubA.store.db.run("INSERT INTO message_deletions VALUES(?,?,?)", ["owner", d.sent.messageId, Date.now()]);
    expect((await d.list()).items).toEqual([]);
    expect((await hubA.botMessages.listConversationComms("owner", d.target.conversationId, guard)).items).toEqual([]);
  });

  it("drops a trace when the message whose turn made it is removed", async () => {
    const d = await delegate("req-cleared");
    expect((await d.list()).items).toHaveLength(1);
    await hubA.store.db.run("INSERT INTO message_deletions VALUES(?,?,?)", ["owner", d.message.id, Date.now()]);
    expect((await d.list()).items).toEqual([]);
  });

  it("reads a finished exchange once, not at every poll", async () => {
    const d = await delegate("req-settled");
    const read = vi.spyOn(hubA.botMessages as unknown as { readLocalTargetInTransaction: (...args: unknown[]) => Promise<unknown> }, "readLocalTargetInTransaction");
    await d.list(); await d.list();
    // Still in progress: read each time.
    expect(read).toHaveBeenCalledTimes(2);
    await d.answer("Done.");
    for (let index = 0; index < 4; index++) expect((await d.list()).items[0]).toMatchObject({ status: "replied", replyExcerpt: "Done." });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("matches an approval only to the message it answers", async () => {
    const first = await delegate("req-first");
    await first.answer("First is done.");
    // A later card of the same Bot in the same chat that answers nothing in particular.
    await hubA.store.db.run("INSERT INTO messages(id,conversation_id,author_type,author_id,reply_to,blocks_json,status,version,created_at) VALUES(?,?,'bot','bot_beta',NULL,?,'streaming',1,?)",
      [`bm_${randomUUID().replace(/-/g, "").slice(0, 12)}`, first.target.conversationId, JSON.stringify([{ type: "card", title: "Permission required", elements: [{ type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId: "perm-2", decision: "allow_once" } }] }]), Date.now() + 5]);
    expect((await first.list()).items[0]).toMatchObject({ status: "replied" });
    expect((await first.list()).summary).toEqual({ total: 1, active: 0, needsApproval: 0 });
  });

  it("survives a damaged stored row and keeps tracing afterwards", async () => {
    const d = await delegate("req-damaged-1");
    const index = await hubA.store.db.get<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'bot-messages:trace-index:%'");
    const trace = await hubA.store.db.get<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'bot-messages:trace:%'");
    // A trace row that is not JSON, then one that is the wrong shape: each is skipped.
    for (const value of ["{not json", JSON.stringify({ requestId: 7 }), JSON.stringify(null)]) {
      await hubA.store.db.run("UPDATE meta SET value=? WHERE key=?", [value, trace!.key]);
      expect(await d.list()).toMatchObject({ items: [], summary: { total: 0, active: 0, needsApproval: 0 } });
    }
    // An index row that is not a list: the list is empty, and the next send starts a new index.
    for (const value of ["{not json", JSON.stringify({ keys: [] }), JSON.stringify("x")]) {
      await hubA.store.db.run("UPDATE meta SET value=? WHERE key=?", [value, index!.key]);
      expect((await d.list()).items).toEqual([]);
    }
    const sent = await hubA.botMessages.local({ operation: "send", host: "ExampleHostA", bot: "bot_beta", conversation: d.target.conversationId, requestId: "req-damaged-2", contextMessage: d.message.id, data: { text: "Second instruction" } }, "bot_alpha", guard) as { messageId: string };
    expect(sent.messageId).toBeTruthy();
    expect((await d.list()).items.map(item => item.sentExcerpt)).toEqual(["Second instruction"]);
  });

  it("keeps the list when one item does not fit the public shape", async () => {
    const d = await delegate("req-long-name");
    await hubA.store.db.run("UPDATE bots SET name=? WHERE id='bot_beta'", ["B".repeat(400)]);
    const listed = await d.list();
    expect(listed.items).toHaveLength(1); expect(listed.items[0]?.targetBotName).toHaveLength(128);
    // A request id at the allowed length still yields a valid item id.
    const long = await delegate("r".repeat(128));
    expect((await long.list()).items[0]?.id.length).toBeLessThanOrEqual(160);
  });

  it("stops counting a cross-host delegation as in progress once nobody has updated it for two hours", async () => {
    const { conv, message } = await startActiveContextTurn(hubA, "bot_alpha");
    const target = await crossBotMessages.local({ operation: "resolve", host: "ExampleHostB", bot: "bot_beta", requestId: randomUUID(), contextMessage: message.id, data: {} }, "bot_alpha", guard) as { conversationId: string };
    await crossBotMessages.local({ operation: "send", host: "ExampleHostB", bot: "bot_beta", conversation: target.conversationId, requestId: "req-never-waited", contextMessage: message.id, data: { text: "Fire and forget" } }, "bot_alpha", guard);
    expect(await crossBotMessages.listConversationComms("owner", conv.id, guard)).toMatchObject({ items: [{ status: "queued" }], summary: { active: 1 } });
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000 + 1000);
    try { expect(await crossBotMessages.listConversationComms("owner", conv.id, guard)).toMatchObject({ items: [{ status: "uncertain", sentExcerpt: "Fire and forget" }], summary: { total: 1, active: 0 } }); }
    finally { later.mockRestore(); }
  });

  it("keeps at most thirty-two traces per conversation and removes what it evicts", async () => {
    const d = await delegate("req-bound-0");
    // A Bot may send ten messages a minute, so the clock moves on between sends.
    const start = Date.now(), clock = vi.spyOn(Date, "now");
    try {
      for (let index = 1; index <= 34; index++) {
        clock.mockReturnValue(start + index * 7_000);
        await hubA.botMessages.local({ operation: "send", host: "ExampleHostA", bot: "bot_beta", conversation: d.target.conversationId, requestId: `req-bound-${index}`, contextMessage: d.message.id, data: { text: `Instruction ${index}` } }, "bot_alpha", guard);
      }
    } finally { clock.mockRestore(); }
    const rows = await hubA.store.db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'bot-messages:trace%'");
    expect(rows.filter(row => row.key.startsWith("bot-messages:trace:"))).toHaveLength(32);
    expect(rows.filter(row => row.key.startsWith("bot-messages:trace-msg:"))).toHaveLength(32);
    expect(rows.filter(row => row.key.startsWith("bot-messages:trace-index:"))).toHaveLength(1);
    const listed = await d.list();
    expect(listed.items.filter(item => item.kind === "outgoing_bot_message")).toHaveLength(32);
    expect(listed.items.some(item => item.sentExcerpt === "Run the regression suite")).toBe(false);
  });
});
