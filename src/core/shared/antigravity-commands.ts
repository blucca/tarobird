import type { Locale } from "../../runtime/message-renderer.js";

export type AntigravitySlashCommandAction =
  | { kind: "swarm_board" }
  | { kind: "automation"; request: string };

/**
 * Recognizes Antigravity slash commands that are CLI-only or Antigravity
 * Desktop App-only and therefore cannot run natively over headless ACP/print:
 * - `/swarm board` (interactive TUI board pane; `/swarm <task>` still goes straight to `agy`)
 * - `/automation` (Antigravity Desktop App-only sidecar scheduler; maps to TaroBird `/cron`)
 */
export function parseAntigravityLocalCommand(text: string): AntigravitySlashCommandAction | null {
  const trimmed = text.trim();
  if (/^\/swarm(?:@[a-z0-9_.-]+)?\s+board(?:\s+[\s\S]*)?$/i.test(trimmed)) {
    return { kind: "swarm_board" };
  }
  const automation = trimmed.match(/^\/automation(?:@[a-z0-9_.-]+)?(?:\s+([\s\S]*))?$/i);
  if (automation) {
    return { kind: "automation", request: (automation[1] ?? "").trim() };
  }
  return null;
}

export async function renderAntigravityLocalCommandReply(
  action: AntigravitySlashCommandAction,
  locale: Locale,
): Promise<{ commandLabel: string; markdown: string }> {
  const english = locale === "en";

  if (action.kind === "swarm_board") {
    return {
      commandLabel: "/swarm board",
      markdown: english
        ? [
            "**Swarm board (`/swarm board`)**",
            "",
            "The interactive `/swarm board` view is only available in the Antigravity desktop app (Swarm pane) or CLI terminal; headless ACP sessions cannot open a TUI pane.",
            "",
            "- **In this chat**: ask the active swarm coordinator directly (for example: `Show the current swarm status and latest board messages`) and it will read the shared board for you.",
            "- **Start a new swarm here**: send `/swarm <your task>`.",
            "- **Open the interactive board locally**: run `/swarm board` in Antigravity CLI or open the Swarm pane in the Antigravity desktop app.",
          ].join("\n")
        : [
            "**Swarm 消息板（`/swarm board`）**",
            "",
            "`/swarm board` 交互式看板仅支持 Antigravity 桌面端（Swarm 面板）或本地 CLI 终端，当前无头 ACP 会话无法直接弹出 TUI 面板。",
            "",
            "- **在当前对话查看**：直接回复协调者（例如：`查看当前 swarm 状态和最新消息板进展`），即可读取并汇总所有 Worker 状态。",
            "- **在此发起新的 Swarm**：直接发送 `/swarm <任务说明>`。",
            "- **打开交互式看板**：在本地终端的 Antigravity CLI 中运行 `/swarm board`，或在 Antigravity 桌面端打开 Swarm 面板。",
          ].join("\n"),
    };
  }

  // action.kind === "automation"
  const samplePrompt = action.request || (english ? "Summarize unread updates" : "汇总今日待办与进展");
  return {
    commandLabel: "/automation",
    markdown: english
      ? [
          "**Scheduled Automations (`/automation`)**",
          "",
          "Antigravity's built-in `/automation` sidecar runs only inside the Antigravity desktop app and is not exposed over ACP.",
          "",
          "In TaroBird, use native durable schedules instead (each run executes automatically on the Host without keeping a chat open):",
          `- **TaroBird recurring schedule**: send \`/cron add 0 9 * * * ${samplePrompt}\` (or \`/cron list\` to view existing jobs), or open the App's **Schedules** panel.`,
          `- **In-session Antigravity timer**: send \`/schedule ${samplePrompt}\` for a timer inside this active session.`,
        ].join("\n")
      : [
          "**定时自动化（`/automation`）**",
          "",
          "Antigravity 内置的 `/automation` 侧车调度仅在 Antigravity 桌面端应用中运行，ACP 协议未对外开放该命令。",
          "",
          "在 TaroBird 中可直接使用原生持久化定时任务（由 Host 自动按时执行，无需保持对话打开）：",
          `- **TaroBird 定时任务（推荐）**：发送 \`/cron add 0 9 * * * ${samplePrompt}\`（查看现有任务用 \`/cron list\`），或直接在 App 的「定时任务」面板创建与启停。`,
          `- **当前会话内定时**：发送 \`/schedule ${samplePrompt}\` 使用 Antigravity 原生会话内定时器。`,
        ].join("\n"),
  };
}
