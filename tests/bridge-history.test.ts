import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter, CodexUserMessageInput, EngineStreamEvent } from "../src/codex/adapter.js";
import { createRunRecord, recordRunEvent } from "../src/core/run-record.js";
import { applyCoreEngineEvent } from "../src/core/card-renderer.js";
import { Bridge, HistoryOperationBusyError, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { shouldPersistEngineTimelineEvent } from "../src/runtime/timeline-events.js";
import { bridgeConversationLockId, sessionLockNamespace, withBridgeTurnLock } from "../src/runtime/turn-lock.js";
import { SessionStore } from "../src/state/session-store.js";

// Synthetic ids and text only; the adapter is a stub.
const access = { load: vi.fn(), issuePairingCode: vi.fn() } as unknown as AccessStoreLike;

describe("Bridge history plumbing (#53)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "bridge-history-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("consumes turn anchors and passes the Hub id to the original input only", async () => {
    const sent: CodexUserMessageInput[] = [];
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn(async (_sessionId: string, input: CodexUserMessageInput) => {
      sent.push(input);
      await input.onEngineEvent?.({ type: "turn_anchor", sessionId: "thr-1", turnId: "t1" });
      await input.onEngineEvent?.({ type: "assistant_text", text: "hi" });
      return { text: "hi", sessionId: "thr-1" };
    }) };
    const sessions = new SessionManager(new SessionStore(path.join(root, "session.json")), adapter);
    const bridge = new Bridge(access, sessions, adapter).createAuthenticatedSurface();
    const events: EngineStreamEvent[] = [];
    const anchors = vi.fn();
    await bridge.handleAuthorizedMessage({ chatId: 1, userId: 2, chatType: "bus", conversationKey: "lark:gw_chat", text: "hello", files: [],
      sourceMessageId: "msg_a", onTurnAnchor: anchors, onEngineEvent: (event) => { events.push(event); } });
    expect(sent[0]!.sourceMessageId).toBe("msg_a");
    expect(anchors).toHaveBeenCalledWith({ sessionId: "thr-1", turnId: "t1" });
    expect(events.map(event => event.type)).toEqual(["assistant_text"]);

    // A ledger observer that throws never fails the turn.
    await expect(bridge.handleAuthorizedMessage({ chatId: 1, userId: 2, chatType: "bus", conversationKey: "lark:gw_chat", text: "again", files: [],
      onTurnAnchor: () => { throw new Error("disk full"); } })).resolves.toMatchObject({ text: "hi" });
    expect(sent[1]).not.toHaveProperty("sourceMessageId");
  });

  it("keeps turn anchors off the card, the run record and the timeline", () => {
    const anchor: EngineStreamEvent = { type: "turn_anchor", sessionId: "thr-1", turnId: "t1" };
    const record = createRunRecord();
    recordRunEvent(record, anchor);
    expect(record).toMatchObject({ revision: 0, entries: [] });
    expect(shouldPersistEngineTimelineEvent(anchor)).toBe(false);
    const state = { blocks: [], reasoning: { active: false } } as unknown as Parameters<typeof applyCoreEngineEvent>[0];
    expect(applyCoreEngineEvent(state, anchor)).toBe(state);
  });

  it("takes both locks without queueing and reports a held one as busy", async () => {
    const file = path.join(root, "session.json");
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn() };
    const manager = new SessionManager(new SessionStore(file), adapter);
    const bridge = new Bridge(access, manager, adapter).createAuthenticatedSurface();
    const scope = { chatId: 7, userId: 2, chatType: "bus", conversationKey: `lark:gw_${randomUUID().slice(0, 8)}` };
    const sessionId = `thr-${randomUUID()}`;
    expect(await bridge.withHistoryLocks(scope, async (session) => session)).toBeNull();
    await manager.bindSession(scope, sessionId);
    expect(await bridge.withHistoryLocks(scope, async (session) => session)).toEqual({ sessionId });

    const conversationLock = bridgeConversationLockId(scope, await sessionLockNamespace(file));
    for (const lockId of [conversationLock, sessionId]) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const holder = withBridgeTurnLock(lockId, async () => { entered(); await held; });
      await inside;
      const started = Date.now();
      const task = vi.fn();
      await expect(bridge.withHistoryLocks(scope, task)).rejects.toBeInstanceOf(HistoryOperationBusyError);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(task).not.toHaveBeenCalled();
      release(); await holder;
    }
  });

  it("writes a forked session as the new conversation's first binding, with the carried workspace", async () => {
    const file = path.join(root, "session.json");
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn() };
    const store = new SessionStore(file);
    const bridge = new Bridge(access, new SessionManager(store, adapter), adapter).createAuthenticatedSurface();
    const target = { chatId: 9, userId: 2, chatType: "bus", conversationKey: "lark:gw_target" };
    await bridge.bindForkedHistorySession(target, "thr-fork", { resume: { sessionId: "thr-fork", dirName: "proj", workspacePath: "/tmp/history-workspace" } });
    expect(await store.findByConversationKey("lark:gw_target")).toMatchObject({ codexSessionId: "thr-fork", resume: { workspacePath: "/tmp/history-workspace" } });
    await expect(bridge.bindForkedHistorySession(target, "thr-other")).rejects.toThrow("history_target_bound");
    expect((await store.findByConversationKey("lark:gw_target"))?.codexSessionId).toBe("thr-fork");
  });

  it("reports no support for an adapter without history methods", async () => {
    await writeFile(path.join(root, "session.json"), JSON.stringify({ chats: [] }));
    const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn() };
    const bridge = new Bridge(access, new SessionManager(new SessionStore(path.join(root, "session.json")), adapter), adapter).createAuthenticatedSurface();
    expect(bridge.historySupport()).toEqual({ rewind: false, fork: false });
    expect(await bridge.historyCapability({ chatId: 1, userId: 2, chatType: "bus", conversationKey: "lark:gw_x" })).toEqual({ rewind: "none", fork: "none", reason: "unsupported" });
  });
});
