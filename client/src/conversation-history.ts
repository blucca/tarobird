import { blocksText, type Conversation, type Message } from "../../src/client-protocol/index.js";
import {
  upstreamRejectionSchema,
  type HistoryError,
  type HistoryStatus,
  type RewindRange,
  type UpstreamRejection,
} from "../../src/client-protocol/history.js";
import type { BackgroundTaskGroup } from "./background-task-groups.js";

export type HistoryBlockedReason = NonNullable<HistoryStatus["blocked"]>;

/** Match the Hub/Gateway slash-token grammar (`src/hub/prompt-queue.ts`), not Unix paths like `/tmp/log`. */
const SLASH_COMMAND_RE = /^\/[a-z][\w.-]*(?:@[a-z0-9_][\w.-]*)?(?=\s|$)/i;

export function isHistorySlashCommand(message: Message): boolean {
  return !message.botSource && !message.forwardedFrom && SLASH_COMMAND_RE.test(blocksText(message.blocks).trim());
}

export function isCancelledQueueMessage(message: Message): boolean {
  return message.blocks.some(block =>
    block.type === "card"
    && !!block.extra?.promptQueue
    && typeof block.extra.promptQueue === "object"
    && !Array.isArray(block.extra.promptQueue)
    && (block.extra.promptQueue as { state?: unknown }).state === "cancelled");
}

/** True when a message falls inside any completed rewind range (inclusive union). */
export function isMessageRewound(
  message: Pick<Message, "id" | "createdAt">,
  rewinds: readonly RewindRange[] | undefined,
): boolean {
  if (!rewinds?.length) return false;
  for (const range of rewinds) {
    if (message.id === range.fromMessageId || message.id === range.throughMessageId) return true;
    const low = Math.min(range.fromCreatedAt, range.throughCreatedAt);
    const high = Math.max(range.fromCreatedAt, range.throughCreatedAt);
    if (message.createdAt >= low && message.createdAt <= high) return true;
  }
  return false;
}

export function resolveSinceCreatedAt(
  messages: readonly Message[],
  sinceMessageId: string | undefined,
): number | undefined {
  if (!sinceMessageId) return undefined;
  return messages.find(message => message.id === sinceMessageId)?.createdAt;
}

/** Whether a single user message can serve as a rewind/fork anchor (§5.1). */
export function isEligibleHistoryAnchor(
  message: Message,
  context: { rewinds?: readonly RewindRange[]; sinceCreatedAt?: number },
): boolean {
  if (message.authorType !== "user") return false;
  if (message.status !== "complete") return false;
  if (message.blocks.some(block => block.type === "steering")) return false;
  if (isHistorySlashCommand(message)) return false;
  if (isCancelledQueueMessage(message)) return false;
  if (isMessageRewound(message, context.rewinds)) return false;
  if (context.sinceCreatedAt !== undefined && message.createdAt < context.sinceCreatedAt) return false;
  return true;
}

/** Chinese source keys (matched in `locales/en.json`) for §5.1 `blocked` reasons. */
export function historyBlockedReasonKey(blocked: HistoryBlockedReason): string {
  switch (blocked) {
    case "running": return "当前轮结束或停止后可用";
    case "queued": return "排队消息发完或取消后可用";
    case "pending_action": return "先回答 Bot 的提问或审批";
    case "goal_active": return "先暂停或清除目标";
    case "background_work": return "后台任务结束后可用";
    case "operation_active": return "另一台设备正在操作";
    case "no_main_session": return "先和 Bot 聊一轮";
  }
}

/** Chinese source keys (matched in `locales/en.json`) for §4.1 / §4.4 / §5.2 `HistoryError` values. */
export function historyErrorKey(error: HistoryError): string {
  switch (error) {
    case "unsupported": return "当前引擎或对话不支持此操作，请检查主机版本。";
    case "busy": return "请等待当前轮次、排队或待处理请求结束后再试。";
    case "goal_active": return "请先暂停或清除目标后再试。";
    case "no_main_session": return "请先和 Bot 聊一轮后再操作。";
    case "history_changed": return "对话有新消息，请再确认一次。";
    case "not_an_anchor": return "这条消息不能作为起点，请换一条消息。";
    case "already_rewound": return "这条消息已在回退区间内。";
    case "session_changed": return "只能在当前上下文范围内操作。";
    case "turn_unresolved": return "无法定位对应的历史轮次，建议新开对话。";
    case "engine_busy": return "会话正被其他客户端占用，请稍后再试。";
    case "engine_failed": return "操作失败，请重试。";
    case "uncertain": return "分叉没有完成，没有创建新对话，可以重新分叉。";
  }
}

export type ConversationHistoryEntries = {
  showForkHead: boolean;
  disabled: boolean;
  blockedReasonKey?: string;
};

