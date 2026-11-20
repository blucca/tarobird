import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleCoreCardAction } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { SessionStore } from "../src/state/session-store.js";

const observation = vi.hoisted(() => ({ waited: undefined as (() => void) | undefined }));
vi.mock("../src/runtime/turn-lock.js", async (load) => {
  const actual = await load<typeof import("../src/runtime/turn-lock.js")>();
  return { ...actual, withBridgeTurnLock: ((key, task, options = {}) => actual.withBridgeTurnLock(key, task, {
    ...options, waitNotifyAfterMs: 0,
    onWait: async event => { observation.waited?.(); await options.onWait?.(event); },
  })) as typeof actual.withBridgeTurnLock };
});
const locks = await vi.importActual<typeof import("../src/runtime/turn-lock.js")>("../src/runtime/turn-lock.js");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("native session resume card ordering", () => {
  const cases = (["claude", "antigravity", "kimi", "deepseek", "pi"] as const).flatMap(engine => (["en", "zh"] as const).map(locale => ({ engine, locale })));
  it.each(cases)("refuses busy $engine resume in $locale without a deferred switch, then permits an idle retry", async ({ engine, locale }) => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "session-card-order-"));
    const conversationKey = "lark:gw_history_fixture";
    const previousId = "11111111-1111-4111-8111-111111111111", selectedId = "22222222-2222-4222-8222-222222222222";
    const entered = deferred(), release = deferred(), waited = deferred();
    observation.waited = waited.resolve;
    const store = new SessionStore(path.join(stateDir, "session.json"));
    const previous = { telegramChatId: 77, conversationKey, codexSessionId: previousId, status: "idle" as const, updatedAt: new Date().toISOString() };
    const channel = { profile: "gateway" as const, send: vi.fn(async () => ({ messageId: "result" })), stream: vi.fn(async () => ({ messageId: "stream" })), downloadResource: vi.fn(async () => Buffer.alloc(0)) };
    const bridge = { checkAccess: vi.fn(async () => ({ kind: "allow" as const })), validateCodexThread: vi.fn(async () => ({ sessionId: selectedId, cwd: stateDir })), handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })) };
    let holder: Promise<void> | undefined, action: Promise<boolean> | undefined;
    try {
      await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale }));
      await store.upsert(previous);
      const key = locks.bridgeConversationLockId({ chatId: 77, conversationKey }, await locks.sessionLockNamespace(path.join(stateDir, "session.json")));
      holder = locks.withBridgeTurnLock(key, async () => {
        entered.resolve(); await release.promise;
        // The ordinary Bridge still owns this binding until its final write.
        await store.upsert({ ...previous, updatedAt: new Date().toISOString() });
      });
      await entered.promise;
      const resume = () => withChannelProfile("gateway", () => handleCoreCardAction({
        stateDir, channel, bridge, runtime: createCoreServiceRuntime(),
        event: { chatId: "gw_history_fixture", messageId: "resume_card", operator: { openId: "owner_fixture" }, action: { value: {
          cctb_lark: "resume", engine, conversationKey, bridgeChatType: "private", sessionId: selectedId, workspacePath: stateDir,
        } } },
      }));
      action = resume();
      const first = await Promise.race([waited.promise.then(() => "waiting"), action.then(() => "finished")]);
      const whileRunning = await store.findByConversationKey(conversationKey);
      release.resolve(); await holder; await action;
      expect(first).toBe("waiting");
      expect(whileRunning?.codexSessionId).toBe(previousId);
      expect((await store.findByConversationKey(conversationKey))?.codexSessionId).toBe(previousId);
      expect(JSON.stringify(channel.send.mock.calls)).toContain(locale === "en" ? "Another operation" : "其他操作正在进行");
      await resume();
      const result = await store.findByConversationKey(conversationKey);
      expect(result?.codexSessionId).toBe(selectedId);
      expect(result?.suspendedPrevious?.sessionId).toBe(previousId);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      release.resolve(); await holder; await action; observation.waited = undefined;
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
