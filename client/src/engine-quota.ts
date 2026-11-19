import type { EngineQuotaBalance, EngineQuotaEntry, EngineQuotaView, EngineQuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HostEngine } from "../../src/client-protocol/engine-settings.js";
import { t } from "./i18n.js";

/** Presentation rules for the owner-only "模型额度" page (EngineQuota.tsx).
 * Everything here is derived from one Host's `EngineQuotaView`; nothing is
 * estimated. A missing value stays missing: unknown is never 0 %, a passed
 * reset time never refills a bar, and separate windows are never summed. */
export const engineQuotaNames: Record<HostEngine, string> = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", kimi: "Kimi", deepseek: "DeepSeek" };
export const engineQuotaBrands: Record<HostEngine, "openai" | "claude" | "gemini" | "kimi" | "deepseek"> = { codex: "openai", claude: "claude", antigravity: "gemini", kimi: "kimi", deepseek: "deepseek" };

/** Used share from which a pool reads as "running low". */
export const QUOTA_WARNING_USED = 80;
/** A reading older than this is labelled expired. The shortest known window is
 * five hours, so by then at least one pool has rolled over since the reading. */
export const QUOTA_STALE_AFTER_MS = 6 * 3_600_000;

export type QuotaTone = "normal" | "warning" | "danger";
export type QuotaReading =
  | { known: false }
  /** `remaining` is 0–100 for the bar; `text` is what people read. */
  | { known: true; remaining: number; text: string; over: boolean; empty: boolean; tone: QuotaTone };

/** Remaining share of one pool. Never negative: above 100 % used is "over". */
export function quotaReading(window: EngineQuotaWindow): QuotaReading {
  const used = window.usedPercent;
  if (used === undefined || !Number.isFinite(used) || used < 0) return { known: false };
  const remaining = Math.max(0, 100 - used);
  // Round down so the page never promises more than the upstream reported;
  // a sliver stays visibly non-zero instead of reading as used up.
  const text = remaining <= 0 ? "0%" : remaining < 1 ? "<1%" : `${Math.floor(remaining)}%`;
  return { known: true, remaining, text, over: used > 100, empty: used >= 100, tone: used >= 100 ? "danger" : used >= QUOTA_WARNING_USED ? "warning" : "normal" };
}

/** "5 小时额度" / "7 天额度" from the upstream window length. */
export function quotaWindowDuration(minutes: number | undefined): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  if (minutes % 1440 === 0) return t("{0} 天额度", minutes / 1440);
  if (minutes % 60 === 0) return t("{0} 小时额度", minutes / 60);
  return t("{0} 分钟额度", minutes);
}
/** The upstream's own pool name wins; the window length then becomes a detail. */
export function quotaWindowTitle(window: EngineQuotaWindow): { title: string; detail?: string } {
  const duration = quotaWindowDuration(window.windowMinutes);
  if (window.label) return { title: window.label, detail: duration };
  return { title: duration ?? t("额度") };
}

const intlLocale = (locale: string) => locale === "en" ? "en" : "zh-CN";
const dayStart = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };

export type QuotaReset = { state: "none" } | { state: "due" } | { state: "future"; relative: string; exact: string; iso: string; full: string };
/** `now` is the Host clock (device clock + `serverTimeOffset`), so a wrong
 * phone clock cannot move the countdown. The exact time is the same instant
 * shown in this device's time zone. */
