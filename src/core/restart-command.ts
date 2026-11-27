import type { EngineTask } from "../client-protocol/engine-tasks.js";
import type { BridgeConversationRestartOutcome } from "../runtime/bridge.js";
import type { Locale } from "../runtime/locale.js";
import { loadInstanceConfig } from "../state/instance-config.js";
import { abortCoreConversation, requestCoreApproval } from "./card-actions.js";
import type { CoreNormalizedBridgeMessage } from "./message-normalizer.js";
import type { CoreServiceRuntime } from "./runtime.js";
import { appendCoreTimelineEvent } from "./timeline.js";
import type { CoreBridgeLike, CoreChannelLike } from "./types.js";

export async function handleCoreRestart(
  input: { channel: CoreChannelLike; bridge: CoreBridgeLike; runtime: CoreServiceRuntime; stateDir: string },
  message: CoreNormalizedBridgeMessage,
  locale: Locale,
): Promise<void> {
  const { channel, bridge, runtime, stateDir } = input;
  const { chatId, conversationKey } = message;
  const reply = { replyTo: message.messageId, replyInThread: Boolean(message.threadId) };
  const supported = bridge.restartConversationSession && bridge.supportsConversationRestart?.() !== false;
  const pause = supported ? runtime.chatQueue.pause(conversationKey) : undefined;
  let result: BridgeConversationRestartOutcome = supported ? "busy" : "unsupported";
  let stopRequested = false;
  try {
    if (pause) {
      channel.releaseMessageAdmission?.();
      try {
        result = await bridge.restartConversationSession!({
          chatId: message.bridgeChatId, conversationKey, signal: pause.signal,
          isCurrentBinding: async () => (await channel.canSteerConversation?.(chatId)) !== false,
          confirm: tasks => confirmRestart(input, message, tasks, locale, pause.signal),
          onStopping: () => {
            stopRequested = true;
            abortCoreConversation(runtime, conversationKey);
          },
        });
      } catch {
        result = pause.signal.aborted && !stopRequested ? "cancelled" : "failed";
      }
    }
    await channel.send(chatId, { text: restartReply(result, locale, stopRequested) }, reply);
    await appendCoreTimelineEvent(stateDir, message, {
      type: "command.handled", detail: "/restart",
      outcome: result === "closed" ? "success" : result === "failed" || result === "exit_unconfirmed" ? "error" : "noop",
      metadata: { result, stopRequested },
    });
  } finally {
    pause?.release();
  }
}

async function confirmRestart(
  input: { channel: CoreChannelLike; runtime: CoreServiceRuntime; stateDir: string },
  message: CoreNormalizedBridgeMessage,
  tasks: readonly EngineTask[],
  locale: Locale,
  abortSignal: AbortSignal,
): Promise<boolean> {
  const zh = locale === "zh";
  const confirm = zh ? "确认重启" : "Confirm restart";
  const cancel = zh ? "取消重启" : "Cancel restart";
  const labels = tasks.slice(0, 10).map(task => task.label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 120)
    .replace(/[\\`*_\[\]<>]/gu, "\\$&"));
  const remaining = tasks.length - labels.length;
  const more = remaining ? (zh ? `，另有 ${remaining} 项，可在任务列表查看` : `, plus ${remaining} more in the task list`) : "";
  const question = zh
    ? `重启将中断以下后台任务：${labels.join("、")}${more}。是否继续？`
    : `Restarting will interrupt these background tasks: ${labels.join(", ")}${more}. Continue?`;
  const { engine } = await loadInstanceConfig(input.stateDir);
  const decision = await requestCoreApproval({
    ...input, chatId: message.chatId, conversationKey: message.conversationKey,
    requesterUserId: message.bridgeUserId, bridgeChatType: message.bridgeChatType,
    replyTo: message.messageId, replyInThread: Boolean(message.threadId), locale, abortSignal,
    request: { engine, toolName: "AskUserQuestion", toolInput: {
      questions: [{ header: zh ? "重启引擎" : "Restart engine", question, options: [{ label: confirm }, { label: cancel }] }],
    } },
  });
  return decision.behavior === "allow"
    && (decision.updatedInput as { answers?: Record<string, string> } | undefined)?.answers?.[question] === confirm;
}

function restartReply(outcome: BridgeConversationRestartOutcome, locale: Locale, stopRequested: boolean): string {
  const zh = locale === "zh";
  switch (outcome) {
    case "closed": return zh
      ? "旧进程已结束，会话已保留，下次发消息时启动。"
      : "The old engine process has exited. The session is kept. Your next message will start the engine.";
    case "not_running": return zh
      ? "当前没有在运行的引擎进程。会话已保留，下次发消息时启动。"
      : "No engine process is running. The session is kept. Your next message will start the engine.";
    case "no_session": return zh
      ? "这个对话还没有已保存的引擎会话，无需重启。"
      : "This chat has no saved engine session yet. There is nothing to restart.";
    case "unsupported": return zh
      ? "当前引擎或运行模式暂不支持 /restart。"
      : "This engine or runtime mode does not support /restart.";
    case "binding_changed": return zh
      ? "会话选择已变更或尚未生效。请在选择生效后重试 /restart。"
      : "The session selection changed or is pending. Retry /restart once the selection takes effect.";
    case "shared_session": return zh
      ? "这个引擎会话由多个对话使用，无法在这里单独重启。"
      : "This engine session is used by more than one chat. It cannot be restarted from this chat alone.";
    case "busy": return zh
      ? "当前会话有另一项会话操作，请等它结束后再试。"
      : "Another session operation is in progress. Try again when it finishes.";
    case "cancelled": return zh ? "已取消重启。" : "Restart cancelled.";
    case "failed":
      if (!stopRequested) return zh
        ? "暂时无法核对会话或后台任务，本次未开始关闭引擎。可重试 /restart。"
        : "Could not check the session or its background tasks. No shutdown was started. You can retry /restart.";
      // An unexpected failure after the stop started has the same uncertain outcome.
    case "exit_unconfirmed": return zh
      ? "未能确认旧引擎进程已退出。会话已保留，可重试 /restart。"
      : "Could not confirm that the old engine process exited. The session is kept. You can retry /restart.";
  }
}
