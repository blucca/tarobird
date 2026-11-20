import { GitFork, History } from "lucide-react";
import { useId } from "react";
import type { HistoryMenuAction, HistoryMessageActions } from "./conversation-history-state.js";
import { t } from "./i18n.js";
import "./conversation-history.css";

export function HistoryMessageMenu({ actions, phone = false, trigger }: { actions?: HistoryMessageActions; phone?: boolean; trigger: () => HTMLElement | null }) {
  const note = useId();
  if (!actions?.fork && !actions?.rewind) return null;
  const reason = actions.fork?.reason ?? actions.rewind?.reason;
  const items = <>
    {actions.fork && <button type="button" role={phone ? undefined : "menuitem"} disabled={!!actions.fork.reason} aria-describedby={reason ? note : undefined} onClick={() => actions.fork!.run(trigger())}><GitFork size={phone ? 20 : 16} aria-hidden/><span className="action-label">{t("从此处分叉")}</span></button>}
    {actions.rewind && <button type="button" role={phone ? undefined : "menuitem"} disabled={!!actions.rewind.reason} aria-describedby={reason ? note : undefined} onClick={() => actions.rewind!.run(trigger())}><History size={phone ? 20 : 16} aria-hidden/><span className="action-label">{t("回退到这条消息之前")}</span></button>}
    {reason && <p className="history-action-note" id={note}>{reason}</p>}
  </>;
  return phone ? <div className="mobile-chat-action-list message-sheet-list history-message-actions">{items}</div> : <><hr/>{items}</>;
}

export function HistoryForkMenu({ action, phone = false }: { action?: HistoryMenuAction; phone?: boolean }) {
  const note = useId();
  if (!action) return null;
  return <><button type="button" aria-label={t("分叉当前对话")} className={phone ? "action-with-note history-fork-action" : "history-fork-action"} disabled={!!action.reason} aria-describedby={note} onClick={event => action.run(event.currentTarget)}><GitFork size={phone ? 20 : 16} aria-hidden/><span className={phone ? "action-text" : "desktop-menu-text"}><span>{t("分叉当前对话")}</span><small id={note}>{action.reason ?? t("沿用当前上下文，开启新对话")}</small></span></button></>;
}
