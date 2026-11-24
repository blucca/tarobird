import { useContext, useEffect, useState } from "react";
import { Activity, Cpu, MemoryStick, RefreshCw, Scale } from "lucide-react";
import {
  defaultLoadBalancingPreferences,
  type HostBalancePreference,
  type LoadBalancingPreferences,
} from "../../src/client-protocol/host-balancer.js";
import { hostResourcesSchema, type HostResources } from "../../src/client-protocol/host-resources.js";
import { BotMessageHostsContext } from "./bot-message-hosts.js";
import { t, useLocale } from "./i18n.js";
import { timeoutSignal } from "./abort-signals.js";
import "./load-balancing.css";

const PREFERENCE_OPTIONS: Array<{ value: HostBalancePreference; label: () => string }> = [
  { value: "normal", label: () => t("默认") },
  { value: "prefer", label: () => t("优先") },
  { value: "less_often", label: () => t("少用") },
  { value: "manual_only", label: () => t("仅手动") },
];

export function LoadBalancingSettings({
  value,
  onChange,
  active,
}: {
  value?: LoadBalancingPreferences;
  onChange: (next: LoadBalancingPreferences) => void;
  active: boolean;
}) {
  useLocale();
  const hosts = useContext(BotMessageHostsContext).filter((entry) => !entry.host.networkBlocked);
  const current: LoadBalancingPreferences = {
    ...defaultLoadBalancingPreferences,
    ...value,
    hostPreferences: { ...(value?.hostPreferences ?? {}) },
    botTemplate: { ...defaultLoadBalancingPreferences.botTemplate, ...(value?.botTemplate ?? {}) },
  };
  const [telemetry, setTelemetry] = useState<Record<string, HostResources | "error">>({});
  const [refreshing, setRefreshing] = useState(false);

  const loadTelemetry = async () => {
    setRefreshing(true);
    const next: Record<string, HostResources | "error"> = {};
    await Promise.all(hosts.map(async (entry) => {
      if (!entry.connection || entry.connection.state.status !== "online") return;
      try {
        const raw = await entry.connection.http<unknown>("/api/host-resources", { signal: timeoutSignal(5_000) });
        next[entry.host.publicKey] = hostResourcesSchema.parse(raw);
      } catch {
        next[entry.host.publicKey] = "error";
      }
    }));
    setTelemetry(next);
    setRefreshing(false);
  };

  useEffect(() => {
    if (!active || hosts.length < 2) return;
    void loadTelemetry();
  }, [active, hosts.length]);

  // Only shown when two or more Hosts are connected/saved.
  if (hosts.length < 2) return null;

  const setPreference = (publicKey: string, pref: HostBalancePreference) => {
    const nextPrefs = { ...current.hostPreferences };
    if (pref === "normal") delete nextPrefs[publicKey];
    else nextPrefs[publicKey] = pref;
    onChange({ ...current, hostPreferences: nextPrefs });
  };

  return <section className="lb-settings" aria-label={t("负载均衡")}>
    <div className="lb-settings-header">
      <div className="lb-settings-title">
        <Scale size={16} aria-hidden="true"/>
        <h4>{t("负载均衡")}</h4>
      </div>
      <button type="button" className="icon-button" aria-label={t("刷新主机负载")} title={t("刷新主机负载")} onClick={() => void loadTelemetry()}>
        <RefreshCw size={14} className={refreshing ? "spin" : undefined}/>
      </button>
    </div>
    <p className="settings-note muted">{t("新建对话时按各主机的 CPU、内存、进行中任务数、网络延迟与偏好自动挑选主机。设置仅保存在此设备。")}</p>

    <div className="settings-group">
      <div className="settings-row">
        <div className="settings-row-text">
          <span id="lb-enabled-label">{t("新建对话时默认自动选择主机")}</span>
          <small>{t("关闭时默认手动选主机；仍可在新建对话窗口随时切换。")}</small>
        </div>
        <button
          type="button"
          className="model-brand-toggle"
          role="switch"
          aria-labelledby="lb-enabled-label"
          aria-checked={current.enabled}
          onClick={() => onChange({ ...current, enabled: !current.enabled })}
        >
          <span className="model-brand-toggle-track" aria-hidden="true"/>
        </button>
      </div>
    </div>

    <div className="lb-host-list" role="list" aria-label={t("各主机偏好")}>
      {hosts.map((entry) => {
        const key = entry.host.publicKey;
        const pref = current.hostPreferences[key] ?? "normal";
        const online = entry.connection?.state.status === "online";
        const res = telemetry[key];
        const latency = entry.connection?.state.latency;
        return <div key={entry.host.id} className="lb-host-row" role="listitem">
          <div className="lb-host-info">
            <div className="lb-host-name-row">
              <span className={`lb-dot${online ? " is-online" : ""}`} aria-hidden="true"/>
              <strong>{entry.host.name}</strong>
              <small>{online ? t("在线") : t("离线")}</small>
            </div>
            <div className="lb-host-metrics">
              {online && res && res !== "error" ? <>
                <span><Cpu size={11} aria-hidden="true"/> CPU {res.cpuPercent}%</span>
                <span><MemoryStick size={11} aria-hidden="true"/> {t("内存")} {res.memoryUsedPercent}%</span>
                <span><Activity size={11} aria-hidden="true"/> {t("{0} 个进行中", res.activeTurns + res.activeTickets)}</span>
                {typeof latency === "number" && <span>{Math.round(latency)} ms</span>}
              </> : online && res === "error" ? (
                <span className="muted">{t("此主机暂未报告资源状态")}</span>
              ) : (
                <span className="muted">{online ? t("正在读取负载…") : t("离线主机不参与自动选择")}</span>
              )}
            </div>
          </div>
          <select
            aria-label={t("{0} 的负载均衡偏好", entry.host.name)}
            value={pref}
            onChange={(event) => setPreference(key, event.target.value as HostBalancePreference)}
          >
            {PREFERENCE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label()}</option>)}
          </select>
        </div>;
      })}
    </div>

    <div className="lb-template-box">
      <p className="lb-template-heading">{t("目标主机无匹配 Bot 时的自动创建模板")}</p>
      <p className="settings-note muted">{t("如果选中主机上已有对应引擎的 Bot，将直接复用并开新对话；否则按此模板自动创建一个 Bot。")}</p>
      <div className="lb-template-fields">
        <label>
          <span>{t("Bot 名称前缀（可选）")}</span>
          <input
            type="text"
            maxLength={48}
            placeholder={t("例如：Auto")}
            value={current.botTemplate.namePrefix}
            onChange={(event) => onChange({ ...current, botTemplate: { ...current.botTemplate, namePrefix: event.target.value } })}
          />
        </label>
        <label>
          <span>{t("默认工作区路径（可选）")}</span>
          <input
            type="text"
            maxLength={512}
            placeholder={t("留空使用主机默认工作区")}
            value={current.botTemplate.workspace}
            onChange={(event) => onChange({ ...current, botTemplate: { ...current.botTemplate, workspace: event.target.value } })}
          />
        </label>
      </div>
    </div>
  </section>;
}
