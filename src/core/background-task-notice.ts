import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../runtime/locale.js";
import { channelProfile, type ChannelProfile } from "./channel-profile.js";

type Notification = Extract<EngineStreamEvent, { type: "task_notification" }>;
const NOTES: Record<NonNullable<Notification["note"]>, { zh: string; en: string }> = {
  review_timeout: { zh: "引擎没有在限定时间内完成对这个后台结果的复核。", en: "The engine did not finish reviewing this background result in time." },
  review_failed: { zh: "引擎复核这个后台结果时失败了。", en: "The engine failed while reviewing this background result." },
  review_interrupted: { zh: "引擎对这个后台结果的复核被中断了。", en: "The engine's review of this background result was interrupted." },
};
export function backgroundTaskBody(event: Notification, locale: Locale): string {
  const en = locale === "en", note = event.note ? NOTES[event.note][en ? "en" : "zh"] : undefined;
  // The task's name, when the engine gave one, says which task this is about. A note already says why there
  // is nothing more, so it stands in for the general line.
  if (event.reason === "no_result") return [event.summary?.trim(), note ?? (en ? "The engine provided no further result." : "引擎没有提供更多结果。")].filter(Boolean).join("\n\n");
  if (event.reason === "engine_exit") return [event.summary?.trim(), en ? "The engine process exited before this task completed." : "引擎进程已退出，未收到此任务的完成结果。"].filter(Boolean).join("\n\n");
  return [event.text, note].filter(Boolean).join("\n\n");
}
export function backgroundTaskReplyTo(event: Notification, replyTo?: string, profile: ChannelProfile = channelProfile()): string | undefined {
  // A recovered task may be delivered through the new turn's callback. That
  // callback is not evidence that the new prompt started the old task.
  return profile === "gateway" && event.origin === "unattributed" ? undefined : replyTo;
}
export function backgroundTaskContext(event: Pick<Notification, "origin">, locale: Locale): string | undefined {
  if (!event.origin) return;
  if (event.origin === "unattributed") return locale === "en"
    ? "Background task report · The original request could not be confirmed. This is separate from the current reply."
    : "后台任务结果 · 暂时无法确认关联的原请求。这是独立通知，不是当前提问的回答。";
  return locale === "en" ? "Background task report · A follow-up to the linked request." : "后台任务结果 · 这是关联请求的后续通知。";
}
