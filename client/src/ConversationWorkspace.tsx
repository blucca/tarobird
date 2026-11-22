import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Cpu,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe,
  Layers,
  ListOrdered,
  Network,
  RefreshCw,
  ShieldCheck,
  Square,
  Users,
  X,
} from "lucide-react";
import { blocksText, type Conversation, type Message } from "../../src/client-protocol/index.js";
import { engineTaskControlResultSchema, engineTaskSnapshotSchema, type EngineTask } from "../../src/client-protocol/engine-tasks.js";
import { promptQueueSnapshotSchema, type PromptQueueSnapshot } from "../../src/client-protocol/prompt-queue.js";
import { conversationFilesPageSchema, type ConversationFile } from "../../src/client-protocol/conversation-files.js";
import { permissionResultSchema, type PermissionSettings } from "../../src/client-protocol/permissions.js";
import { conversationBotCommsSchema, type BotCommItem, type ConversationBotComms } from "../../src/client-protocol/workspace-comms.js";
import { nativeRun } from "../../src/client-protocol/run.js";
import { runChangesSummarySchema } from "../../src/client-protocol/run-changes.js";
import type { Bot, HubConnection } from "./connection.js";
import { DiffViewerTrigger } from "./DiffViewerTrigger.js";
import { listWorkbenchLibrary, type WorkbenchLibraryEntry } from "./workbench-library.js";
import type { WorkbenchFileTarget } from "./workbench-library-context.js";
import { t, useLocale } from "./i18n.js";
import "./conversation-workspace.css";

export type WorkspaceTab = "overview" | "comms" | "files";

const FILES_PAGE_SIZE = 6;
const COMMS_PAGE_SIZE = 4;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 45) return t("刚刚");
  if (diffSec < 3600) return t("{0} 分钟前", Math.floor(diffSec / 60));
  if (diffSec < 86400) return t("{0} 小时前", Math.floor(diffSec / 3600));
  return new Date(timestamp).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric" });
}

function fileBadge(name: string, mime?: string): { label: string; tone: string } {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (ext === "md" || ext === "markdown" || mime === "text/markdown") return { label: "MD", tone: "is-md" };
  if (ext === "pdf" || mime === "application/pdf") return { label: "PDF", tone: "is-pdf" };
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext) || mime?.startsWith("image/")) return { label: "IMG", tone: "is-img" };
  if (["json", "ts", "tsx", "js", "jsx", "py", "go", "rs", "css", "html", "yml", "yaml", "sh", "sql"].includes(ext)) {
    return { label: ext.slice(0, 4).toUpperCase(), tone: "is-code" };
  }
  return { label: (ext || "FILE").slice(0, 4).toUpperCase(), tone: "" };
}

function commStatusLabel(status: BotCommItem["status"]): string {
  switch (status) {
    case "needs_approval": return t("待审批");
    case "running": return t("运行中");
    case "steered": return t("已并入当前轮");
    case "queued": return t("排队中");
    case "replied": return t("已回传");
    case "failed": return t("失败");
    case "cancelled": return t("已取消");
    case "uncertain": return t("状态未确认");
  }
}

function commDeliveryLabel(delivery: BotCommItem["delivery"]): string | undefined {
  switch (delivery) {
    case "steered": return t("引导并入");
    case "fell_back_to_queue": return t("回退排队");
    case "queued": return t("排队投递");
    case "not_delivered": return t("未投递");
    case "steer_uncertain": return t("并入未确认");
    case "pending": return t("投递中");
    default: return undefined;
  }
}

function workbenchKindLabel(kind: WorkbenchLibraryEntry["kind"]): string {
  if (kind === "whiteboard") return t("白板");
  if (kind === "markdown") return t("文档");
  return t("设计稿");
}

