import { useId, useRef, useState } from "react";
import { DesktopMenu, DesktopMenuPortalContext } from "./DesktopMenu.js";
import { t, useLocale, type Locale } from "./i18n.js";
import { shortTokens, usageTone, type ContextView, type QuotaView, type QuotaWindowView } from "./usage-readings.js";
import "./usage-indicators.css";

/** Context: a ring whose drawn part is what is left of the window. */
export function ContextRing({ left, size = 16, stroke = 2.4 }: { left: number; size?: number; stroke?: number }) {
  const radius = (size - stroke) / 2, around = 2 * Math.PI * radius, centre = size / 2;
  return <svg className="usage-ring" data-tone={usageTone(left)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    <circle className="usage-ring-track" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={stroke}/>
    {left > 0 && <circle className="usage-ring-left" cx={centre} cy={centre} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${around * left / 100} ${around}`}/>}
  </svg>;
}
/** Quota: a battery whose charge is what is left of the tightest window. */
export function QuotaBattery({ left, height = 16 }: { left: number; height?: number }) {
  return <svg className="usage-battery" data-tone={usageTone(left)} width={height * 1.5} height={height} viewBox="0 0 24 16" fill="none" aria-hidden="true">
    <rect className="usage-battery-body" x="1.2" y="2.2" width="18.6" height="11.6" rx="3.2" strokeWidth="1.6"/>
    <path className="usage-battery-body" d="M22.4 6.2v3.6" strokeWidth="1.8" strokeLinecap="round"/>
    <rect className="usage-battery-left" x="4" y="5" width={Math.max(1.2, 13 * left / 100)} height="6" rx="1.4"/>
  </svg>;
}

function periodLabel(window: QuotaWindowView): string {
  const hours = (window.periodSeconds ?? 0) / 3600;
  const period = hours >= 48 && hours % 24 === 0 ? t("{0} 天", hours / 24) : hours >= 1 && Number.isInteger(hours) ? t("{0} 小时", hours) : undefined;
  // The Host labels a per-model window "Opus · 7 days"; an unknown window keeps the engine's own name.
  const model = /^(.+?) · /.exec(window.label)?.[1];
  return period ? model ? `${model} · ${period}` : period : window.label;
}
function clock(value: string, locale: Locale, now = new Date()): string {
  const date = new Date(value), sameDay = date.toDateString() === now.toDateString();
  const time: Intl.DateTimeFormatOptions = locale === "zh" ? { hour: "2-digit", minute: "2-digit", hour12: false } : { hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", sameDay ? time : { month: locale === "zh" ? "long" : "short", day: "numeric", ...time }).format(date);
}
function Bar({ left, label }: { left: number; label: string }) {
  return <div className="usage-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}><i data-tone={usageTone(left)} style={{ width: `${left}%` }}/></div>;
}

/** The numbers behind the two symbols. Every percentage is what is left. */
export function UsageDetails({ context, quota }: { context?: ContextView; quota?: QuotaView }) {
  const locale = useLocale();
  const pools = quota ? [...new Set(quota.windows.map(window => window.pool))] : [];
  return <div className="usage-details">
    {context && <section aria-label={t("上下文")}>
      <h4><ContextRing left={context.left} size={14} stroke={2.2}/>{t("上下文")}</h4>
      <div className="usage-row"><b data-tone={usageTone(context.left)}>{context.left}%</b><span>{t("已用 {0} / {1}", shortTokens(context.usedTokens), shortTokens(context.windowTokens))}</span></div>
      <Bar left={context.left} label={t("上下文可用")}/>
      {context.compactAt !== undefined && <p className="usage-note">{t("用到约 {0}% 时自动压缩", context.compactAt)}</p>}
    </section>}
    {quota && pools.map(pool => {
      const windows = quota.windows.filter(window => window.pool === pool);
      return <section key={pool} aria-label={t("额度 · {0}", pool)}>
        <h4><QuotaBattery left={Math.min(...windows.map(window => window.left))} height={13}/>{t("额度 · {0}", pool)}</h4>
        {windows.map(window => <div className="usage-window" key={window.id}>
          <div className="usage-row"><b data-tone={usageTone(window.left)}>{periodLabel(window)}<span className="usage-gap"/>{window.left}%</b>{window.resetsAt && <span>{t("{0} 重置", clock(window.resetsAt, locale))}</span>}</div>
          <Bar left={window.left} label={t("{0} 额度可用", periodLabel(window))}/>
        </div>)}
      </section>;
    })}
    {quota && <p className="usage-note usage-read-at">{t("{0} 读取", clock(quota.observedAt, locale))}</p>}
  </div>;
}

/** Desktop composer: the ring and the battery, each with its number and each only when its value can be read. */
export function UsageIndicators({ context, quota, onOpen }: { context?: ContextView; quota?: QuotaView; onOpen?: () => void }) {
  useLocale();
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null), id = useId();
  if (!context && !quota) return null;
  const label = [context && t("上下文可用 {0}%", context.left), quota && t("额度可用 {0}%", quota.left)].filter(Boolean).join(t("，"));
  return <>
    <button ref={trigger} type="button" className="usage-indicators" aria-label={label} title={label} aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>
      {context && <span className="usage-pair" data-tone={usageTone(context.left)} data-usage="context"><ContextRing left={context.left}/><span>{context.left}%</span></span>}
      {quota && <span className="usage-pair" data-tone={usageTone(quota.left)} data-usage="quota"><QuotaBattery left={quota.left}/><span>{quota.left}%</span></span>}
    </button>
    {open && <DesktopMenuPortalContext.Provider value={true}>
      <DesktopMenu id={id} label={t("上下文与额度")} open close={() => setOpen(false)} trigger={trigger} placement="up-end" className="usage-panel"><UsageDetails context={context} quota={quota}/></DesktopMenu>
    </DesktopMenuPortalContext.Provider>}
  </>;
}

/** Phone header: shown only when quota is nearly gone. */
export function QuotaLowMark({ onOpen }: { onOpen: () => void }) {
  useLocale();
  return <button type="button" className="quota-low-mark" aria-label={t("额度快用完了，查看额度")} title={t("额度快用完了，查看额度")} onClick={onOpen}><QuotaBattery left={0} height={12}/></button>;
}