/** Conversation-level menu / settings visibility (§5.1). */
export function conversationHistoryEntries(input: {
  historyAvailable: boolean;
  status?: HistoryStatus;
  conversation?: Conversation;
  online: boolean;
  readOnly?: boolean;
}): ConversationHistoryEntries {
  const { historyAvailable, status, conversation, online, readOnly } = input;
  if (!historyAvailable || !status?.supported || !conversation || conversation.archived) {
    return { showForkHead: false, disabled: false };
  }
  const showForkHead = status.fork === "turn" || status.fork === "head";
  if (!showForkHead) return { showForkHead: false, disabled: false };
  if (readOnly) return { showForkHead: true, disabled: true, blockedReasonKey: "当前为只读模式，无法执行此操作。" };
  if (!online) return { showForkHead: true, disabled: true, blockedReasonKey: "连接恢复后即可操作" };
  if (status.blocked) {
    return { showForkHead: true, disabled: true, blockedReasonKey: historyBlockedReasonKey(status.blocked) };
  }
  return { showForkHead: true, disabled: false };
}

export type MessageHistoryEntries = {
  showForkTurn: boolean;
  showRewind: boolean;
  disabled: boolean;
  blockedReasonKey?: string;
};

/** Per-message menu visibility (§5.1). */
export function messageHistoryEntries(input: {
  historyAvailable: boolean;
  status?: HistoryStatus;
  conversation?: Conversation;
  message: Message;
  messages: readonly Message[];
  online: boolean;
  readOnly?: boolean;
}): MessageHistoryEntries {
  const { historyAvailable, status, conversation, message, messages, online, readOnly } = input;
  if (!historyAvailable || !status?.supported || !conversation || conversation.archived) {
    return { showForkTurn: false, showRewind: false, disabled: false };
  }
  const showForkTurn = status.fork === "turn";
  const showRewind = status.rewind === "turn";
  if (!showForkTurn && !showRewind) return { showForkTurn: false, showRewind: false, disabled: false };
  const sinceCreatedAt = resolveSinceCreatedAt(messages, status.sinceMessageId);
  if (!isEligibleHistoryAnchor(message, { rewinds: conversation.history?.rewinds, sinceCreatedAt })) {
    return { showForkTurn: false, showRewind: false, disabled: false };
  }
  if (readOnly) return { showForkTurn, showRewind, disabled: true, blockedReasonKey: "当前为只读模式，无法执行此操作。" };
  if (!online) return { showForkTurn, showRewind, disabled: true, blockedReasonKey: "连接恢复后即可操作" };
  if (status.blocked) {
    return { showForkTurn, showRewind, disabled: true, blockedReasonKey: historyBlockedReasonKey(status.blocked) };
  }
  return { showForkTurn, showRewind, disabled: false };
}

/** Computes the `{0}` count and first-in-context flag for the rewind confirmation dialog (§5.2). */
export function computeRewindSummary(
  messages: readonly Message[],
  targetMessageId: string,
  status: HistoryStatus | undefined,
  rewinds: readonly RewindRange[] | undefined,
): { isFirstInContext: boolean; laterCount: number } {
  const visible = messages.filter(message => message.status !== "deleted");
  const index = visible.findIndex(message => message.id === targetMessageId);
  if (index < 0) return { isFirstInContext: false, laterCount: 0 };
  const sinceCreatedAt = resolveSinceCreatedAt(visible, status?.sinceMessageId);
  const laterCount = visible.slice(index + 1).filter(message => !isMessageRewound(message, rewinds)).length;
  if (status?.sinceMessageId && targetMessageId === status.sinceMessageId) {
    return { isFirstInContext: true, laterCount };
  }
  const hasEarlierAnchor = visible.slice(0, index).some(message =>
    isEligibleHistoryAnchor(message, { rewinds, sinceCreatedAt }));
  return { isFirstInContext: !hasEarlierAnchor, laterCount };
}

export type RewindGroupRow = {
  kind: "rewind-group";
  key: string;
  firstId: string;
  lastId: string;
  count: number;
  expanded: boolean;
  messageIds: string[];
};

export type MessageTimelineRow = {
  kind: "message";
  key: string;
  message: Message;
  rewound: boolean;
  groupKey?: string;
};

export type TimelineRow = RewindGroupRow | MessageTimelineRow;

/** Projects displayed messages into virtual rows, collapsing consecutive rewound
 * messages into one `<details>` notice row by default (§5.3). When a group is
 * expanded locally, its individual messages follow the header row so context
 * menus, action sheets, virtualization and message location all keep working. */
