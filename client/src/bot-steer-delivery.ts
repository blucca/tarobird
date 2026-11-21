import type { Block } from "../../src/client-protocol/index.js";
import { t } from "./i18n.js";

/** Display text for a Bot message the receiving Host queued instead of
 * steering (issue #62). Keys match the Host's notice so older Apps show the
 * Host's own Chinese sentence unchanged. */
const REASONS: Record<string, string> = {
  steering_disabled: "接收方未允许其他 Bot 引导", unsupported_engine: "目标引擎不支持引导", unsupported_conversation: "仅支持直连对话",
  attachments_unsupported: "引导只能追加文字", bot_offline: "目标 Bot 离线", worker_update_required: "目标 Bot 需要更新",
  receiver_update_required: "接收主机需要更新", status_unavailable: "无法确认对方状态", no_active_turn: "对方这个对话里没有进行中的回复",
  background_review: "对方正在后台复核", turn_not_from_sender: "进行中的回复不是由发送方发起", pending_card: "对方在等待审批或回答",
  turn_steer_limit: "这次回复已达引导次数上限", steer_rate_limited: "引导过于频繁", turn_ended: "对方的回复刚好结束",
  engine_not_ready: "对方引擎暂不接受引导", session_busy: "对方会话正忙于其他对话", session_changed: "对方会话已切换",
  blank_text: "空白内容不能引导", self_target: "Bot 不能引导自己",
};
/** Why a Bot's steer ended without being merged or queued. */
const NOT_DELIVERED: Record<string, string> = { grant_revoked: "发送方的授权已撤销", source_not_peer: "发送方主机已不在网络中", bot_deleted: "目标 Bot 已删除" };
export function steerFallbackText(reason: unknown): string {
  const known = typeof reason === "string" ? REASONS[reason] : undefined;
  return known ? t("未能并入正在进行的回复（{0}），已改为排队。", t(known)) : t("未能并入正在进行的回复，已改为排队。");
}
/** The Host notice card of a steer request that was queued, if this is one. */
export function steerFallbackReason(block: Block): { reason?: string } | undefined {
  const queue = block.type === "card" ? block.extra?.promptQueue : undefined;
  if (!queue || typeof queue !== "object" || Array.isArray(queue) || queue.state !== "steer_fallback") return undefined;
  return { reason: typeof queue.reason === "string" ? queue.reason : undefined };
}
/** A Bot's message merged into a live reply. It has no owner actions. */
export function botSteerLabel(block: Extract<Block, { type: "steering" }>): string {
  if (block.application?.status === "dropped") return t("已并入，但对方未处理这段补充");
  if (block.application?.status === "applied" || block.application?.status === "absorbed") return t("已并入正在进行的回复，已进入模型上下文");
  if (block.outcome === "rejected") return block.reason && NOT_DELIVERED[block.reason] ? t("未投递（{0}）", t(NOT_DELIVERED[block.reason]!)) : t("未投递");
  if (block.outcome === "accepted") return t("已并入正在进行的回复");
  if (block.outcome === "pending") return t("正在并入正在进行的回复…");
  // Only the Gateway's own "cannot tell" is final; otherwise the Host is still checking.
  return block.reason === "gateway_uncertain" ? t("无法确认是否已并入；不会再次排队") : t("正在确认是否已并入…");
}