/** Lightweight hook shared by the header trigger badge and the Workspace panel. */
export function useConversationBotComms(
  connection: HubConnection,
  conversationId: string | undefined,
  enabled: boolean,
  poll: boolean,
  revision: number,
) {
  const [data, setData] = useState<ConversationBotComms | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const scope = `${connection.identity.hubPublicKey}:${conversationId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled || !conversationId || connection.state.status !== "online" || !connection.state.botCommsAvailable) return;
    const reqScope = scopeRef.current;
    setLoading(true);
    try {
      const raw = await connection.http(`/api/conversations/${encodeURIComponent(conversationId)}/bot-comms`, { signal });
      if (signal?.aborted || scopeRef.current !== reqScope) return;
      setData(conversationBotCommsSchema.parse(raw));
      setError(false);
    } catch {
      if (!signal?.aborted && scopeRef.current === reqScope) setError(true);
    } finally {
      if (!signal?.aborted && scopeRef.current === reqScope) setLoading(false);
    }
  }, [connection, conversationId, enabled]);

  useEffect(() => {
    setData(undefined);
    setError(false);
  }, [scope]);

  useEffect(() => {
    if (!enabled || !conversationId || connection.state.status !== "online" || !connection.state.botCommsAvailable) return;
    const abort = new AbortController();
    void refresh(abort.signal);
    if (!poll) return () => abort.abort();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(abort.signal);
    }, 4500);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [enabled, poll, conversationId, connection.state.status, connection.state.botCommsAvailable, revision, refresh]);

  return { data, loading, error, refresh };
}

export interface ConversationWorkspaceProps {
  id: string;
  connection: HubConnection;
  conversation: Conversation;
  group?: Conversation;
  bots: Bot[];
  botLabels: ReadonlyMap<string, string>;
  hostName: string;
  connectionSummary: string;
  streamingBots: string[];
  messages: Message[];
  comms: ConversationBotComms | undefined;
  commsLoading: boolean;
  onRefreshComms: () => void;
  returnFocus?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onJumpConversation: (conversationId: string, messageId?: string) => void;
  onLocateMessage: (conversationId: string, messageId: string) => void;
  onOpenAllFiles: () => void;
  onOpenWorkbenchFile: (target: WorkbenchFileTarget) => void;
  onOpenTasksModal?: () => void;
}

export function ConversationWorkspace({
  id,
  connection,
  conversation,
  group,
  bots,
  botLabels,
  hostName,
  connectionSummary,
  streamingBots,
  messages,
  comms,
  commsLoading,
  onRefreshComms,
  returnFocus,
  onClose,
  onJumpConversation,
  onLocateMessage,
  onOpenAllFiles,
  onOpenWorkbenchFile,
  onOpenTasksModal,
}: ConversationWorkspaceProps) {
  const locale = useLocale();
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [commFilter, setCommFilter] = useState<"all" | "active" | "cross_host">("all");
  const [commPage, setCommPage] = useState(0);
  const [fileFilter, setFileFilter] = useState<"all" | "diff" | "files">("all");
  const [filePage, setFilePage] = useState(0);
  const [expandedComms, setExpandedComms] = useState<ReadonlySet<string>>(() => new Set());
  const [tasks, setTasks] = useState<EngineTask[]>([]);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | undefined>(undefined);
  const [queue, setQueue] = useState<PromptQueueSnapshot | undefined>(undefined);
  const [permissions, setPermissions] = useState<PermissionSettings | undefined>(undefined);
  const [files, setFiles] = useState<ConversationFile[]>([]);
  const [filesHasMore, setFilesHasMore] = useState(false);
  const [workbenchItems, setWorkbenchItems] = useState<WorkbenchLibraryEntry[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const online = connection.state.status === "online";
  const convBots = useMemo(
    () => bots.filter(bot => conversation.botIds.includes(bot.id)),
    [bots, conversation.botIds],
  );
  const directBot = conversation.type === "direct" && convBots.length === 1 ? convBots[0] : undefined;

  useEffect(() => {
    setExpandedComms(new Set());
    setCommPage(0);
    setFilePage(0);
    setTasks([]);
    setQueue(undefined);
    setPermissions(undefined);
    setFiles([]);
    setFilesHasMore(false);
    setWorkbenchItems([]);
  }, [conversation.id, connection.identity.hubPublicKey]);

  useEffect(() => { setCommPage(0); }, [commFilter]);
  useEffect(() => { setFilePage(0); }, [fileFilter]);

  useEffect(() => {
    const abort = new AbortController();
    const convId = conversation.id;

    void listWorkbenchLibrary(connection, { maxScopes: 200, maxEntries: 500 })
      .then(listing => {
        if (abort.signal.aborted) return;
        setWorkbenchItems(listing.entries.filter(entry => entry.conversationId === convId && entry.state !== "missing").slice(0, 12));
      })
      .catch(() => undefined);

    if (!online) return () => abort.abort();

    const fileParams = new URLSearchParams({ conversationId: convId, q: "" });
    void connection.http(`/api/conversation-files?${fileParams}`, { signal: abort.signal })
      .then(raw => {
        if (abort.signal.aborted) return;
        const page = conversationFilesPageSchema.parse(raw);
        setFiles(page.items.slice(0, 24));
        setFilesHasMore(!!page.nextCursor || page.items.length > 24);
      })
      .catch(() => undefined);

    if (directBot) {
      if (connection.state.engineTasksAvailable && directBot.online) {
        void connection.http(`/api/conversations/${encodeURIComponent(convId)}/tasks?botId=${encodeURIComponent(directBot.id)}`, { signal: abort.signal })
          .then(raw => {
            if (abort.signal.aborted) return;
            const snap = engineTaskSnapshotSchema.parse(raw);
            setTasks(snap.tasks);
          })
          .catch(() => undefined);
      }
      if (connection.state.promptQueueAvailable) {
        void connection.http(`/api/conversations/${encodeURIComponent(convId)}/queue?${new URLSearchParams({ botId: directBot.id })}`, { signal: abort.signal })
          .then(raw => {
            if (abort.signal.aborted) return;
            setQueue(promptQueueSnapshotSchema.parse(raw));
          })
          .catch(() => undefined);
      }
      void connection.http(`/api/bots/${encodeURIComponent(directBot.id)}/permissions`, { signal: abort.signal })
        .then(raw => {
          if (abort.signal.aborted) return;
          const parsed = permissionResultSchema.parse(raw);
          if (parsed.ok) setPermissions(parsed.settings);
        })
        .catch(() => undefined);
    }

    return () => abort.abort();
  }, [
    connection,
    conversation.id,
    directBot?.id,
    directBot?.online,
    online,
    connection.state.engineTasksAvailable,
    connection.state.promptQueueAvailable,
    refreshTick,
    messages.length,
  ]);

  const stopTask = async (task: EngineTask) => {
    if (!directBot || stoppingTaskId) return;
    setStoppingTaskId(task.id);
    try {
      const requestId = `ws_stop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const res = engineTaskControlResultSchema.parse(
        await connection.http(`/api/conversations/${encodeURIComponent(conversation.id)}/tasks`, {
          method: "POST",
          body: JSON.stringify({ botId: directBot.id, taskId: task.id, requestId }),
        }),
      );
      if (res.outcome === "accepted") setRefreshTick(n => n + 1);
    } catch {
      // ignore
    } finally {
      setStoppingTaskId(undefined);
    }
  };

  const diffMessages = useMemo(() => {
    if (connection.state.user?.role !== "owner") return [];
    const found: Message[] = [];
    for (let i = messages.length - 1; i >= 0 && found.length < 4; i--) {
      const msg = messages[i]!;
      if (msg.authorType !== "bot") continue;
      const block = msg.blocks.find(b => b.type === "card" && nativeRun(b));
      if (!block || block.type !== "card") continue;
      const run = nativeRun(block);
      const parsed = runChangesSummarySchema.safeParse(block.extra?.runChanges);
      if (run && parsed.success && parsed.data.runId === run.id && parsed.data.revision === run.revision && parsed.data.files > 0) {
        found.push(msg);
      }
    }
    return found;
  }, [messages, connection.state.user?.role]);

  const activeTasks = useMemo(
    () => tasks.filter(task => task.status === "running"),
    [tasks],
  );
  const queuedItems = queue?.items ?? [];
  const commItems = comms?.items ?? [];
  const filteredComms = useMemo(() => {
    if (commFilter === "active") {
      return commItems.filter(item => item.status === "needs_approval" || item.status === "running" || item.status === "steered" || item.status === "queued");
    }
    if (commFilter === "cross_host") {
      return commItems.filter(item => item.crossHost);
    }
    return commItems;
  }, [commItems, commFilter]);

  const commTotalPages = Math.max(1, Math.ceil(filteredComms.length / COMMS_PAGE_SIZE));
  const pagedComms = filteredComms.slice(commPage * COMMS_PAGE_SIZE, (commPage + 1) * COMMS_PAGE_SIZE);

  // Unified non-diff artifacts (workbench docs + conversation files) for clean pagination & grid
  const fileArtifacts = useMemo(() => [
    ...workbenchItems.map(entry => ({
      kind: "workbench" as const,
      key: `wb:${entry.kind}:${entry.id}`,
      name: entry.title || workbenchKindLabel(entry.kind),
      badgeLabel: entry.kind === "whiteboard" ? "WB" : entry.kind === "markdown" ? "DOC" : "DES",
      badgeTone: "is-wb",
      meta: t("工作台 · {0}", workbenchKindLabel(entry.kind)),
      entry,
    })),
    ...files.map(file => {
      const badge = fileBadge(file.name, file.mime);
      return {
        kind: "file" as const,
        key: `file:${file.attachmentId}:${file.messageId}`,
        name: file.name,
        badgeLabel: badge.label,
        badgeTone: badge.tone,
        meta: `${formatBytes(file.size)} · ${formatRelativeTime(file.createdAt, locale)}`,
        file,
      };
    }),
  ], [workbenchItems, files, locale]);

  const fileTotalPages = Math.max(1, Math.ceil(fileArtifacts.length / FILES_PAGE_SIZE));
  const pagedFileArtifacts = fileArtifacts.slice(filePage * FILES_PAGE_SIZE, (filePage + 1) * FILES_PAGE_SIZE);

  const artifactsCount = diffMessages.length + fileArtifacts.length;
  const permissionLabel = useMemo(() => {
    if (!permissions) return undefined;
    return permissions.choices.find(c => c.id === permissions.choice)?.label ?? permissions.choice;
  }, [permissions]);

  const toggleCommExpand = (itemId: string) => {
    setExpandedComms(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const handleRefreshAll = () => {
    setRefreshTick(n => n + 1);
    onRefreshComms();
  };

  const openArtifact = (artifact: (typeof fileArtifacts)[number]) => {
    if (artifact.kind === "workbench") {
      onOpenWorkbenchFile({
        scope: artifact.entry.scope,
        conversationId: artifact.entry.conversationId,
        id: artifact.entry.id,
        kind: artifact.entry.kind,
        title: artifact.entry.title || workbenchKindLabel(artifact.entry.kind),
      });
    } else {
      onLocateMessage(artifact.file.conversationId, artifact.file.messageId);
    }
  };

  const renderCommCard = (item: BotCommItem, compact: boolean) => {
    const expanded = expandedComms.has(item.id);
    const deliveryLabel = commDeliveryLabel(item.delivery);
    const needsApproval = item.status === "needs_approval";
    const statusClass =
      item.status === "needs_approval" ? "is-needs-approval"
        : item.status === "replied" ? "is-replied"
          : item.status === "running" ? "is-running"
            : item.status === "steered" ? "is-steered"
              : item.status === "failed" ? "is-failed"
                : "is-queued";
    return (
      <article key={item.id} className={`workspace-comm-card${compact ? " is-compact" : ""}${needsApproval ? " is-needs-approval" : ""}`}>
        <div className="workspace-comm-top">
          <div className="workspace-comm-route">
            <span>{item.sourceBotName}</span>
            <ArrowRight size={11} aria-hidden="true"/>
            <span>{item.targetBotName}</span>
          </div>
          <span className={`workspace-comm-status ${statusClass}`}>
            {needsApproval && <AlertTriangle size={10} aria-hidden="true"/>}
            {commStatusLabel(item.status)}
          </span>
        </div>
        {!compact && (
          <div className="workspace-comm-sub">
            {item.crossHost && (
              <span className="workspace-chip is-accent">
                <Globe size={10} aria-hidden="true"/>
                {t("跨主机 · {0}", item.direction === "outgoing" ? item.targetHostName : item.sourceHostName)}
              </span>
            )}
            {item.kind === "agent_bus_stage" && item.workspaceName && (
              <span className="workspace-chip">
                <Network size={10} aria-hidden="true"/>
                {item.workspaceName}
              </span>
            )}
            {item.direction === "incoming" && <span>{t("协作入站")}</span>}
            {deliveryLabel && item.kind !== "agent_bus_stage" && <span>{deliveryLabel}</span>}
            <span>{formatRelativeTime(item.updatedAt, locale)}</span>
          </div>
        )}
        {needsApproval && item.pendingApproval && (
          <div className="workspace-comm-alert-box">
            <strong>{item.pendingApproval.title || t("下游等待审批或确认")}</strong>
            {item.pendingApproval.detail && <span title={item.pendingApproval.detail}>{item.pendingApproval.detail}</span>}
          </div>
        )}
        {!expanded && !(needsApproval && item.pendingApproval) && (item.replyExcerpt || item.sentExcerpt) && (
          <p className="workspace-comm-excerpt" title={item.replyExcerpt ?? item.sentExcerpt}>{item.replyExcerpt ?? item.sentExcerpt}</p>
        )}
        {expanded && (
          <div className="workspace-comm-expanded">
            {item.sentExcerpt && (
              <div>
                <span className="workspace-comm-expanded-label">{t("发出的指令")}</span>
                <div>{item.sentExcerpt}</div>
              </div>
            )}
            {item.replyExcerpt && (
              <div>
                <span className="workspace-comm-expanded-label">{t("最新回传")}</span>
                <div>{item.replyExcerpt}</div>
              </div>
            )}
            {item.targetConversationTitle && (
              <div>
                <span className="workspace-comm-expanded-label">{t("协作对话")}</span>
                <div>{item.targetConversationTitle}</div>
              </div>
            )}
          </div>
        )}
        <div className="workspace-comm-actions">
          {(item.sentExcerpt || item.replyExcerpt) && (
            <button type="button" onClick={() => toggleCommExpand(item.id)}>
              {expanded ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
              <span>{expanded ? t("收起") : t("展开详情")}</span>
            </button>
          )}
          {item.canJumpToTarget && item.targetConversationId && (
            <button
              type="button"
              className={`workspace-jump-btn${needsApproval ? " is-alert" : ""}`}
              onClick={() => {
                onJumpConversation(item.targetConversationId!, item.pendingApproval?.messageId ?? item.targetMessageId);
              }}
            >
              <span>{needsApproval ? t("去批准") : t("去协作对话")}</span>
              <ExternalLink size={11} aria-hidden="true"/>
            </button>
          )}
        </div>
      </article>
    );
  };

  const content = (
    <>
      <div className="workspace-tabs" role="tablist" aria-label={t("工作区标签")}>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          <span>{t("总览")}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={tab === "comms"}
          onClick={() => setTab("comms")}
        >
          <span>{t("Bot 通信")}</span>
          {commItems.length > 0 && (
            <span className={`workspace-tab-count${(comms?.summary.needsApproval ?? 0) > 0 ? " is-alert" : (comms?.summary.active ?? 0) > 0 ? " is-active" : ""}`}>
              {commItems.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={tab === "files"}
          onClick={() => setTab("files")}
        >
          <span>{t("文件")}</span>
          {artifactsCount > 0 && <span className="workspace-tab-count">{artifactsCount}</span>}
        </button>
      </div>

      <div className="workspace-body">
        {tab === "overview" && (
          <>
            {/* 1. Compact Environment & Context Strip */}
            <section className="workspace-section" aria-label={t("环境与上下文")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <Cpu size={12} aria-hidden="true"/>
                  <span>{t("环境与上下文")}</span>
                </span>
              </div>
              <div className="workspace-env-card">
                <div className="workspace-env-top">
                  <span className="workspace-env-host" title={hostName}>
                    <span className={`status-dot${online ? " online" : ""}`}/>
                    <span>{hostName}</span>
                  </span>
                  <span className="workspace-env-route">{connectionSummary}</span>
                </div>
                <div className="workspace-env-meta">
                  {directBot ? (
                    <>
                      <span className="workspace-env-bot">{botLabels.get(directBot.id) ?? directBot.name}</span>
                      {(directBot.model || directBot.engine) && (
                        <span className="workspace-env-model">{[directBot.engine, directBot.model, directBot.effort].filter(Boolean).join(" · ")}</span>
                      )}
                      <span className={`workspace-chip${directBot.online ? " is-online" : ""}`}>
                        {directBot.online ? t("在线") : t("离线")}
                      </span>
                      {permissionLabel && (
                        <span className="workspace-chip is-accent">
                          <ShieldCheck size={10} aria-hidden="true"/>
                          <span>{permissionLabel}</span>
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="workspace-env-bot">
                        <Users size={11} aria-hidden="true"/> {t("{0} 位 Bot", convBots.length)}
                      </span>
                      {convBots.slice(0, 3).map(bot => (
                        <span key={bot.id} className={`workspace-chip${bot.online ? " is-online" : ""}`}>
                          {botLabels.get(bot.id) ?? bot.name}
                        </span>
                      ))}
                    </>
                  )}
                  {group && conversation.parentId && (
                    <span className="workspace-chip">{t("话题 · {0}", group.title)}</span>
                  )}
                </div>
              </div>
            </section>

            {/* 2. Live Tasks & Queue */}
            <section className="workspace-section" aria-label={t("进行中与队列")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <ListOrdered size={12} aria-hidden="true"/>
                  <span>{t("进行中与队列")}</span>
                </span>
                {onOpenTasksModal && directBot && connection.state.engineTasksAvailable && (
                  <button type="button" className="workspace-section-action" onClick={onOpenTasksModal}>
                    {t("全部任务")}
                  </button>
                )}
              </div>
              {activeTasks.length > 0 || queuedItems.length > 0 || streamingBots.length > 0 ? (
                <div className="workspace-list">
                  {streamingBots.length > 0 && activeTasks.length === 0 && (
                    <div className="workspace-item-row">
                      <span className="workspace-item-icon"><span className="status-dot online"/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{t("正在回复")}</span>
                        <span className="workspace-item-meta">{streamingBots.join("、")}</span>
                      </span>
                    </div>
                  )}
                  {activeTasks.slice(0, 2).map(task => (
                    <div key={task.id} className="workspace-item-row">
                      <span className="workspace-item-icon"><span className="status-dot online"/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{task.label || task.id}</span>
                        <span className="workspace-item-meta">{task.kind === "subagent" ? t("子代理") : task.kind === "shell" ? t("后台命令") : t("后台任务")}</span>
                      </span>
                      {task.canStop && (
                        <button
                          type="button"
                          className="workspace-stop-btn"
                          disabled={stoppingTaskId === task.id}
                          onClick={() => void stopTask(task)}
                        >
                          <Square size={10} aria-hidden="true"/>
                          <span>{t("停止")}</span>
                        </button>
                      )}
                    </div>
                  ))}
                  {queuedItems.slice(0, 2).map((item, idx) => (
                    <div key={item.message.id} className="workspace-item-row">
                      <span className="workspace-item-icon"><ListOrdered size={12}/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{blocksText(item.message.blocks).trim() || t("排队消息 #{0}", idx + 1)}</span>
                        <span className="workspace-item-meta">{t("队列第 {0} 位", idx + 1)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="workspace-idle-strip">{t("当前空闲，无运行中或排队任务。")}</div>
              )}
            </section>

            {/* 3. Bot-to-Bot Comms (auto-hidden in Overview when 0 items; capped to 2 compact cards) */}
            {commItems.length > 0 && (
              <section className="workspace-section" aria-label={t("Bot 间通信")}>
                <div className="workspace-section-header">
                  <span className="workspace-section-title">
                    <Network size={12} aria-hidden="true"/>
                    <span>{t("Bot 间通信")}</span>
                  </span>
                  {commItems.length > 2 && (
                    <button type="button" className="workspace-section-action" onClick={() => setTab("comms")}>
                      {t("查看全部 ({0})", commItems.length)}
                    </button>
                  )}
                </div>
                <div className="workspace-list">
                  {commItems.slice(0, 2).map(item => renderCommCard(item, true))}
                </div>
              </section>
            )}

            {/* 4. Artifacts & Run Changes (compact Diff bar + 2-column file tile grid) */}
            <section className="workspace-section" aria-label={t("产物与本轮改动")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <FileCode2 size={12} aria-hidden="true"/>
                  <span>{t("产物与本轮改动")}</span>
                </span>
                {artifactsCount > 0 && (
                  <button type="button" className="workspace-section-action" onClick={() => setTab("files")}>
                    {t("全部 ({0})", artifactsCount)}
                  </button>
                )}
              </div>
              {diffMessages.length === 0 && fileArtifacts.length === 0 ? (
                <div className="workspace-idle-strip">{t("暂无本轮改动、工作台内容或对话文件。")}</div>
              ) : (
                <div className="workspace-list">
                  {diffMessages.slice(0, 1).map(msg => (
                    <div key={`diff:${msg.id}`} className="workspace-diff-row">
                      <DiffViewerTrigger connection={connection} message={msg}/>
                    </div>
                  ))}
                  {fileArtifacts.length > 0 && (
                    <div className="workspace-file-grid">
                      {fileArtifacts.slice(0, diffMessages.length > 0 ? 2 : 3).map(artifact => (
                        <button
                          key={artifact.key}
                          type="button"
                          className="workspace-file-tile"
                          title={artifact.name}
                          onClick={() => openArtifact(artifact)}
                        >
                          <span className={`workspace-file-badge ${artifact.badgeTone}`}>{artifact.badgeLabel}</span>
                          <span className="workspace-file-tile-text">
                            <span className="workspace-file-tile-name">{artifact.name}</span>
                            <span className="workspace-file-tile-meta">{artifact.meta}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}

        {tab === "comms" && (
          <section className="workspace-section" aria-label={t("Bot 间通信")}>
            <div className="workspace-filter-bar">
              <button type="button" className="workspace-filter-pill" aria-pressed={commFilter === "all"} onClick={() => setCommFilter("all")}>
                {t("全部")} ({commItems.length})
              </button>
              <button type="button" className="workspace-filter-pill" aria-pressed={commFilter === "active"} onClick={() => setCommFilter("active")}>
                {t("进行中 / 待审批")} ({comms?.summary.active ?? 0})
              </button>
              <button type="button" className="workspace-filter-pill" aria-pressed={commFilter === "cross_host"} onClick={() => setCommFilter("cross_host")}>
                {t("跨主机")} ({commItems.filter(i => i.crossHost).length})
              </button>
            </div>
            {pagedComms.length > 0 ? (
              <>
                <div className="workspace-list">{pagedComms.map(item => renderCommCard(item, false))}</div>
                {commTotalPages > 1 && (
                  <div className="workspace-pager">
                    <button type="button" disabled={commPage === 0} onClick={() => setCommPage(p => Math.max(0, p - 1))}>{t("上一页")}</button>
                    <span>{commPage + 1} / {commTotalPages}</span>
                    <button type="button" disabled={commPage + 1 >= commTotalPages} onClick={() => setCommPage(p => Math.min(commTotalPages - 1, p + 1))}>{t("下一页")}</button>
                  </div>
                )}
              </>
            ) : (
              <div className="workspace-empty">
                {commItems.length > 0
                  ? t("当前筛选下没有匹配的通信记录。")
                  : t("此对话尚未发起或收到 Bot 间通信。Bot 委托、跨主机调用与 Agent Bus 协作都会自动在此追踪。")}
              </div>
            )}
          </section>
        )}

        {tab === "files" && (
          <section className="workspace-section" aria-label={t("文件与改动")}>
            <div className="workspace-filter-bar">
              <button type="button" className="workspace-filter-pill" aria-pressed={fileFilter === "all"} onClick={() => setFileFilter("all")}>
                {t("全部")} ({artifactsCount})
              </button>
              {diffMessages.length > 0 && (
                <button type="button" className="workspace-filter-pill" aria-pressed={fileFilter === "diff"} onClick={() => setFileFilter("diff")}>
                  {t("本轮改动")} ({diffMessages.length})
                </button>
              )}
              <button type="button" className="workspace-filter-pill" aria-pressed={fileFilter === "files"} onClick={() => setFileFilter("files")}>
                {t("附件与文档")} ({fileArtifacts.length})
              </button>
            </div>

            {artifactsCount === 0 ? (
              <div className="workspace-empty">{t("暂无本轮改动、工作台内容或对话文件。")}</div>
            ) : (
              <div className="workspace-list">
                {fileFilter !== "files" && diffMessages.length > 0 && (
                  <>
                    <div className="workspace-group-label">{t("本轮改动")}</div>
                    {diffMessages.map(msg => (
                      <div key={`diff:${msg.id}`} className="workspace-diff-row">
                        <DiffViewerTrigger connection={connection} message={msg}/>
                      </div>
                    ))}
                  </>
                )}

                {fileFilter !== "diff" && pagedFileArtifacts.length > 0 && (
                  <>
                    <div className="workspace-group-label">{t("附件与文档")}</div>
                    <div className="workspace-file-grid">
                      {pagedFileArtifacts.map(artifact => (
                        <button
                          key={artifact.key}
                          type="button"
                          className="workspace-file-tile"
                          title={artifact.name}
                          onClick={() => openArtifact(artifact)}
                        >
                          <span className={`workspace-file-badge ${artifact.badgeTone}`}>{artifact.badgeLabel}</span>
                          <span className="workspace-file-tile-text">
                            <span className="workspace-file-tile-name">{artifact.name}</span>
                            <span className="workspace-file-tile-meta">{artifact.meta}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {fileFilter !== "diff" && fileTotalPages > 1 && (
                  <div className="workspace-pager">
                    <button type="button" disabled={filePage === 0} onClick={() => setFilePage(p => Math.max(0, p - 1))}>{t("上一页")}</button>
                    <span>{filePage + 1} / {fileTotalPages}</span>
                    <button type="button" disabled={filePage + 1 >= fileTotalPages} onClick={() => setFilePage(p => Math.min(fileTotalPages - 1, p + 1))}>{t("下一页")}</button>
                  </div>
                )}

                {filesHasMore && (
                  <button type="button" className="workspace-section-action" onClick={onOpenAllFiles}>
                    <FolderOpen size={12}/>
                    <span>{t("查看全部对话文件")}</span>
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );

  return (
    <aside id={id} className="conversation-workspace-rail" aria-label={t("会话工作区")}>
      <header className="workspace-rail-header">
        <div className="workspace-rail-title">
          <Layers size={15} aria-hidden="true"/>
          <h2>{t("工作区")}</h2>
        </div>
        <div className="workspace-rail-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("刷新工作区")}
            title={t("刷新工作区")}
            disabled={commsLoading}
            onClick={handleRefreshAll}
          >
            <RefreshCw size={14} className={commsLoading ? "spin" : undefined}/>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("关闭工作区")}
            title={t("关闭工作区")}
            onClick={() => {
              onClose();
              returnFocus?.current?.focus({ preventScroll: true });
            }}
          >
            <X size={15}/>
          </button>
        </div>
      </header>
      {content}
    </aside>
  );
}
