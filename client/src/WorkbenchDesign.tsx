import { WorkbenchDesignHistory } from "./WorkbenchDesignHistory.js";
import { WorkbenchDesignSharing } from "./WorkbenchDesignSharing.js";
import { WorkbenchDesignSystems } from "./WorkbenchDesignSystems.js";
import type { WorkbenchController } from "./workbench-controller.js";
import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Download, RotateCw } from "lucide-react";
import { t, useLocale } from "./i18n.js";
import { designFrame } from "./design-frame.js";
import { exportAttachment } from "./attachment-export.js";
import type { DesignSession } from "./workbench-design-session.js";
import "./workbench-design.css";

export default function WorkbenchDesign({ controller, session, active, title, botAvailable, onActivate }: { controller: WorkbenchController; session: DesignSession; active: boolean; title: string; botAvailable: boolean; onActivate(): void }) {
  useLocale();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot), surface = useRef<HTMLDivElement>(null), [error, setError] = useState<string>();
  const activate = useRef(onActivate); activate.current = onActivate;
  let supported = true;
  if (Capacitor.isNativePlatform()) {
    try { supported = !!document.querySelector('meta[name="tarobot-widget-guard"][content="1"]') && (window as unknown as { tarobotWidgetIsolation?: { supported(): boolean } }).tarobotWidgetIsolation?.supported() === true; } catch { supported = false; }
  }
  useEffect(() => { if (supported && active && surface.current) return designFrame(session).attach(surface.current, setError, () => activate.current()); }, [active, session, supported]);
  const exportProject = async () => {
    try { const backup=await controller.exportDesign(session.document.id,title); await exportAttachment(new Blob([backup], { type: "application/json" }), `${title.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")}.tarobot-design.json`); setError(undefined); }
    catch { setError("design_not_saved"); }
  };
  if (!supported) return <p>{t("当前版本缺少安全设计预览支持，请更新 App 或系统后重试。")}</p>;
  return <div className="workbench-design" data-design-revision={state.document.revision}>
    {!botAvailable && <p className="workbench-design-info">{t("更新主机后可让 Bot 协助设计。本机编辑仍可用。")}</p>}
    {(error || state.error) && <div className="workbench-design-error" role="alert">{t("设计尚未保存或编辑器未就绪。请重试，保存成功前不要退出应用。")}<button onClick={() => { void designFrame(session).reload().then(() => setError(undefined), () => setError("design_not_saved")); }}><RotateCw size={14}/>{t("重试")}</button></div>}
    <div ref={surface} className="workbench-design-surface"/>
    <div className="workbench-design-status">
      {[undefined,"canvas","slides"].includes(state.document.format) && <WorkbenchDesignSystems controller={controller} session={session}/>}
      <WorkbenchDesignHistory session={session}/>
      <span hidden className="workbench-design-sharing-entry"><WorkbenchDesignSharing controller={controller} session={session} title={title}/></span>
      {(state.saving || state.error) && <span role="status">{state.saving ? t("正在保存…") : t("尚未保存")}</span>}
      <button title={state.document.format === "slides" ? t("备份可重新导入的 PPT 项目；PowerPoint 导出在编辑器下载菜单中") : t("导出可重新导入的完整设计")} onClick={() => void exportProject()}><Download size={14}/>{state.document.format === "slides" ? t("备份 PPT 项目") : t("导出设计")}</button>
    </div>
  </div>;
}