export function quotaReset(resetsAt: number | undefined, now: number, locale: string): QuotaReset {
  if (!resetsAt) return { state: "none" };
  const left = resetsAt - now;
  if (left <= 0) return { state: "due" };
  const minutes = Math.floor(left / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  const relative = minutes < 1 ? t("不到 1 分钟后重置")
    : hours < 1 ? t("{0} 分钟后重置", minutes)
    : days < 1 ? minutes % 60 ? t("{0} 小时 {1} 分后重置", hours, minutes % 60) : t("{0} 小时后重置", hours)
    : hours % 24 ? t("{0} 天 {1} 小时后重置", days, hours % 24) : t("{0} 天后重置", days);
  const tag = intlLocale(locale), time = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(resetsAt);
  // Day names follow the device's calendar day, matched against the Host's "now".
  const offset = Math.round((dayStart(resetsAt) - dayStart(now)) / 86_400_000);
  // Within a week the weekday is unambiguous and short; the full date is in `full`.
  const exact = offset === 0 ? t("今天 {0}", time) : offset === 1 ? t("明天 {0}", time)
    : `${new Intl.DateTimeFormat(tag, offset < 7 ? { weekday: "short" } : { month: "short", day: "numeric" }).format(resetsAt)} ${time}`;
  return { state: "future", relative, exact, iso: new Date(resetsAt).toISOString(), full: new Intl.DateTimeFormat(tag, { dateStyle: "full", timeStyle: "short" }).format(resetsAt) };
}

/** "刚才" / "5 分钟前" / a date, used inside a sentence. Never claims a future reading. */
export function quotaSince(at: number, now: number, locale: string): string {
  const seconds = Math.max(0, (now - at) / 1000);
  if (seconds < 60) return t("刚才");
  if (seconds < 3600) return t("{0} 分钟前", Math.floor(seconds / 60));
  if (seconds < 86_400) return t("{0} 小时前", Math.floor(seconds / 3600));
  if (seconds < 7 * 86_400) return t("{0} 天前", Math.floor(seconds / 86_400));
  return new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium" }).format(at);
}
/** The "last updated" label of one entry. */
export const quotaUpdatedText = (at: number, now: number, locale: string) => now - at < 60_000 ? t("刚刚更新") : t("更新于 {0}", quotaSince(at, now, locale));
export const quotaExactTime = (at: number, locale: string) => new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(at);

/** The upstream's own figure and unit: no conversion, rounding or grouping. */
export function quotaBalanceText(balance: EngineQuotaBalance): string {
  const negative = balance.amount.startsWith("-"), digits = negative ? balance.amount.slice(1) : balance.amount, sign = negative ? "-" : "";
  if (balance.unit === "CNY") return `${sign}¥${digits}`;
  if (balance.unit === "USD") return `${sign}$${digits}`;
  return `${balance.amount} ${balance.unit}`;
}

/** Stable identity of one reset boundary, so it triggers at most one re-read. */
export const quotaResetKey = (entry: EngineQuotaEntry, window: EngineQuotaWindow) => `${entry.id}\n${window.id}\n${window.resetsAt ?? 0}`;
/** Windows whose reset time has passed: their reading predates the reset. */
export function quotaDueResets(view: EngineQuotaView | undefined, now: number): string[] {
  return (view?.entries ?? []).flatMap(entry => entry.windows.filter(window => !!window.resetsAt && window.resetsAt <= now).map(window => quotaResetKey(entry, window)));
}
/** The next reset still ahead, if any: when the page asks the Host again. */
export function quotaNextReset(view: EngineQuotaView | undefined, now: number): number | undefined {
  const upcoming = (view?.entries ?? []).flatMap(entry => entry.windows.flatMap(window => window.resetsAt && window.resetsAt > now ? [window.resetsAt] : []));
  return upcoming.length ? Math.min(...upcoming) : undefined;
}
/** A reading too old to trust as current. Entries without a reading are not
 * "expired"; their own status already says why there is nothing to show. */
export function quotaEntryStale(entry: EngineQuotaEntry, now: number): boolean {
  return entry.updatedAt !== undefined && now - entry.updatedAt > QUOTA_STALE_AFTER_MS;
}
/** Whether an entry carries figures at all (bars or balances). */
export const quotaEntryHasData = (entry: EngineQuotaEntry) => entry.windows.length > 0 || entry.balances.length > 0;

export type QuotaChip = { tone: "muted" | "warning" | "danger"; text: string };
/** The single status word beside an engine name. A healthy entry has none, so
 * the entries that need attention are the ones that carry a mark. */
export function quotaEntryChip(entry: EngineQuotaEntry, stale: boolean, now: number): QuotaChip | undefined {
  switch (entry.status) {
    case "login_required": return { tone: "warning", text: t("需要登录") };
    case "unsupported": return { tone: "muted", text: t("此登录方式不提供") };
    case "not_adapted": return { tone: "muted", text: t("尚未适配") };
    case "engine_missing": return { tone: "muted", text: t("未安装") };
    case "error": return { tone: "warning", text: t("读取失败") };
    case "unknown": return { tone: "muted", text: t("暂无数据") };
  }
  if (stale) return { tone: "muted", text: t("数据已过期") };
  // A window past its reset no longer describes the pool, so it cannot keep an
  // entry marked as used up; its own row says that it is being read again.
  const current = entry.windows.filter(window => !window.resetsAt || window.resetsAt > now), readings = current.map(quotaReading).filter(reading => reading.known);
  if (readings.some(reading => reading.empty) || entry.status === "exhausted" && current.length === entry.windows.length) return { tone: "danger", text: readings.some(reading => reading.over) ? t("已超额") : t("已用完") };
  if (readings.some(reading => reading.tone === "warning")) return { tone: "warning", text: t("快用完") };
  return undefined;
}
/** One plain sentence under the engine name for every state without figures.
 * `reading`: a read of this Host is in flight, so "nothing yet" is still open. */
export function quotaEntryDetail(entry: EngineQuotaEntry, reading = false): string | undefined {
  const name = engineQuotaNames[entry.engine];
  switch (entry.status) {
    case "unknown": return entry.source === "event" ? t("还没有读到额度，下一次对话后更新。") : reading ? t("正在读取…") : t("还没有读到额度，可稍后刷新。");
    case "login_required": return t("请在主机上重新登录 {0}。", name);
    case "unsupported": return t("当前登录方式不提供账号额度，例如 API Key。");
    case "not_adapted": return t("TaroBird 还没有接入 {0} 的额度读取。", name);
    case "engine_missing": return t("这台主机上没有找到 {0}。", name);
    case "error": return entry.reason === "timeout" ? t("读取超时，可稍后刷新。")
      : entry.reason === "rate_limited" ? t("查询太频繁，请稍后再刷新。")
      : entry.reason === "invalid_response" ? t("上游返回的内容无法识别。")
      : entry.reason === "upstream_error" ? t("上游服务出错，可稍后刷新。")
      : t("读取失败，可稍后刷新。");
  }
  return undefined;
}
