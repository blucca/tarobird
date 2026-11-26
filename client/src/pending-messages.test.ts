import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import {
  clearRememberedPendingPreviewsForTest,
  partitionOutboxItems,
  rememberForwardedMessage,
  rememberUploadedAttachment,
  type OutboxViewItem,
} from "./pending-messages.js";

function sendItem(overrides: Partial<OutboxViewItem> = {}): OutboxViewItem {
  const id = overrides.id ?? "client_1";
  return {
    id,
    order: 1700000000100,
    frame: {
      v: 1,
      type: "message.send",
      clientMsgId: id,
      conversationId: "conv_1",
      text: "Hello",
      attachments: [],
    },
    copyable: true,
    text: "Hello",
    expired: false,
    blocked: false,
    sent: false,
    syncing: false,
    ...overrides,
  };
}

function forwardItem(overrides: Partial<OutboxViewItem> = {}): OutboxViewItem {
  const id = overrides.id ?? "forward_1";
  return {
    id,
    order: 1700000000200,
    frame: {
      v: 1,
      type: "message.forward",
      clientMsgId: id,
      conversationId: "conv_2",
      sourceMessageId: "msg_src",
    },
    copyable: false,
    text: "转发消息",
    expired: false,
    blocked: false,
    sent: false,
    syncing: false,
    ...overrides,
  };
}

function cardItem(overrides: Partial<OutboxViewItem> = {}): OutboxViewItem {
  const id = overrides.id ?? "action_1";
  return {
    id,
    order: 1700000000300,
    frame: {
      v: 1,
      type: "interaction.submit",
      clientActionId: id,
      conversationId: "conv_1",
      messageId: "msg_card",
      actionId: "approve",
      values: {},
    },
    copyable: false,
    text: "卡片操作",
    expired: false,
    blocked: false,
    sent: false,
    syncing: false,
    ...overrides,
  };
}

describe("partitionOutboxItems", () => {
  afterEach(() => {
    clearRememberedPendingPreviewsForTest();
  });

  it("renders normal online message.send directly as a user bubble with no attention row", () => {
    rememberUploadedAttachment("att_img", { name: "photo.png", size: 120, type: "image/png" });
    rememberUploadedAttachment("att_doc", { name: "notes.txt", size: 42, type: "text/plain" });
    const item = sendItem({
      frame: {
        v: 1,
        type: "message.send",
        clientMsgId: "client_1",
        conversationId: "conv_1",
        text: "Check https://example.com",
        attachments: ["att_img", "att_doc", "att_unknown"],
        replyTo: "msg_parent",
        previewUrl: "https://example.com",
        previewStyle: "card",
        mentions: ["bot_1"],
      },
    });
    const result = partitionOutboxItems([item], [], true, "owner");
    expect(result.attentionQueued).toEqual([]);
    expect(result.pendingMessages).toHaveLength(1);
    const msg = result.pendingMessages[0]!;
    expect(msg).toMatchObject({
      id: "client_1",
      clientMsgId: "client_1",
      conversationId: "conv_1",
      authorId: "owner",
      authorType: "user",
      replyTo: "msg_parent",
      previewUrl: "https://example.com",
      previewStyle: "card",
      mentions: ["bot_1"],
      status: "pending",
      createdAt: item.order,
    });
    expect(msg.blocks).toEqual([
      { type: "text", text: "Check https://example.com" },
      { type: "image", attachmentId: "att_img", title: "photo.png" },
      { type: "file", attachmentId: "att_doc", name: "notes.txt", size: 42, mime: "text/plain" },
      { type: "file", attachmentId: "att_unknown", name: "附件", size: 0, mime: "application/octet-stream" },
    ]);
    expect(result.pendingById.get("client_1")).toBe(item);
  });

  it("renders normal online message.forward with remembered source blocks and metadata", () => {
    const source: Message = {
      id: "msg_src",
      conversationId: "conv_1",
      authorId: "bot_1",
      authorType: "bot",
      blocks: [
        { type: "text", text: "Forwarded body" },
        { type: "image", attachmentId: "att_1", title: "diagram.png" },
      ],
      status: "complete",
      version: 1,
      createdAt: 1700000000000,
    };
    rememberForwardedMessage("forward_1", source, "Source Chat", "Alpha Bot");
    const item = forwardItem();
    const result = partitionOutboxItems([item], [], true, "owner");
    expect(result.attentionQueued).toEqual([]);
    expect(result.pendingMessages).toHaveLength(1);
    expect(result.pendingMessages[0]).toMatchObject({
      id: "forward_1",
      clientMsgId: "forward_1",
      conversationId: "conv_2",
      authorType: "user",
      forwardedFrom: {
        messageId: "msg_src",
        conversationId: "conv_1",
        conversationTitle: "Source Chat",
        authorName: "Alpha Bot",
        createdAt: 1700000000000,
      },
      blocks: source.blocks,
    });
  });

  it("hides normal online card actions while keeping offline, blocked, and failed actions in attentionQueued", () => {
    const onlineCard = cardItem({ id: "action_online" });
    const onlineResult = partitionOutboxItems([onlineCard], [], true, "owner");
    expect(onlineResult.pendingMessages).toEqual([]);
    expect(onlineResult.attentionQueued).toEqual([]);

    const offlineCard = cardItem({ id: "action_offline" });
    const offlineResult = partitionOutboxItems([offlineCard], [], false, "owner");
    expect(offlineResult.pendingMessages).toEqual([]);
    expect(offlineResult.attentionQueued).toEqual([offlineCard]);

    const failedCard = cardItem({ id: "action_failed", error: "此卡片操作已失效，请查看最新卡片。", expired: true });
    const blockedMsg = sendItem({ id: "client_blocked", blocked: true });
    const failedResult = partitionOutboxItems([failedCard, blockedMsg], [], true, "owner");
    expect(failedResult.pendingMessages).toEqual([]);
    expect(failedResult.attentionQueued).toEqual([failedCard, blockedMsg]);
  });

  it("routes offline un-accepted sends to attentionQueued while keeping sent/syncing items in pendingMessages", () => {
    const offlinePending = sendItem({ id: "c_offline" });
    const alreadySent = sendItem({ id: "c_sent", sent: true });
    const syncing = sendItem({ id: "c_syncing", syncing: true });
    const result = partitionOutboxItems([offlinePending, alreadySent, syncing], [], false, "owner");
    expect(result.attentionQueued).toEqual([offlinePending]);
    expect(result.pendingMessages.map((m) => m.id)).toEqual(["c_sent", "c_syncing"]);
  });

  it("never duplicates a message once the canonical history message has arrived", () => {
    const item = sendItem({ id: "c_done", sent: true });
    const canonical: Message = {
      id: "msg_99",
      conversationId: "conv_1",
      authorId: "owner",
      authorType: "user",
      blocks: [{ type: "text", text: "Hello" }],
      status: "complete",
      version: 1,
      clientMsgId: "c_done",
      createdAt: 1700000000150,
    };
    const result = partitionOutboxItems([item], [canonical], true, "owner");
    expect(result.pendingMessages).toEqual([]);
    expect(result.attentionQueued).toEqual([]);
  });
});
