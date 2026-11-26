import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientFrame, Message } from "../src/client-protocol/index.js";
import {
  beginSendTiming,
  clearSendTimingRecords,
  getSendTimingRecords,
  hasActiveSendTiming,
  hasPendingBubbleTiming,
  hasPendingComposerTiming,
  isSendTimingEnabled,
  markSendTimingBubbleVisible,
  markSendTimingByClientMsgId,
  markSendTimingComposerCleared,
  markSendTimingHistoryRead,
  markSendTimingOutboxReload,
  markSendTimingSideVisible,
  SEND_TIMING_STORAGE_KEY,
  setSendTimingTestHook,
  type SendTimingDebugApi,
} from "../client/src/send-timing.js";

function installStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  return store;
}

afterEach(() => {
  setSendTimingTestHook(false);
  clearSendTimingRecords();
  delete (globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming;
  vi.unstubAllGlobals();
});

describe("opt-in send timing probe", () => {
  it("is disabled by default and performs no recording when off", () => {
    installStorage();
    expect(isSendTimingEnabled()).toBe(false);
    const trace = beginSendTiming({
      conversationId: "c_1",
      kind: "direct",
      engine: "claude",
      messageLength: 12,
      historyCount: 5,
      matchText: "hello world",
    });
    expect(trace).toBeUndefined();
    expect(hasActiveSendTiming()).toBe(false);
    expect(hasPendingBubbleTiming("c_1")).toBe(false);
    expect(hasPendingComposerTiming("c_1")).toBe(false);
    expect(getSendTimingRecords()).toHaveLength(0);
    expect((globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming).toBeUndefined();

    const frame: ClientFrame = { v: 1, type: "message.send", conversationId: "c_1", clientMsgId: "cli_1", text: "hello", attachments: [] };
    markSendTimingByClientMsgId(frame, "enqueueDoneAt");
    markSendTimingOutboxReload("c_1", [{ id: "cli_1" }]);
    markSendTimingHistoryRead("c_1", [], 100, 0, 5);
    markSendTimingBubbleVisible("c_1", [], () => true);
    markSendTimingComposerCleared("c_1");
    expect(getSendTimingRecords()).toHaveLength(0);
  });

  it("records full queued send lifecycle when localStorage flag is set", () => {
    installStorage({ [SEND_TIMING_STORAGE_KEY]: "1" });
    expect(isSendTimingEnabled()).toBe(true);

    const trace = beginSendTiming({
      conversationId: "c_queue",
      kind: "direct",
      engine: "codex",
      messageLength: 18,
      historyCount: 300,
      matchText: "check latency",
    });
    expect(trace).toBeDefined();
    expect((globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming?.records).toHaveLength(1);

    trace!.mark("workbenchDoneAt");
    trace!.mark("steeringStateDoneAt");
    trace!.setRoute("queue");
    trace!.setClientMsgId("cli_q1");

    const frame: ClientFrame = { v: 1, type: "message.send", conversationId: "c_queue", clientMsgId: "cli_q1", text: "check latency", attachments: [] };
    markSendTimingByClientMsgId(frame, "historySettledDoneAt");
    markSendTimingByClientMsgId(frame, "enqueueDoneAt");
    markSendTimingOutboxReload("c_queue", [{ id: "cli_q1" }]);
    markSendTimingByClientMsgId(frame, "outboxFlushSentAt");

    const msg: Message = {
      id: "msg_q1",
      conversationId: "c_queue",
      authorId: "owner",
      authorType: "user",
      clientMsgId: "cli_q1",
      status: "complete",
      version: 1,
      createdAt: Date.now(),
      blocks: [{ type: "text", text: "check latency" }],
    };
    const readEnd = performance.now();
    markSendTimingHistoryRead("c_queue", [msg], readEnd, 42, 7.5);
    expect(hasPendingBubbleTiming("c_queue")).toBe(true);
    markSendTimingBubbleVisible("c_queue", [msg], id => id === "msg_q1");
    trace!.expectComposerClear();
    expect(hasPendingComposerTiming("c_queue")).toBe(true);
    markSendTimingComposerCleared("c_queue");

    expect(hasActiveSendTiming()).toBe(false);
    const rec = (globalThis as { __tarobirdSendTiming?: SendTimingDebugApi }).__tarobirdSendTiming?.latest();
    expect(rec).toBeDefined();
    expect(rec!.engine).toBe("codex");
    expect(rec!.route).toBe("queue");
    expect(rec!.messageLength).toBe(18);
    expect(rec!.historyCount).toBe(300);
    expect(rec!.workbenchDoneAt).toBeGreaterThanOrEqual(rec!.enterAt);
    expect(rec!.steeringStateDoneAt).toBeGreaterThanOrEqual(rec!.workbenchDoneAt!);
    expect(rec!.historySettledDoneAt).toBeGreaterThanOrEqual(rec!.steeringStateDoneAt!);
    expect(rec!.enqueueDoneAt).toBeGreaterThanOrEqual(rec!.historySettledDoneAt!);
    expect(rec!.outboxReloadDoneAt).toBeGreaterThanOrEqual(rec!.enqueueDoneAt!);
    expect(rec!.outboxFlushSentAt).toBeGreaterThanOrEqual(rec!.outboxReloadDoneAt!);
    expect(rec!.historyReadDoneAt).toBe(readEnd);
    expect(rec!.historyReadGapWaitMs).toBe(42);
    expect(rec!.historyReadCostMs).toBe(7.5);
    expect(rec!.bubbleVisibleAt).toBeGreaterThanOrEqual(rec!.enterAt);
    expect(rec!.composerClearedAt).toBeGreaterThanOrEqual(rec!.bubbleVisibleAt!);
    expect("matchText" in (rec as unknown as Record<string, unknown>)).toBe(false);
  });

  it("matches native steering and group discussion messages without leaking text", () => {
    setSendTimingTestHook(true);

    const steerTrace = beginSendTiming({
      conversationId: "c_claude",
      kind: "direct",
      engine: "claude",
      messageLength: 7,
      matchText: "steer 1",
    })!;
    steerTrace.mark("workbenchDoneAt");
    steerTrace.mark("steeringPreflightDoneAt");
    steerTrace.setRoute("native_message");
    steerTrace.setClientMsgId("req_steer_1");
    const steerMsg: Message = {
      id: "msg_steer_1",
      conversationId: "c_claude",
      authorId: "owner",
      authorType: "user",
      clientMsgId: "req_steer_1",
      status: "complete",
      version: 1,
      createdAt: Date.now(),
      blocks: [{ type: "text", text: "steer 1" }],
    };
    markSendTimingHistoryRead("c_claude", [steerMsg], performance.now(), 0, 2);
    markSendTimingBubbleVisible("c_claude", [steerMsg], id => id === "msg_steer_1");
    steerTrace.mark("steeringStateDoneAt");
    steerTrace.expectComposerClear();
    markSendTimingComposerCleared("c_claude");

    const groupTrace = beginSendTiming({
      conversationId: "c_group",
      kind: "group",
      engine: "group",
      route: "discussion_start",
      messageLength: 10,
      matchText: "topic body",
    })!;
    const topicMsg: Message = {
      id: "msg_gd_1",
      conversationId: "c_group",
      authorId: "owner",
      authorType: "user",
      clientMsgId: "gdtopic_abc",
      status: "complete",
      version: 1,
      createdAt: Date.now(),
      blocks: [{ type: "text", text: "topic body" }],
    };
    markSendTimingHistoryRead("c_group", [topicMsg], performance.now(), 0, 3);
    markSendTimingBubbleVisible("c_group", [topicMsg], id => id === "msg_gd_1");
    groupTrace.expectComposerClear();
    markSendTimingComposerCleared("c_group");

    const all = getSendTimingRecords();
    expect(all).toHaveLength(2);
    expect(all[0]!.messageId).toBe("msg_steer_1");
    expect(all[0]!.steeringPreflightDoneAt).toBeDefined();
    expect(all[1]!.clientMsgId).toBe("gdtopic_abc");
    expect(all[1]!.bubbleVisibleAt).toBeDefined();
    expect(hasActiveSendTiming()).toBe(false);
  });

  it("tracks side conversation visibility and retires failed sends cleanly", () => {
    setSendTimingTestHook(true);
    const failed = beginSendTiming({ conversationId: "c_side", kind: "direct", engine: "pi", messageLength: 4 })!;
    failed.fail(new Error("offline"));
    expect(hasActiveSendTiming()).toBe(false);
    expect(getSendTimingRecords()[0]!.error).toBe("offline");

    const side = beginSendTiming({ conversationId: "c_side", kind: "side", engine: "side", route: "side", messageLength: 9, matchText: "side ask?" })!;
    side.mark("outboxFlushSentAt");
    side.expectComposerClear();
    markSendTimingSideVisible("c_side", "side ask?");
    markSendTimingComposerCleared("c_side");

    expect(hasActiveSendTiming()).toBe(false);
    expect(getSendTimingRecords()[1]!.bubbleVisibleAt).toBeDefined();
    expect(getSendTimingRecords()[1]!.composerClearedAt).toBeDefined();
  });
});
