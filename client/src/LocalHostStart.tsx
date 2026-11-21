import { LoaderCircle, Power } from "lucide-react";
import { t } from "./i18n.js";

/** One shared state for every "Start local host" entry (banner, devices page):
 * starting marks all of them busy; a failure stays visible beside each button. */
export type LocalHostStartControl = { busy: boolean; error: string; start: () => void };

/** Busy is aria-disabled, not disabled, so keyboard focus stays on the button. */
export function LocalHostStartButton({ control, className = "" }: { control: LocalHostStartControl; className?: string }) {
  return <button type="button" className={`local-host-start ${className}`.trim()} aria-disabled={control.busy || undefined} aria-busy={control.busy || undefined} onClick={() => { if (!control.busy) control.start(); }}>
    {control.busy ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <Power size={15} aria-hidden="true"/>}
    {control.busy ? t("正在启动本机主机…") : t("启动本机主机")}
  </button>;
}

/** `live` only where no enclosing live region already announces it. */
export function LocalHostStartError({ control, live = false }: { control: LocalHostStartControl; live?: boolean }) {
  return control.error && !control.busy ? <p className="error-text local-host-start-error" role={live ? "status" : undefined}>{control.error}</p> : null;
}
