import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/state/session-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const source = { telegramChatId: 7, conversationKey: "lark:source", codexSessionId: "native-source", status: "idle" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-state-")); roots.push(root);
  const file = path.join(root, "session.json"), store = new SessionStore(file);
  await store.upsert(source);
  return { store, second: new SessionStore(file) };
}

describe("durable native history binding", () => {
  it("retains explicit reset recovery for corrupt session files", async () => {
    const { store } = await fixture();
    await writeFile(store.filePath, "{invalid json", "utf8");
    await store.reset();
    expect((await store.load()).chats).toEqual([]);
  });
  it("enrolls legacy bindings once, then persists revisions across store instances", async () => {
    const { store, second } = await fixture();
    const initial = await store.inspectHistory(source.conversationKey);
    expect(initial?.record.historyRevision).toMatch(/^[a-f0-9-]+$/);
    expect(await second.inspectHistory(source.conversationKey)).toEqual(initial);
    await second.upsert({ ...source });
    const next = await store.inspectHistory(source.conversationKey);
    expect(next?.record.historyGeneration).toBe(initial?.record.historyGeneration);
    expect(next?.record.historyRevision).not.toBe(initial?.record.historyRevision);
  });

  it("rejects ABA revisions even when timestamps and final native ID match", async () => {
    const { store } = await fixture();
    const before = (await store.inspectHistory(source.conversationKey))!;
    await store.upsert({ ...source, codexSessionId: "other" }); await store.upsert(source);
    const after = (await store.inspectHistory(source.conversationKey))!;
    expect(after.record.historyGeneration).not.toBe(before.record.historyGeneration);
    await expect(store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1")).rejects.toThrow("history_source_changed");
  });

  it("fences all binding replacement and removal paths across restart until a definite outcome", async () => {
    const { store, second } = await fixture();
    const before = (await store.inspectHistory(source.conversationKey))!;
    await store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1");
    for (const change of [() => second.upsert(source), () => second.upsert({ ...source, conversationKey: "lark:alias", telegramChatId: 9 }), () => second.removeByConversationKey(source.conversationKey), () => second.removeByChatId(7), () => second.clearAll(), () => second.clearAllThen(async () => null), () => second.reset()]) {
      await expect(change()).rejects.toThrow("history_outcome_pending");
    }
    expect((await second.inspectHistory(source.conversationKey))?.record.historyFence?.operationId).toBe("op1");
    await expect(second.releaseHistory(source.conversationKey, "wrong")).rejects.toThrow("history_source_changed");
    await second.releaseHistory(source.conversationKey, "op1");
    await second.releaseHistory(source.conversationKey, "op1");
    expect((await store.inspectHistory(source.conversationKey))?.record.historyRevision).toBe(before.record.historyRevision);
    await second.upsert({ ...source, codexSessionId: "allowed" });
  });

  it("refuses shared native bindings and catches a second binding added before reservation", async () => {
    const { store, second } = await fixture();
    const before = (await store.inspectHistory(source.conversationKey))!;
    await second.upsert({ ...source, conversationKey: "lark:alias", telegramChatId: 8 });
    expect((await store.inspectHistory(source.conversationKey))?.shared).toBe(true);
    await expect(store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1")).rejects.toThrow("history_shared_session");
  });

  it("commits a fork binding atomically without replacing the source, and reconciles identical finalization", async () => {
    const { store, second } = await fixture();
    const before = (await store.inspectHistory(source.conversationKey))!;
    await store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1");
    const input = { operationId: "op1", destination: { ...source, conversationKey: "lark:fork", telegramChatId: 9, codexSessionId: "native-fork" } };
    const result = await store.finalizeHistory(source.conversationKey, input);
    expect(await second.finalizeHistory(source.conversationKey, input)).toEqual(result);
    expect((await store.findByConversationKey(source.conversationKey))?.codexSessionId).toBe(source.codexSessionId);
    expect((await store.findByConversationKey("lark:fork"))?.codexSessionId).toBe("native-fork");
    expect((await store.load()).chats).toHaveLength(2);
    await expect(second.finalizeHistory(source.conversationKey, { ...input, destination: { ...input.destination, codexSessionId: "wrong" } })).rejects.toThrow("history_request_conflict");
  });

  it("refuses a preexisting fork destination without clearing the source fence", async () => {
    const { store } = await fixture();
    const before = (await store.inspectHistory(source.conversationKey))!;
    await store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1");
    const destination = { ...source, conversationKey: "lark:destination", codexSessionId: "occupied", telegramChatId: 9 };
    await store.upsert(destination);
    await expect(store.finalizeHistory(source.conversationKey, { operationId: "op1", destination: { ...destination, codexSessionId: "new" } })).rejects.toThrow("history_destination_exists");
    expect((await store.findByConversationKey(source.conversationKey))?.historyFence?.operationId).toBe("op1");
  });

  it("refuses a native destination that is already bound to another conversation", async () => {
    const { store } = await fixture();
    const before = (await store.inspectHistory(source.conversationKey))!;
    await store.upsert({ ...source, conversationKey: "lark:unrelated", codexSessionId: "already-bound", telegramChatId: 9 });
    await store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1");
    await expect(store.finalizeHistory(source.conversationKey, { operationId: "op1", destination: {
      ...source, conversationKey: "lark:fork", codexSessionId: "already-bound", telegramChatId: 10,
    } })).rejects.toThrow("history_destination_exists");
    expect((await store.findByConversationKey(source.conversationKey))?.historyFence?.operationId).toBe("op1");
  });

  it("advances context revision for confirmed rewind while retaining generation and resume metadata", async () => {
    const { store } = await fixture();
    const resume = { sessionId: source.codexSessionId, workspacePath: "/fixture/workspace", dirName: "fixture" };
    await store.upsert({ ...source, resume });
    const before = (await store.inspectHistory(source.conversationKey))!;
    await store.reserveHistory(source.conversationKey, before.record.historyRevision!, "op1");
    await store.finalizeHistory(source.conversationKey, { operationId: "op1", rewind: true });
    const after = (await store.inspectHistory(source.conversationKey))!;
    expect(after.record.historyGeneration).toBe(before.record.historyGeneration);
    expect(after.record.historyRevision).not.toBe(before.record.historyRevision);
    expect(after.record.resume).toEqual(resume);
    expect(after.record.historyFence).toBeUndefined();
  });
});
