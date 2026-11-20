import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { quotaReadingExpired, type QuotaConstraint, type QuotaEngine, type QuotaReason, type QuotaSnapshot, type QuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { SettingsGroupHeading } from "./SettingsParts.js";
import { useEngineQuota } from "./use-engine-quota.js";
import { t, useLocale } from "./i18n.js";
import "./engine-quota.css";

const engines = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", kimi: "Kimi", deepseek: "DeepSeek", pi: "Pi" };
function reasonText(reason: QuotaReason | undefined, engine: QuotaEngine): string {
  switch (reason) {
    case "not_adapted": return t("此引擎尚未接入原生额度。");
    case "not_loaded": return t("尚未读取原生额度，可点击刷新。");
    case "native_unverified": return t("此引擎的原生额度接口尚未验证。");
    case "mode_not_supported": return t("此授权方式不提供可读取的原生额度。");
    case "no_passive_event": return t("尚未收到原生额度状态，仅在正常使用中被动更新。");
    case "login_required": return t("请先在运行主机上完成引擎登录，再刷新。");
    case "auth_changed": return t("授权信息已变化，旧额度已清除。请核对后再次刷新。");
    case "scope_unverifiable": return engine === "claude"
      ? t("Claude Code 的凭据来源无法由公开接口核实（例如 macOS 钥匙串登录），为避免显示其他账号的额度，不展示被动收到的读数。")
      : t("无法从运行主机的凭据文件确认当前账号（例如登录保存在系统钥匙串），读数不会保留；刷新时由引擎原生接口当场核对一次，只有原生回包能把当前用户、前后两次的工作区和这次用量对应到同一账号时才展示读数。");
    case "offline": return t("Bot 当前离线，连接恢复后重新读取列表。");
    case "timeout": return t("读取原生额度超时，可稍后再刷新。");
    case "cancelled": return t("本次读取已取消，可重新刷新。");
    case "rate_limited": return t("原生服务暂时限制读取，请等待后再刷新。");
    case "invalid_response": return t("原生额度数据无法确认，未将缺失数据当作零。");
    case "cli_unavailable": return t("主机上的引擎程序不可用，请检查后再刷新。");
    case "native_error": return t("暂时无法读取原生额度，可稍后再刷新。");
    case "host_upgrade_required": return t("请更新主机与 Bot 运行程序以读取额度。");
    default: return "";
  }
}
// Verified against each engine's own CLI help/changelog and official docs; shown when no current reading exists.
function helpText(help: QuotaSnapshot["help"]): string {
  switch (help) {
    case "codex_usage": return t("官方查看：在运行主机的 Codex CLI 中以 ChatGPT 登录后输入 /usage，可查看账号额度和重置时间。");
    case "claude_usage": return t("官方查看：订阅登录时，在 Claude Code 中输入 /usage，或打开 claude.ai/settings/usage。");
    case "antigravity_usage": return t("官方查看：在 Antigravity CLI 中输入 /usage 或 /quota，AI credits 用 /credits；GEMINI_API_KEY 没有账号额度，请在 Google AI Studio 查看该 Key 的用量。");
    case "gemini_api_usage": return t("官方查看：GEMINI_API_KEY 没有账号额度，请在 Google AI Studio 查看该 Key 的用量。");
    case "kimi_usage": return t("官方查看：在 Kimi Code CLI 交互界面输入 /usage 查看套餐额度；ACP 会话里的 /usage 只显示本会话 token。");
    case "deepseek_balance": return t("官方查看：使用 DeepSeek 官方 API 时，登录 DeepSeek 开放平台（platform.deepseek.com）查看账户余额；其他供应商请在其控制台查看。");
    default: return "";
  }
}
function constraintText(constraint: QuotaConstraint): string {
  switch (constraint.code) {
    case "ordinary_usage_blocked": return t("常规使用受限");
    case "spend_control": return t("已触发原生消费限制");
    case "credits_depleted": return t("原生 credits 已耗尽");
    case "overage_disabled": return t("超额使用未启用");
    default: return t("存在其他原生限制");
  }
}
const expired = (value: { expiresAt: string; resetsAt?: string }, now: number) => Date.parse(value.expiresAt) <= now || !!value.resetsAt && Date.parse(value.resetsAt) <= now;
function WindowQuota({ window, stale, now, formatTime, formatNumber }: { window: QuotaWindow; stale: boolean; now: number; formatTime: (value: string) => string; formatNumber: (value: number) => string }) {
  const old = stale || expired(window, now);
  const percent = window.metric === "percent" ? window.usedPercent : undefined;
  const value = percent === undefined ? t("尚无数据") : percent > 100 ? t("超出 {0}%", formatNumber(percent - 100)) : t("剩余 {0}%", formatNumber(100 - percent));
  return <div className="quota-window" data-stale={old || undefined}>
    <div className="quota-window-heading"><span>{window.label}</span><strong>{old && percent !== undefined ? t("上次读数：{0}", value) : value}</strong></div>
    {percent !== undefined && <><div className="quota-meter" role="meter" aria-label={t("{0} 已用额度", window.label)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, percent)} aria-valuetext={t("已用 {0}%", formatNumber(percent))}><span style={{ width: `${Math.min(100, percent)}%` }}/></div><small>{t("已用 {0}%", formatNumber(percent))}</small></>}
    <div className="quota-window-meta">{window.resetsAt && <time dateTime={window.resetsAt}>{Date.parse(window.resetsAt) <= now ? t("已到重置时间，等待更新") : t("重置：{0}", formatTime(window.resetsAt))}</time>}{old && <span>{t("已过期，需重新读取")}</span>}</div>
  </div>;
}
export function EngineQuota({ connection, active }: { connection: HubConnection; active: boolean }) {
  const locale = useLocale(), host = useContext(RuntimeHostContext);
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const owner = state.user?.role === "owner", online = state.status === "online", supported = state.engineQuotaAvailable === true;
  const quota = useEngineQuota(connection, { userId: state.user?.id, owner, online, supported, active });
  const [clock, setClock] = useState(Date.now);
  useEffect(() => { if (!active || !quota.visible) return; setClock(Date.now()); const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [active, quota.visible]);
  const now = clock + (state.serverTimeOffset ?? 0);
  const formatTime = (value: string) => new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const formatNumber = (value: number) => new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", { maximumFractionDigits: 2 }).format(value);
  if (!owner) return null;
  return <div className="engine-quota">
    <SettingsGroupHeading scope="host" host={host}>{t("原生模型额度")}</SettingsGroupHeading>
    <p className="settings-note muted">{t("按 Bot 展示原生额度；不同 Bot 可能共用同一账号，请勿相加。这里不是消息用量统计。")}</p>
    {!online && <p className="quota-notice" role="status">{t("连接已断开，仅保留上次读数。恢复后重新核对。")}</p>}
    {!supported ? online && <p role="status">{t("请更新主机以查看模型额度。")}</p> : <>
      <div className="quota-toolbar"><button type="button" className="secondary" disabled={!online || quota.loading || quota.busy.length > 0} onClick={() => void quota.readDirectory()}><RefreshCw size={14} aria-hidden="true"/>{t("重新读取列表")}</button><small>{t("列表只读取已知状态；单卡刷新不会发送模型消息。")}</small></div>
      {quota.loading && <p role="status"><LoaderCircle size={14} className="spin" aria-hidden="true"/> {t("正在读取…")}</p>}
      {quota.error && <p className="quota-notice" role="alert">{quota.error === "permission" ? t("额度查看权限已变化，旧数据已清除。请重新连接后核对。") : quota.error === "upgrade" ? t("请更新主机以查看模型额度。") : t("未能读取额度列表，请重新读取。保留的读数不代表当前余额。")}</p>}
      {quota.notice === "changed" && <p className="quota-notice" role="status">{t("Bot 或授权配置已变化，已重新读取列表。请核对后再刷新。")}</p>}
      {quota.directory?.truncated && <p className="quota-notice" role="status">{t("主机只返回了部分 Bot 的额度状态。")}</p>}
      {quota.directory && !quota.directory.scopes.length && <p role="status">{t("当前主机还没有可展示额度的 Bot。")}</p>}
      <div className="quota-list">{quota.directory?.scopes.map(scope => {
        // Same rule as the Gateway, re-evaluated locally as time passes: TTL, window/balance expiry and constraint resets.
        const stale = !online || !!quota.error || !!quota.errors[scope.id] || scope.state === "stale" || quotaReadingExpired(scope, now);
        const status = stale ? t("待更新") : ({ ready: t("已读取"), stale: t("待更新"), unknown: t("尚无数据"), login_required: t("需要登录"), offline: t("离线"), unavailable: t("暂不可用"), unsupported: t("暂不支持") })[scope.state];
        const passive = scope.capability.mode === "passive";
        const canRead = scope.capability.mode !== "unsupported" && scope.state !== "offline" && scope.state !== "unsupported" && scope.reason !== "host_upgrade_required";
        const cooling = !!scope.nextRefreshAt && Date.parse(scope.nextRefreshAt) > now;
        const busy = quota.busy.includes(scope.id), reason = reasonText(scope.reason ?? scope.capability.reason, scope.engine);
        const help = scope.state === "ready" && !stale ? "" : helpText(scope.help);
        const auth = ({ subscription: t("订阅授权"), api_key: "API Key", adc: t("应用默认凭据"), other: t("其他授权"), unknown: t("授权方式未确认") })[scope.authMode];
        const constraints = [...scope.constraints, ...scope.pools.flatMap(pool => pool.constraints)];
        const availabilityNotice = scope.availability === "blocked" ? t("原生服务报告使用受限；窗口剩余量不代表可以继续请求。") : scope.availability === "warning" ? t("原生服务报告额度预警。") : "";
        return <section className="quota-card" key={scope.id} aria-label={`${scope.label} · ${engines[scope.engine]}`} aria-busy={busy || undefined}>
          <header className="quota-card-heading"><div><h4>{scope.label}</h4><p>{engines[scope.engine]} · {auth}</p></div><span className="quota-state">{status}</span></header>
          {reason && <p className="quota-reason">{reason}</p>}
          {help && <p className="quota-help">{help}</p>}
          {passive && <p className="muted">{t("仅显示正常使用中收到的状态；读取不会触发新对话。")}</p>}
          {availabilityNotice && <p className="quota-notice">{stale ? t("上次读数：{0}", availabilityNotice) : availabilityNotice}</p>}
          {constraints.length > 0 && <ul className="quota-constraints">{constraints.map((value, index) => <li key={`${value.code}:${index}`}>{constraintText(value)}{value.resetsAt && <span> · {Date.parse(value.resetsAt) <= now ? t("已到重置时间，等待更新") : t("重置：{0}", formatTime(value.resetsAt))}</span>}</li>)}</ul>}
          {scope.pools.map(pool => <div className="quota-pool" key={pool.id}><h5>{pool.label}</h5>{pool.models?.length ? <p className="muted">{pool.models.join(" · ")}</p> : null}
            {pool.windows.map(window => <WindowQuota key={window.id} window={window} stale={stale} now={now} formatTime={formatTime} formatNumber={formatNumber}/>)}
            {pool.balances.map(balance => <p className="quota-balance" key={balance.id}>{t("原生 credits")}<strong>{balance.unlimited ? t("不限额") : balance.amount === null ? t("尚无数据") : `${balance.amount} credits`}</strong>{(stale || expired(balance, now)) && <small>{t("上次读数，需重新读取")}</small>}</p>)}
          </div>)}
          {quota.errors[scope.id] && <p className="quota-notice" role="alert">{t("本次刷新失败，可重试。保留的读数不代表当前余额。")}</p>}
          <footer className="quota-card-footer"><div>{scope.observedAt && <time dateTime={scope.observedAt}>{t("读取于 {0}", formatTime(scope.observedAt))}</time>}{cooling && <time dateTime={scope.nextRefreshAt}>{t("{0} 后可再刷新", formatTime(scope.nextRefreshAt!))}</time>}</div>
            {canRead && <button type="button" className="secondary" disabled={!online || quota.loading || quota.busy.length >= 2 || busy || cooling || quota.error === "permission"} onClick={() => void quota.refresh(scope)}>{busy ? <LoaderCircle size={14} className="spin" aria-hidden="true"/> : <RefreshCw size={14} aria-hidden="true"/>}{busy ? t("正在读取…") : passive ? t("读取已知状态") : t("刷新")}</button>}
          </footer>
        </section>;
      })}</div>
      {quota.directory && <p className="quota-local-time muted">{t("时间按当前设备时区显示；到达重置时间不会自动填满额度。")}</p>}
    </>}
  </div>;
}
