import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historyBotForkReplySchema, historyBotRewindReplySchema, historyBotStatusSchema } from "../src/client-protocol/history.js";
import type { CodexAdapter, CodexThreadGoal } from "../src/codex/adapter.js";
import { CoreGoalRunController } from "../src/core/bus.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { gatewayHistory } from "../src/gateway/history.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { appendHistoryLedgerLine, findHistoryLedgerRun, readHistoryLedger } from "../src/runtime/history-ledger.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { bridgeConversationLockId, sessionLockNamespace, withBridgeTurnLock } from "../src/runtime/turn-lock.js";
import { SessionStore } from "../src/state/session-store.js";

// Synthetic payloads called directly, as the Hub would; the engine is a stub.
const access = { load: vi.fn(), issuePairingCode: vi.fn() } as unknown as AccessStoreLike;
type History = ReturnType<typeof gatewayHistory>;
type AdapterStub = CodexAdapter & { [K in "historyCapability" | "rewindSession" | "forkSession" | "resolveHistoryAnchor" | "getThreadGoal"]: ReturnType<typeof vi.fn> };

describe("Gateway history handlers (#53)", () => {
  let stateDir: string;
  let conversationId: string;
  let key: string;
  let sid: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "gateway-history-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
    // Unique ids: turn locks live in the shared OS temp directory.
    conversationId = `gw_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    key = buildCoreConversationKey(conversationId);
    sid = `thr-${randomUUID()}`;
  });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  function fixture(options: { adapter?: Partial<AdapterStub>; history?: boolean } = {}) {
    const adapter = {
      createSession: vi.fn(), sendUserMessage: vi.fn(),
      ...(options.history === false ? {} : {
        historyCapability: vi.fn(async () => ({ rewind: "turn", fork: "turn" })),
        rewindSession: vi.fn(async (sessionId: string) => ({ sessionId })),
        forkSession: vi.fn(async () => ({ sessionId: "thr-fork" })),
        resolveHistoryAnchor: vi.fn(async () => undefined),
        getThreadGoal: vi.fn(async () => ({ goal: null })),
      }),
      ...options.adapter,
    } as AdapterStub;
    const store = new SessionStore(path.join(stateDir, "session.json"));
    const bridge = new Bridge(access, new SessionManager(store, adapter), adapter).createAuthenticatedSurface();
    const runtime = createCoreServiceRuntime();
    const closeSideSessions = vi.fn(async () => undefined);
    const bindingReady = vi.fn(async () => true);
    const create = (): History => gatewayHistory({ bridge, runtime, stateDir, closeSideSessions, bindingReady });
    return { adapter, store, bridge, runtime, closeSideSessions, bindingReady, history: create(), create };
  }
  const bind = (store: SessionStore, sessionId: string, conversationKey = key, workspacePath = "/tmp/history-ws") => store.upsert({
    telegramChatId: stableCoreNumericId(conversationKey), conversationKey, codexSessionId: sessionId, status: "idle", updatedAt: new Date(0).toISOString(),
    resume: { sessionId, dirName: "ws", workspacePath, symlinkPath: "/tmp/history-owned-link" } });
  const ledger = (messageId: string, sessionId: string, anchor?: { firstTurnId: string; lastTurnId: string }) =>
    appendHistoryLedgerLine(stateDir, key, { v: 1, sourceMessageId: messageId, runId: `run-${messageId}`, engine: "codex", sessionId, ...(anchor ? { anchor } : {}), startedAt: 1, endedAt: 2, outcome: "ok" });
  const rewind = (history: History, extra: Record<string, unknown> = {}) => history("history.rewind", { conversationId, userId: "user_1", requestId: "req_1", beforeMessageId: "msg_a", ...extra });
  const fork = (history: History, extra: Record<string, unknown> = {}) => history("history.fork", { conversationId, userId: "user_1", requestId: "req_f", targetConversationId: "gw_new", throughMessageId: "msg_a", ...extra });

  it("reports none, and refuses, when the engine has no history operations", async () => {
    const f = fixture({ history: false });
    expect(await f.history("history.status", { conversationId, userId: "user_1" })).toEqual({ supported: false, rewind: "none", fork: "none", reason: "unsupported" });
    expect(await rewind(f.history)).toEqual({ ok: false, error: "unsupported" });
    expect(await fork(f.history)).toEqual({ ok: false, error: "unsupported" });
  });

  it("reports capability, blocks and the current session's first message", async () => {
    const f = fixture();
    const status = () => f.history("history.status", { conversationId, userId: "user_1" });
    expect(await status()).toEqual({ supported: true, rewind: "turn", fork: "turn", blocked: "no_main_session" });
    expect(f.adapter.historyCapability.mock.calls[0]![0]).toMatch(/^tarobot-/);
    await bind(f.store, sid);
    await appendHistoryLedgerLine(stateDir, key, { v: 1, sourceMessageId: "msg_first", runId: "r0", engine: "codex", sessionId: "unbound", startedAt: 1 });
    await appendHistoryLedgerLine(stateDir, key, { v: 1, sourceMessageId: "msg_first", runId: "r0", engine: "codex", sessionId: sid, anchor: { firstTurnId: "t0", lastTurnId: "t0" }, startedAt: 1 });
    const ready = await status();
    expect(historyBotStatusSchema.parse(ready)).toEqual({ supported: true, rewind: "turn", fork: "turn", sinceMessageId: "msg_first" });
    expect(f.adapter.historyCapability).toHaveBeenLastCalledWith(sid, { workspaceOverride: "/tmp/history-ws" });
    f.runtime.activeRuns.set(key, { abortController: new AbortController() });
    expect(await status()).toMatchObject({ blocked: "running" });
    f.runtime.activeRuns.set(key, { abortController: new CoreGoalRunController(), goalWatch: true });
    expect(await status()).toMatchObject({ blocked: "goal_active" });
    f.runtime.activeRuns.delete(key);
    f.adapter.getThreadGoal.mockResolvedValue({ goal: { status: "active" } as CodexThreadGoal });
    expect(await status()).toMatchObject({ blocked: "goal_active" });
    f.adapter.getThreadGoal.mockResolvedValue({ goal: null });
    // Another conversation attached to the same session: fork only.
    await bind(f.store, sid, buildCoreConversationKey("gw_other"));
    expect(await status()).toEqual({ supported: true, rewind: "none", fork: "turn", reason: "external_session", sinceMessageId: "msg_first" });
    f.bindingReady.mockResolvedValue(false);
    expect(await status()).toMatchObject({ blocked: "no_main_session" });
  });

  it("is busy, without waiting, while a run, the conversation lock or the session lock is held", async () => {
    const f = fixture();
    await bind(f.store, sid);
    await ledger("msg_a", sid, { firstTurnId: "t1", lastTurnId: "t2" });
    f.runtime.activeRuns.set(key, { abortController: new AbortController() });
    expect(await rewind(f.history, { requestId: "busy_run" })).toEqual({ ok: false, error: "busy" });
    f.runtime.activeRuns.delete(key);
    const session = (await f.store.findByConversationKey(key))!.codexSessionId;
    for (const lockId of [bridgeConversationLockId({ chatId: stableCoreNumericId(key), conversationKey: key }, await sessionLockNamespace(path.join(stateDir, "session.json"))), session]) {
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; }), inside = new Promise<void>((resolve) => { entered = resolve; });
      const holder = withBridgeTurnLock(lockId, async () => { entered(); await held; });
      await inside;
      expect(await rewind(f.history, { requestId: `busy_${lockId.length}` })).toEqual({ ok: false, error: "busy" });
      expect(await fork(f.history, { requestId: `busy_f_${lockId.length}` })).toEqual({ ok: false, error: "busy" });
      release(); await holder;
    }
    expect(f.adapter.rewindSession).not.toHaveBeenCalled();
    expect(f.adapter.forkSession).not.toHaveBeenCalled();
  });

  it("needs a real engine session", async () => {
    const f = fixture();
    expect(await rewind(f.history, { requestId: "none" })).toEqual({ ok: false, error: "no_main_session" });
    await bind(f.store, "tarobot-1-logical");
    expect(await rewind(f.history, { requestId: "logical" })).toEqual({ ok: false, error: "no_main_session" });
    expect(await fork(f.history, { requestId: "logical_f" })).toEqual({ ok: false, error: "no_main_session" });
    await bind(f.store, sid);
    f.bindingReady.mockResolvedValue(false);
    expect(await rewind(f.history, { requestId: "pending_selection" })).toEqual({ ok: false, error: "no_main_session" });
  });

  it("rewinds to the ledger anchor once per request, closes side handles and replays the receipt", async () => {
    const f = fixture();
    await bind(f.store, sid);
    await ledger("msg_a", sid, { firstTurnId: "t1", lastTurnId: "t2" });
    let finish!: () => void;
    f.adapter.rewindSession.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ sessionId: sid }); }));
    const both = Promise.all([rewind(f.history), rewind(f.history)]);
    await vi.waitFor(() => expect(f.adapter.rewindSession).toHaveBeenCalledTimes(1));
    finish();
    expect(await both).toEqual([{ ok: true }, { ok: true }]);
    expect(f.adapter.rewindSession).toHaveBeenCalledWith(sid, { anchor: { firstTurnId: "t1", lastTurnId: "t2" }, workspaceOverride: "/tmp/history-ws", abortSignal: undefined });
    expect(f.closeSideSessions).toHaveBeenCalledWith(conversationId);
    // A restarted Gateway answers from the receipt.
    expect(historyBotRewindReplySchema.parse(await rewind(f.create()))).toEqual({ ok: true });
    expect(f.adapter.rewindSession).toHaveBeenCalledTimes(1);
  });

  it("refuses an earlier session's message, a run without an engine turn, and an unmatched older run", async () => {
    const f = fixture();
    await bind(f.store, sid);
    await ledger("msg_old", "thr-0", { firstTurnId: "t0", lastTurnId: "t0" });
    await ledger("msg_noturn", sid);
    expect(await rewind(f.history, { requestId: "r1", beforeMessageId: "msg_old" })).toEqual({ ok: false, error: "session_changed" });
    expect(await rewind(f.history, { requestId: "r2", beforeMessageId: "msg_noturn" })).toEqual({ ok: false, error: "not_an_anchor" });
    expect(await rewind(f.history, { requestId: "r3", beforeMessageId: "msg_unknown" })).toEqual({ ok: false, error: "turn_unresolved" });
    expect(await rewind(f.history, { requestId: "r4", beforeMessageId: "msg_unknown", hints: { target: { sourceMessageId: "msg_unknown", text: "x", createdAt: 5 } } })).toEqual({ ok: false, error: "turn_unresolved" });
    expect(f.adapter.resolveHistoryAnchor).toHaveBeenCalledWith(sid, { sourceMessageId: "msg_unknown", text: "x", startedAt: 5 });
    expect(f.adapter.rewindSession).not.toHaveBeenCalled();
  });

  it("persists a matched older anchor before rewinding, so a retry after a crash stays re-entrant", async () => {
    const f = fixture();
    await bind(f.store, sid);
    f.adapter.resolveHistoryAnchor.mockResolvedValue({ firstTurnId: "t5", lastTurnId: "t6" });
    let ledgerAtRewind: unknown;
    f.adapter.rewindSession.mockImplementationOnce(async () => {
      ledgerAtRewind = findHistoryLedgerRun(await readHistoryLedger(stateDir, key), "msg_a")?.last.anchor;
      throw new Error("socket closed");
    });
    const hints = { target: { sourceMessageId: "msg_a", text: "fix it", createdAt: 10, startedAt: 12 }, next: { sourceMessageId: "msg_b", text: "and", createdAt: 20 } };
    expect(await rewind(f.history, { hints })).toEqual({ ok: false, error: "engine_failed" });
    expect(ledgerAtRewind).toEqual({ firstTurnId: "t5", lastTurnId: "t6" });
    expect(f.adapter.resolveHistoryAnchor).toHaveBeenCalledWith(sid, { sourceMessageId: "msg_a", text: "fix it", startedAt: 12, next: { sourceMessageId: "msg_b", text: "and", startedAt: 20 } });
    // A Gateway that died mid-revert left its receipt running: within the
    // retry window it runs again, from the persisted anchor, never re-matching.
    const receipt = path.join(stateDir, "gateway-receipts", `${createHash("sha256").update("history.rewind:user_1:req_crash").digest("hex")}.json`);
    await mkdir(path.dirname(receipt), { recursive: true });
    await writeFile(receipt, JSON.stringify({ state: "running", retryUntil: Date.now() + 60_000 }));
    expect(await rewind(f.create(), { requestId: "req_crash", hints })).toEqual({ ok: true });
    expect(f.adapter.resolveHistoryAnchor).toHaveBeenCalledTimes(1);
    expect(f.adapter.rewindSession).toHaveBeenLastCalledWith(sid, expect.objectContaining({ anchor: { firstTurnId: "t5", lastTurnId: "t6" } }));
  });

  it("maps engine refusals and goals to their errors", async () => {
    const f = fixture();
    await bind(f.store, sid);
    await ledger("msg_a", sid, { firstTurnId: "t1", lastTurnId: "t2" });
    f.adapter.getThreadGoal.mockResolvedValueOnce({ goal: { status: "active" } as CodexThreadGoal });
    expect(await rewind(f.history, { requestId: "goal" })).toEqual({ ok: false, error: "goal_active" });
    f.adapter.rewindSession.mockRejectedValueOnce(new Error("engine_busy"));
    expect(await rewind(f.history, { requestId: "writer" })).toEqual({ ok: false, error: "engine_busy" });
    f.adapter.rewindSession.mockRejectedValueOnce(new Error("socket closed"));
    expect(await rewind(f.history, { requestId: "other" })).toEqual({ ok: false, error: "engine_failed" });
    f.adapter.historyCapability.mockResolvedValueOnce({ rewind: "none", fork: "turn", reason: "external_session" });
    expect(await rewind(f.history, { requestId: "external" })).toEqual({ ok: false, error: "unsupported" });
    expect(f.closeSideSessions).not.toHaveBeenCalled();
  });

  it("forks into the reserved conversation with the carried workspace, once per request", async () => {
    const f = fixture();
    await bind(f.store, sid);
    await ledger("msg_a", sid, { firstTurnId: "t1", lastTurnId: "t2" });
    expect(historyBotForkReplySchema.parse(await fork(f.history))).toEqual({ ok: true, mode: "turn" });
    expect(f.adapter.forkSession).toHaveBeenCalledWith(sid, { through: { lastTurnId: "t2" }, workspaceOverride: "/tmp/history-ws", abortSignal: undefined });
    const record = await f.store.findByConversationKey(buildCoreConversationKey("gw_new"));
    expect(record).toMatchObject({ codexSessionId: "thr-fork", resume: { sessionId: "thr-fork", dirName: "ws", workspacePath: "/tmp/history-ws" } });
    expect(record?.resume).not.toHaveProperty("symlinkPath");
    // The source conversation is untouched.
    expect((await f.store.findByConversationKey(key))?.codexSessionId).toBe(sid);
    expect(await fork(f.create())).toEqual({ ok: true, mode: "turn" });
    expect(f.adapter.forkSession).toHaveBeenCalledTimes(1);

    f.adapter.forkSession.mockResolvedValueOnce({ sessionId: "thr-head" });
    expect(await fork(f.history, { requestId: "head", targetConversationId: "gw_head", throughMessageId: undefined })).toEqual({ ok: true, mode: "head" });
    expect(f.adapter.forkSession).toHaveBeenLastCalledWith(sid, { workspaceOverride: "/tmp/history-ws", abortSignal: undefined });
    // A reserved id that is already bound is never overwritten.
    expect(await fork(f.history, { requestId: "again", targetConversationId: "gw_head" })).toEqual({ ok: false, error: "engine_failed" });
    expect(f.adapter.forkSession).toHaveBeenCalledTimes(2);
  });

  it("reports an interrupted fork instead of forking twice", async () => {
    const f = fixture();
    await bind(f.store, sid);
    await ledger("msg_a", sid, { firstTurnId: "t1", lastTurnId: "t2" });
    f.adapter.forkSession.mockImplementationOnce(() => new Promise(() => undefined));
    void fork(f.history, { requestId: "crash" });
    await vi.waitFor(() => expect(f.adapter.forkSession).toHaveBeenCalledTimes(1));
    expect(await fork(f.create(), { requestId: "crash" })).toEqual({ ok: false, error: "operation_interrupted" });
    expect(await fork(f.create(), { requestId: "crash" })).toEqual({ ok: false, error: "operation_interrupted" });
    expect(f.adapter.forkSession).toHaveBeenCalledTimes(1);
    expect(await f.store.findByConversationKey(buildCoreConversationKey("gw_new"))).toBeNull();
  });

  it("matches a recorded older run again when its fork end was missing, never moving its start", async () => {
    const f = fixture();
    await bind(f.store, sid);
    const hints = { target: { sourceMessageId: "msg_a", text: "x", createdAt: 1 }, next: { sourceMessageId: "msg_b", text: "y", createdAt: 2 } };
    f.adapter.resolveHistoryAnchor.mockResolvedValueOnce({ firstTurnId: "t5" });
    expect(await fork(f.history, { requestId: "first", hints })).toEqual({ ok: false, error: "turn_unresolved" });
    expect(findHistoryLedgerRun(await readHistoryLedger(stateDir, key), "msg_a")?.last.anchor).toEqual({ firstTurnId: "t5" });
    // The next run can be matched now: the line is completed and used.
    f.adapter.resolveHistoryAnchor.mockResolvedValueOnce({ firstTurnId: "t5", lastTurnId: "t6" });
    expect(await fork(f.history, { requestId: "second", targetConversationId: "gw_n2", hints })).toEqual({ ok: true, mode: "turn" });
    expect(f.adapter.forkSession).toHaveBeenLastCalledWith(sid, expect.objectContaining({ through: { lastTurnId: "t6" } }));
    expect(findHistoryLedgerRun(await readHistoryLedger(stateDir, key), "msg_a")?.last.anchor).toEqual({ firstTurnId: "t5", lastTurnId: "t6" });
    // A rewind needs only the start and never re-matches a recorded one.
    await rewind(f.history, { requestId: "rw", hints });
    expect(f.adapter.resolveHistoryAnchor).toHaveBeenCalledTimes(2);
    // A different start is a different run: refused, the record is kept.
    await appendHistoryLedgerLine(stateDir, key, { v: 1, sourceMessageId: "msg_c", runId: "resolved-msg_c", engine: "codex", sessionId: sid, anchor: { firstTurnId: "t8" }, startedAt: 1 });
    f.adapter.resolveHistoryAnchor.mockResolvedValueOnce({ firstTurnId: "t9", lastTurnId: "t9" });
    expect(await fork(f.history, { requestId: "moved", targetConversationId: "gw_n3", throughMessageId: "msg_c", hints: { target: { sourceMessageId: "msg_c", text: "z", createdAt: 3 } } })).toEqual({ ok: false, error: "turn_unresolved" });
    expect(findHistoryLedgerRun(await readHistoryLedger(stateDir, key), "msg_c")?.last.anchor).toEqual({ firstTurnId: "t8" });
  });

  it("needs a fork boundary for an older run and refuses an active goal", async () => {
    const f = fixture();
    await bind(f.store, sid);
    f.adapter.resolveHistoryAnchor.mockResolvedValueOnce({ firstTurnId: "t5" });
    expect(await fork(f.history, { requestId: "nobound", hints: { target: { sourceMessageId: "msg_a", text: "x", createdAt: 1 }, next: { sourceMessageId: "msg_b", text: "y", createdAt: 2 } } })).toEqual({ ok: false, error: "turn_unresolved" });
    f.adapter.getThreadGoal.mockResolvedValueOnce({ goal: { status: "active" } as CodexThreadGoal });
    expect(await fork(f.history, { requestId: "goal", throughMessageId: undefined })).toEqual({ ok: false, error: "goal_active" });
    expect(f.adapter.forkSession).not.toHaveBeenCalled();
  });
});
