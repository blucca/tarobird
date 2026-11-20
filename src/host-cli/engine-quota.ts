import { ENGINE_QUOTA_CAPABILITY, quotaDirectorySchema, quotaReadingExpired, quotaScopeSchema, type QuotaDirectory, type QuotaScope, type QuotaSnapshot } from "../client-protocol/engine-quota.js";
import type { LocalHostClient } from "./client.js";

export async function engineQuotaCommand(client: Pick<LocalHostClient, "request" | "ready">, flags: { bot?: string; refresh?: boolean; revision?: string }) {
  if (!client.ready.serverCapabilities.includes(ENGINE_QUOTA_CAPABILITY)) throw new Error("请更新主机后查看模型额度 / Update the host to view model quotas.");
  if (flags.refresh && (!flags.bot || !flags.revision) || flags.revision && !flags.refresh) throw new Error("刷新前先读取额度，再使用 engines quota --bot BOT --refresh --revision REV / Read quotas before refreshing a Bot scope.");
  if (flags.bot && !/^[A-Za-z0-9_-]{1,128}$/.test(flags.bot) || flags.revision && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(flags.revision)) throw new Error("Invalid quota scope or revision");
  const url = `/api/engine-quotas${flags.bot ? `/${encodeURIComponent(flags.bot)}` : ""}${flags.refresh ? `?refresh=1&revision=${encodeURIComponent(flags.revision!)}` : ""}`;
  return (flags.bot ? quotaScopeSchema : quotaDirectorySchema).parse(await client.request(url));
}

// Same verified sources as the App settings card (client/src/EngineQuota.tsx).
const guidance: Record<NonNullable<QuotaSnapshot["help"]>, string> = {
  codex_usage: "官方查看：在运行主机的 Codex CLI 中以 ChatGPT 登录后输入 /usage / Official view: sign in to Codex CLI with ChatGPT and enter /usage.",
  claude_usage: "官方查看：订阅登录时在 Claude Code 中输入 /usage，或打开 claude.ai/settings/usage / Official view: enter /usage in Claude Code or open claude.ai/settings/usage.",
  antigravity_usage: "官方查看：在 Antigravity CLI 中输入 /usage 或 /quota（AI credits 用 /credits）；GEMINI_API_KEY 请在 Google AI Studio 查看 / Official view: enter /usage or /quota (/credits for AI credits) in Antigravity CLI; check a GEMINI_API_KEY in Google AI Studio.",
  gemini_api_usage: "官方查看：GEMINI_API_KEY 没有账号额度，请在 Google AI Studio 查看 / Official view: a GEMINI_API_KEY has no account quota; check it in Google AI Studio.",
  kimi_usage: "官方查看：在 Kimi Code CLI 交互界面输入 /usage；ACP 会话的 /usage 只显示本会话 token / Official view: enter /usage in the interactive Kimi Code CLI; ACP /usage shows session tokens only.",
  deepseek_balance: "官方查看：DeepSeek 官方 API 在 platform.deepseek.com 查看余额，其他供应商在其控制台查看 / Official view: see the DeepSeek Platform (platform.deepseek.com) balance, or another provider's console.",
};

/** Human hints for standard error only; standard output keeps the strict JSON contract. */
export function engineQuotaGuidance(value: QuotaDirectory | QuotaScope, now = Date.now()): string[] {
  const groups = new Map<NonNullable<QuotaSnapshot["help"]>, string[]>();
  for (const scope of "scopes" in value ? value.scopes : [value]) {
    if (!scope.help || scope.state === "ready" && !quotaReadingExpired(scope, now)) continue;
    groups.set(scope.help, [...groups.get(scope.help) ?? [], scope.label]);
  }
  return [...groups].map(([help, labels]) => `${labels.join(", ")}: ${guidance[help]}`);
}
