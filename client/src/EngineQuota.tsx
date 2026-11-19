import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, ChevronRight, RefreshCw, Server } from "lucide-react";
import { engineQuotaViewSchema, type EngineQuotaEntry, type EngineQuotaView, type EngineQuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { useConnectionSelection } from "./connection-selection.js";
import { BotMessageHostsContext } from "./bot-message-hosts.js";
import { connectedHostName } from "./host-connections.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { HubHttpError } from "./http-error.js";
import { timeoutSignal } from "./abort-signals.js";
import { t, useLocale } from "./i18n.js";
import { engineQuotaBrands, engineQuotaNames, quotaBalanceText, quotaDueResets, quotaEntryChip, quotaEntryDetail, quotaEntryHasData, quotaEntryStale, quotaExactTime, quotaNextReset, quotaReading, quotaReset, quotaResetKey, quotaSince, quotaUpdatedText, quotaWindowTitle } from "./engine-quota.js";
import openai from "./assets/model-brands/openai.svg";
import claude from "./assets/model-brands/claude.svg";
import gemini from "./assets/model-brands/gemini.svg";
import deepseek from "./assets/model-brands/deepseek.svg";
import kimi from "./assets/model-brands/kimi.svg";
import "./engine-quota.css";

const brandIcons = { openai, claude, gemini, deepseek, kimi };
/** A passed reset asks the Host again at most this often per Host, and only a
 * few times per visit: an upstream that keeps reporting a reset time already
 * in the past must not turn the open page into a poll. */
const RESET_REREAD_GAP_MS = 60_000, RESET_REREAD_LIMIT = 3;
/** Returning to the page (foreground, reconnect) re-reads only after this long. */
const RETURN_REREAD_GAP_MS = 60_000;
/** While the Host says a refresh is still running: a few bounded follow-up reads. */
const FOLLOW_UP_MS = 2_500, FOLLOW_UP_LIMIT = 6;
/** Countdown labels move without asking the Host. */
const CLOCK_TICK_MS = 30_000;

/** The last reading of each Host for this App session, so reopening the page or
 * losing the connection shows it with its time instead of an empty page. Keyed
 * by Host identity and user: another account on this device never sees it. */
const lastReadings = new Map<string, { view: EngineQuotaView; at: number }>();
/** Test seam: fixtures start every case from an empty page. */
export function forgetEngineQuotaReadings() { lastReadings.clear(); }

export type EngineQuotaHost = { id: string; name: string; connection: HubConnection };
/** Paired Hosts whose quota this user may read: only where they are the owner.
 * Each Host keeps its own section; nothing is merged across Hosts by engine,
 * Bot or account name. The Host that opened the page comes first. */
export function useEngineQuotaHosts(connection: HubConnection): EngineQuotaHost[] {
  const entries = useContext(BotMessageHostsContext), currentName = useContext(RuntimeHostContext);
  const paired = entries.flatMap(entry => entry.connection && entry.host.state === "ready" && !entry.host.networkBlocked && !entry.connection.isNetworkBlocked
    ? [{ id: entry.host.id, name: connectedHostName(entry), connection: entry.connection }] : []);
  const hosts = paired.some(host => host.connection === connection) ? paired : [{ id: "current", name: currentName ?? "", connection }, ...paired];
  const subscribe = useCallback((notify: () => void) => { const stops = hosts.map(host => host.connection.subscribe(notify)); return () => stops.forEach(stop => stop()); },
    // Resubscribe only when the set of connections changes.
    [hosts.map(host => host.id).join("\n")]);
  const roles = useSyncExternalStore(subscribe, () => hosts.map(host => host.connection.state.user?.role === "owner" ? "1" : "0").join(""));
  const named = hosts.map(host => ({ ...host, name: host.name || host.connection.state.hostProfile?.name || t("当前主机") }));
  return named.filter((_, index) => roles[index] === "1")
    .map(host => ({ ...host, name: named.filter(other => other.name === host.name).length > 1 && host.id !== "current" ? `${host.name} · ${host.id.slice(4, 12)}` : host.name }))
    .sort((a, b) => Number(b.connection === connection) - Number(a.connection === connection));
}

const subscribeVisibility = (notify: () => void) => { document.addEventListener("visibilitychange", notify); return () => document.removeEventListener("visibilitychange", notify); };
const pageVisible = () => document.visibilityState !== "hidden";

type Failure = "failed" | "forbidden" | "outdated";
/** One Host's quota reads. The page reads once when it opens and again only on
 * the refresh button, when a reset time passes, or when the page returns after
 * a while. Nothing runs while the page is closed or the App is in the background. */
function useHostQuota(connection: HubConnection, active: boolean, manual: number) {
  const state = useConnectionSelection(connection, value => ({ role: value.state.user?.role, user: value.state.user?.id, status: value.state.status, supported: value.state.engineQuotaAvailable, offset: value.state.serverTimeOffset ?? 0 }));
  const owner = state.role === "owner", online = state.status === "online", supported = state.supported === true;
  const scope = `${connection.identity.hubPublicKey ?? ""}\n${state.user ?? ""}`;
  const visible = useSyncExternalStore(subscribeVisibility, pageVisible);
  const shown = active && visible, eligible = owner && online && supported;
  const [saved, setSaved] = useState(() => lastReadings.get(scope));
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<Failure>();
  const [now, setNow] = useState(() => Date.now());
  /** Reset boundaries that already caused their one re-read. */
  const [reread, setReread] = useState<ReadonlySet<string>>(() => new Set());
  const flight = useRef<symbol | undefined>(undefined), generation = useRef(0);
  const lastAttempt = useRef(0), lastResetRead = useRef(0), resetReads = useRef(0), followUps = useRef(0), activeBefore = useRef(false), manualSeen = useRef(manual);
  useEffect(() => {
    generation.current++; flight.current = undefined; lastAttempt.current = 0; lastResetRead.current = 0; resetReads.current = 0; followUps.current = 0;
    setBusy(false); setFailure(undefined); setSaved(lastReadings.get(scope)); setReread(new Set());
    return () => { generation.current++; flight.current = undefined; };
  }, [connection, scope]);
  const read = useCallback(async (kind: "open" | "refresh") => {
    if (flight.current) return;
    const current = generation.current, token = Symbol(); flight.current = token; setBusy(true); lastAttempt.current = Date.now();
    try {
      const view = engineQuotaViewSchema.parse(await connection.http(kind === "refresh" ? "/api/engines/quota/refresh" : "/api/engines/quota",
        kind === "refresh" ? { method: "POST", signal: timeoutSignal(20_000) } : { signal: timeoutSignal(15_000) }));
      if (current !== generation.current) return;
      const next = { view, at: Date.now() }; lastReadings.set(scope, next); setSaved(next); setFailure(undefined); setNow(next.at);
    } catch (cause) {
      // The previous reading stays on screen, labelled with its own time.
      if (current === generation.current) setFailure(cause instanceof HubHttpError && cause.status === 403 ? "forbidden" : cause instanceof HubHttpError && cause.status === 404 ? "outdated" : "failed");
    } finally { if (flight.current === token) { flight.current = undefined; if (current === generation.current) setBusy(false); } }
  }, [connection, scope]);
  // Opening the page reads once. Coming back to it (foreground, reconnect) reads
  // again only when the last attempt is no longer recent.
  useEffect(() => {
    const opening = active && !activeBefore.current; activeBefore.current = active;
    if (opening) resetReads.current = 0;
    if (!shown || !eligible) return;
    if (!opening && Date.now() - lastAttempt.current < RETURN_REREAD_GAP_MS) return;
    followUps.current = 0; void read("open");
  }, [shown, eligible, active, read]);
  useEffect(() => {
    if (manual === manualSeen.current) return;
    manualSeen.current = manual;
    if (shown && eligible) { followUps.current = 0; resetReads.current = 0; void read("refresh"); }
  }, [manual, shown, eligible, read]);
  // Another device's refresh, or one that outlived the Host's wait, is still running.
  useEffect(() => {
    if (!shown || !eligible || busy || !saved?.view.refreshing || followUps.current >= FOLLOW_UP_LIMIT) return;
    const timer = setTimeout(() => { followUps.current++; void read("open"); }, FOLLOW_UP_MS);
    return () => clearTimeout(timer);
  }, [shown, eligible, busy, saved, read]);
  // A reset time passing never refills a bar here. It asks the Host once per
  // boundary, spaced out, and shows "re-reading" until the answer arrives.
  useEffect(() => {
    if (!shown || !eligible || !saved) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const hostNow = Date.now() + state.offset, due = quotaDueResets(saved.view, hostNow).filter(key => !reread.has(key));
      setNow(Date.now());
      if (!due.length) {
        const next = quotaNextReset(saved.view, hostNow);
        if (next !== undefined) timer = setTimeout(check, Math.min(next - hostNow + 1_000, 2_000_000_000));
        return;
      }
      // Out of automatic re-reads for this visit: these boundaries wait for the refresh button.
      if (resetReads.current >= RESET_REREAD_LIMIT) { setReread(old => new Set([...old, ...due])); return; }
      const wait = flight.current ? 2_000 : lastResetRead.current + RESET_REREAD_GAP_MS - Date.now();
      if (wait > 0) { timer = setTimeout(check, wait); return; }
      lastResetRead.current = Date.now(); resetReads.current++;
      setReread(old => new Set([...old, ...due]));
      void read("refresh");
    };
    check();
    return () => clearTimeout(timer);
  }, [shown, eligible, saved, reread, state.offset, read]);
  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [shown]);
  // The Host may still be reading after it answered; the page then reads as busy until the follow-ups end.
  const pending = busy || shown && eligible && !!saved?.view.refreshing && followUps.current < FOLLOW_UP_LIMIT;
  return { owner, online, connecting: state.status === "connecting", supported, eligible: shown && eligible, saved, busy: pending, failure, now, hostNow: now + state.offset, reread, retry: () => { followUps.current = 0; void read("open"); } };
}

