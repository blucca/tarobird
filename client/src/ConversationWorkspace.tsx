import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Users,
  X,
} from "lucide-react";
import { type Conversation, type Message } from "../../src/client-protocol/index.js";
import { engineTaskSnapshotSchema, type EngineTask } from "../../src/client-protocol/engine-tasks.js";
import { promptQueueSnapshotSchema } from "../../src/client-protocol/prompt-queue.js";
import { conversationFilesPageSchema, type ConversationFile } from "../../src/client-protocol/conversation-files.js";
import { permissionSettingsSchema, type PermissionSettings } from "../../src/client-protocol/permissions.js";
import { BOT_COMMS_LIMIT, conversationBotCommsSchema, type BotCommItem, type ConversationBotComms } from "../../src/client-protocol/workspace-comms.js";
import { nativeRun } from "../../src/client-protocol/run.js";
import { runChangesSummarySchema } from "../../src/client-protocol/run-changes.js";
import { isAgentBusRecord } from "./agent-bus-record.js";
import type { Bot, HubConnection } from "./connection.js";
import { WorkspaceRunChanges } from "./WorkspaceRunChanges.js";
import {
  buildReplyingEntries,
  createWorkspaceQueueReader,
  previewWorkspaceMessage,
  scopePromptQueue,
  type ScopedPromptQueueState,
  type WorkspaceQueueReader,
} from "./workspace-replying.js";
import { listWorkbenchLibrary, type WorkbenchLibraryEntry } from "./workbench-library.js";
import type { WorkbenchFileTarget } from "./workbench-library-context.js";
import { t, useLocale } from "./i18n.js";
import { formatFileLimit } from "./files.js";
import "./conversation-workspace.css";

export type WorkspaceTab = "overview" | "comms" | "files";

const FILES_PAGE_SIZE = 6;
// A page of Bot messages holds as many whole cards as the rail is tall: four left half of a tall rail empty,
// and a fixed larger number cut a card in two at the bottom edge. A card is about 104px plus the 8px gap (an
// approval card about 135px); the filter row, the pager and the body's padding take about 150px.
const COMMS_PAGE_MIN = 4, COMMS_CARD_PITCH = 114, COMMS_PAGE_CHROME = 150;
export function commsPageSize(bodyHeight: number): number {
  return Math.max(COMMS_PAGE_MIN, Math.floor((bodyHeight - COMMS_PAGE_CHROME) / COMMS_CARD_PITCH));
}

function formatRelativeTime(timestamp: number, locale: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 45) return t("刚刚");
  if (diffSec < 3600) return t("{0} 分钟前", Math.floor(diffSec / 60));
  if (diffSec < 86400) return t("{0} 小时前", Math.floor(diffSec / 3600));
  return new Date(timestamp).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric" });
}

