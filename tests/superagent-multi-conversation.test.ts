import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import type { DispatchTicket } from "../src/client-protocol/dispatch.js";
import type { Conversation } from "../src/client-protocol/index.js";

describe("Superagent multiple conversations, groups, and Bot messages (#122)", () => {
  let root: string;
  let hub: HubServer;
  let firstChat: Conversation;
  const owner = { kind: "owner" as const, userId: "owner" };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "superagent-multi-"));
    hub = await HubServer.start({ stateDir: root });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role,online) VALUES('super','Superagent','fixture','claude','','','dispatcher',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,online) VALUES('helper','Helper','fixture','codex','','',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role,online) VALUES('w_codex','Superagent · codex','fixture','codex','','','worker',1)");
    hub.dispatch.workers = {
      catalog: async () => ({ engines: [{ id: "codex", available: true, models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" }] }),
      dispatchWorker: async () => "w_codex",
      ticketWorkspace: async (_dispatcher, ticketId) => path.join(root, "tickets", ticketId),
    };
    firstChat = await hub.store.createConversation("owner", ["super"], "Project Alpha", "alpha");
  });

  afterEach(async () => {
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });

  async function activeBotTurn(conversationId: string, text: string, clientMsgId: string) {
    const sent = await hub.store.sendMessage("owner", { conversationId, clientMsgId, text, attachments: [], mentions: ["super"], previewUrl: null });
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='super'", [sent.message.id]);
    return { kind: "bot" as const, botId: "super", contextMessage: sent.message.id };
  }

  async function settleTicket(ticket: DispatchTicket, text: string) {
    const attempt = ticket.attempts.at(-1)!;
    await hub.store.publishBotMessage(attempt.botId, { conversationId: attempt.conversationId, blocks: [{ type: "text", text }], replyTo: attempt.inputMessageId, status: "complete" });
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [attempt.inputMessageId, attempt.botId]);
    await hub.dispatch.sweep();
    return hub.dispatch.show(owner, ticket.id);
  }

  it("isolates tickets and settlement notices across parallel direct conversations while supporting an all-tickets view", async () => {
    const secondChat = await hub.store.createConversation("owner", ["super"], "Project Beta", "beta");

    const turnA = await activeBotTurn(firstChat.id, "Build Alpha", "msg-a");
    const turnB = await activeBotTurn(secondChat.id, "Build Beta", "msg-b");

    const ticketA = await hub.dispatch.create(turnA, "super", { requestId: "req-a", title: "Alpha Task", request: "Do Alpha" });
    const ticketB = await hub.dispatch.create(turnB, "super", { requestId: "req-b", title: "Beta Task", request: "Do Beta" });

    expect(ticketA.conversationId).toBe(firstChat.id);
    expect(ticketB.conversationId).toBe(secondChat.id);

    // Filtered list & overview return only each conversation's tickets; unfiltered returns all.
    expect((await hub.dispatch.list(owner, "super", { conversationId: firstChat.id })).tickets.map(t => t.id)).toEqual([ticketA.id]);
    expect((await hub.dispatch.list(owner, "super", { conversationId: secondChat.id })).tickets.map(t => t.id)).toEqual([ticketB.id]);
    expect((await hub.dispatch.overview(owner, "super", { conversationId: secondChat.id })).tickets.map(t => t.id)).toEqual([ticketB.id]);
    expect((await hub.dispatch.list(owner, "super")).tickets.map(t => t.id).sort()).toEqual([ticketA.id, ticketB.id].sort());

    // Dispatch and settle ticket B -> notice must land ONLY in secondChat, never leaking into firstChat.
    const workingB = await hub.dispatch.dispatch(turnB, "super", { requestId: "go-b", ticketId: ticketB.id, engine: "codex" });
    await settleTicket(workingB, "Beta finished cleanly.");

    const noticesA = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [firstChat.id]);
    const noticesB = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [secondChat.id]);
    expect(noticesA).toHaveLength(0);
    expect(noticesB).toHaveLength(1);
    expect(noticesB[0]!.blocks_json).toContain("Beta Task");
    expect(noticesB[0]!.blocks_json).toContain("【工单完成】");
  });

  it("allows a Superagent to join groups and deliver group ticket notices back to that group", async () => {
    const group = await hub.store.createConversation("owner", ["helper"], "Release Squad", "grp1", { type: "group" });
    const [updated] = await hub.store.updateGroup("owner", group.id, {
      title: group.title,
      expectedTitle: group.title,
      botIds: ["helper", "super"],
      expectedBotIds: ["helper"],
    });
    expect(updated!.botIds).toEqual(["helper", "super"]);

    const groupTurn = await activeBotTurn(group.id, "@Superagent ship release", "msg-grp");
    const ticket = await hub.dispatch.create(groupTurn, "super", { requestId: "req-grp", title: "Ship Release", request: "Tag and verify" });
    expect(ticket.conversationId).toBe(group.id);

    const working = await hub.dispatch.dispatch(groupTurn, "super", { requestId: "go-grp", ticketId: ticket.id, engine: "codex" });
    await settleTicket(working, "Release verified.");

    const groupNotices = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [group.id]);
    expect(groupNotices).toHaveLength(1);
    expect(groupNotices[0]!.blocks_json).toContain("Ship Release");
    const delivered = await hub.store.db.all<{ bot_id: string }>("SELECT d.bot_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND m.bot_source_json IS NOT NULL", [group.id]);
    expect(delivered).toEqual([{ bot_id: "super" }]);
  });

  it("supports Bot-to-Bot messages, dedicated collaboration chats, and steering settings on a Superagent", async () => {
    const guard = async () => undefined;
    await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
    await hub.botMessages.grant({ sourceHost: "macmini", sourceBot: "helper", targetBot: "super" }, guard);

    // Helper sends a Bot message to Superagent (creates a dedicated collaboration conversation even though firstChat already exists!).
    const helperChat = await hub.store.createConversation("owner", ["helper"], "Helper Chat", "helper-chat");
    const trigger = await hub.store.sendMessage("owner", { conversationId: helperChat.id, clientMsgId: "h1", text: "Ask Superagent", attachments: [], mentions: ["helper"], previewUrl: null });
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='helper'", [trigger.message.id]);

    const resolved = await hub.botMessages.local({
      operation: "resolve",
      host: "macmini",
      bot: "super",
      requestId: "bm-resolve-1",
      contextMessage: trigger.message.id,
      data: {},
    }, "helper", guard) as { conversationId: string; botId: string };
    expect(resolved.botId).toBe("super");
    expect(resolved.conversationId).not.toBe(firstChat.id);

    const receipt = await hub.botMessages.local({
      operation: "send",
      host: "macmini",
      bot: "super",
      conversation: resolved.conversationId,
      requestId: "bm-send-1",
      contextMessage: trigger.message.id,
      data: { text: "Please review this design", attachments: [] },
    }, "helper", guard) as { messageId: string; conversationId: string };
    expect(receipt.conversationId).toBe(resolved.conversationId);
    expect(receipt.messageId).toBeTruthy();

    // Steering support is enabled for Claude/Codex dispatchers just like ordinary Bots.
    const steerSettings = await hub.botMessages.readSteering("owner", "super", guard);
    expect(steerSettings).toMatchObject({ botId: "super", supported: true, allowed: true });
  });

  it("preserves upgrade compatibility: existing single conversation receives tickets created without explicit conversationId", async () => {
    const legacyTicket = await hub.dispatch.create(owner, "super", { requestId: "legacy-1", title: "Legacy Task", request: "Keep working" });
    expect(legacyTicket.conversationId).toBe(firstChat.id);
    const working = await hub.dispatch.dispatch(owner, "super", { requestId: "legacy-go", ticketId: legacyTicket.id, engine: "codex" });
    await settleTicket(working, "Done.");
    const notices = await hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=? AND bot_source_json IS NOT NULL", [firstChat.id]);
    expect(notices).toHaveLength(1);
  });
});
