import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { EngineIncompleteResponseError, failedTurnUsage, withFailedTurnUsage } from "../src/codex/adapter.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { handleCoreCardAction } from "../src/core/card-actions.js";
import { buildCoreCronExecutor } from "../src/core/cron.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { createCoreRunCardController } from "../src/core/message-handler.js";
import { deliverCoreResponse } from "../src/core/delivery.js";
import { stableCoreNumericId } from "../src/core/message-normalizer.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { UsageStore } from "../src/state/usage-store.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { fakeChannel, fakeLarkMessage } from "./helpers/core-compat-fixtures.js";

// P-test 2026-11-21: the Pi process was killed after one assistant message had been billed; the ledger missed it.
const billed = { inputTokens: 4, outputTokens: 102, cachedTokens: 40335, costUsd: 0.00829 };

it.each(["message", "cron", "card-action"])("records the usage of a turn whose engine failed midway in the %s entrypoint", async entrypoint => withChannelProfile("gateway", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "failed-turn-usage-"));
  const channel = Object.assign(fakeChannel(), { profile: "gateway" as const }), runtime = createCoreServiceRuntime();
  const bridge: CoreBridgeLike = {
    checkAccess: async () => ({ kind: "allow" }),
    handleAuthorizedMessage: async () => { throw withFailedTurnUsage(new EngineIncompleteResponseError("Pi exited before the turn finished", "interrupted"), billed); },
  };
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "pi", locale: "en" }));
    if (entrypoint === "message") {
      await handleCoreMessage({ channel, bridge, runtime, stateDir: root, message: fakeLarkMessage() });
    } else if (entrypoint === "cron") {
      const executor = buildCoreCronExecutor({ channel, bridge, runtime, stateDir: root, deliverResponse: deliverCoreResponse, createRunCard: createCoreRunCardController });
      await executor({ id: "usage-cron", channel: "lark", chatId: stableCoreNumericId("lark:oc_chat"), userId: stableCoreNumericId("user:ou_user"), chatType: "private", conversationKey: "lark:oc_chat", larkChatId: "oc_chat", cronExpr: "0 9 * * *", timezone: "UTC", prompt: "usage fixture", enabled: true, runOnce: false, sessionMode: "new_per_run", deliveryMode: "agent", mute: false, silent: false, timeoutMins: 30, maxFailures: 3, createdAt: "2026-11-20T00:00:00.000Z", updatedAt: "2026-11-20T00:00:00.000Z", failureCount: 0, runHistory: [], locale: "en" }).catch(() => undefined);
    } else {
      await deliverCoreResponse({ channel, runtime, stateDir: root, chatId: "oc_chat", conversationKey: "lark:oc_chat", bridgeChatType: "private", bridgeChatId: 42, text: '[tool:{"name":"lark.choice","payload":{"title":"Choose","options":[{"label":"Continue","value":"continue"}]}}]' });
      const messageId = channel.send.mock.results[0]?.value ? (await channel.send.mock.results[0].value).messageId : "";
      await handleCoreCardAction({ channel, bridge, runtime, stateDir: root, createRunCard: createCoreRunCardController, event: { messageId, chatId: "oc_chat", operator: { openId: "ou_user" }, action: { value: { cctb_lark: "choice", conversationKey: "lark:oc_chat", bridgeChatType: "private", label: "Continue", value: "continue" } } } });
      await runtime.chatQueue.enqueue("lark:oc_chat", async () => undefined);
    }
    const usage = await new UsageStore(root).load();
    expect(usage).toMatchObject({ totalInputTokens: 4, totalOutputTokens: 102, totalCachedTokens: 40335, requestCount: 1 });
    expect(usage.totalCostUsd).toBeCloseTo(0.00829, 8);
  } finally { await runtime.chatQueue.enqueue("lark:oc_chat", async () => undefined); await rm(root, { recursive: true, force: true }); }
}));

it("records nothing extra for a failure that carries no usage", async () => withChannelProfile("gateway", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "failed-turn-usage-"));
  const channel = Object.assign(fakeChannel(), { profile: "gateway" as const }), runtime = createCoreServiceRuntime();
  const bridge: CoreBridgeLike = { checkAccess: async () => ({ kind: "allow" }), handleAuthorizedMessage: async () => { throw new Error("plain failure"); } };
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "pi", locale: "en" }));
    await handleCoreMessage({ channel, bridge, runtime, stateDir: root, message: fakeLarkMessage() });
    expect(await new UsageStore(root).load()).toMatchObject({ requestCount: 0, totalInputTokens: 0 });
  } finally { await runtime.chatQueue.enqueue("lark:oc_chat", async () => undefined); await rm(root, { recursive: true, force: true }); }
}));

it("does not count a refused or aborted request whose usage is all zero", async () => withChannelProfile("gateway", async () => {
  // Pi puts a zeroed usage on a provider error message (pi-ai openai-completions); it was counted as a metered request.
  const root = await mkdtemp(path.join(os.tmpdir(), "failed-turn-usage-"));
  const channel = Object.assign(fakeChannel(), { profile: "gateway" as const }), runtime = createCoreServiceRuntime();
  const zero = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
  const bridge: CoreBridgeLike = { checkAccess: async () => ({ kind: "allow" }), handleAuthorizedMessage: async () => { throw withFailedTurnUsage(new Error("provider refused"), zero); } };
  try {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "pi", locale: "en" }));
    await handleCoreMessage({ channel, bridge, runtime, stateDir: root, message: fakeLarkMessage() });
    expect(await new UsageStore(root).load()).toMatchObject({ requestCount: 0, totalInputTokens: 0 });
    expect(failedTurnUsage(withFailedTurnUsage(new Error("x"), zero))).toBeUndefined();
    expect(failedTurnUsage(withFailedTurnUsage(new Error("x"), { ...zero, cachedTokens: 3 }))).toMatchObject({ cachedTokens: 3 });
  } finally { await runtime.chatQueue.enqueue("lark:oc_chat", async () => undefined); await rm(root, { recursive: true, force: true }); }
}));
