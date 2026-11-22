import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Cpu,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Layers,
  ListOrdered,
  Network,
  Paperclip,
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
import { CreationDialog } from "./CreationDialog.js";
import { listWorkbenchLibrary, type WorkbenchLibraryEntry } from "./workbench-library.js";
import type { WorkbenchFileTarget } from "./workbench-library-context.js";
import { t, useLocale } from "./i18n.js";
import "./conversation-workspace.css";

export type WorkspaceTab = "overview" | "comms" | "files";

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
  phone: boolean;
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
  phone,
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

  // Reset per-conversation expanded items on switch
  useEffect(() => {
    setExpandedComms(new Set());
    setTasks([]);
    setQueue(undefined);
    setPermissions(undefined);
    setFiles([]);
    setFilesHasMore(false);
    setWorkbenchItems([]);
  }, [conversation.id, connection.identity.hubPublicKey]);

  // Fetch live tasks, queue, permissions, files, and local workbench entries
  useEffect(() => {
    const abort = new AbortController();
    const convId = conversation.id;

    // 1. Local workbench items for this conversation (IndexedDB, works offline too)
    void listWorkbenchLibrary(connection, { maxScopes: 200, maxEntries: 500 })
      .then(listing => {
        if (abort.signal.aborted) return;
        setWorkbenchItems(listing.entries.filter(entry => entry.conversationId === convId && entry.state !== "missing").slice(0, 12));
      })
      .catch(() => undefined);

    if (!online) return () => abort.abort();

    // 2. Conversation files
    const fileParams = new URLSearchParams({ conversationId: convId, q: "" });
    void connection.http(`/api/conversation-files?${fileParams}`, { signal: abort.signal })
      .then(raw => {
        if (abort.signal.aborted) return;
        const page = conversationFilesPageSchema.parse(raw);
        setFiles(page.items.slice(0, 12));
        setFilesHasMore(!!page.nextCursor || page.items.length > 12);
      })
      .catch(() => undefined);

    // 3. Direct-bot runtime details (tasks, queue, permissions)
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
      // ignore; user can retry or inspect in full tasks modal
    } finally {
      setStoppingTaskId(undefined);
    }
  };

  // Extract latest bot messages with runChanges summaries (for code conversations)
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

  const artifactsCount = diffMessages.length + workbenchItems.length + files.length;
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

  const renderCommCard = (item: BotCommItem) => {
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
      <article key={item.id} className={`workspace-comm-card${needsApproval ? " is-needs-approval" : ""}`}>
        <div className="workspace-comm-top">
          <div className="workspace-comm-route">
            <span>{item.sourceBotName}</span>
            <ArrowRight size={12} aria-hidden="true"/>
            <span>{item.targetBotName}</span>
          </div>
          <span className={`workspace-comm-status ${statusClass}`}>
            {needsApproval && <AlertTriangle size={11} aria-hidden="true"/>}
            {commStatusLabel(item.status)}
          </span>
        </div>
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
          {item.direction === "incoming" && (
            <span>{t("协作入站")}</span>
          )}
          {deliveryLabel && item.kind !== "agent_bus_stage" && <span>{deliveryLabel}</span>}
          <span>{formatRelativeTime(item.updatedAt, locale)}</span>
        </div>
        {needsApproval && item.pendingApproval && (
          <div className="workspace-comm-alert-box">
            <strong>{item.pendingApproval.title || t("下游等待审批或确认")}</strong>
            {item.pendingApproval.detail && <span>{item.pendingApproval.detail}</span>}
          </div>
        )}
        {!expanded && !(needsApproval && item.pendingApproval) && (item.replyExcerpt || item.sentExcerpt) && (
          <p className="workspace-comm-excerpt">{item.replyExcerpt ?? item.sentExcerpt}</p>
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
                if (phone) onClose();
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

  const renderArtifactsSection = (limit?: number) => {
    const shownDiffs = limit ? diffMessages.slice(0, limit) : diffMessages;
    const shownWb = limit ? workbenchItems.slice(0, limit) : workbenchItems;
    const shownFiles = limit ? files.slice(0, limit) : files;
    const empty = !shownDiffs.length && !shownWb.length && !shownFiles.length;
    if (empty) {
      return <div className="workspace-empty">{t("暂无本轮改动、工作台内容或对话文件。")}</div>;
    }
    return (
      <div className="workspace-list">
        {shownDiffs.map(msg => (
          <div key={`diff:${msg.id}`} className="workspace-diff-row">
            <DiffViewerTrigger connection={connection} message={msg}/>
          </div>
        ))}
        {shownWb.map(entry => (
          <button
            key={`wb:${entry.kind}:${entry.id}`}
            type="button"
            className="workspace-item-row is-interactive"
            onClick={() => {
              onOpenWorkbenchFile({ scope: entry.scope, conversationId: entry.conversationId, id: entry.id, kind: entry.kind, title: entry.title || workbenchKindLabel(entry.kind) });
              if (phone) onClose();
            }}
          >
            <span className="workspace-item-icon"><FileText size={15}/></span>
            <span className="workspace-item-main">
              <span className="workspace-item-title">{entry.title || workbenchKindLabel(entry.kind)}</span>
              <span className="workspace-item-meta">{t("工作台 · {0}", workbenchKindLabel(entry.kind))}</span>
            </span>
          </button>
        ))}
        {shownFiles.map(file => (
          <button
            key={`file:${file.attachmentId}:${file.messageId}`}
            type="button"
            className="workspace-item-row is-interactive"
            onClick={() => {
              onLocateMessage(file.conversationId, file.messageId);
              if (phone) onClose();
            }}
          >
            <span className="workspace-item-icon"><Paperclip size={14}/></span>
            <span className="workspace-item-main">
              <span className="workspace-item-title">{file.name}</span>
              <span className="workspace-item-meta">{formatBytes(file.size)} · {formatRelativeTime(file.createdAt, locale)}</span>
            </span>
          </button>
        ))}
        {(filesHasMore || (limit && files.length > limit)) && (
          <button type="button" className="workspace-section-action" onClick={onOpenAllFiles}>
            <FolderOpen size={12}/>
            <span>{t("查看全部对话文件")}</span>
          </button>
        )}
      </div>
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
            {/* 1. Environment & Context */}
            <section className="workspace-section" aria-label={t("环境与上下文")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <Cpu size={13} aria-hidden="true"/>
                  <span>{t("环境与上下文")}</span>
                </span>
              </div>
              <div className="workspace-card">
                <div className="workspace-kv-grid">
                  <div className="workspace-kv-row">
                    <span className="workspace-kv-label">{t("主机")}</span>
                    <span className="workspace-kv-value" title={hostName}>
                      <span className={`status-dot${online ? " online" : ""}`}/>
                      <span>{hostName}</span>
                    </span>
                  </div>
                  <div className="workspace-kv-row">
                    <span className="workspace-kv-label">{t("连接")}</span>
                    <span className="workspace-kv-value">{connectionSummary}</span>
                  </div>
                  {directBot ? (
                    <>
                      <div className="workspace-kv-row">
                        <span className="workspace-kv-label">Bot</span>
                        <span className="workspace-kv-value">{botLabels.get(directBot.id) ?? directBot.name}</span>
                      </div>
                      {(directBot.model || directBot.engine) && (
                        <div className="workspace-kv-row">
                          <span className="workspace-kv-label">{t("引擎 / 模型")}</span>
                          <span className="workspace-kv-value">{[directBot.engine, directBot.model, directBot.effort].filter(Boolean).join(" · ")}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="workspace-kv-row">
                      <span className="workspace-kv-label">{t("群组成员")}</span>
                      <span className="workspace-kv-value">
                        <Users size={12} aria-hidden="true"/>
                        <span>{t("{0} 位 Bot", convBots.length)}</span>
                      </span>
                    </div>
                  )}
                </div>
                <div className="workspace-chips">
                  {directBot && (
                    <span className={`workspace-chip${directBot.online ? " is-online" : ""}`}>
                      {directBot.online ? t("在线") : t("离线")}
                    </span>
                  )}
                  {permissionLabel && (
                    <span className="workspace-chip is-accent">
                      <ShieldCheck size={11} aria-hidden="true"/>
                      <span>{permissionLabel}</span>
                    </span>
                  )}
                  {group && conversation.parentId && (
                    <span className="workspace-chip">{t("话题 · {0}", group.title)}</span>
                  )}
                  {!directBot && convBots.slice(0, 4).map(bot => (
                    <span key={bot.id} className={`workspace-chip${bot.online ? " is-online" : ""}`}>
                      {botLabels.get(bot.id) ?? bot.name}
                    </span>
                  ))}
                </div>
              </div>
            </section>

            {/* 2. Live Tasks & Queue */}
            <section className="workspace-section" aria-label={t("进行中与队列")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <ListOrdered size={13} aria-hidden="true"/>
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
                  {activeTasks.map(task => (
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
                  {queuedItems.slice(0, 3).map((item, idx) => (
                    <div key={item.message.id} className="workspace-item-row">
                      <span className="workspace-item-icon"><ListOrdered size={13}/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{blocksText(item.message.blocks).trim() || t("排队消息 #{0}", idx + 1)}</span>
                        <span className="workspace-item-meta">{t("队列第 {0} 位", idx + 1)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="workspace-empty">{t("当前空闲，无运行中或排队任务。")}</div>
              )}
            </section>

            {/* 3. Bot-to-Bot Comms (auto-hidden in Overview when 0 items) */}
            {commItems.length > 0 && (
              <section className="workspace-section" aria-label={t("Bot 间通信")}>
                <div className="workspace-section-header">
                  <span className="workspace-section-title">
                    <Network size={13} aria-hidden="true"/>
                    <span>{t("Bot 间通信")}</span>
                  </span>
                  {commItems.length > 3 && (
                    <button type="button" className="workspace-section-action" onClick={() => setTab("comms")}>
                      {t("查看全部 ({0})", commItems.length)}
                    </button>
                  )}
                </div>
                <div className="workspace-list">
                  {commItems.slice(0, 4).map(renderCommCard)}
                </div>
              </section>
            )}

            {/* 4. Artifacts & Run Changes */}
            <section className="workspace-section" aria-label={t("产物与本轮改动")}>
              <div className="workspace-section-header">
                <span className="workspace-section-title">
                  <FileCode2 size={13} aria-hidden="true"/>
                  <span>{t("产物与本轮改动")}</span>
                </span>
                {artifactsCount > 4 && (
                  <button type="button" className="workspace-section-action" onClick={() => setTab("files")}>
                    {t("全部 ({0})", artifactsCount)}
                  </button>
                )}
              </div>
              {renderArtifactsSection(4)}
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
            {filteredComms.length > 0 ? (
              <div className="workspace-list">{filteredComms.map(renderCommCard)}</div>
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
            {renderArtifactsSection()}
          </section>
        )}
      </div>
    </>
  );

  if (phone) {
    return (
      <CreationDialog
        title={t("会话工作区")}
        closeLabel={t("关闭工作区")}
        returnFocus={returnFocus}
        close={onClose}
        className="conversation-workspace-sheet"
      >
        {content}
      </CreationDialog>
    );
  }

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
