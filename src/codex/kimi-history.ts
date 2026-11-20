import { createHash } from "node:crypto";
import type { NativeHistoryRejection } from "./adapter.js";

export class KimiHistoryError extends Error {
  constructor(readonly reason: NativeHistoryRejection) { super(`Kimi history ${reason}`); }
}
const metadata = new Set(["available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update", "notice"]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Hash the ordered native replay, never display it or save a transcript copy. */
export class KimiHistoryReplay {
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private count = 0;
  private overflow = false;
  constructor(readonly sessionId: string) {}
  add(update: { sessionUpdate: string }): void {
    if (metadata.has(update.sessionUpdate) || this.overflow) return;
    const text = JSON.stringify(canonical(update));
    this.bytes += Buffer.byteLength(text); this.count++;
    if (this.bytes > 8 * 1024 * 1024 || this.count > 20_000) { this.overflow = true; return; }
    this.hash.update(text).update("\n");
  }
  digest(): string {
    if (this.overflow) throw new KimiHistoryError("not_ready");
    return this.hash.digest("hex");
  }
}
export function kimiHistoryRejection(error: unknown): NativeHistoryRejection {
  if (error instanceof KimiHistoryError) return error.reason;
  const value = error as { message?: string; data?: { details?: string } };
  const text = `${value?.message ?? error} ${value?.data?.details ?? ""}`;
  if (/unknown session|session.*not found|no such session/i.test(text)) return "source_missing";
  if (/in use by another|busy|active turn|in.flight turn/i.test(text)) return "busy";
  if (/unsupported|method not found|does not support/i.test(text)) return "unsupported";
  return "not_ready";
}
