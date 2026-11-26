import { useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { HelpCircle, X } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { Avatar, AvatarProvider, Profiles } from "./Avatar.js";
import { RoleStarSuppressed } from "./AgentAvatar.js";
import { BotMessageHostsContext, botMessageHostId } from "./bot-message-hosts.js";
import { useAttachment } from "./use-attachment.js";
import { t } from "./i18n.js";

/** Format a raw model ID (e.g. "claude-sonnet-4-6") into an everyday readable label. */
export function formatModelDisplayName(model?: string, engine?: string): string | undefined {
  const raw = (model ?? "").trim();
  if (!raw || raw === "default" || raw === "auto") {
    return engine ? formatEngineDisplayName(engine) : undefined;
  }
  const leaf = raw.split("/").pop() ?? raw;
  const cleaned = leaf
    .replace(/-\d{8}(?:[-_].*)?$/, "")
    .replace(/:\d+$/, "");

  const claudeNew = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-(.*))?$/i.exec(cleaned);
  if (claudeNew) {
    const family = claudeNew[1]![0]!.toUpperCase() + claudeNew[1]!.slice(1).toLowerCase();
    return `Claude ${family} ${claudeNew[2]}.${claudeNew[3]}`;
  }
  const claudeOld = /^claude-(\d+)-(\d+)-(opus|sonnet|haiku)(?:-(.*))?$/i.exec(cleaned);
  if (claudeOld) {
    const family = claudeOld[3]![0]!.toUpperCase() + claudeOld[3]!.slice(1).toLowerCase();
    return `Claude ${claudeOld[1]}.${claudeOld[2]} ${family}`;
  }
  if (/^claude-/i.test(cleaned)) {
    return cleaned.split("-").map(part => part ? part[0]!.toUpperCase() + part.slice(1) : "").join(" ");
  }
  if (/^gpt-/i.test(cleaned)) {
    return cleaned
      .replace(/^gpt-/i, "GPT-")
      .replace(/-codex$/i, " Codex")
      .replace(/-mini$/i, " mini")
      .replace(/-turbo$/i, " Turbo");
  }
  if (/^gemini-/i.test(cleaned)) {
    return cleaned.split("-").map(part => {
      if (!part) return "";
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part[0]!.toUpperCase() + part.slice(1);
    }).join(" ");
  }
  if (/^deepseek-/i.test(cleaned)) {
    return cleaned.split("-").map(part => part.toLowerCase() === "deepseek" ? "DeepSeek" : part[0]!.toUpperCase() + part.slice(1)).join(" ");
  }
  if (/^kimi-/i.test(cleaned)) {
    return cleaned.split("-").map(part => part.toLowerCase() === "kimi" ? "Kimi" : part.toUpperCase() === part ? part : part[0]!.toUpperCase() + part.slice(1)).join(" ");
  }
  return cleaned;
}

export function formatEngineDisplayName(engine?: string): string | undefined {
  switch ((engine ?? "").trim().toLowerCase()) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    case "antigravity":
    case "agy": return "Antigravity";
    case "deepseek": return "DeepSeek";
    case "kimi": return "Kimi";
    case "pi": return "Pi";
    default: return engine?.trim() || undefined;
  }
}

export type SignalStrength = {
  bars: 0 | 1 | 2 | 3 | 4;
  tone: "ok" | "warn" | "bad" | "muted";
  label: string;
};

/** Turn connection status + latency into plain-language signal strength. */
export function signalStrength(status: "online" | "connecting" | "offline", latency?: number): SignalStrength {
  if (status === "offline") return { bars: 0, tone: "bad", label: t("未连上") };
  if (status === "connecting") return { bars: 1, tone: "warn", label: t("正在连接…") };
  if (latency === undefined || !Number.isFinite(latency)) return { bars: 4, tone: "ok", label: t("已连上") };
  const ms = Math.max(0, Math.round(latency));
  if (ms <= 80) return { bars: 4, tone: "ok", label: t("很好 · {0}ms", ms) };
  if (ms <= 220) return { bars: 3, tone: "ok", label: t("不错 · {0}ms", ms) };
  if (ms <= 500) return { bars: 2, tone: "warn", label: t("有点慢 · {0}ms", ms) };
  return { bars: 1, tone: "bad", label: t("较卡顿 · {0}ms", ms) };
}