/** "剩余 {0}" with the figure emphasised, in whichever order the language puts it. */
function withFigure(text: string, figure: ReactNode): ReactNode {
  const [before, after] = text.split("\u0000");
  return <>{before}{figure}{after}</>;
}

function QuotaWindowRow({ entry, window, hostNow, locale, rereading }: { entry: EngineQuotaEntry; window: EngineQuotaWindow; hostNow: number; locale: string; rereading: boolean }) {
  const reading = quotaReading(window), reset = quotaReset(window.resetsAt, hostNow, locale), name = quotaWindowTitle(window);
  // Past its reset the old figure is no longer the pool's state; show neither it nor a full bar.
  const due = reset.state === "due", figure = reading.known && !due;
  const tone = !figure ? "none" : reading.tone;
  return <li className="quota-window" data-tone={tone} data-due={due || undefined} data-window={`${entry.id}:${window.id}`}>
    <div className="quota-window-head">
      <span className="quota-window-name">{name.title}{name.detail && <small>{name.detail}</small>}</span>
      {figure && <span className="quota-window-value">{reading.over ? t("已超额") : reading.empty ? t("已用完") : withFigure(t("剩余 {0}", "\u0000"), <b>{reading.text}</b>)}</span>}
    </div>
    <div className="quota-meter" aria-hidden="true">{figure && <span style={{ "--quota-fill": `${reading.remaining}%` } as CSSProperties}/>}</div>
    <div className="quota-window-notes">
      {reset.state === "future" && <p className="quota-window-reset"><time dateTime={reset.iso} title={reset.full}>{reset.relative}</time><span>{reset.exact}</span></p>}
      {due && <p className="quota-window-reset" role="status">{rereading ? t("已到重置时间，正在重新读取…") : t("已到重置时间，等待新数据。")}</p>}
      {!reading.known && !due && <p className="quota-window-reset">{t("上游没有提供用量。")}</p>}
      {!!window.models?.length && <p className="quota-window-models">{t("适用模型：{0}", window.models.join(locale === "en" ? ", " : "、"))}</p>}
    </div>
  </li>;
}

