import { blocksText, type Message } from "../../src/client-protocol/index.js";

export type MessageRailItem = {
  id: string;
  /** Index inside `displayedMessages` (virtualizer row index). */
  index: number;
  /** 1-based ordinal among all rail items in the conversation. */
  turnNumber: number;
  /** Single-line user prompt / trigger summary. */
  prompt: string;
  /** Optional single-line preview of the first Bot reply to this turn. */
  replyPreview?: string;
  /** Optional reply author label (populated for group chats or multi-bot replies). */
  replyAuthor?: string;
  /** Optional source label for delegated/automated turns. */
  sourceLabel?: string;
  createdAt: number;
};

export type BuildMessageRailOptions = {
  /** Fallback text when a user message contains only non-text blocks. */
  attachmentFallback?: string;
  /** Fallback text when a message has only card/interactive blocks. */
  cardFallback?: string;
  /** Resolve a Bot's display name (used in reply previews). */
  botName?: (botId: string) => string | undefined;
  /** Whether this conversation is a group chat (includes reply author in preview). */
  isGroup?: boolean;
};

const MAX_PROMPT_CHARS = 120;
const MAX_REPLY_CHARS = 120;

function collapseLine(raw: string, limit: number): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function summarizeMessage(message: Message, attachmentFallback: string, cardFallback: string): string {
  const plainText = collapseLine(
    message.blocks
      .filter((block): block is Extract<Message["blocks"][number], { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(" "),
    MAX_PROMPT_CHARS,
  );
  if (plainText) return plainText;
  const media = message.blocks
    .filter((block) => block.type === "file" || block.type === "image" || block.type === "audio")
    .map((block) => ("name" in block && typeof block.name === "string" && block.name.trim()) ? block.name.trim() : "")
    .filter(Boolean);
  if (media.length) return collapseLine(media.join(" · "), MAX_PROMPT_CHARS);
  if (message.blocks.some((block) => block.type === "file" || block.type === "image" || block.type === "audio")) {
    return attachmentFallback;
  }
  const fallback = collapseLine(blocksText(message.blocks), MAX_PROMPT_CHARS);
  return fallback || cardFallback;
}

/** Whether a displayed message represents a user-turn anchor on the right-edge rail.
 * Excludes deleted messages and internal group-discussion speaker handoffs. */
export function isRailAnchorMessage(message: Message): boolean {
  if (message.status === "deleted") return false;
  if (message.authorType !== "user") return false;
  if (message.groupDiscussion?.role === "input") return false;
  return true;
}

/** Build ordered message-rail entries from `displayedMessages`. */
export function buildMessageRailItems(
  displayedMessages: readonly Message[],
  options: BuildMessageRailOptions = {},
): MessageRailItem[] {
  const attachmentFallback = options.attachmentFallback ?? "[Attachment]";
  const cardFallback = options.cardFallback ?? "[Message]";
  const anchors: Array<{ message: Message; index: number }> = [];
  const replyByTarget = new Map<string, Message>();

  for (let index = 0; index < displayedMessages.length; index++) {
    const message = displayedMessages[index]!;
    if (isRailAnchorMessage(message)) {
      anchors.push({ message, index });
    } else if (message.status !== "deleted" && message.authorType === "bot" && message.replyTo && !replyByTarget.has(message.replyTo)) {
      replyByTarget.set(message.replyTo, message);
    }
  }

  return anchors.map(({ message, index }, ordinal) => {
    const nextAnchorIndex = anchors[ordinal + 1]?.index ?? displayedMessages.length;
    let reply = replyByTarget.get(message.id);
    if (!reply) {
      // Fall back to the first non-deleted Bot message before the next user turn.
      for (let cursor = index + 1; cursor < nextAnchorIndex; cursor++) {
        const candidate = displayedMessages[cursor]!;
        if (candidate.status === "deleted" || candidate.authorType !== "bot") continue;
        reply = candidate;
        break;
      }
    }

    const replyPreview = reply
      ? collapseLine(summarizeMessage(reply, attachmentFallback, cardFallback), MAX_REPLY_CHARS)
      : undefined;
    const replyAuthor = reply && options.isGroup
      ? (options.botName?.(reply.authorId) || reply.authorId)
      : undefined;
    const sourceLabel = message.botSource?.botName
      ? (message.botSource.hostName ? `${message.botSource.hostName} · ${message.botSource.botName}` : message.botSource.botName)
      : undefined;

    return {
      id: message.id,
      index,
      turnNumber: ordinal + 1,
      prompt: summarizeMessage(message, attachmentFallback, cardFallback),
      ...(replyPreview ? { replyPreview } : {}),
      ...(replyAuthor ? { replyAuthor } : {}),
      ...(sourceLabel ? { sourceLabel } : {}),
      createdAt: message.createdAt,
    };
  });
}

/** Evenly sample long histories down to at most `maxTicks` ticks while ALWAYS
 * preserving the first item, the last item, and the currently active item. */
export function sampleMessageRailItems(
  items: readonly MessageRailItem[],
  activeId: string | undefined,
  maxTicks = 44,
): MessageRailItem[] {
  if (items.length <= maxTicks || maxTicks < 3) return [...items];

  const lastIndex = items.length - 1;
  const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
  const picked = new Set<number>([0, lastIndex]);
  if (activeIndex >= 0) picked.add(activeIndex);

  const slots = maxTicks - picked.size;
  if (slots > 0) {
    const step = lastIndex / (maxTicks - 1);
    for (let i = 1; i < maxTicks - 1 && picked.size < maxTicks; i++) {
      const candidate = Math.round(i * step);
      if (candidate > 0 && candidate < lastIndex) picked.add(candidate);
    }
    // Fill any rounding collisions deterministically from interior indices.
    if (picked.size < maxTicks) {
      for (let candidate = 1; candidate < lastIndex && picked.size < maxTicks; candidate++) {
        picked.add(candidate);
      }
    }
  }

  return [...picked].sort((a, b) => a - b).map((idx) => items[idx]!);
}

/** Pick the active rail item for the reader's current position in `displayedMessages`.
 * When `atBottom` is true, highlights the final turn. Otherwise selects the latest
 * turn whose `index <= anchorMessageIndex` (clamped to the first turn). */
export function findActiveRailItemId(
  items: readonly MessageRailItem[],
  anchorMessageIndex: number,
  atBottom = false,
): string | undefined {
  if (!items.length) return undefined;
  if (atBottom) return items[items.length - 1]!.id;
  let active = items[0]!;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.index <= anchorMessageIndex) active = item;
    else break;
  }
  return active.id;
}
