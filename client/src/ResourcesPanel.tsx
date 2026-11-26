import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Activity, ChevronDown, ChevronRight, Monitor, RefreshCw, Square, X } from "lucide-react";
import {
  formatCpuPercent,
  formatMemoryBytes,
  sortResourceBots,
  sortResourceConversations,
  type HostResourceStopRequest,
  type HostResourcesSnapshot,
  type ResourceBotGroup,
  type ResourceProcess,
  type ResourceSortKey,
  type ResourceSparklinePoint,
} from "../../src/client-protocol/host-resources.js";
import { useBackAction } from "./back-navigation.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { useDialogDrag } from "./dialog-drag.js";
import { t, useLocale } from "./i18n.js";
import "./resources.css";

export type ResourceHostEntry = {
  id: string;
  name: string;
  connection: HubConnection;
};

const POLL_CLOSED_MS = 10_000;
const POLL_OPEN_MS = 3_000;

export function ResourceSparkline({
  points,
  metric = "memory",
  width = 84,
  height = 22,
}: {
  points: readonly ResourceSparklinePoint[];
  metric?: "memory" | "cpu";
  width?: number;
  height?: number;
}) {
  if (!points.length) return null;
  const values = points.map((p) => (metric === "cpu" ? p.cpuPercent : p.memoryBytes));
  const max = Math.max(...values, metric === "cpu" ? 10 : 1024 * 1024);
  const min = 0;
  const range = Math.max(1e-6, max - min);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((v, i) => {
    const x = values.length > 1 ? i * step : width / 2;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = values.length === 1
    ? `M 0,${coords[0]!.split(",")[1]} L ${width},${coords[0]!.split(",")[1]}`
    : `M ${coords.join(" L ")}`;
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;
  return (
    <svg className="resources-sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="resources-sparkline-area" d={areaPath} />
      <path className="resources-sparkline-line" d={linePath} />
    </svg>
  );
}

type PendingStop = {
  botId: string;
  botName: string;
  conversationId?: string;
  conversationTitle?: string;
  pid?: number;
  processName?: string;
};

function useHostResources(connection: HubConnection | undefined, active: boolean, intervalMs: number) {
  const [snapshot, setSnapshot] = useState<HostResourcesSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inflight = useRef(false);

  const load = useCallback(async (force = false) => {
    if (!connection || connection.state.status !== "online" || !connection.state.hostResourcesAvailable || inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const data = await connection.hostResources({ force });
      setSnapshot(data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("无法读取资源数据"));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => {
    setSnapshot(undefined);
    setError("");
  }, [connection]);

  useEffect(() => {
    if (!active || !connection) return;
    void load(false);
    const timer = setInterval(() => {
      if (!document.hidden) void load(false);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, connection, intervalMs, load]);

  return { snapshot, loading, error, refresh: () => void load(true) };
}

function ResourceTreeBody({
  snapshot,
  loading,
  error,
  sort,
  stoppingKey,
  onRequestStop,
}: {
  snapshot?: HostResourcesSnapshot;
  loading: boolean;
  error: string;
  sort: ResourceSortKey;
  stoppingKey?: string;
  onRequestStop?: (target: PendingStop) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const sortedBots = useMemo(() => sortResourceBots(snapshot?.bots ?? [], sort), [snapshot?.bots, sort]);

  if (error && !snapshot) {
    return <p className="resources-empty error-text" role="alert">{t("暂时无法读取资源使用情况。")}</p>;
  }
  if (!snapshot) {
    return <p className="resources-empty muted" role="status">{loading ? t("正在采样进程资源…") : t("暂无资源数据")}</p>;
  }

  const readOnly = !snapshot.canStop;
  const canStop = snapshot.canStop;
  const toggleBot = (botId: string) => setCollapsed((old) => ({ ...old, [botId]: !old[botId] }));

  return (
    <div className="resources-body">
      <section className="resources-card" aria-label={t("TaroBird 自身占用")}>
        <header className="resources-card-head">
          <div>
            <strong>TaroBird</strong>
            <span className="resources-card-sub">
              {t("{0} 个进程 · {1} 个运行中任务", snapshot.summary.processCount, snapshot.summary.activeTasks)}
            </span>
          </div>
          <div className="resources-card-totals">
            <span className="resources-metric-pill">{formatCpuPercent(snapshot.summary.totalCpuPercent)} CPU</span>
            <span className="resources-metric-pill">{formatMemoryBytes(snapshot.summary.totalMemoryBytes)}</span>
          </div>
        </header>
        <div className="resources-sparkline-row">
          <div className="resources-sparkline-box">
            <span>{t("内存趋势")}</span>
            <ResourceSparkline points={snapshot.history} metric="memory" width={144} height={28} />
          </div>
          <div className="resources-sparkline-box">
            <span>{t("CPU 趋势")}</span>
            <ResourceSparkline points={snapshot.history} metric="cpu" width={144} height={28} />
          </div>
        </div>
        <div className="resources-breakdown">
          <div className="resources-breakdown-card">
            <small>{t("主机服务")}</small>
            <span>{formatCpuPercent(snapshot.summary.hostCpuPercent)} · {formatMemoryBytes(snapshot.summary.hostMemoryBytes)}</span>
          </div>
          {snapshot.summary.appMemoryBytes > 0 && (
            <div className="resources-breakdown-card">
              <small>{t("桌面应用")}</small>
              <span>{formatCpuPercent(snapshot.summary.appCpuPercent)} · {formatMemoryBytes(snapshot.summary.appMemoryBytes)}</span>
            </div>
          )}
          <div className="resources-breakdown-card">
            <small>{t("引擎与 Bot")}</small>
            <span>{formatCpuPercent(snapshot.summary.engineCpuPercent)} · {formatMemoryBytes(snapshot.summary.engineMemoryBytes)}</span>
          </div>
        </div>
      </section>

      <section className="resources-section" aria-label={t("Bot 与引擎进程")}>
        <header className="resources-section-head">
          <h3>{t("Bot 与对话进程")}</h3>
          {readOnly && <span className="resources-readonly-badge">{t("只读")}</span>}
        </header>
        {!sortedBots.length ? (
          <p className="resources-empty muted">{t("当前没有运行中的 Bot 进程。")}</p>
        ) : (
          <ul className="resources-bot-list">
            {sortedBots.map((bot: ResourceBotGroup) => {
              const isCollapsed = !!collapsed[bot.botId];
              const conversations = sortResourceConversations(bot.conversations, sort);
              return (
                <li key={bot.botId} className="resources-bot-group">
                  <button
                    type="button"
                    className="resources-bot-row"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleBot(bot.botId)}
                  >
                    {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <span className="resources-bot-name">{bot.botName}</span>
                    {bot.engine && <span className="resources-engine-tag">{bot.engine}</span>}
                    {bot.activeTurns > 0 && <span className="resources-active-tag">{t("{0} 运行中", bot.activeTurns)}</span>}
                    <span className="resources-row-metrics">
                      <span>{formatCpuPercent(bot.cpuPercent)}</span>
                      <span>{formatMemoryBytes(bot.memoryBytes)}</span>
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className="resources-bot-children">
                      {conversations.map((conv) => {
                        const convStopKey = `${bot.botId}:${conv.conversationId}`;
                        return (
                          <div key={conv.conversationId} className="resources-conv-group">
                            <div className="resources-conv-row">
                              <span className="resources-conv-title" title={conv.title}>{conv.title}</span>
                              <span className="resources-row-metrics">
                                <span>{formatCpuPercent(conv.cpuPercent)}</span>
                                <span>{formatMemoryBytes(conv.memoryBytes)}</span>
                              </span>
                              {canStop && conv.stoppable && (
                                <button
                                  type="button"
                                  className="resources-stop-btn"
                                  disabled={stoppingKey === convStopKey}
                                  aria-label={t("停止 {0} 中的运行", conv.title)}
                                  onClick={() => onRequestStop?.({
                                    botId: bot.botId,
                                    botName: bot.botName,
                                    conversationId: conv.conversationId,
                                    conversationTitle: conv.title,
                                    pid: conv.processes[0]?.pid,
                                    processName: conv.processes[0]?.name,
                                  })}
                                >
                                  <Square size={11} aria-hidden="true" />
                                  <span>{t("停止")}</span>
                                </button>
                              )}
                            </div>
                            {conv.processes.length > 0 && (
                              <ul className="resources-proc-list">
                                {conv.processes.map((proc: ResourceProcess) => {
                                  const procKey = `${bot.botId}:${conv.conversationId}:${proc.pid}`;
                                  return (
                                    <li key={proc.id} className="resources-proc-row">
                                      <span className="resources-proc-name">{proc.name}</span>
                                      <span className="resources-proc-pid">PID {proc.pid}</span>
                                      <span className="resources-row-metrics">
                                        <span>{formatCpuPercent(proc.cpuPercent)}</span>
                                        <span>{formatMemoryBytes(proc.memoryBytes)}</span>
                                      </span>
                                      {canStop && proc.stoppable && conv.processes.length > 1 && (
                                        <button
                                          type="button"
                                          className="resources-stop-btn is-subtle"
                                          disabled={stoppingKey === procKey}
                                          aria-label={t("停止进程 {0}", proc.pid)}
                                          onClick={() => onRequestStop?.({
                                            botId: bot.botId,
                                            botName: bot.botName,
                                            conversationId: conv.conversationId,
                                            conversationTitle: conv.title,
                                            pid: proc.pid,
                                            processName: proc.name,
                                          })}
                                        >
                                          <Square size={10} aria-hidden="true" />
                                        </button>
                                      )}
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                      {bot.unattributed.length > 0 && (
                        <ul className="resources-proc-list is-bot-other">
                          {bot.unattributed.map((proc: ResourceProcess) => {
                            const procKey = `${bot.botId}:pid:${proc.pid}`;
                            return (
                              <li key={proc.id} className="resources-proc-row">
                                <span className="resources-proc-name">{proc.name}</span>
                                <span className="resources-proc-pid">PID {proc.pid}</span>
                                <span className="resources-row-metrics">
                                  <span>{formatCpuPercent(proc.cpuPercent)}</span>
                                  <span>{formatMemoryBytes(proc.memoryBytes)}</span>
                                </span>
                                {canStop && proc.stoppable && (
                                  <button
                                    type="button"
                                    className="resources-stop-btn is-subtle"
                                    disabled={stoppingKey === procKey}
                                    aria-label={t("停止进程 {0}", proc.pid)}
                                    onClick={() => onRequestStop?.({
                                      botId: bot.botId,
                                      botName: bot.botName,
                                      pid: proc.pid,
                                      processName: proc.name,
                                    })}
                                  >
                                    <Square size={10} aria-hidden="true" />
                                    <span>{t("停止")}</span>
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {snapshot.unattributed.length > 0 && (
        <section className="resources-section" aria-label={t("未归属进程")}>
          <header className="resources-section-head">
            <h3>{t("未归属进程")}</h3>
          </header>
          <ul className="resources-proc-list resources-unattributed-list">
            {snapshot.unattributed.map((proc) => (
              <li key={proc.id} className="resources-proc-row">
                <span className="resources-proc-name">{proc.name}</span>
                <span className="resources-proc-pid">PID {proc.pid}</span>
                <span className="resources-row-metrics">
                  <span>{formatCpuPercent(proc.cpuPercent)}</span>
                  <span>{formatMemoryBytes(proc.memoryBytes)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Centered desktop Resource Manager modal dialog. */
function ResourcesDialog({
  id,
  hosts,
  targetHost,
  onSelectHost,
  snapshot,
  loading,
  error,
  sort,
  onSortChange,
  stopNotice,
  stoppingKey,
  pendingStop,
  onRequestStop,
  onConfirmStop,
  onCancelStop,
  onRefresh,
  onClose,
  returnFocus,
}: {
  id: string;
  hosts: readonly ResourceHostEntry[];
  targetHost: ResourceHostEntry;
  onSelectHost: (hostId: string) => void;
  snapshot?: HostResourcesSnapshot;
  loading: boolean;
  error: string;
  sort: ResourceSortKey;
  onSortChange: (sort: ResourceSortKey) => void;
  stopNotice: string;
  stoppingKey?: string;
  pendingStop?: PendingStop;
  onRequestStop: (target: PendingStop) => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
  onRefresh: () => void;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);
  const intentionalClose = useRef(false);
  const titleId = useId();
  const busy = !!pendingStop || !!stoppingKey;

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useBackAction(dialogRef, requestClose);
  useDialogDrag(dialogRef, headerRef, true);

  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    intentionalClose.current = false;
    node?.showModal();
    if (document.activeElement === closeButtonRef.current || !node?.contains(document.activeElement)) {
      headingRef.current?.focus({ preventScroll: true });
    }
    return () => {
      intentionalClose.current = true;
      node?.close();
      (returnFocus.current ?? before)?.focus({ preventScroll: true });
    };
  }, [returnFocus]);

  return (
    <>
      <dialog
        ref={dialogRef}
        id={id}
        className="resources-dialog is-movable"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onCancel={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          event.stopPropagation();
          requestClose();
        }}
        onClose={(event) => {
          if (event.target !== event.currentTarget || intentionalClose.current || event.currentTarget.open) return;
          if (busy) {
            event.currentTarget.showModal();
          } else {
            onClose();
          }
        }}
        onPointerDown={(event) => {
          const r = event.currentTarget.getBoundingClientRect();
          backdropPress.current = event.button === 0 && event.target === event.currentTarget
            && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
        }}
        onClick={(event) => {
          const startedOutside = backdropPress.current;
          backdropPress.current = false;
          if (startedOutside && event.target === event.currentTarget && !busy) {
            const r = event.currentTarget.getBoundingClientRect();
            if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
              onClose();
            }
          }
        }}
      >
        <header ref={headerRef} className="resources-dialog-header">
          <div className="resources-dialog-title">
            <Activity size={17} aria-hidden="true" />
            <h2 id={titleId} ref={headingRef} tabIndex={-1}>{t("资源管理")}</h2>
          </div>
          <div className="resources-dialog-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t("刷新资源")}
              title={t("刷新资源")}
              disabled={loading}
              onClick={onRefresh}
            >
              <RefreshCw size={15} className={loading ? "spin" : undefined} />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="icon-button"
              aria-label={t("关闭资源面板")}
              onClick={requestClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="resources-toolbar">
          {hosts.length > 1 ? (
            <label className="resources-select-wrap">
              <Monitor size={14} aria-hidden="true" />
              <select
                aria-label={t("切换主机")}
                value={targetHost.id}
                onChange={(e) => onSelectHost(e.target.value)}
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>{host.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="resources-host-label"><Monitor size={14} aria-hidden="true" />{targetHost.name}</span>
          )}
          <label className="resources-select-wrap">
            <span className="screen-reader-only">{t("排序方式")}</span>
            <select aria-label={t("排序方式")} value={sort} onChange={(e) => onSortChange(e.target.value as ResourceSortKey)}>
              <option value="memory">{t("按内存排序")}</option>
              <option value="cpu">{t("按 CPU 排序")}</option>
              <option value="name">{t("按名称排序")}</option>
            </select>
          </label>
        </div>

        {stopNotice && <p className="resources-notice" role="status">{stopNotice}</p>}

        <ResourceTreeBody
          snapshot={snapshot}
          loading={loading}
          error={error}
          sort={sort}
          stoppingKey={stoppingKey}
          onRequestStop={onRequestStop}
        />
      </dialog>

      {pendingStop && (
        <CreationDialog
          title={t("确认停止进程？")}
          closeLabel={t("取消")}
          close={onCancelStop}
          busy={!!stoppingKey}
          showHost={false}
        >
          <p>
            {pendingStop.conversationTitle
              ? t("将停止「{0}」在对话「{1}」中的当前运行，效果与在聊天中点击停止相同，对话中会显示已停止。", pendingStop.botName, pendingStop.conversationTitle)
              : t("将停止「{0}」的引擎进程（PID {1}）。", pendingStop.botName, pendingStop.pid ?? 0)}
          </p>
          {pendingStop.pid && (
            <p className="muted">{t("目标进程：{0} (PID {1})", pendingStop.processName ?? "engine", pendingStop.pid)}</p>
          )}
          <div className="quick-actions">
            <button type="button" disabled={!!stoppingKey} onClick={onCancelStop}>{t("取消")}</button>
            <button type="button" className="text-danger" disabled={!!stoppingKey} onClick={onConfirmStop}>
              {stoppingKey ? t("正在停止…") : t("确认停止")}
            </button>
          </div>
        </CreationDialog>
      )}
    </>
  );
}

/** Desktop bottom-right status bar entry + centered Resource Manager modal dialog. */
export function DesktopResourcesBar({
  hosts,
  activeHostId,
  visible,
}: {
  hosts: readonly ResourceHostEntry[];
  activeHostId: string;
  visible: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState(activeHostId);
  const [sort, setSort] = useState<ResourceSortKey>("memory");
  const [pendingStop, setPendingStop] = useState<PendingStop>();
  const [stoppingKey, setStoppingKey] = useState<string>();
  const [stopNotice, setStopNotice] = useState("");
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) setSelectedHostId(activeHostId);
  }, [activeHostId, open]);

  useEffect(() => {
    if (!visible && open) {
      setPendingStop(undefined);
      setOpen(false);
    }
  }, [visible, open]);

  const targetHost = hosts.find((h) => h.id === selectedHostId) ?? hosts.find((h) => h.id === activeHostId) ?? hosts[0];
  const { snapshot, loading, error, refresh } = useHostResources(targetHost?.connection, visible, open ? POLL_OPEN_MS : POLL_CLOSED_MS);

  if (!targetHost || !targetHost.connection.state.hostResourcesAvailable) return null;

  const confirmStop = async () => {
    if (!pendingStop || !targetHost) return;
    const key = pendingStop.conversationId
      ? `${pendingStop.botId}:${pendingStop.conversationId}`
      : `${pendingStop.botId}:pid:${pendingStop.pid ?? 0}`;
    setStoppingKey(key);
    setStopNotice("");
    try {
      const payload: HostResourceStopRequest = {
        botId: pendingStop.botId,
        ...(pendingStop.conversationId ? { conversationId: pendingStop.conversationId } : {}),
        ...(pendingStop.pid ? { pid: pendingStop.pid } : {}),
      };
      await targetHost.connection.stopHostResource(payload);
      setPendingStop(undefined);
      setStopNotice(pendingStop.conversationTitle ? t("已请求停止「{0}」中的运行。", pendingStop.conversationTitle) : t("已请求停止该引擎进程。"));
      setTimeout(refresh, 300);
    } catch {
      setStopNotice(t("停止进程失败，请确认此设备具有管理员权限且主机在线。"));
    } finally {
      setStoppingKey(undefined);
    }
  };

  const summaryMem = snapshot ? formatMemoryBytes(snapshot.summary.totalMemoryBytes) : "";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`icon-button resources-footer-button${open ? " is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={t("资源")}
        title={snapshot ? t("资源 · CPU {0} · 内存 {1}", formatCpuPercent(snapshot.summary.totalCpuPercent), summaryMem) : t("资源")}
        onClick={() => { setStopNotice(""); setOpen(true); }}
      >
        <Activity size={15} aria-hidden="true" />
      </button>

      {open && (
        <ResourcesDialog
          id={dialogId}
          hosts={hosts}
          targetHost={targetHost}
          onSelectHost={(hostId) => { setStopNotice(""); setSelectedHostId(hostId); }}
          snapshot={snapshot}
          loading={loading}
          error={error}
          sort={sort}
          onSortChange={setSort}
          stopNotice={stopNotice}
          stoppingKey={stoppingKey}
          pendingStop={pendingStop}
          onRequestStop={setPendingStop}
          onConfirmStop={() => void confirmStop()}
          onCancelStop={() => { if (!stoppingKey) setPendingStop(undefined); }}
          onRefresh={refresh}
          onClose={() => setOpen(false)}
          returnFocus={triggerRef}
        />
      )}
    </>
  );
}
