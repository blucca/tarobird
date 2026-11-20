import { useRef } from "react";
import { GitFork, History } from "lucide-react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";
import type { ConversationHistory } from "./use-conversation-history.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import "./conversation-history.css";

export function ConversationHistoryDialog({ history }: { history: ConversationHistory }) {
  useLocale();
  const cancel = useRef<HTMLButtonElement>(null);
  const { view } = history, action = view.intent?.action ?? view.pending?.change.action;
  if (!view.open) return null;
  const rewind = action?.kind === "rewind", whole = action?.kind === "fork" && action.scope === "whole";
  const syncing = history.recovery && view.result?.state === "applied";
  const title = history.recovery ? t("核对历史操作") : rewind ? t("回退到这条消息之前？") : action ? whole ? t("分叉当前对话？") : t("从此处分叉？") : t("历史操作结果");
  return <CreationDialog title={title} closeLabel={t("关闭历史操作")} close={history.close} busy={view.busy} initialFocus={cancel} returnFocus={history.returnFocus} className="history-dialog">
    {view.intent?.excerpt && <p className="history-message-excerpt">{view.intent.excerpt}</p>}
    {view.intent && !history.recovery && <>
      {rewind ? <p>{t("后续对话将使用这条消息之前的上下文。这条消息及之后被回退的记录仍可查看，并标记为“已排除出上下文”。只回退对话上下文，工作区文件不会回滚。")}</p>
        : <><p>{whole ? t("新对话会沿用当前会话的上下文，原对话保持不变。") : view.intent.boundary === "before-input" ? t("新对话会沿用这条消息之前的上下文，原对话保持不变。") : t("新对话会沿用直到本轮回复结束的上下文，原对话保持不变。")}</p><p className="muted">{t("两个对话继续使用同一工作区；此操作不会复制或回滚文件。")}</p></>}
    </>}
    {history.recovery && <p>{syncing ? view.result?.destinationConversationId ? t("分叉已创建，正在同步列表。") : t("上下文已回退，正在同步历史。") : t("操作结果尚未确认。核对结果不会再次执行回退或创建分叉。")}</p>}
    {view.busy && <p role="status">{syncing ? t("正在同步操作结果…") : view.intent ? rewind ? t("正在回退…") : t("正在创建分叉…") : t("正在核对结果…")}</p>}
    {view.notice && <p role="status">{view.notice}</p>}
    {view.error && <p className="error-text" role="alert">{syncing ? t("结果已保存，显示同步尚未完成。请核对结果。") : view.error}</p>}
    {view.intent && !history.recovery && history.reason && <p className="muted">{history.reason}</p>}
    <div className="history-dialog-actions">
      <button type="button" ref={cancel} disabled={view.busy} onClick={history.close}>{view.intent && !history.recovery ? t("取消") : t("关闭")}</button>
      {history.recovery ? <button type="button" className="primary" disabled={!history.canCheck} onClick={history.check}>{t("核对结果")}</button>
        : view.destination ? <button type="button" className="primary" onClick={history.openDestination}>{t("打开分叉对话")}</button>
          : view.intent && <button type="button" className="primary" disabled={view.busy || !!history.reason} onClick={history.submit}>{rewind ? t("确认回退") : t("创建分叉对话")}</button>}
    </div>
  </CreationDialog>;
}

export function ConversationHistoryStatus({ history }: { history: ConversationHistory }) {
  useLocale();
  if (!history.recovery && !history.view.notice) return null;
  const text = history.view.result?.state === "applied" ? history.view.result.destinationConversationId ? t("分叉已创建，正在同步列表。") : t("上下文已回退，正在同步历史。") : t("操作结果尚未确认，请先核对。");
  return <div className="history-status"><span role="status">{history.recovery ? text : history.view.notice}</span>{history.recovery && <button type="button" onClick={event => history.recover(event.currentTarget)}>{t("核对结果")}</button>}</div>;
}

export function HistoryExclusion({ message }: { message: Message }) {
  useLocale();
  return message.historyContext ? <span className="history-excluded" title={t("回退后保留的记录，不会自动带入后续上下文。") }><History size={12} aria-hidden/>{t("已排除出上下文")}</span> : null;
}

export function ConversationHistoryOrigin({ conversation, source, open, details = false }: { conversation: Conversation; source?: Conversation; open: (id: string) => void; details?: boolean }) {
  useLocale();
  const origin = conversation.historyOrigin;
  if (!origin) return null;
  const boundary = origin.boundary === "whole" ? t("已继承原会话的上下文，之前的消息保留在原对话中。") : origin.boundary === "before-input" ? t("已继承所选消息之前的上下文，之前的消息保留在原对话中。") : t("已继承直到所选轮次结束的上下文，之前的消息保留在原对话中。");
  return <div className={details ? "history-origin-details" : "history-origin"}>
    {!details && <GitFork size={15} aria-hidden/>}<span><span>{source ? t("分叉自「{0}」", source.title) : t("此对话来自一次分叉。")}</span>{" "}<span>{boundary}</span></span>
    {source ? <button type="button" onClick={() => open(source.id)}>{t("查看原对话")}</button> : <span>{t("原对话当前不可访问")}</span>}
  </div>;
}
