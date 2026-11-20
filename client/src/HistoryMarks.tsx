import { GitBranch, MessageSquarePlus, Undo2 } from "lucide-react";
import type { ForkOrigin } from "../../src/client-protocol/history.js";
import type { UpstreamRejectionAction } from "./conversation-history.js";
import { formatMessageTime } from "./conversation-inbox.js";
import { t, useLocale } from "./i18n.js";
import "./conversation-history.css";

/** 12px GitBranch glyph before forked conversation titles in list rows (§5.4). */
export function ForkRowMark({ origin, glyph = false }: { origin: ForkOrigin; glyph?: boolean }) {
  useLocale();
  return (
    <span
      className={glyph ? "row-glyph fork-row-glyph" : "fork-row-mark"}
      role="img"
      aria-label={t("分叉对话")}
      title={t("分叉自 {0}", origin.title)}
    >
      <GitBranch size={12} aria-hidden="true"/>
    </span>
  );
}

/** Header badge next to title in a forked conversation (§5.4). Icon-only on tight phones. */
export function ForkOriginHeaderBadge({ origin, onOpen }: { origin: ForkOrigin; onOpen: () => void }) {
  useLocale();
  const label = t("分叉自 {0}", origin.title);
  return (
    <button
      type="button"
      className="fork-origin-badge"
      title={label}
      aria-label={label}
      onClick={onOpen}
    >
      <GitBranch size={12} aria-hidden="true"/>
      <span className="fork-origin-badge-text">{label}</span>
    </button>
  );
}

function compactExcerpt(excerpt: string, max = 36): string {
  const single = excerpt.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

/** Client-rendered top banner inside a forked conversation's message list (§5.4). */
export function ForkOriginBanner({
  origin,
  compactTime = false,
  onOpen,
}: {
  origin: ForkOrigin;
  compactTime?: boolean;
  onOpen: () => void;
}) {
  const locale = useLocale();
  const when = formatMessageTime(origin.at, locale, compactTime);
  const excerpt = origin.mode === "turn" ? compactExcerpt(origin.excerpt) : "";
  const text = excerpt
    ? t("分叉自「{0}」· 截至「{1}」这一轮 · {2}", origin.title, excerpt, when)
    : t("分叉自「{0}」· {1}", origin.title, when);
  return (
    <div className="fork-origin-banner" role="note">
      <span className="fork-origin-banner-text">{text}</span>
      <button type="button" className="fork-origin-open" onClick={onOpen}>{t("查看原对话")}</button>
    </div>
  );
}

/** Centered collapsible notice row for consecutive rewound messages (§5.3).
 * On 320px screens, only the text after the count truncates; the count stays intact. */
export function RewindGroupNotice({
  count,
  expanded,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  useLocale();
  return (
    <details className="dispatch-notice rewind-notice" open={expanded}>
      <summary
        onClick={event => {
          event.preventDefault();
          onToggle();
        }}
      >
        <span className="rewind-notice-count">{t("已回退的 {0} 条消息", count)}</span>
        <span className="rewind-notice-sep" aria-hidden="true"> · </span>
        <span className="rewind-notice-detail">{t("不再进入上下文")}</span>
      </summary>
    </details>
  );
}

/** Recovery action buttons mounted below the last `upstreamRejection` failure card (§5.6). */
export function UpstreamRejectionActionsBar({
  primary,
  secondary,
  onRewind,
  onFork,
  onNewChat,
}: {
  primary?: UpstreamRejectionAction;
  secondary?: UpstreamRejectionAction;
  onRewind: (targetMessageId: string, trigger: HTMLElement | null) => void;
  onFork: (targetMessageId: string, trigger: HTMLElement | null) => void;
  onNewChat: () => void;
}) {
  useLocale();
  if (!primary && !secondary) return null;
  const renderButton = (action: UpstreamRejectionAction, emphasis: "primary" | "secondary") => {
    if (action.kind === "rewind") {
      const reason = action.blockedReasonKey ? t(action.blockedReasonKey) : undefined;
      return (
        <button
          key="rewind"
          type="button"
          className={`upstream-rejection-btn${emphasis === "primary" ? " is-primary" : ""}`}
          disabled={action.disabled}
          title={reason}
          onClick={event => onRewind(action.targetMessageId, event.currentTarget)}
        >
          <Undo2 size={14} aria-hidden="true"/>
          <span>{t("回退到出问题之前")}</span>
        </button>
      );
    }
    if (action.kind === "fork") {
      const reason = action.blockedReasonKey ? t(action.blockedReasonKey) : undefined;
      return (
        <button
          key="fork"
          type="button"
          className={`upstream-rejection-btn${emphasis === "primary" ? " is-primary" : ""}`}
          disabled={action.disabled}
          title={reason}
          onClick={event => onFork(action.targetMessageId, event.currentTarget)}
        >
          <GitBranch size={14} aria-hidden="true"/>
          <span>{t("从出问题之前分叉")}</span>
        </button>
      );
    }
    return (
      <button
        key="new-chat"
        type="button"
        className={`upstream-rejection-btn${emphasis === "primary" ? " is-primary" : ""}`}
        onClick={onNewChat}
      >
        <MessageSquarePlus size={14} aria-hidden="true"/>
        <span>{t("新开对话")}</span>
      </button>
    );
  };
  const blockedNote = primary && "blockedReasonKey" in primary && primary.disabled && primary.blockedReasonKey
    ? t(primary.blockedReasonKey)
    : undefined;
  return (
    <section className="upstream-rejection-actions" aria-label={t("对话恢复操作")}>
      <div className="upstream-rejection-buttons">
        {primary && renderButton(primary, "primary")}
        {secondary && renderButton(secondary, "secondary")}
      </div>
      {blockedNote && <small className="upstream-rejection-note">{blockedNote}</small>}
    </section>
  );
}