/** Plain-language summary of what a Bot is asking permission to do. */
export function approvalPlainSummary(botName: string, title?: string, detail?: string): string {
  const combined = `${title ?? ""} ${detail ?? ""}`.toLowerCase();
  if (/(命令|shell|bash|command|exec|run\b|npm|pnpm|yarn|pytest|vitest|psql|git\s)/.test(combined)) {
    return t("{0} 想运行一条命令，需要你同意", botName);
  }
  if (/(修改|写入|删除|文件|edit|write|patch|delete|rm\b|file)/.test(combined)) {
    return t("{0} 想修改或写入文件，需要你同意", botName);
  }
  if (/(网页|联网|网络|fetch|http|url|browser|curl)/.test(combined)) {
    return t("{0} 想访问网络或网页，需要你同意", botName);
  }
  const cleanTitle = title?.trim();
  if (cleanTitle && !/^(请求执行命令审批|approve|approval|等待审批|需要审批)$/i.test(cleanTitle)) {
    return t("{0} 想「{1}」，需要你同意", botName, cleanTitle);
  }
  return t("{0} 有操作需要你点头同意", botName);
}

export function formatElapsedBrief(startedAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return t("{0} 秒", Math.max(1, sec));
  const min = Math.floor(sec / 60);
  if (min < 60) return t("{0} 分钟", min);
  return t("{0} 小时", Math.floor(min / 60));
}

export type WorkspaceFileKind = "doc" | "sheet" | "image" | "code" | "pdf" | "workbench" | "file";

export function fileKindInfo(name: string, mime?: string): { kind: WorkspaceFileKind; ext: string; label: string; tone: string } {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "pdf" || mime === "application/pdf") {
    return { kind: "pdf", ext: "PDF", label: t("PDF 文档"), tone: "is-pdf" };
  }
  if (["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico"].includes(ext) || mime?.startsWith("image/")) {
    return { kind: "image", ext: (ext || "IMG").slice(0, 4).toUpperCase(), label: t("图片"), tone: "is-img" };
  }
  if (["csv", "tsv", "xlsx", "xls", "ods", "json"].includes(ext) || mime === "text/csv" || mime === "application/json") {
    return { kind: "sheet", ext: ext.slice(0, 4).toUpperCase(), label: ext === "json" ? t("数据文件") : t("表格"), tone: "is-sheet" };
  }
  if (["md", "markdown", "txt", "doc", "docx", "rtf"].includes(ext) || mime === "text/markdown" || mime === "text/plain") {
    return { kind: "doc", ext: (ext === "markdown" ? "MD" : ext || "DOC").slice(0, 4).toUpperCase(), label: t("文档"), tone: "is-md" };
  }
  if (["ts", "tsx", "mts", "js", "jsx", "mjs", "py", "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "css", "scss", "html", "yml", "yaml", "toml", "sh", "sql"].includes(ext)) {
    return { kind: "code", ext: ext.slice(0, 4).toUpperCase(), label: t("代码"), tone: "is-code" };
  }
  return { kind: "file", ext: (ext || "FILE").slice(0, 4).toUpperCase(), label: t("文件"), tone: "" };
}

/** Extract the direct "allow once" button actionId from an approval card message, if present. */
export function findApprovalAllowAction(message: Message | undefined): string | undefined {
  if (!message || message.authorType !== "bot" || message.status === "deleted" || message.status === "error") return undefined;
  type CardEl = Extract<Message["blocks"][number], { type: "card" }>["elements"][number];
  const visit = (elements: CardEl[]): string | undefined => {
    for (const element of elements) {
      if (element.disabled) continue;
      if (element.type === "button" && element.actionId && !element.url) {
        const value = element.value;
        if (value && typeof value === "object" && !Array.isArray(value) && value.cctb_lark === "approval" && value.decision === "allow_once") {
          return element.actionId;
        }
      }
      const nested = visit(element.children ?? []);
      if (nested) return nested;
    }
    return undefined;
  };
  for (const block of message.blocks) {
    if (block.type === "card") {
      const actionId = visit(block.elements);
      if (actionId) return actionId;
    }
  }
  return undefined;
}

