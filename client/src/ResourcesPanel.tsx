import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronRight, Cpu, Monitor, RefreshCw, Square, X } from "lucide-react";
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
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
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
  readOnly,
  stoppingKey,
  onRequestStop,
}: {
  snapshot?: HostResourcesSnapshot;
  loading: boolean;
  error: string;
  sort: ResourceSortKey;
  readOnly: boolean;
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

  const canStop = !readOnly && snapshot.canStop;
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
            <ResourceSparkline points={snapshot.history} metric="memory" width={104} height={24} />
          </div>
          <div className="resources-sparkline-box">
            <span>{t("CPU 趋势")}</span>
            <ResourceSparkline points={snapshot.history} metric="cpu" width={104} height={24} />
          </div>
        </div>
        <div className="resources-breakdown">
          <div>
            <small>{t("主机服务")}</small>
            <span>{formatCpuPercent(snapshot.summary.hostCpuPercent)} · {formatMemoryBytes(snapshot.summary.hostMemoryBytes)}</span>
          </div>
          {snapshot.summary.appMemoryBytes > 0 && (
            <div>
              <small>{t("桌面应用")}</small>
              <span>{formatCpuPercent(snapshot.summary.appCpuPercent)} · {formatMemoryBytes(snapshot.summary.appMemoryBytes)}</span>
            </div>
          )}
          <div>
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
          <ul className="resources-proc-list">
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

/** Desktop bottom-right status bar entry + Resource Manager popover. */
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
  const popoverId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) setSelectedHostId(activeHostId);
  }, [activeHostId, open]);

  const targetHost = hosts.find((h) => h.id === selectedHostId) ?? hosts.find((h) => h.id === activeHostId) ?? hosts[0];
  const { snapshot, loading, error, refresh } = useHostResources(targetHost?.connection, visible, open ? POLL_OPEN_MS : POLL_CLOSED_MS);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (pendingStop) return;
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingStop) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, pendingStop]);

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

  return (
    <div ref={rootRef} className="resources-statusbar-anchor">
      <button
        type="button"
        className={`resources-status-pill${open ? " is-open" : ""}`}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={t("资源")}
        onClick={() => { setStopNotice(""); setOpen((v) => !v); }}
      >
        <Cpu size={13} aria-hidden="true" />
        <span className="resources-status-label">{t("资源")}</span>
        {snapshot ? (
          <>
            <span className="resources-status-value">{formatCpuPercent(snapshot.summary.totalCpuPercent)}</span>
            <span className="resources-status-sep" aria-hidden="true">·</span>
            <span className="resources-status-value">{formatMemoryBytes(snapshot.summary.totalMemoryBytes)}</span>
            <ResourceSparkline points={snapshot.history} metric="memory" width={40} height={14} />
          </>
        ) : (
          <span className="resources-status-value muted">—</span>
        )}
      </button>

      {open && (
        <section id={popoverId} className="resources-popover" role="dialog" aria-label={t("资源管理")}>
          <header className="resources-popover-header">
            <div className="resources-popover-title">
              <Activity size={16} aria-hidden="true" />
              <strong>{t("资源管理")}</strong>
            </div>
            <div className="resources-popover-actions">
              <button
                type="button"
                className="icon-button"
                aria-label={t("刷新资源")}
                title={t("刷新资源")}
                disabled={loading}
                onClick={refresh}
              >
                <RefreshCw size={14} className={loading ? "spin" : undefined} />
              </button>
              <button type="button" className="icon-button" aria-label={t("关闭资源面板")} onClick={() => setOpen(false)}>
                <X size={15} />
              </button>
            </div>
          </header>

          <div className="resources-toolbar">
            {hosts.length > 1 ? (
              <label className="resources-select-wrap">
                <Monitor size={13} aria-hidden="true" />
                <select
                  aria-label={t("切换主机")}
                  value={targetHost.id}
                  onChange={(e) => { setStopNotice(""); setSelectedHostId(e.target.value); }}
                >
                  {hosts.map((host) => (
                    <option key={host.id} value={host.id}>{host.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="resources-host-label"><Monitor size={13} aria-hidden="true" />{targetHost.name}</span>
            )}
            <label className="resources-select-wrap">
              <span className="screen-reader-only">{t("排序方式")}</span>
              <select aria-label={t("排序方式")} value={sort} onChange={(e) => setSort(e.target.value as ResourceSortKey)}>
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
            readOnly={false}
            stoppingKey={stoppingKey}
            onRequestStop={setPendingStop}
          />
        </section>
      )}

      {pendingStop && (
        <CreationDialog
          title={t("确认停止进程？")}
          closeLabel={t("取消")}
          close={() => { if (!stoppingKey) setPendingStop(undefined); }}
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
            <button type="button" disabled={!!stoppingKey} onClick={() => setPendingStop(undefined)}>{t("取消")}</button>
            <button type="button" className="text-danger" disabled={!!stoppingKey} onClick={() => void confirmStop()}>
              {stoppingKey ? t("正在停止…") : t("确认停止")}
            </button>
          </div>
        </CreationDialog>
      )}
    </div>
  );
}

/** Read-only mobile resource list on the Host's page. */
export function MobileResourcesDialog({
  connection,
  hostName,
  close,
}: {
  connection: HubConnection;
  hostName: string;
  close: () => void;
}) {
  useLocale();
  const [sort, setSort] = useState<ResourceSortKey>("memory");
  const { snapshot, loading, error, refresh } = useHostResources(connection, true, POLL_OPEN_MS);

  return (
    <CreationDialog
      mobilePage
      title={t("资源监控")}
      closeLabel={t("返回")}
      close={close}
      className="resources-mobile-dialog"
    >
      <div className="resources-toolbar">
        <span className="resources-host-label"><Monitor size={14} aria-hidden="true" />{hostName}</span>
        <div className="resources-mobile-controls">
          <select aria-label={t("排序方式")} value={sort} onChange={(e) => setSort(e.target.value as ResourceSortKey)}>
            <option value="memory">{t("按内存排序")}</option>
            <option value="cpu">{t("按 CPU 排序")}</option>
            <option value="name">{t("按名称排序")}</option>
          </select>
          <button type="button" className="icon-button" aria-label={t("刷新资源")} disabled={loading} onClick={refresh}>
            <RefreshCw size={15} className={loading ? "spin" : undefined} />
          </button>
        </div>
      </div>
      <p className="muted resources-mobile-note">{t("手机端仅支持查看资源占用；如需停止异常引擎进程，请在电脑端操作。")}</p>
      <ResourceTreeBody
        snapshot={snapshot}
        loading={loading}
        error={error}
        sort={sort}
        readOnly={true}
      />
    </CreationDialog>
  );
}
