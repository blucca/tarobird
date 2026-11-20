import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAdapter, EngineStreamEvent } from "../src/codex/adapter.js";
import { Bridge, type AccessStoreLike, type BridgeAuthorizedMessageInput } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const scope = { chatId: 7, conversationKey: "lark:source" };
const anchor = { sessionId: "native-source", inputId: "native-input", rewind: true, fork: true, forkBoundary: "after-turn" as const };
const event = { type: "history_anchor", anchor } as const;
async function fixture(send: CodexAdapter["sendUserMessage"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-anchors-")); roots.push(root);
  const store = new SessionStore(path.join(root, "session.json"));
  const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [7], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
  const adapter: CodexAdapter = { createSession: vi.fn(), sendUserMessage: vi.fn(send) };
  const manager = new SessionManager(store, adapter);
  const telemetry = { recordError: vi.fn() };
  const bridge = new Bridge(access, manager, adapter, { telemetry });
  const onHistoryAnchor = vi.fn().mockResolvedValue(undefined);
  const input: BridgeAuthorizedMessageInput = { ...scope, userId: 42, chatType: "private", text: "An owner message", files: [], historyInputMessageId: "message-1", onHistoryAnchor };
  return { bridge, adapter, manager, store, input, onHistoryAnchor, telemetry };
}

describe("exact App to native history anchors", () => {
  it("binds and publishes one native input with the current durable generation", async () => {
    const f = await fixture(async (_id, input) => {
      // Some native emitters do not await an async event callback.
      void input.onEngineEvent?.(event); void input.onEngineEvent?.(event);
      return { text: "done", sessionId: anchor.sessionId };
    });
    await f.bridge.handleAuthorizedMessage(f.input);
    const bound = (await f.store.inspectHistory(scope.conversationKey))!;
    expect(f.onHistoryAnchor).toHaveBeenCalledExactlyOnceWith({ messageId: "message-1", sessionId: anchor.sessionId,
      bindingGeneration: bound.record.historyGeneration, revision: bound.record.historyRevision, nativeAnchor: anchor });
    expect(bound.record.codexSessionId).toBe(anchor.sessionId);
  });

  it("holds the turn until anchor publication has settled, even when the emitter ignores its promise", async () => {
    const entered = gate(), release = gate();
    const f = await fixture(async (_id, input) => { void input.onEngineEvent?.(event); return { text: "done", sessionId: anchor.sessionId }; });
    f.onHistoryAnchor.mockImplementation(async () => { entered.resolve(); await release.promise; });
    let settled = false;
    const turn = f.bridge.handleAuthorizedMessage(f.input).then(result => { settled = true; return result; });
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(f.adapter.sendUserMessage).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await turn; }
    expect(settled).toBe(true);
  });

  it.each(["no owner boundary", "one-off session"] as const)("does not project an anchor for %s", async mode => {
    const f = await fixture(async (_id, input) => { await input.onEngineEvent?.(event); return { text: "done" }; });
    await f.bridge.handleAuthorizedMessage({ ...f.input, ...(mode === "no owner boundary" ? { historyInputMessageId: undefined } : { sessionIdOverride: "isolated" }) });
    expect(f.onHistoryAnchor).not.toHaveBeenCalled();
    expect((await f.store.load()).chats).toEqual([]);
  });

  it("ignores a delayed event from a completed turn without rebinding its conversation", async () => {
    let emit!: NonNullable<Parameters<CodexAdapter["sendUserMessage"]>[1]["onEngineEvent"]>;
    const f = await fixture(async (_id, input) => { emit = input.onEngineEvent!; return { text: "done", sessionId: anchor.sessionId }; });
    await f.bridge.handleAuthorizedMessage(f.input);
    await f.manager.bindSession(scope, "another-native-session");
    await emit(event);
    expect(f.onHistoryAnchor).not.toHaveBeenCalled();
    expect((await f.store.findByConversationKey(scope.conversationKey))?.codexSessionId).toBe("another-native-session");
  });

  it("does not replay native work or fail a reply when publishing metadata fails", async () => {
    const f = await fixture(async (_id, input) => { await input.onEngineEvent?.(event); return { text: "done", sessionId: anchor.sessionId }; });
    f.onHistoryAnchor.mockRejectedValue(new Error("outbox unavailable"));
    f.telemetry.recordError.mockRejectedValue(new Error("telemetry unavailable"));
    expect(await f.bridge.handleAuthorizedMessage(f.input)).toMatchObject({ text: "done" });
    expect(f.adapter.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(f.telemetry.recordError).toHaveBeenCalledWith(expect.objectContaining({ message: "history_anchor_not_recorded" }), {});
  });

  it("does not accept malformed native point evidence", async () => {
    const f = await fixture(async (_id, input) => {
      await input.onEngineEvent?.({ type: "history_anchor", anchor: { ...anchor, sessionId: "" } } as EngineStreamEvent);
      return { text: "done" };
    });
    await f.bridge.handleAuthorizedMessage(f.input);
    expect(f.onHistoryAnchor).not.toHaveBeenCalled();
    expect((await f.store.load()).chats).toEqual([]);
  });
});