function QuotaEntryCard({ entry, hostNow, locale, offline, live, busy, reread }: { entry: EngineQuotaEntry; hostNow: number; locale: string; offline: boolean; live: boolean; busy: boolean; reread: ReadonlySet<string> }) {
  const name = engineQuotaNames[entry.engine], stale = quotaEntryStale(entry, hostNow);
  const chip = quotaEntryChip(entry, stale, hostNow), detail = quotaEntryDetail(entry, busy), hasData = quotaEntryHasData(entry);
  // Figures kept from an earlier reading are shown as that: an older result.
  const earlier = hasData && (offline || stale || entry.status === "error" || entry.status === "login_required");
  return <article className="quota-entry" aria-label={entry.plan ? `${name} ${entry.plan}` : name} data-status={entry.status} data-entry={entry.id} data-earlier={earlier || undefined}>
    <header className="quota-entry-head">
      <span className="quota-engine"><span className="bot-brand-icon" aria-hidden="true" style={{ "--brand-icon": `url("${brandIcons[engineQuotaBrands[entry.engine]]}")` } as CSSProperties}/><strong>{name}</strong></span>
      {entry.plan && <span className="quota-plan" title={t("订阅方案")}>{entry.plan}</span>}
    </header>
    <div className="quota-entry-status">
      {chip && <span className="quota-chip" data-tone={chip.tone}>{chip.text}</span>}
      {entry.updatedAt !== undefined && <time className="quota-updated" dateTime={new Date(entry.updatedAt).toISOString()} title={quotaExactTime(entry.updatedAt, locale)}>{quotaUpdatedText(entry.updatedAt, hostNow, locale)}</time>}
    </div>
    <div className="quota-entry-body">
      {detail && <p className="quota-detail">{detail}</p>}
      {stale && entry.status !== "error" && <p className="quota-detail">{entry.source === "event" ? t("这是较早的读数，下一次对话后更新。") : t("这是较早的读数，可点刷新重新读取。")}</p>}
      {!!entry.windows.length && <ul className="quota-windows">{entry.windows.map(window => <QuotaWindowRow key={window.id} entry={entry} window={window} hostNow={hostNow} locale={locale} rereading={live && (busy || !reread.has(quotaResetKey(entry, window)))}/>)}</ul>}
      {!!entry.balances.length && <dl className="quota-balances">{entry.balances.map(balance => <div key={balance.id}><dt>{balance.label ?? t("余额")}</dt><dd>{quotaBalanceText(balance)}</dd></div>)}</dl>}
    </div>
    <footer className="quota-entry-foot">
      {entry.bots.length === 1 && <span className="quota-bots-one">{t("Bot：{0}", entry.bots[0]!.name)}</span>}
      {entry.bots.length > 1 && <details className="quota-bots"><summary data-disclosure-icon><ChevronRight size={14} aria-hidden="true"/>{t("{0} 个 Bot 共用", entry.bots.length)}</summary><ul>{entry.bots.map(bot => <li key={bot.id}>{bot.name}</li>)}</ul></details>}
      {entry.guideUrl && <a className="quota-guide" href={entry.guideUrl} target="_blank" rel="noopener noreferrer">{t("去官方页面查看")}<ArrowUpRight size={13} aria-hidden="true"/></a>}
    </footer>
  </article>;
}

