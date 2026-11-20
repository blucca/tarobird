import { t } from "./i18n.js";

type Status = "ready" | "no-models" | "unavailable" | undefined;
/** Older Hosts keep their manual settings contract; only an explicit catalog
 * failure blocks new choices. The Host revalidates every submitted choice. */
export function deepSeekCatalogBlocked(engine: string, status: Status) {
  return engine === "deepseek" && status !== undefined && status !== "ready";
}
export function DeepSeekModelCatalogNotice({ status }: { status: Status }) {
  if (status === "ready") return null;
  return <p className="dashboard-notice" role="status">{status === "no-models"
    ? t("DeepSeek 未提供可用模型。请检查主机上的提供商配置与授权，然后重新读取；已保存的选择和当前填写内容会保留。")
    : status === "unavailable"
      ? t("暂未完整读取 DeepSeek 模型目录。请检查主机上的提供商配置与授权，然后重新读取；已保存的选择和当前填写内容会保留。")
      : t("此主机未提供 DeepSeek 模型目录。可继续使用已有选项或手工填写，更新主机后可读取完整目录。")}</p>;
}
export function deepSeekSettingsErrorText(error: unknown): string | undefined {
  switch (error instanceof Error ? error.message : "") {
    case "model_catalog_unavailable": case "effort_catalog_unavailable":
      return t("暂未完整读取 DeepSeek 模型目录。请检查主机上的提供商配置与授权，然后重新读取；已保存的选择和当前填写内容会保留。");
    case "model_unavailable": case "effort_model_unavailable":
      return t("所选模型已不在主机目录中。请重新读取并选择可用模型；已保存的设置不会被清除。");
    default: return undefined;
  }
}
