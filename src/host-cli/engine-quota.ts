import { ENGINE_QUOTA_CAPABILITY, quotaDirectorySchema, quotaScopeSchema } from "../client-protocol/engine-quota.js";
import type { LocalHostClient } from "./client.js";

export async function engineQuotaCommand(client: Pick<LocalHostClient, "request" | "ready">, flags: { bot?: string; refresh?: boolean; revision?: string }) {
  if (!client.ready.serverCapabilities.includes(ENGINE_QUOTA_CAPABILITY)) throw new Error("请更新主机后查看模型额度 / Update the host to view model quotas.");
  if (flags.refresh && (!flags.bot || !flags.revision) || flags.revision && !flags.refresh) throw new Error("刷新前先读取额度，再使用 engines quota --bot BOT --refresh --revision REV / Read quotas before refreshing a Bot scope.");
  if (flags.bot && !/^[A-Za-z0-9_-]{1,128}$/.test(flags.bot) || flags.revision && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(flags.revision)) throw new Error("Invalid quota scope or revision");
  const url = `/api/engine-quotas${flags.bot ? `/${encodeURIComponent(flags.bot)}` : ""}${flags.refresh ? `?refresh=1&revision=${encodeURIComponent(flags.revision!)}` : ""}`;
  return (flags.bot ? quotaScopeSchema : quotaDirectorySchema).parse(await client.request(url));
}
