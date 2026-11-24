import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, Bot as BotIcon, CheckCircle2, Cpu, LoaderCircle, MemoryStick, Monitor, Plus, RefreshCw, Scale } from "lucide-react";
import {
  defaultLoadBalancingPreferences,
  selectBalancedHost,
  type HostBalanceCandidate,
  type HostBalanceExclusionReason,
  type HostBalanceSelection,
  type LoadBalancingPreferences,
} from "../../src/client-protocol/host-balancer.js";
import { hostResourcesSchema, type HostResources } from "../../src/client-protocol/host-resources.js";
import { createBotSchema } from "../../src/client-protocol/bots.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { ConnectedHost } from "./host-connections.js";
import { CreationDialog } from "./CreationDialog.js";
import { isDispatcher } from "./dispatcher.js";
import { timeoutSignal } from "./abort-signals.js";
import { t, useLocale } from "./i18n.js";
import "./load-balancing.css";

const ENGINES = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Antigravity" },
  { id: "kimi", label: "Kimi Code" },
  { id: "pi", label: "Pi" },
  { id: "deepseek", label: "DeepSeek" },
] as const;

function exclusionLabel(reason: HostBalanceExclusionReason): string {
  switch (reason) {
    case "offline": return t("离线");
    case "manual_only": return t("已设为仅手动");
    case "engine_unavailable": return t("未安装或未就绪该引擎");
    case "quota_exhausted": return t("额度已用尽");
    case "resources_unavailable": return t("无法读取主机负载");
    case "overloaded": return t("当前负载已满");
  }
}