function previewMessage(message: Message | undefined): string {
  return previewWorkspaceMessage(message, t("附件消息"));
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

// The wording follows what the conversation itself says about the same events (bot-steer-delivery.ts).
function commStatusLabel(status: BotCommItem["status"]): string {
  switch (status) {
    case "needs_approval": return t("待审批");
    case "running": return t("运行中");
    case "steered": return t("已并入回复");
    case "queued": return t("排队中");
    case "replied": return t("已回传");
    case "failed": return t("失败");
    case "cancelled": return t("已取消");
    case "uncertain": return t("结果未确认");
  }
}

function commDeliveryLabel(delivery: BotCommItem["delivery"]): string | undefined {
  switch (delivery) {
    case "steered": return t("已并入正在进行的回复");
    case "fell_back_to_queue": return t("未能并入，已改为排队");
    case "queued": return t("经排队投递");
    case "not_delivered": return t("未投递");
    case "steer_uncertain": return t("无法确认是否已并入");
    case "pending": return t("投递中");
    default: return undefined;
  }
}

function workbenchKindLabel(kind: WorkbenchLibraryEntry["kind"]): string {
  if (kind === "whiteboard") return t("白板");
  if (kind === "markdown") return t("文档");
  return t("设计稿");
}

const BOT_COMMS_READ_MS = 20_000;

/** Lightweight hook shared by the header trigger badge and the Workspace panel. */
export function useConversationBotComms(
  connection: HubConnection,
  conversationId: string | undefined,
  enabled: boolean,
  /** The rail is showing. A closed rail only feeds the header badge. */
  visible: boolean,
  /** Changes when a reply in this conversation has ended. */
  turn: string,
) {
  const [data, setData] = useState<ConversationBotComms | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const scope = `${connection.identity.hubPublicKey}:${conversationId ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // One request at a time per conversation: a slow Host must not collect a queue of polls. A read asked for
  // meanwhile (a reply just ended, the rail just opened) runs once when the current one is back.
  const running = useRef<{ scope: string; again: boolean }>(undefined);
  const available = enabled && !!conversationId && connection.state.status === "online" && !!connection.state.botCommsAvailable;

  /** Resolves false only when the Host was asked and did not answer. */
  const refresh = useCallback(async (): Promise<boolean> => {
    if (!available || !conversationId) return true;
    const reqScope = scopeRef.current;
    if (running.current?.scope === reqScope) { running.current.again = true; return true; }
    const mine = running.current = { scope: reqScope, again: false };
    setLoading(true);
    let answered = true;
    try {
      // The general request limit is five minutes; the refresh button waits on this read.
      const raw = await connection.http(`/api/conversations/${encodeURIComponent(conversationId)}/bot-comms`, { signal: AbortSignal.timeout(BOT_COMMS_READ_MS) });
      if (scopeRef.current === reqScope) { setData(conversationBotCommsSchema.parse(raw)); setError(false); }
    } catch {
      if (scopeRef.current === reqScope) { setError(true); answered = false; }
    } finally {
      if (running.current === mine) running.current = undefined;
      if (scopeRef.current === reqScope) setLoading(false);
    }
    if (mine.again && scopeRef.current === reqScope) return latest.current();
    return answered;
  }, [connection, conversationId, available]);
  const latest = useRef(refresh); latest.current = refresh;

  useEffect(() => {
    setData(undefined);
    setError(false);
  }, [scope]);

  // Read when the conversation opens, the rail opens, the connection returns, and a reply ends.
  useEffect(() => { if (available) void refresh(); }, [available, visible, turn, refresh]);

  // Between those, only while something is still in progress (quickly with the rail open, slowly for the
  // badge of a closed one) or slowly with the rail open. A Host that does not answer is asked less often.
  const inProgress = (data?.summary.active ?? 0) > 0;
  useEffect(() => {
    if (!available) return;
    const interval = visible ? inProgress ? 6_000 : 30_000 : inProgress ? 30_000 : 0;
    if (!interval) return;
    let delay = interval, stopped = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") delay = await refresh() ? interval : Math.min(delay * 2, 120_000);
      if (!stopped) timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => { stopped = true; clearTimeout(timer); };
  }, [available, visible, inProgress, refresh]);

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
  /** The newest read of the Bot messages failed. */
  commsError?: boolean;
  onRefreshComms: () => void;
  returnFocus?: React.RefObject<HTMLButtonElement | null>;
  /** Set by whoever opens the rail on the person's request; the rail then takes the focus once. */
  takeFocus?: React.RefObject<boolean>;
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
  commsError,
  onRefreshComms,
  returnFocus,
  takeFocus,
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
  const [queueState, setQueueState] = useState<ScopedPromptQueueState | undefined>(undefined);
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
    setQueueState(undefined);
    setPermissions(undefined);
    setFiles([]);
    setFilesHasMore(false);
    setWorkbenchItems([]);
    // Another conversation may have no changes, and then no "changes" filter to switch back with.
    setFileFilter("all");
  }, [conversation.id, connection.identity.hubPublicKey]);

  const [settledMessageCount, setSettledMessageCount] = useState(messages.length);
  useEffect(() => {
    const timer = setTimeout(() => setSettledMessageCount(messages.length), 1500);
    return () => clearTimeout(timer);
  }, [messages.length]);

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
    }

    return () => abort.abort();
  }, [
    connection,
    conversation.id,
    directBot?.id,
    directBot?.online,
    online,
    connection.state.engineTasksAvailable,
    refreshTick,
    settledMessageCount,
  ]);

  const queueScope = directBot ? `${connection.identity.hubPublicKey}:${conversation.id}:${directBot.id}` : "";
  const scopedQueue = useMemo(
    () => scopePromptQueue(queueState, queueScope, conversation.id, directBot?.id),
    [queueState, queueScope, conversation.id, directBot?.id],
  );
  const queuedItems = scopedQueue?.items ?? [];
  const dispatchedItems = useMemo(
    () => queuedItems.filter(item => item.state === "dispatched"),
    [queuedItems],
  );
  const waitingItems = useMemo(
    () => queuedItems.filter(item => item.state === "queued"),
    [queuedItems],
  );

  // Refresh the prompt queue promptly when messages arrive or active replies start/finish.
  const queueSignal = useMemo(() => {
    let count = 0;
    let streaming = "";
    let lastBot = "";
    for (const msg of messages) {
      if (msg.conversationId !== conversation.id) continue;
      count++;
      if (msg.authorType !== "bot" || msg.forwardedFrom || isAgentBusRecord(msg)) continue;
      if (msg.status === "streaming") streaming += `${msg.id}:${msg.replyTo ?? ""};`;
      else lastBot = `${msg.id}:${msg.status}`;
    }
    return `${count}|${streaming}|${lastBot}`;
  }, [messages, conversation.id]);

  const queueAvailable = online && !!directBot && !!connection.state.promptQueueAvailable;
  const queueNeedsPoll = queuedItems.length > 0 || (online && streamingBots.length > 0);
  const queueReaderRef = useRef<WorkspaceQueueReader | undefined>(undefined);

  useEffect(() => {
    if (!queueAvailable || !directBot) return;
    const convId = conversation.id;
    const botId = directBot.id;
    const scope = queueScope;
    const reader = createWorkspaceQueueReader({
      fetch: async signal => {
        const raw = await connection.http(
          `/api/conversations/${encodeURIComponent(convId)}/queue?${new URLSearchParams({ botId })}`,
          { signal },
        );
        return promptQueueSnapshotSchema.parse(raw);
      },
      onSnapshot: snapshot => {
        setQueueState({ scope, snapshot });
      },
    });
    queueReaderRef.current = reader;
    const onVisibility = () => reader.onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      reader.dispose();
      if (queueReaderRef.current === reader) queueReaderRef.current = undefined;
    };
  }, [connection, conversation.id, directBot?.id, queueAvailable, queueScope]);

  useEffect(() => {
    if (!queueAvailable) return;
    queueReaderRef.current?.trigger();
  }, [queueAvailable, queueScope, queueSignal, refreshTick]);

  useEffect(() => {
    queueReaderRef.current?.setPolling(queueAvailable && queueNeedsPoll);
  }, [queueAvailable, queueScope, queueNeedsPoll]);

  // The permission mode is a Bot setting, owner-only on the Host: read when the rail opens for a Bot and on a
  // manual refresh, not with every message.
  const mayReadPermissions = online && connection.state.user?.role === "owner" && !!directBot?.online;
  useEffect(() => {
    if (!directBot || !mayReadPermissions) return;
    const abort = new AbortController();
    void connection.http(`/api/bots/${encodeURIComponent(directBot.id)}/permissions`, { signal: abort.signal })
      .then(raw => { if (!abort.signal.aborted) setPermissions(permissionSettingsSchema.parse(raw)); })
      .catch(() => undefined);
    return () => abort.abort();
  }, [connection, directBot?.id, mayReadPermissions, refreshTick]);

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
  const replyingEntries = useMemo(
    () => buildReplyingEntries({
      messages,
      conversationId: conversation.id,
      online,
      directBotId: directBot?.id,
      dispatchedItems,
      streamingBots,
      resolveBotName: botId => botLabels.get(botId) ?? bots.find(bot => bot.id === botId)?.name ?? botId,
      attachmentLabel: t("附件消息"),
    }),
    [messages, conversation.id, online, directBot?.id, dispatchedItems, streamingBots, botLabels, bots, locale],
  );
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

  const body = useRef<HTMLDivElement>(null);
  const [commPageSize, setCommPageSize] = useState(COMMS_PAGE_MIN);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const fit = () => setCommPageSize(commsPageSize(node.clientHeight));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // The estimate can be one card too many (cards with two lines of text are taller). When the page then
  // runs past the bottom, it gives one card back, until it fits. An opened card is the person's own choice
  // to see more than fits, and scrolls. The estimate returns when the rail is resized.
  useLayoutEffect(() => {
    const node = body.current;
    if (!node || tab !== "comms" || expandedComms.size > 0 || commPageSize <= COMMS_PAGE_MIN) return;
    if (node.scrollHeight > node.clientHeight + 1) setCommPageSize(size => Math.max(COMMS_PAGE_MIN, size - 1));
  });
  const commTotalPages = Math.max(1, Math.ceil(filteredComms.length / commPageSize));
  useEffect(() => { if (commPage > commTotalPages - 1) setCommPage(commTotalPages - 1); }, [commPage, commTotalPages]);
  const shownCommPage = Math.min(commPage, commTotalPages - 1);
  const pagedComms = filteredComms.slice(shownCommPage * commPageSize, (shownCommPage + 1) * commPageSize);

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
        // The same figure as on the card of this file in the conversation.
        meta: `${formatFileLimit(file.size)} · ${formatRelativeTime(file.createdAt, locale)}`,
        file,
      };
    }),
  ], [workbenchItems, files, locale]);

  const fileTotalPages = Math.max(1, Math.ceil(fileArtifacts.length / FILES_PAGE_SIZE));
  useEffect(() => { if (filePage > fileTotalPages - 1) setFilePage(fileTotalPages - 1); }, [filePage, fileTotalPages]);
  const shownFilePage = Math.min(filePage, fileTotalPages - 1);
  const pagedFileArtifacts = fileArtifacts.slice(shownFilePage * FILES_PAGE_SIZE, (shownFilePage + 1) * FILES_PAGE_SIZE);

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
                : item.status === "cancelled" ? "is-cancelled"
                  : item.status === "uncertain" ? "is-uncertain"
                    : "is-queued";
    return (
      <article key={item.id} className={`workspace-comm-card${compact ? " is-compact" : ""}${needsApproval ? " is-needs-approval" : ""}`}>
        <div className="workspace-comm-top">
          <div className="workspace-comm-route">
            <span title={item.sourceBotName}>{item.sourceBotName}</span>
            <ArrowRight size={11} aria-hidden="true"/>
            <span title={item.targetBotName}>{item.targetBotName}</span>
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
                <span className="workspace-comm-expanded-label">{item.status === "failed" ? t("失败信息") : t("最新回传")}</span>
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

  // The tabs are one stop for the Tab key; the arrow keys, Home and End move between them.
  const tabList = useRef<HTMLDivElement>(null);
  const onTabKey = (event: React.KeyboardEvent) => {
    const order: WorkspaceTab[] = ["overview", "comms", "files"], at = order.indexOf(tab);
    const next = event.key === "ArrowRight" ? order[(at + 1) % order.length]
      : event.key === "ArrowLeft" ? order[(at + order.length - 1) % order.length]
        : event.key === "Home" ? order[0] : event.key === "End" ? order.at(-1) : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[order.indexOf(next)]?.focus({ preventScroll: true });
  };
  // Opened on the person's request: the rail takes the focus, so the keyboard continues inside it and not
  // through every message first. A rail restored with the page leaves the focus where it is.
  useEffect(() => {
    if (!takeFocus?.current) return;
    takeFocus.current = false;
    tabList.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [takeFocus]);
  const close = () => {
    onClose();
    returnFocus?.current?.focus({ preventScroll: true });
  };

  const content = (
    <>
      <div className="workspace-tabs" role="tablist" aria-label={t("工作区标签")} ref={tabList} onKeyDown={onTabKey}>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          id={`${id}-tab-overview`}
          aria-controls={`${id}-panel`}
          aria-selected={tab === "overview"}
          tabIndex={tab === "overview" ? 0 : -1}
          onClick={() => setTab("overview")}
        >
          <span>{t("总览")}</span>
        </button>
        <button
          type="button"
          role="tab"
          className="workspace-tab"
          id={`${id}-tab-comms`}
          aria-controls={`${id}-panel`}
          aria-selected={tab === "comms"}
          tabIndex={tab === "comms" ? 0 : -1}
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
          id={`${id}-tab-files`}
          aria-controls={`${id}-panel`}
          aria-selected={tab === "files"}
          tabIndex={tab === "files" ? 0 : -1}
          onClick={() => setTab("files")}
        >
          <span>{t("文件")}</span>
          {artifactsCount > 0 && <span className="workspace-tab-count">{artifactsCount}</span>}
        </button>
      </div>

      <div className="workspace-body" ref={body} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
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
                      {convBots.length > 3 && (
                        <span className="workspace-chip" title={convBots.slice(3).map(bot => botLabels.get(bot.id) ?? bot.name).join("、")}>
                          +{convBots.length - 3}
                        </span>
                      )}
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
              {activeTasks.length > 0 || waitingItems.length > 0 || replyingEntries.length > 0 ? (
                <div className="workspace-list">
                  {replyingEntries.map(entry => (
                    <div key={entry.key} className="workspace-item-row workspace-replying-row">
                      <span className="workspace-item-icon"><span className="status-dot online"/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title" title={entry.text || undefined}>{entry.text || t("正在回复")}</span>
                        <span className="workspace-item-meta">{entry.text ? t("正在回复 · {0}", entry.botName) : entry.botName}</span>
                      </span>
                    </div>
                  ))}
                  {activeTasks.slice(0, 2).map(task => (
                    <div key={task.id} className="workspace-item-row">
                      <span className="workspace-item-icon"><span className="status-dot online"/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title">{task.label || task.id}</span>
                        <span className="workspace-item-meta">{task.kind === "subagent" ? t("子代理") : task.kind === "shell" ? t("后台命令") : t("后台任务")}</span>
                      </span>
                    </div>
                  ))}
                  {waitingItems.slice(0, 2).map((item, idx) => (
                    <div key={item.message.id} className="workspace-item-row workspace-queue-row">
                      <span className="workspace-item-icon"><ListOrdered size={12}/></span>
                      <span className="workspace-item-main">
                        <span className="workspace-item-title" title={previewMessage(item.message) || undefined}>{previewMessage(item.message) || t("排队消息 #{0}", idx + 1)}</span>
                        <span className="workspace-item-meta">{online ? t("队列第 {0} 位", idx + 1) : t("{0} · {1}", t("队列第 {0} 位", idx + 1), t("离线"))}</span>
                      </span>
                    </div>
                  ))}
                  {(activeTasks.length > 2 || waitingItems.length > 2) && (
                    <div className="workspace-more-hint">
                      {[activeTasks.length > 2 ? t("还有 {0} 个后台任务", activeTasks.length - 2) : "", waitingItems.length > 2 ? t("还有 {0} 条排队消息", waitingItems.length - 2) : ""].filter(Boolean).join(" · ")}
                    </div>
                  )}
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
                  {diffMessages.slice(0, 1).map(msg => <WorkspaceRunChanges key={`diff:${msg.id}`} connection={connection} message={msg}/>)}
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
                    <button type="button" disabled={shownCommPage === 0} onClick={() => setCommPage(p => Math.max(0, p - 1))}>{t("上一页")}</button>
                    <span>{shownCommPage + 1} / {commTotalPages}</span>
                    <button type="button" disabled={shownCommPage + 1 >= commTotalPages} onClick={() => setCommPage(p => Math.min(commTotalPages - 1, p + 1))}>{t("下一页")}</button>
                  </div>
                )}
              </>
            ) : (
              <div className="workspace-empty">
                {commItems.length > 0
                  ? t("当前筛选下没有匹配的通信记录。")
                  : comms !== undefined
                    ? t("这个对话里还没有 Bot 之间的往来。Bot 互相委托、跨主机调用和多 Bot 协作会自动显示在这里。")
                    : commsError && !commsLoading
                      ? t("暂时读不到 Bot 之间的往来，请稍后再刷新。")
                      : t("正在读取…")}
              </div>
            )}
            {commItems.length >= BOT_COMMS_LIMIT && (
              <div className="workspace-more-hint">{t("这里最多显示最近 {0} 条，更早的往来不在其中。", BOT_COMMS_LIMIT)}</div>
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
                    {diffMessages.map(msg => <WorkspaceRunChanges key={`diff:${msg.id}`} connection={connection} message={msg}/>)}
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
                    <button type="button" disabled={shownFilePage === 0} onClick={() => setFilePage(p => Math.max(0, p - 1))}>{t("上一页")}</button>
                    <span>{shownFilePage + 1} / {fileTotalPages}</span>
                    <button type="button" disabled={shownFilePage + 1 >= fileTotalPages} onClick={() => setFilePage(p => Math.min(fileTotalPages - 1, p + 1))}>{t("下一页")}</button>
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
    <aside id={id} className="conversation-workspace-rail" aria-label={t("会话工作区")}
      onKeyDown={event => {
        // Only an Escape pressed in the rail itself: one that closes a dialog opened from here (the changes
        // viewer) reaches this handler too, through React's tree or from inside the rail's own element.
        const target = event.target as Element;
        if (event.key !== "Escape" || event.defaultPrevented || !event.currentTarget.contains(target) || target.closest("dialog,[role='dialog'],[role='menu']")) return;
        event.preventDefault(); close();
      }}>
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
            onClick={close}
          >
            <X size={15}/>
          </button>
        </div>
      </header>
      {content}
    </aside>
  );
}
