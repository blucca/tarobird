import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema, type Conversation, type HubEvent, type Json } from "../client-protocol/index.js";
import { historyActionSchema, historyAnchorEvidenceSchema, numberedForkTitle, historyAnchorPageSchema, historyChangeSchema, historyInternalSnapshotSchema, historyNativeResultSchema, historyOperationSchema, historySnapshotSchema, type HistoryAnchorEvidence, type HistoryChange, type HistoryInternalSnapshot, type HistoryNativeResult, type HistoryOperation } from "../client-protocol/conversation-history.js";
import { HubError, HubStore, newId, type TransactionGuard } from "./store.js";

type OperationRow = { id: string; owner_id: string; request_id: string; payload_hash: string; bot_id: string; source_conversation_id: string; expected_revision: string; action_json: string; anchor_json: string | null; destination_conversation_id: string | null; state: string; native_result_json: string | null; result_json: string };
type AnchorRow = { id: string; message_id: string; generation: string; session_id: string; evidence_json: string; message_rowid: number };
type HistoryHost = {
  available(botId: string): "ready" | "offline" | "unsupported";
  busy(botId: string, conversationId: string): boolean;
  call(botId: string, method: string, input: unknown): Promise<Json>;
  changed(conversation: Conversation): Promise<void>;
};
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicResult = (row: OperationRow) => historyOperationSchema.parse(JSON.parse(row.result_json));

/** Native mutations are sent once. Reconnect recovery only reads receipts and
 * completes already-confirmed local bindings and Hub projections. */
export class HubConversationHistory {
  private finishing = new Map<string, Promise<void>>();
  constructor(private readonly store: HubStore, private readonly host: HistoryHost) {}

