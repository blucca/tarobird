import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HubConversationHistory } from "../src/hub/conversation-history.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import type { HistoryNativeResult } from "../src/client-protocol/conversation-history.js";
import type { SteeringApplication } from "../src/client-protocol/steering-outcome.js";

let directory: string, store: HubStore, history: HubConversationHistory, conversationId: string;
let result: HistoryNativeResult;
const changed = vi.fn(async () => {});
const call = vi.fn(async (_bot: string, method: string, _input: unknown): Promise<any> => {
  if (method === "history.snapshot") return { supported: true, revision: "revision", bindingGeneration: "generation", sourceSessionId: "native_source", capabilities: { rewind: true, fork: true, anchoredFork: true } };
  if (method === "history.apply") return result;
  if (method === "history.receipt") return { result };
  if (method === "history.finalize") return { revision: "next_revision" };
  throw new Error(method);
});
const host = { available: () => "ready" as const, busy: () => false, call, changed };
beforeEach(async () => {
  vi.clearAllMocks(); directory = await mkdtemp(path.join(os.tmpdir(), "tarobird-history-")); store = await HubStore.open(directory);
  await store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Fixture','unused','codex')");
  conversationId = (await store.createConversation("owner", ["bot"], "Source", "create")).id;
  history = new HubConversationHistory(store, host);
  result = { outcome: "applied", sourceSessionId: "native_source", destinationSessionId: "native_fork", forkBoundary: "after-turn" };
});
afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });
const change = (requestId = "request") => ({ botId: "bot", requestId, expectedRevision: "revision", action: { kind: "fork" as const, scope: "whole" as const } });
async function anchor(name: string) {
  const { message } = await store.sendMessage("owner", { conversationId, clientMsgId: name, text: name, attachments: [] });
  await store.db.run("UPDATE deliveries SET dispatched=1,status='delivered' WHERE message_id=?", [message.id]);
  await history.recordAnchor("bot", { conversationId, messageId: message.id, sessionId: "native_source", bindingGeneration: "generation", revision: "revision", nativeAnchor: { sessionId: "native_source", inputId: name, rewind: true, fork: true, forkBoundary: "after-turn" } });
  const row = await store.db.get<{ id: string }>("SELECT id FROM history_anchors WHERE message_id=?", [message.id]);
  return { message, id: row!.id };
}
it("creates one persistent fork and never copies messages or changes the source binding", async () => {
  const before = await store.conversationForBot("bot", conversationId);
  await anchor("input");
  const first = await history.start("owner", conversationId, change());
  expect(first.state).toBe("applied"); expect(first.destinationConversationId).toBeTruthy();
  expect(await history.start("owner", conversationId, change())).toEqual(first);
  expect(call.mock.calls.filter(([, method]) => method === "history.apply")).toHaveLength(1);
  const destination = await store.conversationForBot("bot", first.destinationConversationId!);
  expect(destination.historyOrigin).toMatchObject({ operationId: first.operationId, sourceConversationId: conversationId, boundary: "whole" });
  expect(await store.db.get("SELECT 1 FROM messages WHERE conversation_id=?", [destination.id])).toBeUndefined();
  expect(await store.conversationForBot("bot", conversationId)).toEqual(before);
  expect(changed).toHaveBeenCalledOnce();
});
it("reserves complete request identity, including after a definite rejection", async () => {
  const queued = await store.sendMessage("owner", { conversationId, clientMsgId: "queue", text: "wait", attachments: [] });
  await store.db.run("UPDATE deliveries SET queue_paused=1 WHERE message_id=?", [queued.message.id]);
  expect(await history.start("owner", conversationId, change())).toMatchObject({ state: "rejected", reason: "queued" });
  await store.db.run("UPDATE deliveries SET status='cancelled'");
  expect(await history.start("owner", conversationId, change())).toMatchObject({ state: "rejected", reason: "queued" });
  await expect(history.start("owner", conversationId, { ...change(), expectedRevision: "other" })).rejects.toThrow("history_request_conflict");
  expect(call).not.toHaveBeenCalled();
});
it("blocks a native input still queued after its HTTP admission returned", async () => {
  const input = await store.beginSteering("owner", { conversationId, botId: "bot", requestId: "input", targetId: "native_run", text: "queued input", mode: "message" });
  await store.finishSteering(input.id, { outcome: "accepted" });
  await store.applyNativeInputProgress("bot", { conversationId, userId: "owner", requestId: "input", targetId: "native_run", progress: { state: "queued" } });
  expect(await history.start("owner", conversationId, change())).toMatchObject({ state: "rejected", reason: "queued" });
  expect(call).not.toHaveBeenCalled();
  await store.applyNativeInputProgress("bot", { conversationId, userId: "owner", requestId: "input", targetId: "native_run", progress: { state: "cancelled" } });
  expect(await history.start("owner", conversationId, change("after_cancel"))).toMatchObject({ state: "applied" });
});
it("fences sends, bindings, actions and queue claims while native outcome is unknown", async () => {
  result = { outcome: "unknown", reason: "uncertain" };
  const operation = await history.start("owner", conversationId, change());
  expect(operation.state).toBe("unknown");
  await expect(store.sendMessage("owner", { conversationId, clientMsgId: "later", text: "later", attachments: [] })).rejects.toThrow("history_operation_pending");
  await expect(store.updateConversation("owner", conversationId, { sessionId: "another" })).rejects.toThrow("history_operation_pending");
  await expect(store.enqueueAction("owner", "action", {}, "bot", conversationId, {})).rejects.toThrow("history_operation_pending");
  expect(await new HubPromptQueue(store).take("bot", conversationId, () => true)).toBeUndefined();
  const before = call.mock.calls.length;
  expect(await history.status("owner", "bot", conversationId, "request")).toEqual(operation);
  expect(call.mock.calls).toHaveLength(before);
  expect(await history.snapshot("owner", "bot", conversationId)).toMatchObject({ pendingOperation: "request", blocked: "outcome_unknown" });
});
it("marks only exact native-excluded inputs and their replies, retaining all bodies", async () => {
  const one = await anchor("native_one"), two = await anchor("native_two"), unrelated = await anchor("native_other_branch");
  const reply = await store.publishBotMessage("bot", { conversationId, blocks: [{ type: "text", text: "kept reply" }], replyTo: two.message.id });
  result = { outcome: "applied", sourceSessionId: "native_source", excludedNativeInputIds: ["native_two"] };
  const operation = await history.start("owner", conversationId, { ...change(), action: { kind: "rewind", anchorId: two.id } });
  expect(operation.state).toBe("applied");
  expect((await store.messageForBot("bot", one.message.id)).historyContext).toBeUndefined();
  expect((await store.messageForBot("bot", unrelated.message.id)).historyContext).toBeUndefined();
  expect(await store.messageForBot("bot", two.message.id)).toMatchObject({ historyContext: { excludedBy: operation.operationId }, blocks: [{ type: "text", text: "native_two" }] });
  expect((await store.messageForBot("bot", reply.id)).historyContext).toEqual({ excludedBy: operation.operationId });
});
it("marks only accepted or adopted inputs linked to an exact excluded native turn", async () => {
  const point = await anchor("native_turn"), other = await anchor("unrelated_turn");
  const cases: Array<{ name: string; outcome: "accepted" | "pending" | "unknown"; mode?: "message"; application?: SteeringApplication; received?: boolean; excluded: boolean }> = [
    { name: "accepted", outcome: "accepted", excluded: true },
    { name: "adopted", outcome: "unknown", application: { status: "applied", via: "fold" }, excluded: true },
    { name: "received", outcome: "accepted", mode: "message", received: true, excluded: true },
    { name: "pending", outcome: "pending", excluded: false },
    { name: "unknown", outcome: "unknown", excluded: false },
    { name: "dropped", outcome: "accepted", application: { status: "dropped", reason: "stopped" }, excluded: false },
    { name: "native_admission_only", outcome: "accepted", mode: "message", excluded: false },
    { name: "unrelated", outcome: "accepted", excluded: false },
  ];
  const messages: Array<{ id: string; excluded: boolean }> = [];
  for (const item of cases) {
    const input = { conversationId, botId: "bot", requestId: item.name, targetId: "run", text: item.name, ...(item.mode ? { mode: item.mode } : {}) };
    const message = await store.beginSteering("owner", input);
    if (item.outcome !== "pending") await store.finishSteering(message.id, { outcome: item.outcome });
    if (item.application) await store.applySteeringOutcome("bot", { conversationId, userId: "owner", requestId: item.name, targetId: "run", application: item.application });
    if (item.received) await store.applyNativeInputProgress("bot", { conversationId, userId: "owner", requestId: item.name, targetId: "run", progress: { state: "received" } });
    await store.bindRunInput(item.name === "unrelated" ? other.message.id : point.message.id, message.id);
    messages.push({ id: message.id, excluded: item.excluded });
  }
  const reply = await store.publishBotMessage("bot", { conversationId, blocks: [{ type: "text", text: "steer reply" }], replyTo: messages[0]!.id });
  result = { outcome: "applied", sourceSessionId: "native_source", excludedNativeInputIds: ["native_turn"] };
  const operation = await history.start("owner", conversationId, { ...change(), action: { kind: "rewind", anchorId: point.id } });
  expect(operation.state).toBe("applied");
  for (const message of messages) expect((await store.messageForBot("bot", message.id)).historyContext?.excludedBy, message.id).toBe(message.excluded ? operation.operationId : undefined);
  expect((await store.messageForBot("bot", reply.id)).historyContext?.excludedBy).toBe(operation.operationId);
});
it("does not guess exclusions when an applied rewind omits exact native IDs", async () => {
  const point = await anchor("native_one"); result = { outcome: "applied", sourceSessionId: "native_source" };
  expect(await history.start("owner", conversationId, { ...change(), action: { kind: "rewind", anchorId: point.id } })).toMatchObject({ state: "unknown" });
  expect((await store.messageForBot("bot", point.message.id)).historyContext).toBeUndefined();
  expect(call.mock.calls.filter(([, method]) => method === "history.finalize")).toHaveLength(0);
});
it("rejects fresh card actions from excluded messages after the operation fence clears", async () => {
  const point = await anchor("native_one");
  const card = await store.publishBotMessage("bot", { conversationId, replyTo: point.message.id, blocks: [{ type: "text", text: "old control" }] });
  result = { outcome: "applied", sourceSessionId: "native_source", excludedNativeInputIds: ["native_one"] };
  expect(await history.start("owner", conversationId, { ...change(), action: { kind: "rewind", anchorId: point.id } })).toMatchObject({ state: "applied" });
  await expect(store.enqueueAction("owner", "stale_action", {}, "bot", conversationId, { messageId: card.id })).rejects.toThrow("history_message_excluded");
  expect(await store.pendingActions("bot")).toEqual([]);
});
it("rejects excluded steering retries and native input controls", async () => {
  const input = { conversationId, botId: "bot", requestId: "native_input", targetId: "old_run", text: "old input", mode: "message" as const };
  const message = await store.beginSteering("owner", input);
  await store.db.transaction(() => store.excludeHistoryMessagesInTransaction(conversationId, [message.id], "rewind", "bot"));
  await expect(store.beginSteering("owner", input)).rejects.toThrow("history_message_excluded");
  await expect(store.nativeInputForControl("owner", conversationId, message.id)).rejects.toThrow("history_message_excluded");
});
it("rejects foreign anchors, groups and nonowners before native mutation", async () => {
  expect(await history.start("owner", conversationId, { ...change(), action: { kind: "rewind", anchorId: "foreign" } })).toMatchObject({ state: "rejected", reason: "anchor_unavailable" });
  await store.db.run("UPDATE conversations SET type='group' WHERE id=?", [conversationId]);
  await expect(history.start("owner", conversationId, change("group"))).rejects.toThrow("history_wrong_scope");
  await store.db.run("UPDATE users SET role='member' WHERE id='owner'");
  await expect(history.status("owner", "bot", conversationId, "request")).rejects.toThrow("owner_required");
  expect(call).not.toHaveBeenCalled();
});
it("returns only an exact requested anchor and strips private native state from snapshot", async () => {
  await anchor("one"); const two = await anchor("two");
  expect(await history.anchors("owner", "bot", conversationId, { messageId: two.message.id })).toEqual({ anchors: [{ id: two.id, messageId: two.message.id, rewind: true, fork: true, forkBoundary: "after-turn" }] });
  expect(await history.snapshot("owner", "bot", conversationId)).not.toHaveProperty("sourceSessionId");
  expect(await history.snapshot("owner", "bot", conversationId)).not.toHaveProperty("bindingGeneration");
});
it("recovers a lost response with receipt inspection and local finalization only", async () => {
  call.mockImplementationOnce(async () => { throw new Error("disconnected_after_native_call"); });
  expect(await history.start("owner", conversationId, change())).toMatchObject({ state: "unknown" });
  const restarted = new HubConversationHistory(store, host);
  await restarted.recoverBot("bot");
  expect(await restarted.status("owner", "bot", conversationId, "request")).toMatchObject({ state: "applied" });
  expect(call.mock.calls.filter(([, method]) => method === "history.apply")).toHaveLength(1);
  expect(call.mock.calls.filter(([, method]) => method === "history.receipt")).toHaveLength(1);
});
it("reserves before native await so duplicate clicks join the durable identity and new sends fail", async () => {
  let release!: (value: HistoryNativeResult) => void;
  call.mockImplementationOnce(async () => new Promise(resolve => { release = resolve; }));
  const first = history.start("owner", conversationId, change());
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(release).toBeTypeOf("function");
  expect(await history.start("owner", conversationId, change())).toMatchObject({ state: "pending" });
  call.mockImplementationOnce(async () => ({}));
  expect(await history.reconcile("owner", conversationId, change())).toMatchObject({ state: "pending" });
  expect(await history.authorizeWorker("bot", { userId: "owner", conversationId, operationId: (await history.status("owner", "bot", conversationId, "request")).operationId, purpose: "apply" })).toEqual({ allowed: true });
  await expect(store.sendMessage("owner", { conversationId, clientMsgId: "racing_send", text: "later", attachments: [] })).rejects.toThrow("history_operation_pending");
  release(result); expect(await first).toMatchObject({ state: "applied" });
  expect(call.mock.calls.filter(([, method]) => method === "history.apply")).toHaveLength(1);
});
it("reconciles a never-admitted request with a tombstone that rejects a delayed original POST", async () => {
  const cancelled = await history.reconcile("owner", conversationId, change());
  expect(cancelled).toMatchObject({ state: "rejected", reason: "cancelled" });
  expect(await history.start("owner", conversationId, change())).toEqual(cancelled);
  await expect(history.reconcile("owner", conversationId, { ...change(), expectedRevision: "changed" })).rejects.toThrow("history_request_conflict");
  expect(call).not.toHaveBeenCalled();
});
it("reconciles a durable result after temporary local finalization failure without another native apply", async () => {
  call.mockImplementationOnce(async () => result).mockImplementationOnce(async () => { throw new Error("temporary_local_failure"); });
  expect(await history.start("owner", conversationId, change())).toMatchObject({ state: "unknown" });
  expect(await history.reconcile("owner", conversationId, change())).toMatchObject({ state: "applied" });
  expect(call.mock.calls.filter(([, method]) => method === "history.apply")).toHaveLength(1);
  expect(call.mock.calls.filter(([, method]) => method === "history.finalize")).toHaveLength(2);
});
it("numbers default fork titles per source and keeps an explicit title as given", async () => {
  const title = async (requestId: string, action: Record<string, unknown> = { kind: "fork", scope: "whole" }) => {
    result = { outcome: "applied", sourceSessionId: "native_source", destinationSessionId: `native_${requestId}` };
    const operation = await history.start("owner", conversationId, { ...change(requestId), action: action as any });
    expect(operation.state).toBe("applied");
    return (await store.conversationForBot("bot", operation.destinationConversationId!)).title;
  };
  expect(await title("first")).toBe("Source · 分叉");
  expect(await title("second")).toBe("Source · 分叉 2");
  expect(await title("named", { kind: "fork", scope: "whole", title: "My branch" })).toBe("My branch");
  expect(await title("third")).toBe("Source · 分叉 3");
});
