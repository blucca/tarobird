import { ENGINE_QUOTA_CAPABILITY, engineQuotaViewSchema, type EngineQuotaView } from "../client-protocol/engine-quota.js";
import type { LocalHostClient } from "./client.js";

/** Same owner-only Host read as the App; the CLI never asks an engine itself. */
export async function engineQuotaCommand(client: Pick<LocalHostClient, "request" | "ready">, flags: { refresh?: boolean }): Promise<EngineQuotaView> {
  if (!client.ready.serverCapabilities.includes(ENGINE_QUOTA_CAPABILITY)) throw new Error("请更新主机后查看模型额度。");
  return engineQuotaViewSchema.parse(flags.refresh ? await client.request("/api/engines/quota/refresh", "POST", {}) : await client.request("/api/engines/quota"));
}
