import { HISTORY_REWIND_RANGES_MAX, forkOriginSchema, historyErrorSchema, historyOperationSchema, rewindRangeSchema,
  type ConversationHistory, type HistoryOperation, type RewindRange } from "../client-protocol/history.js";

/** One row of `conversation_history_ops` (#53). Kept free of store imports:
 * conversation serialization and the history service both read it. */
export type HistoryOpRow = {
  id: string; user_id: string; request_id: string; payload_hash: string; conversation_id: string; bot_id: string;
  kind: "rewind" | "fork"; anchor_message_id: string | null; anchor_created_at: number | null;
  through_message_id: string | null; through_created_at: number | null; target_conversation_id: string | null;
  state: "started" | "completed" | "failed" | "unknown"; error: string | null; result_json: string | null;
  created_at: number; updated_at: number;
};

/** A completed rewind row is its range; nothing else stores it. */
export function rewindRange(row: Pick<HistoryOpRow, "id" | "user_id" | "anchor_message_id" | "anchor_created_at" | "through_message_id" | "through_created_at" | "updated_at">): RewindRange | undefined {
  const range = rewindRangeSchema.safeParse({ id: row.id, fromMessageId: row.anchor_message_id, fromCreatedAt: row.anchor_created_at,
    throughMessageId: row.through_message_id, throughCreatedAt: row.through_created_at, at: row.updated_at, by: row.user_id });
  return range.success ? range.data : undefined;
}

/** Ranges in completion order. A range fully covered by a later one is
 * dropped; only the newest HISTORY_REWIND_RANGES_MAX reach clients. */
export function visibleRewindRanges(ranges: RewindRange[]): RewindRange[] {
  const kept = ranges.filter((range, index) => !ranges.slice(index + 1).some(later => later.fromCreatedAt <= range.fromCreatedAt && later.throughCreatedAt >= range.throughCreatedAt));
  return kept.slice(-HISTORY_REWIND_RANGES_MAX);
}

/** Never lets one malformed row break a whole conversation listing. */
export function conversationHistory(rewindRows: Parameters<typeof rewindRange>[0][], forkJson: string | null): ConversationHistory | undefined {
  const rewinds = visibleRewindRanges(rewindRows.flatMap(row => { const range = rewindRange(row); return range ? [range] : []; }));
  let forkedFrom;
  if (forkJson) { try { const parsed = forkOriginSchema.safeParse(JSON.parse(forkJson)); if (parsed.success) forkedFrom = parsed.data; } catch { /* Omitted below. */ } }
  if (!rewinds.length && !forkedFrom) return undefined;
  return { ...(rewinds.length ? { rewinds } : {}), ...(forkedFrom ? { forkedFrom } : {}) };
}

export function historyReceipt(row: HistoryOpRow, replayed = false): HistoryOperation {
  const error = row.error ? historyErrorSchema.safeParse(row.error) : undefined;
  const range = row.kind === "rewind" && row.state === "completed" ? rewindRange(row) : undefined;
  return historyOperationSchema.parse({ id: row.id, requestId: row.request_id, kind: row.kind, state: row.state,
    ...(error?.success ? { error: error.data } : {}), ...(range ? { rewind: range } : {}),
    ...(row.kind === "fork" && row.state === "completed" && row.target_conversation_id ? { conversationId: row.target_conversation_id } : {}),
    ...(replayed ? { replayed: true } : {}) });
}