export function buildTimelineRows(
  displayedMessages: readonly Message[],
  rewinds: readonly RewindRange[] | undefined,
  expandedGroups: ReadonlySet<string>,
  backgroundByAnchor?: ReadonlyMap<string, BackgroundTaskGroup>,
): { rows: TimelineRow[]; groupByMessageId: Map<string, string> } {
  const rows: TimelineRow[] = [];
  const groupByMessageId = new Map<string, string>();
  if (!rewinds?.length) {
    for (const message of displayedMessages) {
      rows.push({ kind: "message", key: backgroundByAnchor?.get(message.id)?.key ?? message.id, message, rewound: false });
    }
    return { rows, groupByMessageId };
  }
  let run: Message[] = [];
  const flush = () => {
    if (!run.length) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const key = `rewind:${first.id}`;
    const expanded = expandedGroups.has(key);
    const count = run.reduce((sum, item) => sum + (backgroundByAnchor?.get(item.id)?.tasks.length ?? 1), 0);
    const messageIds = run.map(item => item.id);
    for (const item of run) groupByMessageId.set(item.id, key);
    rows.push({ kind: "rewind-group", key, firstId: first.id, lastId: last.id, count, expanded, messageIds });
    if (expanded) {
      for (const item of run) {
        rows.push({
          kind: "message",
          key: backgroundByAnchor?.get(item.id)?.key ?? item.id,
          message: item,
          rewound: true,
          groupKey: key,
        });
      }
    }
    run = [];
  };
  for (const message of displayedMessages) {
    if (isMessageRewound(message, rewinds)) {
      run.push(message);
    } else {
      flush();
      rows.push({ kind: "message", key: backgroundByAnchor?.get(message.id)?.key ?? message.id, message, rewound: false });
    }
  }
  flush();
  return { rows, groupByMessageId };
}

/** Parses `extra.upstreamRejection` from any card block on a message (§5.6). */
export function messageUpstreamRejection(message: Message): UpstreamRejection | undefined {
  for (const block of message.blocks) {
    if (block.type !== "card") continue;
    const parsed = upstreamRejectionSchema.safeParse(block.extra?.upstreamRejection);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

/** Returns the ID of the LAST non-deleted, non-rewound message carrying `upstreamRejection` (§5.6). */
export function findLastUpstreamRejectionMessageId(
  messages: readonly Message[],
  rewinds: readonly RewindRange[] | undefined,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.status === "deleted" || isMessageRewound(message, rewinds)) continue;
    if (messageUpstreamRejection(message)) return message.id;
  }
  return undefined;
}

export type UpstreamRejectionAction =
  | { kind: "rewind"; targetMessageId: string; disabled: boolean; blockedReasonKey?: string }
  | { kind: "fork"; targetMessageId: string; disabled: boolean; blockedReasonKey?: string }
  | { kind: "new-chat" };

/** Resolves the recovery buttons below the last upstream-rejection failure card (§5.6). */
export function resolveUpstreamRejectionActions(input: {
  messages: readonly Message[];
  rejection: UpstreamRejection;
  historyAvailable: boolean;
  status?: HistoryStatus;
  rewinds?: readonly RewindRange[];
  online: boolean;
  readOnly?: boolean;
  canCreateChat: boolean;
}): { primary?: UpstreamRejectionAction; secondary?: UpstreamRejectionAction } {
  const { messages, rejection, historyAvailable, status, rewinds, online, readOnly, canCreateChat } = input;
  const visible = messages.filter(message => message.status !== "deleted");
  const sinceCreatedAt = resolveSinceCreatedAt(visible, status?.sinceMessageId);
  const firstIndex = visible.findIndex(message => message.id === rejection.firstMessageId);
  const firstMessage = firstIndex >= 0 ? visible[firstIndex] : undefined;
  const disabled = !!readOnly || !online || !!status?.blocked;
  const blockedReasonKey = readOnly
    ? "当前为只读模式，无法执行此操作。"
    : !online
      ? "连接恢复后即可操作"
      : status?.blocked
        ? historyBlockedReasonKey(status.blocked)
        : undefined;
  const newChat: UpstreamRejectionAction | undefined = canCreateChat ? { kind: "new-chat" } : undefined;

  if (historyAvailable && status?.supported && status.rewind === "turn") {
    if (firstMessage && isEligibleHistoryAnchor(firstMessage, { rewinds, sinceCreatedAt })) {
      return {
        primary: { kind: "rewind", targetMessageId: firstMessage.id, disabled, blockedReasonKey },
        ...(newChat ? { secondary: newChat } : {}),
      };
    }
    return newChat ? { primary: newChat } : {};
  }

  if (historyAvailable && status?.supported && status.rewind === "none" && status.fork === "turn") {
    if (firstIndex > 0) {
      for (let i = firstIndex - 1; i >= 0; i--) {
        const candidate = visible[i]!;
        if (isEligibleHistoryAnchor(candidate, { rewinds, sinceCreatedAt })) {
          return {
            primary: { kind: "fork", targetMessageId: candidate.id, disabled, blockedReasonKey },
            ...(newChat ? { secondary: newChat } : {}),
          };
        }
      }
    }
    return newChat ? { primary: newChat } : {};
  }

  return newChat ? { primary: newChat } : {};
}
