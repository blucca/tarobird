import { describe, expect, it } from "vitest";
import { CAPABILITIES, conversationSchema } from "../src/client-protocol/index.js";
import {
  HISTORY_CAPABILITY, historyBotForkReplySchema, historyBotRewindReplySchema, historyForkSchema, historyLedgerLineSchema,
  historyOperationSchema, historyRewindSchema, historyStatusSchema, upstreamRejectionSchema,
} from "../src/client-protocol/history.js";

// Synthetic ids only.
const range = { id: "hop_1", fromMessageId: "msg_a", fromCreatedAt: 10, throughMessageId: "msg_z", throughCreatedAt: 20, at: 30, by: "user_1" };

describe("history protocol (#53)", () => {
  it("keeps the App handshake list unchanged", () => {
    expect(CAPABILITIES).not.toContain(HISTORY_CAPABILITY);
    expect(CAPABILITIES.length + 1).toBeLessThanOrEqual(64);
  });
  it("carries rewind ranges and fork origin on a conversation", () => {
    const base = { id: "gw_1", type: "direct", title: "t", ownerId: "user_1", botIds: ["bot_1"], archived: false, createdAt: 1, updatedAt: 1 };
    const parsed = conversationSchema.parse({ ...base, history: { rewinds: [range], forkedFrom: { opId: "hop_2", conversationId: "gw_0", title: "src", mode: "turn", throughMessageId: "msg_k", excerpt: "hello", at: 5 } } });
    expect(parsed.history?.rewinds?.[0]?.fromMessageId).toBe("msg_a");
    expect(conversationSchema.parse(base).history).toBeUndefined();
    expect(() => conversationSchema.parse({ ...base, history: { rewinds: [{ ...range, extra: 1 }] } })).toThrow();
  });
  it("validates requests, receipts and status", () => {
    expect(historyRewindSchema.parse({ botId: "bot_1", requestId: "r1", beforeMessageId: "msg_a", expectedLastMessageId: "msg_z" })).toBeTruthy();
    expect(historyForkSchema.parse({ botId: "bot_1", requestId: "r2", expectedLastMessageId: "msg_z" }).throughMessageId).toBeUndefined();
    expect(() => historyRewindSchema.parse({ botId: "bot_1", requestId: "r1", beforeMessageId: "msg_a" })).toThrow();
    expect(historyOperationSchema.parse({ id: "hop_1", requestId: "r1", kind: "rewind", state: "completed", rewind: range }).rewind?.id).toBe("hop_1");
    expect(historyStatusSchema.parse({ supported: true, rewind: "turn", fork: "turn", blocked: "running" }).blocked).toBe("running");
    expect(() => historyStatusSchema.parse({ supported: true, rewind: "head", fork: "none" })).toThrow();
  });
  it("lets the Gateway report an interrupted fork, which the App never sees", () => {
    expect(historyBotForkReplySchema.parse({ ok: false, error: "operation_interrupted" })).toBeTruthy();
    expect(historyBotRewindReplySchema.parse({ ok: true })).toBeTruthy();
    expect(() => historyOperationSchema.parse({ id: "hop_1", requestId: "r1", kind: "fork", state: "failed", error: "operation_interrupted" })).toThrow();
  });
  it("shapes ledger lines and the upstream-rejection mark", () => {
    expect(historyLedgerLineSchema.parse({ v: 1, sourceMessageId: "msg_a", runId: "run-1", engine: "codex", sessionId: "thr-1", anchor: { firstTurnId: "t1", lastTurnId: "t2" }, startedAt: 1, outcome: "failed:engine-invalid-request" })).toBeTruthy();
    expect(() => historyLedgerLineSchema.parse({ v: 1, sourceMessageId: "msg_a", runId: "run-1", engine: "codex", sessionId: "thr-1", startedAt: 1, outcome: "FAILED" })).toThrow();
    expect(upstreamRejectionSchema.parse({ v: 1, streak: 2, firstMessageId: "msg_a" }).streak).toBe(2);
    expect(() => upstreamRejectionSchema.parse({ v: 1, streak: 1, firstMessageId: "msg_a" })).toThrow();
  });
});