  async authorizeInTransaction(userId: string, botId: string, conversationId: string): Promise<Conversation> {
    await this.store.requireOwner(userId); await this.store.requireMember(userId, conversationId); await this.store.requireBot(botId, conversationId);
    const conversation = await this.store.conversationInTransaction(conversationId);
    const bot = await this.store.db.get<{ role: string; owner_id: string | null }>("SELECT b.role,m.owner_id FROM bots b LEFT JOIN managed_bots m ON m.bot_id=b.id WHERE b.id=? AND b.deleted_at IS NULL", [botId]);
    if (conversation.ownerId !== userId || bot?.owner_id && bot.owner_id !== userId) throw new HubError("history_forbidden", 403);
    if (!bot || bot.role || conversation.type !== "direct" || conversation.parentId || conversation.hidden || conversation.ticket || conversation.botIds.length !== 1) throw new HubError("history_wrong_scope", 409);
    if (conversation.archived) throw new HubError("conversation_archived", 409);
    return conversation;
  }
  async authorizeWorker(botId: string, raw: unknown): Promise<{ allowed: boolean }> {
    const p = z.object({ userId: idSchema, conversationId: idSchema, operationId: idSchema.optional(), purpose: z.literal("apply").optional() }).strict().parse(raw);
    return this.store.db.serial(async () => {
      await this.authorizeInTransaction(p.userId, botId, p.conversationId);
      if (this.host.available(botId) !== "ready") return { allowed: false };
      if (!p.operationId) return { allowed: true };
      const row = await this.row(p.operationId);
      return { allowed: !!row && row.bot_id === botId && row.owner_id === p.userId && row.source_conversation_id === p.conversationId
        && (!p.purpose || row.state === "dispatched" && row.native_result_json === null) };
    });
  }
  private row(id: string): Promise<OperationRow | undefined> { return this.store.db.get("SELECT * FROM history_operations WHERE id=?", [id]); }
  private async pending(conversationId: string): Promise<OperationRow | undefined> {
    return this.store.db.get("SELECT * FROM history_operations WHERE (source_conversation_id=? OR destination_conversation_id=?) AND state NOT IN ('applied','rejected') LIMIT 1", [conversationId, conversationId]);
  }
  private async internalSnapshot(userId: string, botId: string, conversationId: string): Promise<HistoryInternalSnapshot> {
    const availability = this.host.available(botId);
    if (availability === "unsupported") return { supported: false };
    if (availability === "offline") return { supported: true, blocked: "not_ready" };
    return historyInternalSnapshotSchema.parse(await this.host.call(botId, "history.snapshot", { userId, botId, conversationId }));
  }
  async snapshot(userId: string, botId: string, conversationId: string, validate?: TransactionGuard) {
    await this.store.db.serial(async () => { await validate?.(); await this.authorizeInTransaction(userId, botId, conversationId); });
    const snapshot = await this.internalSnapshot(userId, botId, conversationId).catch(() => ({ supported: true, blocked: "not_ready" as const }));
    return this.store.db.serial(async () => {
      await validate?.(); await this.authorizeInTransaction(userId, botId, conversationId);
      const operation = await this.pending(conversationId);
      const { sourceSessionId: _session, bindingGeneration: _generation, ...result } = snapshot as HistoryInternalSnapshot;
      if (operation) { result.pendingOperation = operation.request_id; result.blocked = operation.state === "unknown" ? "outcome_unknown" : "busy"; }
      else if (await this.queued(conversationId)) result.blocked = "queued";
      return historySnapshotSchema.parse(result);
    });
  }
  async anchors(userId: string, botId: string, conversationId: string, input: { messageId?: string; cursor?: string }, validate?: TransactionGuard) {
    await this.store.db.serial(async () => { await validate?.(); await this.authorizeInTransaction(userId, botId, conversationId); });
    const snapshot = await this.internalSnapshot(userId, botId, conversationId);
    return this.store.db.serial(async () => {
      await validate?.(); await this.authorizeInTransaction(userId, botId, conversationId);
      if (!snapshot.supported || !snapshot.bindingGeneration || !snapshot.sourceSessionId) return { anchors: [] };
      const rows = await this.store.db.all<AnchorRow>(`SELECT a.*,m.rowid AS message_rowid FROM history_anchors a JOIN messages m ON m.id=a.message_id WHERE a.bot_id=? AND a.conversation_id=? AND a.generation=? AND a.session_id=? AND m.status!='deleted' AND m.history_json IS NULL AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=m.id AND d.user_id=?) ${input.messageId ? "AND a.message_id=?" : "AND a.id>?"} ORDER BY a.id LIMIT 101`, [botId, conversationId, snapshot.bindingGeneration, snapshot.sourceSessionId, userId, input.messageId ?? input.cursor ?? ""]);
      return historyAnchorPageSchema.parse({ anchors: rows.slice(0, 100).map(row => {
        const evidence = historyAnchorEvidenceSchema.parse(JSON.parse(row.evidence_json));
        const native = z.object({ rewind: z.boolean(), fork: z.boolean(), forkBoundary: z.enum(["before-input", "after-turn"]).optional() }).passthrough().safeParse(evidence.nativeAnchor);
        const boundary = native.success && native.data.fork ? native.data.forkBoundary : undefined;
        return { id: row.id, messageId: row.message_id, rewind: !!snapshot.capabilities?.rewind && native.success && native.data.rewind === true, fork: !!snapshot.capabilities?.anchoredFork && !!boundary, ...(boundary ? { forkBoundary: boundary } : {}) };
      }), ...(rows.length > 100 ? { next: rows[99]!.id } : {}) });
    });
  }
  async recordAnchor(botId: string, raw: unknown): Promise<void> {
    const input = historyAnchorEvidenceSchema.parse(raw);
    await this.store.db.transaction(async () => {
      await this.store.requireBot(botId, input.conversationId);
      const message = await this.store.db.get<{ author_id: string; author_type: string; bot_source_json: string | null; discussion_json: string | null; conversation_id: string }>("SELECT author_id,author_type,bot_source_json,discussion_json,conversation_id FROM messages WHERE id=?", [input.messageId]);
      if (!message || message.conversation_id !== input.conversationId || message.author_type !== "user" || message.bot_source_json || message.discussion_json) throw new HubError("history_anchor_forbidden", 403);
      await this.authorizeInTransaction(message.author_id, botId, input.conversationId);
      if (!await this.store.db.get("SELECT 1 FROM deliveries WHERE message_id=? AND bot_id=? AND dispatched=1", [input.messageId, botId])) throw new HubError("history_anchor_unadmitted", 409);
      const old = await this.store.db.get<{ evidence_json: string }>("SELECT evidence_json FROM history_anchors WHERE bot_id=? AND message_id=? AND generation=?", [botId, input.messageId, input.bindingGeneration]);
      if (old) { if (old.evidence_json !== JSON.stringify(input)) throw new HubError("history_anchor_conflict", 409); return; }
      await this.store.db.run("INSERT INTO history_anchors VALUES(?,?,?,?,?,?,?,?,?)", [newId("anchor"), botId, input.conversationId, input.messageId, input.bindingGeneration, input.revision, input.sessionId, JSON.stringify(input), Date.now()]);
    });
  }
  private async queued(conversationId: string): Promise<boolean> {
    return !!await this.store.db.get(`SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE m.conversation_id=? AND d.status='pending'
      UNION ALL SELECT 1 FROM action_deliveries WHERE conversation_id=? AND status='pending'
      UNION ALL SELECT 1 FROM messages m JOIN json_each(m.blocks_json) b WHERE m.conversation_id=?
        AND json_extract(b.value,'$.type')='steering' AND json_extract(b.value,'$.mode')='message'
        AND json_extract(b.value,'$.outcome')!='rejected' AND json_extract(b.value,'$.nativeInput.state') IN ('queued','dequeued') LIMIT 1`, [conversationId, conversationId, conversationId]);
  }
  async start(userId: string, conversationId: string, raw: unknown, validate?: TransactionGuard): Promise<HistoryOperation> {
    const input = historyChangeSchema.parse(raw), hash = fingerprint([userId, conversationId, input]);
    const reservation = await this.store.db.transaction(async () => {
      await validate?.(); await this.authorizeInTransaction(userId, input.botId, conversationId);
      const old = await this.store.db.get<OperationRow>("SELECT * FROM history_operations WHERE owner_id=? AND request_id=?", [userId, input.requestId]);
      if (old) { if (old.payload_hash !== hash) throw new HubError("history_request_conflict", 409); return { row: old, fresh: false }; }
      let reason: HistoryOperation["reason"];
      if (this.host.available(input.botId) !== "ready") reason = this.host.available(input.botId) === "unsupported" ? "unsupported" : "not_ready";
      else if (await this.pending(conversationId)) reason = "busy";
      else if (await this.queued(conversationId)) reason = "queued";
      else if (this.host.busy(input.botId, conversationId)) reason = "busy";
      let anchor: HistoryAnchorEvidence | undefined;
      if ("anchorId" in input.action) {
        const row = await this.store.db.get<AnchorRow>("SELECT a.*,m.rowid AS message_rowid FROM history_anchors a JOIN messages m ON m.id=a.message_id WHERE a.id=? AND a.bot_id=? AND a.conversation_id=? AND m.status!='deleted' AND m.history_json IS NULL AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=m.id AND d.user_id=?)", [input.action.anchorId, input.botId, conversationId, userId]);
        if (!row) reason ??= "anchor_unavailable"; else anchor = historyAnchorEvidenceSchema.parse(JSON.parse(row.evidence_json));
      }
      const id = newId("history"), result: HistoryOperation = { requestId: input.requestId, operationId: id, sourceRevision: input.expectedRevision, state: reason ? "rejected" : "pending", ...(reason ? { reason } : {}) };
      await this.store.db.run("INSERT INTO history_operations(id,owner_id,request_id,payload_hash,bot_id,source_conversation_id,expected_revision,action_json,anchor_json,state,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [id, userId, input.requestId, hash, input.botId, conversationId, input.expectedRevision, JSON.stringify(input.action), anchor ? JSON.stringify(anchor) : null, reason ? "rejected" : "dispatched", JSON.stringify(result), Date.now(), Date.now()]);
      return { row: (await this.row(id))!, fresh: !reason };
    });
    if (reservation.fresh) {
      try {
        const nativeResult = historyNativeResultSchema.parse(await this.host.call(input.botId, "history.apply", this.workerInput(reservation.row)));
        await this.acceptResult(input.botId, { operationId: reservation.row.id, result: nativeResult });
        await this.finish(reservation.row.id);
      } catch { await this.markUnknown(reservation.row.id); }
    }
    return this.status(userId, input.botId, conversationId, input.requestId, validate);
  }
  private workerInput(row: OperationRow) {
    const anchor = row.anchor_json ? historyAnchorEvidenceSchema.parse(JSON.parse(row.anchor_json)) : undefined;
    return { userId: row.owner_id, botId: row.bot_id, conversationId: row.source_conversation_id, operationId: row.id, expectedRevision: row.expected_revision, action: historyActionSchema.parse(JSON.parse(row.action_json)), ...(anchor ? { nativeAnchor: anchor.nativeAnchor, anchorGeneration: anchor.bindingGeneration, anchorSessionId: anchor.sessionId } : {}) };
  }
  async status(userId: string, botId: string, conversationId: string, requestId: string, validate?: TransactionGuard): Promise<HistoryOperation> {
    return this.store.db.serial(async () => {
      await validate?.(); await this.authorizeInTransaction(userId, botId, conversationId);
      const row = await this.store.db.get<OperationRow>("SELECT * FROM history_operations WHERE owner_id=? AND request_id=? AND bot_id=? AND source_conversation_id=?", [userId, requestId, botId, conversationId]);
      if (!row) throw new HubError("history_operation_not_found", 404); return publicResult(row);
    });
  }
  /** Explicit reconciliation never invokes native apply. A missing request is
   * tombstoned atomically, so even an original POST still in transit cannot run. */
  async reconcile(userId: string, conversationId: string, raw: unknown, validate?: TransactionGuard): Promise<HistoryOperation> {
    const input = historyChangeSchema.parse(raw), hash = fingerprint([userId, conversationId, input]);
    const row = await this.store.db.transaction(async () => {
      await validate?.(); await this.authorizeInTransaction(userId, input.botId, conversationId);
      const old = await this.store.db.get<OperationRow>("SELECT * FROM history_operations WHERE owner_id=? AND request_id=?", [userId, input.requestId]);
      if (old) { if (old.payload_hash !== hash) throw new HubError("history_request_conflict", 409); return old; }
      const id = newId("history"), result: HistoryOperation = { requestId: input.requestId, operationId: id, sourceRevision: input.expectedRevision, state: "rejected", reason: "cancelled" };
      await this.store.db.run("INSERT INTO history_operations(id,owner_id,request_id,payload_hash,bot_id,source_conversation_id,expected_revision,action_json,state,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [id, userId, input.requestId, hash, input.botId, conversationId, input.expectedRevision, JSON.stringify(input.action), "rejected", JSON.stringify(result), Date.now(), Date.now()]);
      return (await this.row(id))!;
    });
    if (!["applied", "rejected"].includes(row.state) && this.host.available(row.bot_id) === "ready") await this.reconcileRow(row, true);
    return this.status(userId, input.botId, conversationId, input.requestId, validate);
  }
  async acceptResult(botId: string, raw: unknown): Promise<string> {
    const input = z.object({ operationId: idSchema, result: historyNativeResultSchema }).strict().parse(raw);
    await this.store.db.transaction(async () => {
      const row = await this.row(input.operationId);
      if (!row || row.bot_id !== botId) throw new HubError("history_operation_forbidden", 403);
      if (row.native_result_json && row.native_result_json !== JSON.stringify(input.result)) throw new HubError("history_result_conflict", 409);
      if (["applied", "rejected"].includes(row.state)) return;
      await this.store.db.run("UPDATE history_operations SET native_result_json=?,updated_at=? WHERE id=?", [JSON.stringify(input.result), Date.now(), row.id]);
    });
    return input.operationId;
  }
  private async markUnknown(id: string): Promise<void> {
    await this.store.db.transaction(async () => {
      const row = await this.row(id); if (!row || ["applied", "rejected"].includes(row.state)) return;
      await this.store.db.run("UPDATE history_operations SET state='unknown',result_json=?,updated_at=? WHERE id=?", [JSON.stringify({ ...publicResult(row), state: "unknown", reason: "uncertain" }), Date.now(), id]);
    });
  }
  finish(id: string): Promise<void> {
    const existing = this.finishing.get(id); if (existing) return existing;
    const task = this.finalize(id).catch(async () => { await this.markUnknown(id); });
    this.finishing.set(id, task); void task.finally(() => { if (this.finishing.get(id) === task) this.finishing.delete(id); }); return task;
  }
  private async finalize(id: string): Promise<void> {
    let row = await this.store.db.serial(() => this.row(id)); if (!row || ["applied", "rejected"].includes(row.state) || !row.native_result_json) return;
    const result = historyNativeResultSchema.parse(JSON.parse(row.native_result_json));
    if (result.outcome === "unknown" || result.outcome === "applied" && (!result.sourceSessionId || JSON.parse(row.action_json).kind === "rewind" && !result.excludedNativeInputIds)) { await this.markUnknown(id); return; }
    const action = historyActionSchema.parse(JSON.parse(row.action_json));
    if (action.kind === "rewind" && result.outcome === "applied") {
      const anchor = row.anchor_json ? historyAnchorEvidenceSchema.parse(JSON.parse(row.anchor_json)) : undefined;
      if (!anchor || result.sourceSessionId !== anchor.sessionId || !result.excludedNativeInputIds?.includes(anchor.nativeAnchor.inputId)) { await this.markUnknown(id); return; }
    }
    if (result.outcome === "applied" && action.kind === "fork") {
      if (!result.destinationSessionId || result.destinationSessionId === result.sourceSessionId || action.scope === "anchor" && !result.forkBoundary) { await this.markUnknown(id); return; }
      await this.store.db.transaction(async () => {
        row = (await this.row(id))!;
        if (row.destination_conversation_id) return;
        const source = await this.store.conversationInTransaction(row.source_conversation_id);
        // The App names its forks itself. A default here (CLI) matches the
        // App's Chinese default: Host-side text defaults to Chinese and
        // managed Bots are created with locale zh.
        const forks = action.title ? [] : await this.store.db.all<{ title: string }>("SELECT title FROM conversations WHERE json_extract(history_origin_json,'$.sourceConversationId')=?", [row.source_conversation_id]);
        const title = action.title ?? numberedForkTitle(`${source.title.slice(0, 230)} · 分叉`, forks.map(fork => fork.title));
        const destination = await this.store.createConversationInTransaction(row.owner_id, [row.bot_id], title, `fork_${id}`, { type: "direct" });
        const anchor = row.anchor_json ? historyAnchorEvidenceSchema.parse(JSON.parse(row.anchor_json)) : undefined;
        const origin = { operationId: id, sourceConversationId: row.source_conversation_id, sourceRevision: row.expected_revision, ...(anchor ? { sourceMessageId: anchor.messageId } : {}), boundary: action.scope === "whole" ? "whole" : result.forkBoundary ?? "before-input" };
        await this.store.db.run("UPDATE conversations SET history_origin_json=? WHERE id=?", [JSON.stringify(origin), destination.id]);
        await this.store.db.run("UPDATE history_operations SET destination_conversation_id=? WHERE id=?", [destination.id, id]);
        row.destination_conversation_id = destination.id;
      });
    }
    const finalized = z.object({ revision: idSchema }).strict().parse(await this.host.call(row.bot_id, "history.finalize", { ...this.workerInput(row), result, ...(row.destination_conversation_id ? { destinationConversationId: row.destination_conversation_id } : {}) }));
    const events: HubEvent[] = [];
    const changed = await this.store.db.transaction(async () => {
      const current = (await this.row(id))!; if (["applied", "rejected"].includes(current.state)) return;
      if (result.outcome === "applied" && action.kind === "rewind" && current.anchor_json) {
        const anchor = historyAnchorEvidenceSchema.parse(JSON.parse(current.anchor_json));
        const inputs = await this.store.db.all<{ message_id: string }>("SELECT a.message_id FROM history_anchors a JOIN messages m ON m.id=a.message_id WHERE a.bot_id=? AND a.conversation_id=? AND a.generation=? AND a.session_id=? AND json_extract(a.evidence_json,'$.nativeAnchor.inputId') IN (SELECT value FROM json_each(?)) AND m.history_json IS NULL", [current.bot_id, current.source_conversation_id, anchor.bindingGeneration, anchor.sessionId, JSON.stringify(result.excludedNativeInputIds)]);
        events.push(...await this.store.excludeHistoryMessagesInTransaction(current.source_conversation_id, inputs.map(input => input.message_id), id, current.bot_id));
        const event = await this.store.historyNoticeInTransaction(current.source_conversation_id, id, "模型上下文已回到所选消息之前；App 消息和文件仍保留。 Native context was rewound; App messages and files were retained."); if (event) events.push(event);
      }
      const operation: HistoryOperation = { ...publicResult(current), state: result.outcome === "applied" ? "applied" : "rejected", ...(result.reason ? { reason: result.reason } : { reason: undefined }), resultingRevision: finalized.revision, ...(events.length ? { sourceEventSeq: events[events.length - 1]!.seq } : {}), ...(result.outcome === "applied" && current.destination_conversation_id ? { destinationConversationId: current.destination_conversation_id } : {}) };
      await this.store.db.run("UPDATE history_operations SET state=?,result_json=?,updated_at=? WHERE id=?", [operation.state, JSON.stringify(operation), Date.now(), id]);
      if (current.destination_conversation_id && result.outcome === "applied") return this.store.conversationInTransaction(current.destination_conversation_id);
    });
    this.store.emitCommitted(events); if (changed) await this.host.changed(changed);
  }
  async recoverBot(botId: string): Promise<void> {
    const rows = await this.store.db.serial(() => this.store.db.all<OperationRow>("SELECT * FROM history_operations WHERE bot_id=? AND state NOT IN ('applied','rejected') ORDER BY created_at LIMIT 100", [botId]));
    for (const row of rows) await this.reconcileRow(row);
  }
  private async reconcileRow(row: OperationRow, preserveInFlight = false): Promise<void> {
    try {
      if (!row.native_result_json) {
        const receipt = z.object({ result: historyNativeResultSchema.optional() }).strict().parse(await this.host.call(row.bot_id, "history.receipt", this.workerInput(row)));
        if (receipt.result) await this.acceptResult(row.bot_id, { operationId: row.id, result: receipt.result });
        else {
          // An explicit check may race the still-running original POST before
          // its receipt is written. Do not revoke that original admission.
          if (!preserveInFlight || row.state !== "dispatched") await this.markUnknown(row.id);
          return;
        }
      }
      await this.finish(row.id);
    } catch { await this.markUnknown(row.id); }
  }
}
