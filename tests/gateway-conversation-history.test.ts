import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { CONVERSATION_HISTORY_CAPABILITY } from "../src/client-protocol/conversation-history.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import type { GatewayChannel } from "../src/gateway/channel.js";

let directory: string, run: ReturnType<typeof gatewayConversationHistory>, runtime: ReturnType<typeof createCoreServiceRuntime>;
const input = { userId: "owner", botId: "bot", conversationId: "chat", operationId: "operation", expectedRevision: "revision", action: { kind: "fork" as const, scope: "whole" as const } };
const native = { outcome: "applied" as const, sourceSessionId: "source", destinationSessionId: "destination" };
const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })), getConversationHistory: vi.fn(async () => ({ supported: true, revision: "revision", sourceSessionId: "source", bindingGeneration: "generation", capabilities: { rewind: true, fork: true, anchoredFork: true } })), applyConversationHistory: vi.fn(async () => native), finalizeConversationHistory: vi.fn(async () => ({ revision: "next_revision" })) };
const requestLive = vi.fn(async () => ({ allowed: true })), publish = vi.fn(() => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }));
const channel = { transport: { capabilities: [CONVERSATION_HISTORY_CAPABILITY], requestLive, enqueue: publish }, canSteerConversation: async () => true, isConversationProcessing: () => false } as unknown as GatewayChannel;
beforeEach(async () => { vi.clearAllMocks(); directory = await mkdtemp(path.join(os.tmpdir(), "gateway-history-")); await writeFile(path.join(directory, "config.json"), "{}"); runtime = createCoreServiceRuntime(); run = gatewayConversationHistory(bridge, channel, runtime, directory, "bot"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it("performs native mutation once and finalizes only the persisted exact payload", async () => {
  expect(await run("history.apply", input)).toEqual(native);
  expect(await run("history.apply", input)).toEqual(native);
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
  expect(await run("history.finalize", { ...input, result: native, destinationConversationId: "fork" })).toEqual({ revision: "next_revision" });
  await expect(run("history.finalize", { ...input, action: { ...input.action, title: "changed" }, result: native, destinationConversationId: "fork" })).rejects.toThrow("history_request_conflict");
  expect(bridge.finalizeConversationHistory).toHaveBeenCalledOnce();
});
it("reads a completed receipt without changing files or invoking native/finalize", async () => {
  await run("history.apply", input); const folder = path.join(directory, "gateway-receipts"), files = await readdir(folder);
  const before = await Promise.all(files.map(file => readFile(path.join(folder, file), "utf8")));
  const restarted = gatewayConversationHistory(bridge, channel, runtime, directory, "bot");
  expect(await restarted("history.receipt", input)).toEqual({ result: native });
  expect(await Promise.all(files.map(file => readFile(path.join(folder, file), "utf8")))).toEqual(before);
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce(); expect(bridge.finalizeConversationHistory).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledOnce();
});
it("keeps thrown native outcomes unknown and never replays them after restart", async () => {
  bridge.applyConversationHistory.mockRejectedValueOnce(new Error("native_reply_lost"));
  expect(await run("history.apply", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
  const restarted = gatewayConversationHistory(bridge, channel, runtime, directory, "bot");
  expect(await restarted("history.apply", input)).toEqual({ outcome: "unknown", reason: "uncertain" });
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
});
it("rejects live queue work and stale anchor generation without invoking native", async () => {
  let release!: () => void; const queue = runtime.chatQueue.enqueue(buildCoreConversationKey("chat"), () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  expect(await run("history.apply", input)).toEqual({ outcome: "rejected", reason: "busy" }); release(); await queue;
  expect(await run("history.apply", { ...input, operationId: "other", anchorGeneration: "old", anchorSessionId: "source", nativeAnchor: { inputId: "anchor" } })).toEqual({ outcome: "rejected", reason: "source_changed" });
  expect(bridge.applyConversationHistory).not.toHaveBeenCalled();
});
it("reauthorizes receipt lookup and never reveals an old result after revocation", async () => {
  await run("history.apply", input); requestLive.mockResolvedValueOnce({ allowed: false });
  await expect(run("history.receipt", input)).rejects.toThrow("history_forbidden");
  expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
});