export function AutoHostDialog({
  hosts,
  loadBalancing,
  recentAssignments,
  onAssigned,
  onManualHost,
  onCreated,
  close,
}: {
  hosts: ConnectedHost[];
  loadBalancing?: LoadBalancingPreferences;
  recentAssignments: readonly string[];
  onAssigned: (hostId: string) => void;
  onManualHost: (hostId: string) => void;
  onCreated: (hostId: string, conversation: Conversation) => void;
  close: () => void;
}) {
  useLocale();
  const prefs: LoadBalancingPreferences = {
    ...defaultLoadBalancingPreferences,
    ...loadBalancing,
    hostPreferences: { ...(loadBalancing?.hostPreferences ?? {}) },
    botTemplate: { ...defaultLoadBalancingPreferences.botTemplate, ...(loadBalancing?.botTemplate ?? {}) },
  };
  const [mode, setMode] = useState<"auto" | "manual">(prefs.enabled ? "auto" : "manual");
  const [engine, setEngine] = useState<string>("claude");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [selection, setSelection] = useState<HostBalanceSelection | undefined>(undefined);
  // Keep the chosen Host pinned during the draft stage until the user explicitly re-picks or changes engine.
  const [pinnedHostId, setPinnedHostId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const evalSeq = useRef(0);

  const evaluate = useCallback(async (targetEngine: string, forceRepick = false) => {
    const seq = ++evalSeq.current;
    setEvaluating(true);
    setError("");
    try {
      const candidates: HostBalanceCandidate[] = await Promise.all(hosts.map(async (entry) => {
        const conn = entry.connection;
        const online = conn?.state.status === "online";
        const pref = prefs.hostPreferences[entry.host.publicKey] ?? "normal";
        const bots = (conn?.state.bots ?? []).filter((bot) => !isDispatcher(bot));
        const matchingBot = bots.find((bot) => bot.engine === targetEngine && bot.online) ?? bots.find((bot) => bot.engine === targetEngine);

        let resources: HostResources | undefined;
        let engineAvailable = Boolean(matchingBot);
        if (online && conn) {
          const [resOutcome, catOutcome] = await Promise.allSettled([
            conn.http<unknown>("/api/host-resources", { signal: timeoutSignal(4_000) }),
            conn.state.user?.role === "owner" ? conn.http<{ engines?: Array<{ id?: string; engine?: string; available?: boolean; installed?: boolean }> }>("/api/bots/catalog", { signal: timeoutSignal(4_000) }) : Promise.resolve(undefined),
          ]);
          if (resOutcome.status === "fulfilled") {
            const parsed = hostResourcesSchema.safeParse(resOutcome.value);
            if (parsed.success) resources = parsed.data;
          }
          if (catOutcome.status === "fulfilled" && catOutcome.value?.engines) {
            const matchedEngine = catOutcome.value.engines.find((item) => (item.id ?? item.engine) === targetEngine);
            if (matchedEngine) {
              engineAvailable = matchedEngine.available !== false && matchedEngine.installed !== false;
            }
          }
        }
        return {
          hostId: entry.host.id,
          hostName: entry.host.name,
          hostKey: entry.host.publicKey,
          online,
          preference: pref,
          engineAvailable,
          quotaExhausted: false,
          latencyMs: conn?.state.latency,
          resources,
          ...(matchingBot ? { matchingBotId: matchingBot.id, matchingBotName: matchingBot.name } : {}),
        };
      }));
      if (seq !== evalSeq.current) return;
      const result = selectBalancedHost(candidates, { recentAssignments });
      setSelection(result);
      setPinnedHostId((prev) => {
        if (!forceRepick && prev && result.ranked.some((item) => item.candidate.hostId === prev)) return prev;
        return result.selected?.hostId;
      });
    } finally {
      if (seq === evalSeq.current) setEvaluating(false);
    }
  }, [hosts, prefs.hostPreferences, recentAssignments]);

  useEffect(() => {
    if (mode === "auto") void evaluate(engine, true);
  }, [mode, engine]);

  const chosenCandidate = selection?.ranked.find((item) => item.candidate.hostId === pinnedHostId)?.candidate ?? selection?.selected ?? null;

  const submitAuto = async () => {
    if (busy || !chosenCandidate) return;
    const entry = hosts.find((item) => item.host.id === chosenCandidate.hostId);
    const conn = entry?.connection;
    if (!entry || !conn || conn.state.status !== "online") {
      setError(t("所选主机当前不在线，请重新选择或改为手动选择。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      let botId = chosenCandidate.matchingBotId;
      let botName = chosenCandidate.matchingBotName;
      if (!botId) {
        if (conn.state.user?.role !== "owner") {
          throw new Error(t("该主机上没有匹配的 Bot，且当前账号没有自动创建 Bot 的权限。"));
        }
        const engineLabel = ENGINES.find((e) => e.id === engine)?.label ?? engine;
        const prefix = prefs.botTemplate.namePrefix.trim();
        const name = prefix ? `${prefix} ${engineLabel}` : engineLabel;
        const createBody = createBotSchema.parse({
          requestId: `auto_bot_${crypto.randomUUID()}`,
          name,
          engine,
          model: model.trim(),
          effort: "",
          workspace: prefs.botTemplate.workspace.trim(),
        });
        const createdBot = await conn.http<{ bot?: { id: string; name: string }; id?: string; name?: string }>("/api/bots", {
          method: "POST",
          body: JSON.stringify(createBody),
        });
        botId = createdBot.bot?.id ?? createdBot.id;
        botName = createdBot.bot?.name ?? createdBot.name ?? name;
        if (!botId) throw new Error(t("自动创建 Bot 失败，请手动选择主机创建。"));
      }
      const conversation = await conn.createConversation({
        v: 1,
        type: "conversation.create",
        conversationType: "direct",
        botIds: [botId],
        title: title.trim() || t("与 {0} 的新对话", botName ?? engine),
        clientActionId: `auto_conv_${crypto.randomUUID()}`,
      });
      onAssigned(entry.host.id);
      onCreated(entry.host.id, conversation);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("创建对话失败，请重试或改为手动选择。"));
    } finally {
      setBusy(false);
    }
  };

  return <CreationDialog className="lb-create-dialog" title={t("新建对话")} close={close} busy={busy}>
    <div className="lb-mode-tabs" role="tablist" aria-label={t("主机选择方式")}>
      <button type="button" role="tab" aria-selected={mode === "auto"} className={mode === "auto" ? "is-active" : undefined} onClick={() => setMode("auto")}>
        <Scale size={14} aria-hidden="true"/>
        <span>{t("自动选择主机")}</span>
      </button>
      <button type="button" role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "is-active" : undefined} onClick={() => setMode("manual")}>
        <Monitor size={14} aria-hidden="true"/>
        <span>{t("手动选择主机")}</span>
      </button>
    </div>

    {mode === "manual" ? (
      <div className="lb-manual-wrap">
        <p className="creation-help">{t("Bot、工作区和会话将保存在所选主机上。")}</p>
        <div className="host-choices">
          {hosts.map((entry) => (
            <button
              key={entry.host.id}
              type="button"
              disabled={!entry.connection || entry.connection.state.status !== "online"}
              onClick={() => onManualHost(entry.host.id)}
            >
              <Monitor size={20}/>
              <span>
                <strong>{entry.host.name}</strong>
                <small>{entry.connection?.state.status === "online" ? t("已连接") : t("离线")}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    ) : (
      <form className="lb-auto-form" onSubmit={(event) => { event.preventDefault(); void submitAuto(); }}>
        <p className="creation-help">{t("只需选择引擎，系统按当前负载、网络延迟与主机偏好自动分配。选定后保持固定，不会在中途迁移。")}</p>
        <div className="lb-field-grid">
          <label>
            <span>{t("选择引擎")}</span>
            <select value={engine} disabled={busy} onChange={(event) => setEngine(event.target.value)}>
              {ENGINES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <label>
            <span>{t("模型（可选）")}</span>
            <input type="text" maxLength={128} value={model} disabled={busy} placeholder={t("跟随默认")} onChange={(event) => setModel(event.target.value)}/>
          </label>
        </div>
        <label>
          <span>{t("对话名称（可选）")}</span>
          <input type="text" maxLength={256} value={title} disabled={busy} placeholder={t("为这段对话起个名字")} onChange={(event) => setTitle(event.target.value)}/>
        </label>

        <div className="lb-result-card" aria-live="polite">
          {evaluating ? (
            <div className="lb-result-loading"><LoaderCircle size={15} className="spin"/><span>{t("正在评估各主机负载…")}</span></div>
          ) : chosenCandidate ? (
            <>
              <div className="lb-result-top">
                <div className="lb-result-host">
                  <CheckCircle2 size={15} className="lb-ok-icon" aria-hidden="true"/>
                  <span>{t("已自动选定")}</span>
                  <strong>{chosenCandidate.hostName}</strong>
                </div>
                <div className="lb-result-actions">
                  <button type="button" className="lb-inline-btn" onClick={() => void evaluate(engine, true)}>
                    <RefreshCw size={12}/>
                    <span>{t("重新选择")}</span>
                  </button>
                  <button type="button" className="lb-inline-btn" onClick={() => setMode("manual")}>
                    <span>{t("改为手动")}</span>
                  </button>
                </div>
              </div>
              {chosenCandidate.resources && <div className="lb-host-metrics">
                <span><Cpu size={11}/> CPU {chosenCandidate.resources.cpuPercent}%</span>
                <span><MemoryStick size={11}/> {t("内存")} {chosenCandidate.resources.memoryUsedPercent}%</span>
                <span><Activity size={11}/> {t("{0} 个进行中", chosenCandidate.resources.activeTurns + chosenCandidate.resources.activeTickets)}</span>
                {typeof chosenCandidate.latencyMs === "number" && <span>{Math.round(chosenCandidate.latencyMs)} ms</span>}
              </div>}
              <div className="lb-bot-plan">
                <BotIcon size={13} aria-hidden="true"/>
                <span>{chosenCandidate.matchingBotName
                  ? t("将复用已有 Bot：{0}", chosenCandidate.matchingBotName)
                  : t("该主机尚无此引擎 Bot，将按预设模板自动创建")}</span>
              </div>
            </>
          ) : (
            <div className="lb-result-empty">
              <div className="lb-result-empty-head">
                <AlertTriangle size={15} aria-hidden="true"/>
                <strong>{t("暂无可自动分配的主机，请改为手动选择")}</strong>
              </div>
              {!!selection?.excluded.length && <ul className="lb-excluded-list">
                {selection.excluded.map((item) => (
                  <li key={item.hostId}><span>{item.hostName}</span><small>{exclusionLabel(item.reason)}</small></li>
                ))}
              </ul>}
              <button type="button" className="lb-inline-btn" onClick={() => setMode("manual")}>{t("手动选择主机")}</button>
            </div>
          )}
        </div>

        {error && <p role="alert" className="error-text">{error}</p>}
        <button className="primary full" type="submit" disabled={busy || evaluating || !chosenCandidate}>
          {busy ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>}
          <span>{busy ? t("正在创建…") : t("在选定主机创建对话")}</span>
        </button>
      </form>
    )}
  </CreationDialog>;
}
