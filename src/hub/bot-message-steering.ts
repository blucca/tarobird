import type { Block } from "../client-protocol/index.js";
import { botMessageSteeringProofPayload, type BotMessageSteeringCommand, type BotSteerFallbackReason } from "../client-protocol/bot-message-delivery.js";
import { hashSecret } from "./auth.js";
import type { BotSteerCall, BotSteerReconcileCall } from "../client-protocol/steering.js";

/** Hub → Gateway calls used by a receiving Host to merge a signed Bot message
 * into the recipient's live turn (issue #62). Owned by HubServer. */
export interface BotMessageSteeringHooks {
  /** `undefined` while no worker is attached; `false` for a worker without bot-messages.steer.v1. */
  capable(botId: string): boolean | undefined;
  status(botId: string, conversationId: string): Promise<unknown>;
  steer(botId: string, call: BotSteerCall): Promise<unknown>;
  /** Never steers; see botSteerReconcileCallSchema. */
  reconcile(botId: string, call: BotSteerReconcileCall): Promise<unknown>;
}
/** Gateway RPC deadlines. A send that asks to steer waits for at most status
 * + steer (~13 s) beyond a queued send; within the sender's 15 s peer
 * exchange for a text request. Reconciliation runs during wait/replay. */
export const STEER_STATUS_TIMEOUT_MS = 3_000, STEER_CALL_TIMEOUT_MS = 10_000, STEER_RECONCILE_TIMEOUT_MS = 5_000;
export const offlineSteering: BotMessageSteeringHooks = {
  capable: () => undefined,
  status: async () => { throw new Error("bot_offline"); },
  steer: async () => { throw new Error("bot_offline"); },
  reconcile: async () => { throw new Error("bot_offline"); },
};

/** At most this many Bot steers enter one live turn. A steer starts no new
 * turn and raises no hop count, so this caps two live turns steering each other. */
export const STEER_TURN_LIMIT = 3;
/** Per sender edge (source Host + source Bot → target Bot). */
export const STEER_EDGE_LIMIT = 6;
export const STEER_EDGE_WINDOW_MS = 10 * 60_000;

/** Absent = allowed (owner default 2026-11-21); only a disabled switch is stored. */
export const steeringDisabledKey = (botId: string) => `bot-messages:steering-disabled:${botId}`;
export const botMessageSteeringProofTarget = (command: BotMessageSteeringCommand): string => hashSecret(botMessageSteeringProofPayload(command));

/** The `incoming` request memo. `steer` exists only for requests that asked
 * to steer; older Hubs read `content` alone. */
export type IncomingMemo = { content: string; at: number; steer?: { turn?: string; targetId?: string; reason?: BotSteerFallbackReason } };

const REASON_TEXT: Record<BotSteerFallbackReason, string> = {
  steering_disabled: "接收方未允许其他 Bot 引导", unsupported_engine: "目标引擎不支持引导", unsupported_conversation: "仅支持直连对话",
  attachments_unsupported: "引导只能追加文字", bot_offline: "目标 Bot 离线", worker_update_required: "目标 Bot 需要更新",
  receiver_update_required: "接收主机需要更新", status_unavailable: "无法确认对方状态", no_active_turn: "对方这个对话里没有进行中的回复",
  background_review: "对方正在后台复核", turn_not_from_sender: "进行中的回复不是由发送方发起", pending_card: "对方在等待审批或回答",
  turn_steer_limit: "这次回复已达引导次数上限", steer_rate_limited: "引导过于频繁", turn_ended: "对方的回复刚好结束",
  engine_not_ready: "对方引擎暂不接受引导", session_busy: "对方会话正忙于其他对话", session_changed: "对方会话已切换",
};
/** Host notice on a Bot message that asked to steer but was queued. Cards
 * carrying `extra.promptQueue` stay out of the engine prompt (blocksText). */
export function steerFallbackNotice(botId: string, reason: BotSteerFallbackReason): Extract<Block, { type: "card" }> {
  return { type: "card", elements: [{ type: "markdown", text: `未能并入正在进行的回复（${REASON_TEXT[reason]}），已改为排队。` }], extra: { promptQueue: { state: "steer_fallback", botId, reason } } };
}