function HostQuota({ host, active, manual, onBusy }: { host: EngineQuotaHost; active: boolean; manual: number; onBusy: (id: string, busy: boolean, ready: boolean) => void }) {
  const locale = useLocale();
  const quota = useHostQuota(host.connection, active, manual), { saved, busy, failure } = quota;
  useEffect(() => { onBusy(host.id, busy, quota.eligible); return () => onBusy(host.id, false, false); }, [host.id, busy, quota.eligible, onBusy]);
  if (!quota.owner) return null;
  const offline = !quota.online, since = saved && quotaSince(saved.at, quota.now, locale);
  // An older Host is told apart from "nothing read yet": it needs an update, not a retry.
  const outdated = !offline && (!quota.supported || failure === "outdated");
  const view = outdated || failure === "forbidden" ? undefined : saved?.view;
  return <section className="quota-host" aria-label={t("主机：{0}", host.name)} data-host={host.id} data-offline={offline || undefined} aria-busy={busy || undefined}>
    <div className="quota-host-heading">
      <h4><Server size={14} aria-hidden="true"/><span>{host.name}</span></h4>
      <span className="quota-host-state" data-tone={offline ? "muted" : "online"}><i aria-hidden="true"/>{quota.online ? t("已连接") : quota.connecting ? t("连接中…") : t("离线")}</span>
    </div>
    {outdated && <p className="quota-note" role="status">{t("请更新这台主机后查看模型额度。")}</p>}
    {failure === "forbidden" && !outdated && <p className="quota-note" role="status">{t("只有主机所有者可以查看模型额度。")}</p>}
    {offline && <p className="quota-note" data-tone="offline" role="status">{view ? t("主机离线。下面是上次读到的结果（{0}）。", since) : t("主机离线，连接恢复后读取。")}</p>}
    {!offline && failure === "failed" && <div className="quota-note" data-tone="warning" role="alert"><span>{view ? t("这次没有读到。下面是上次的结果（{0}）。", since) : t("没有读到额度，请重试。")}</span><button type="button" className="secondary" disabled={busy} onClick={quota.retry}>{t("重试")}</button></div>}
    {!offline && !outdated && !failure && !view && <p className="quota-note" role="status">{t("正在读取…")}</p>}
    {view && (view.entries.length
      ? <div className="quota-list">{view.entries.map(entry => <QuotaEntryCard key={entry.id} entry={entry} hostNow={quota.hostNow} locale={locale} offline={offline} live={quota.eligible} busy={busy} reread={quota.reread}/>)}</div>
      : <p className="quota-note" role="status">{t("这台主机还没有可显示的引擎。")}</p>)}
  </section>;
}

