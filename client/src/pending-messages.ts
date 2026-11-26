import { forwardedBlocks, messageAttachmentIds } from "../../src/client-protocol/forwarding.js";
import type { Block, ClientFrame, Message } from "../../src/client-protocol/index.js";
import { t } from "./i18n.js";

export type OutboxViewItem = {
  id: string;
  order: number;
  frame: ClientFrame;
  copyable: boolean;
  text: string;
  expired: boolean;
  error?: string;
  blocked: boolean;
  sent: boolean;
  syncing: boolean;
};

type UploadedAttachmentMeta = { name: string; size: number; mime: string };
type ForwardedPreviewMeta = Pick<Message, "blocks" | "forwardedFrom" | "previewUrl" | "previewStyle" | "linkPreview">;

const MAX_REMEMBERED_ATTACHMENTS = 256;
const MAX_REMEMBERED_FORWARDS = 128;
const uploadedAttachments = new Map<string, UploadedAttachmentMeta>();
const forwardedPreviews = new Map<string, ForwardedPreviewMeta>();

function rememberBounded<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Remember uploaded attachment metadata so a pending bubble renders the same
 * image, audio, or file card as the canonical message before history refreshes. */
export function rememberUploadedAttachment(attachmentId: string, file: { name: string; size: number; type: string }) {
  rememberBounded(uploadedAttachments, attachmentId, {
    name: file.name,
    size: file.size,
    mime: file.type.split(";")[0] || "application/octet-stream",
  }, MAX_REMEMBERED_ATTACHMENTS);
}

/** Remember forwarded message content so a pending forward renders in its final
 * forwarded-bubble layout before the Hub event reaches local history. */
export function rememberForwardedMessage(
  clientMsgId: string,
  source: Message,
  sourceConversationTitle?: string,
  sourceAuthorName?: string,
) {
  const identityAttachments = new Map<string, string>();
  for (const id of messageAttachmentIds(source.blocks)) identityAttachments.set(id, id);
  if (source.linkPreview?.imageAttachmentId) {
    identityAttachments.set(source.linkPreview.imageAttachmentId, source.linkPreview.imageAttachmentId);
  }
  rememberBounded(forwardedPreviews, clientMsgId, {
    blocks: forwardedBlocks(source.blocks, identityAttachments),
    forwardedFrom: {
      messageId: source.id,
      conversationId: source.conversationId,
      conversationTitle: sourceConversationTitle ?? "",
      authorName: (sourceAuthorName ?? "").slice(0, 256),
      createdAt: source.createdAt,
    },
    ...(source.previewUrl !== undefined ? { previewUrl: source.previewUrl } : {}),
    ...(source.previewStyle ? { previewStyle: source.previewStyle } : {}),
    ...(source.linkPreview ? { linkPreview: source.linkPreview } : {}),
  }, MAX_REMEMBERED_FORWARDS);
}

export function clearRememberedPendingPreviewsForTest() {
  uploadedAttachments.clear();
  forwardedPreviews.clear();
}

export function pendingMessageBlocks(frame: Extract<ClientFrame, { type: "message.send" }>): Block[] {
  const blocks: Block[] = frame.text ? [{ type: "text", text: frame.text }] : [];
  for (const id of frame.attachments) {
    const meta = uploadedAttachments.get(id);
    if (!meta) {
      blocks.push({ type: "file", attachmentId: id, name: t("附件"), size: 0, mime: "application/octet-stream" });
      continue;
    }
    blocks.push(
      meta.mime.startsWith("image/") ? { type: "image", attachmentId: id, title: meta.name }
      : meta.mime.startsWith("audio/") ? { type: "audio", attachmentId: id, name: meta.name }
      : { type: "file", attachmentId: id, name: meta.name, size: meta.size, mime: meta.mime },
    );
  }
  return blocks;
}

/** Split outbox items into normal online message bubbles (rendered seamlessly in
 * the message list) and attention-needing rows (failed, blocked, or offline). */
export function partitionOutboxItems<T extends OutboxViewItem>(
  queued: readonly T[],
  messages: readonly Message[],
  online: boolean,
  authorId: string,
): { pendingMessages: Message[]; pendingById: Map<string, T>; attentionQueued: T[] } {
  const existing = new Set<string>();
  for (const message of messages) if (message.clientMsgId) existing.add(message.clientMsgId);
  const pendingMessages: Message[] = [];
  const pendingById = new Map<string, T>();
  const attentionQueued: T[] = [];

  for (const item of queued) {
    if (!item.error && existing.has(item.id)) continue;
    const isMessage = item.frame.type === "message.send" || item.frame.type === "message.forward";
    const needsAttention = !!item.error || item.blocked || (!online && !item.sent && !item.syncing);
    if (needsAttention) {
      attentionQueued.push(item);
      continue;
    }
    if (!isMessage) continue;
    let message: Message;
    if (item.frame.type === "message.send") {
      const frame = item.frame;
      message = {
        id: item.id,
        conversationId: frame.conversationId,
        authorId,
        authorType: "user",
        blocks: pendingMessageBlocks(frame),
        status: "pending",
        version: 1,
        clientMsgId: frame.clientMsgId,
        ...(frame.mentions?.length ? { mentions: frame.mentions } : {}),
        ...(frame.replyTo ? { replyTo: frame.replyTo } : {}),
        ...(frame.previewUrl !== undefined ? { previewUrl: frame.previewUrl } : {}),
        ...(frame.previewUrl && frame.previewStyle ? { previewStyle: frame.previewStyle } : {}),
        createdAt: item.order,
      };
    } else if (item.frame.type === "message.forward") {
      const frame = item.frame;
      const preview = forwardedPreviews.get(item.id);
      message = {
        id: item.id,
        conversationId: frame.conversationId,
        authorId,
        authorType: "user",
        blocks: preview?.blocks ?? [{ type: "text", text: t("转发消息") }],
        status: "pending",
        version: 1,
        clientMsgId: frame.clientMsgId,
        ...(frame.mentions?.length ? { mentions: frame.mentions } : {}),
        ...(preview?.forwardedFrom ? { forwardedFrom: preview.forwardedFrom } : {}),
        ...(preview?.previewUrl !== undefined ? { previewUrl: preview.previewUrl } : {}),
        ...(preview?.previewStyle ? { previewStyle: preview.previewStyle } : {}),
        ...(preview?.linkPreview ? { linkPreview: preview.linkPreview } : {}),
        createdAt: item.order,
      };
    } else {
      continue;
    }
    pendingMessages.push(message);
    pendingById.set(item.id, item);
  }
  return { pendingMessages, pendingById, attentionQueued };
}