/** Small computer illustration with integrated online indicator dot. */
export function HostComputerArt({ online }: { online: boolean }) {
  return (
    <span className={`ws-computer-art${online ? " is-online" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 28 24" width="26" height="22" fill="none">
        <rect x="2.5" y="2.5" width="23" height="15" rx="3" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.6" />
        <path d="M9.5 21h9M14 17.5V21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M7.5 8.5h6M7.5 11.5h9" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className={`ws-computer-dot${online ? " online" : ""}`} />
    </span>
  );
}

/** Four-bar signal strength meter. */
export function SignalBarsArt({ bars, tone }: { bars: 0 | 1 | 2 | 3 | 4; tone: SignalStrength["tone"] }) {
  const heights = [4, 7, 10, 13];
  return (
    <span className={`ws-signal-bars is-${tone}`} aria-hidden="true">
      {heights.map((h, i) => (
        <i key={h} className={i < bars ? "is-lit" : undefined} style={{ height: h }} />
      ))}
    </span>
  );
}

/** Friendly amber bell / hand spot illustration for Waiting for you. */
export function WaitingHandArt() {
  return (
    <span className="ws-waiting-art" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <circle cx="16" cy="16" r="14" fill="currentColor" fillOpacity="0.14" />
        <path d="M16 7.5a5.5 5.5 0 0 0-5.5 5.5v3.2c0 .9-.35 1.76-.97 2.4L8.5 19.7h15l-1.03-1.1a3.4 3.4 0 0 1-.97-2.4V13A5.5 5.5 0 0 0 16 7.5Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M13.6 21.8a2.5 2.5 0 0 0 4.8 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M7.2 10.6c-.8 1.1-1.2 2.4-1.2 3.8M24.8 10.6c.8 1.1 1.2 2.4 1.2 3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.65" />
      </svg>
    </span>
  );
}

/** Gentle working indicator: rhythmic pulsing dots when motion is enabled, calm badge when reduced. */
export function WorkingMotionArt({ animated }: { animated: boolean }) {
  return (
    <span className={`ws-working-art${animated ? " is-animated" : ""}`} aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

/** Simple helper badge icon for subagents (explicitly NOT Bot avatars). */
export function HelperCountArt() {
  return (
    <span className="ws-helper-art" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        <circle cx="9" cy="8.5" r="3" fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.6" />
        <path d="M4 18.5c0-2.6 2.2-4.5 5-4.5s5 1.9 5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M17.5 6.5v4M15.5 8.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="17.5" cy="16" r="2.3" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.7" />
      </svg>
    </span>
  );
}

/** Cute varied SVG file-type illustrations for What was made. */
export function FileTypeArt({ kind, ext }: { kind: WorkspaceFileKind; ext?: string }) {
  if (kind === "image") {
    return (
      <span className="ws-file-art is-img" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <rect x="4" y="5" width="24" height="22" rx="4.5" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="11.5" cy="12" r="2.2" fill="currentColor" fillOpacity="0.7" />
          <path d="M6.5 23l6.2-6.2a1.2 1.2 0 0 1 1.7 0l3.4 3.4 2.3-2.3a1.2 1.2 0 0 1 1.7 0L25.5 23" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (kind === "sheet") {
    return (
      <span className="ws-file-art is-sheet" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <rect x="4.5" y="4.5" width="23" height="23" rx="4.5" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 12h22M5 18.5h22M13 12v15M20 12v15" stroke="currentColor" strokeWidth="1.35" strokeOpacity="0.8" />
          <rect x="5" y="5" width="22" height="7" rx="3" fill="currentColor" fillOpacity="0.22" />
        </svg>
      </span>
    );
  }
  if (kind === "code") {
    return (
      <span className="ws-file-art is-code" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <path d="M7 4.5h12l6 6V25a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 5 25V7A2.5 2.5 0 0 1 7.5 4.5Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 15.5 9.2 18.2 12 21M20 15.5l2.8 2.7L20 21M17.2 14.5l-2.4 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (kind === "pdf") {
    return (
      <span className="ws-file-art is-pdf" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <path d="M7.5 4.5h11.5l6 6V25a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 5 25V7a2.5 2.5 0 0 1 2.5-2.5Z" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M19 4.5v5.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <rect x="8.5" y="15.5" width="15" height="7.5" rx="2" fill="currentColor" fillOpacity="0.2" />
          <text x="16" y="21.2" textAnchor="middle" fill="currentColor" fontSize="6.5" fontWeight="700" fontFamily="sans-serif">PDF</text>
        </svg>
      </span>
    );
  }
  if (kind === "workbench") {
    return (
      <span className="ws-file-art is-wb" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <rect x="4" y="5.5" width="24" height="18" rx="3.5" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 17.5c2.5-5 5-5 7.5 0s4.5 1 6.5-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M11 27l2.5-3.5M21 27l-2.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  if (kind === "doc") {
    return (
      <span className="ws-file-art is-md" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
          <path d="M7.5 4.5h11.5l6 6V25a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 5 25V7a2.5 2.5 0 0 1 2.5-2.5Z" fill="currentColor" fillOpacity="0.11" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M19 4.5v5.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M10 14.5h10M10 18.5h12M10 22.5h7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="ws-file-art is-file" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="32" height="32" fill="none">
        <path d="M7.5 4.5h11.5l6 6V25a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 5 25V7a2.5 2.5 0 0 1 2.5-2.5Z" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M19 4.5v5.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        {ext && <text x="16" y="21.5" textAnchor="middle" fill="currentColor" fontSize="6.2" fontWeight="700" fontFamily="sans-serif">{ext.slice(0, 4)}</text>}
      </svg>
    </span>
  );
}

/** Real thumbnail preview for image attachments, falling back cleanly to FileTypeArt while loading or offline. */
export function WorkspaceFileThumbnail({ connection, attachmentId, name }: { connection: HubConnection; attachmentId: string; name: string }) {
  const { url } = useAttachment(connection, attachmentId, true, false);
  if (!url) return <FileTypeArt kind="image" ext="IMG" />;
  return (
    <span className="ws-file-thumb" aria-hidden="true">
      <img src={url} alt="" loading="lazy" draggable={false} />
    </span>
  );
}

/** Friendly spot illustrations for empty and error states. */
export function EmptyStateArt({ kind }: { kind: "idle" | "comms" | "files" | "error" }) {
  if (kind === "comms") {
    return (
      <svg className="ws-empty-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <rect x="6" y="10" width="24" height="18" rx="6" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="14" cy="19" r="1.6" fill="currentColor" /><circle cx="22" cy="19" r="1.6" fill="currentColor" />
        <rect x="34" y="18" width="24" height="18" rx="6" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="42" cy="27" r="1.6" fill="currentColor" /><circle cx="50" cy="27" r="1.6" fill="currentColor" />
        <path d="M29 14c3-3 7-3 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 3" />
      </svg>
    );
  }
  if (kind === "files") {
    return (
      <svg className="ws-empty-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M12 14a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V14Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M24 26h16M24 31h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
        <circle cx="48" cy="11" r="2.2" fill="currentColor" fillOpacity="0.5" />
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg className="ws-empty-art is-error" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <circle cx="32" cy="24" r="16" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.6" />
        <path d="M32 16v10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="32" cy="31.5" r="1.6" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="ws-empty-art" viewBox="0 0 48 36" width="38" height="28" fill="none" aria-hidden="true">
      <circle cx="24" cy="18" r="13" fill="currentColor" fillOpacity="0.09" stroke="currentColor" strokeWidth="1.5" />
      <path d="M19 16.5c.8-1 2.2-1 3 0M26 16.5c.8-1 2.2-1 3 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M19.5 22c2.5 2 6.5 2 9 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** First-use "?" help button with a compact, friendly popover containing a small illustration and plain words. */
export function SectionHelpButton({
  title,
  description,
  art,
  open,
  onToggle,
  onClose,
}: {
  title: string;
  description: string;
  art: ReactNode;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const popoverId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);

  return (
    <span className="ws-help-wrap" ref={wrapRef}>
      <button
        type="button"
        className="ws-help-btn"
        aria-label={t("说明：{0}", title)}
        title={t("这是什么？")}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={onToggle}
      >
        <HelpCircle size={12} aria-hidden="true" />
      </button>
      {open && (
        <div id={popoverId} className="ws-help-popover" role="region" aria-label={title}>
          <div className="ws-help-popover-art">{art}</div>
          <div className="ws-help-popover-body">
            <div className="ws-help-popover-head">
              <strong>{title}</strong>
              <button type="button" className="ws-help-close" aria-label={t("关闭说明")} onClick={onClose}>
                <X size={11} aria-hidden="true" />
              </button>
            </div>
            <p>{description}</p>
          </div>
        </div>
      )}
    </span>
  );
}

/** Resolve a Bot's real Avatar across the current Hub and any connected peer Hosts (used ONLY in Bot-to-Bot comms). */
export function WorkspaceBotAvatar({
  hostId,
  botId,
  name,
  size = 22,
}: {
  hostId?: string;
  botId?: string;
  name: string;
  size?: number;
}) {
  const profiles = useContext(Profiles);
  const hostEntries = useContext(BotMessageHostsContext);
  const resolvedId = botId || name;

  const remoteConnection = (() => {
    if (!hostId || !profiles?.connection) return undefined;
    const currentPub = profiles.connection.identity.hubPublicKey;
    if (currentPub && botMessageHostId(currentPub) === hostId) return undefined;
    const match = hostEntries.find(
      entry => entry.host.publicKey && botMessageHostId(entry.host.publicKey) === hostId && entry.connection && !entry.host.networkBlocked && !entry.connection.isNetworkBlocked,
    );
    return match?.connection;
  })();

  const avatar = (
    <RoleStarSuppressed.Provider value={true}>
      <Avatar kind="bot" id={resolvedId} name={name} size={size} />
    </RoleStarSuppressed.Provider>
  );

  if (remoteConnection) {
    return (
      <AvatarProvider connection={remoteConnection} conversations={[]} directory={remoteConnection.state.bots}>
        {avatar}
      </AvatarProvider>
    );
  }
  return avatar;
}