/** Owner-only, read-only page: what each engine login has left and when it
 * resets, one section per Host. `active` is false while the section is hidden. */
export function EngineQuota({ connection, active }: { connection: HubConnection; active: boolean }) {
  useLocale();
  const hosts = useEngineQuotaHosts(connection);
  const [manual, setManual] = useState(0), [flights, setFlights] = useState<Record<string, { busy: boolean; ready: boolean }>>({});
  const onBusy = useCallback((id: string, busy: boolean, ready: boolean) => setFlights(old => old[id]?.busy === busy && old[id]?.ready === ready ? old : { ...old, [id]: { busy, ready } }), []);
  const shownFlights = hosts.map(host => flights[host.id]), busy = shownFlights.some(flight => flight?.busy), ready = shownFlights.some(flight => flight?.ready);
  if (!hosts.length) return <div className="engine-quota"><p className="settings-note muted">{t("只有主机所有者可以查看模型额度。")}</p></div>;
  return <div className="engine-quota" data-hosts={hosts.length}>
    <div className="quota-toolbar">
      <p className="quota-lede">{t("各引擎账号还剩多少额度、何时重置。")}</p>
      <button type="button" className="secondary quota-refresh" disabled={!ready} aria-disabled={busy || undefined} onClick={() => { if (!busy) setManual(value => value + 1); }}><RefreshCw size={15} aria-hidden="true" className={busy ? "spin" : undefined}/>{busy ? t("正在刷新…") : t("刷新")}</button>
    </div>
    {hosts.map(host => <HostQuota key={`${host.id}:${host.connection.identity.hubPublicKey ?? ""}`} host={host} active={active} manual={manual} onBusy={onBusy}/>)}
    <p className="quota-footnote">{t("这是引擎账号的整体额度，也包含在其他工具里的用量。刷新不会发起对话。")}</p>
  </div>;
}
