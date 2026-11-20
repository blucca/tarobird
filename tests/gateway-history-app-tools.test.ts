import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { CONVERSATION_HISTORY_CAPABILITY } from "../src/client-protocol/conversation-history.js";
import type { GatewayChannel } from "../src/gateway/channel.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const change = { userId: "owner", botId: "bot", conversationId: "chat", operationId: "fork-operation", expectedRevision: "revision", action: { kind: "fork" as const, scope: "whole" as const } };
const native = { outcome: "applied" as const, sourceSessionId: "native-source", destinationSessionId: "native-fork" };
const legacyVersion = "8ef5114a6d1726e315c98b2f864bcd5fda7518204122312ae1454e722942972b";
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "history-app-tools-")); roots.push(dir);
  await writeFile(path.join(dir, "config.json"), "{}");
  const file = (id: string) => path.join(dir, "app-tool-threads", `${createHash("sha256").update(id).digest("hex")}.json`);
  const seed = async (id: string, version: string) => { await mkdir(path.dirname(file(id)), { recursive: true }); await writeFile(file(id), JSON.stringify({ toolVersion: version })); };
  const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
    getConversationHistory: vi.fn(async () => ({ supported: true, revision: "revision", sourceSessionId: native.sourceSessionId, bindingGeneration: "generation", capabilities: { rewind: false, fork: true, anchoredFork: false } })),
    applyConversationHistory: vi.fn(async () => native), finalizeConversationHistory: vi.fn(async () => ({ revision: "next" })) };
  const channel = { transport: { capabilities: [CONVERSATION_HISTORY_CAPABILITY], requestLive: async () => ({ allowed: true }),
    enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }) }, canSteerConversation: async () => true, isConversationProcessing: () => false } as unknown as GatewayChannel;
  const make = () => gatewayConversationHistory(bridge, channel, createCoreServiceRuntime(), dir, "bot");
  const tools = (conversationId: string) => createAppPlatformTools({ stateDir: dir, conversationId, signal: new AbortController().signal,
    receipts: new GatewayReceipts(dir), channel: { sendArtifact: vi.fn(), sendArtifactBatch: vi.fn() } });
  const finalize = (run = make()) => run("history.finalize", { ...change, result: native, destinationConversationId: "fork-chat" });
  return { dir, file, seed, bridge, make, tools, finalize, run: make() };
}

it("makes the exact inherited tool contract usable before opening the fork binding", async () => {
  const f = await fixture(); await f.seed(native.sourceSessionId, legacyVersion);
  f.bridge.finalizeConversationHistory.mockImplementationOnce(async () => {
    const inherited = await f.tools("fork-chat").forSession!(native.destinationSessionId);
    expect(inherited).toBeDefined();
    expect(createHash("sha256").update(JSON.stringify(inherited!.definitions)).digest("hex")).toBe(legacyVersion);
    expect(inherited!.definitions.map(tool => tool.name)).not.toContain("app_send_batch");
    const help = await inherited!.call({ name: "app_capability", arguments: { topic: "files" }, callId: "help", sessionId: native.destinationSessionId, abortSignal: new AbortController().signal });
    expect(help.isError).not.toBe(true); expect(help.text).not.toContain("app_send_batch");
    return { revision: "next" };
  });
  expect(await f.run("history.apply", change)).toEqual(native);
  expect(await f.finalize()).toEqual({ revision: "next" });
});
it("uses the durable pre-fork contract after restart, never the later source registration", async () => {
  const f = await fixture(); await f.seed(native.sourceSessionId, legacyVersion);
  await f.run("history.apply", change); await f.tools("chat").register(native.sourceSessionId);
  await f.finalize(f.make()); await f.finalize(f.make());
  expect(JSON.parse(await readFile(f.file(native.destinationSessionId), "utf8")).toolVersion).toBe(legacyVersion);
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledTimes(1);
});
it("refuses unreadable source registration before submitting any native fork", async () => {
  const f = await fixture(); await f.seed(native.sourceSessionId, legacyVersion); await writeFile(f.file(native.sourceSessionId), "{broken");
  expect(await f.run("history.apply", change)).toEqual({ outcome: "rejected", reason: "storage_unavailable" });
  expect(f.bridge.applyConversationHistory).not.toHaveBeenCalled();
});
it("retains a conflicting destination and refuses binding finalization without re-forking", async () => {
  const f = await fixture(); await f.seed(native.sourceSessionId, legacyVersion); await f.run("history.apply", change);
  await f.tools("unrelated").register(native.destinationSessionId);
  const before = await readFile(f.file(native.destinationSessionId), "utf8");
  await expect(f.finalize()).rejects.toThrow("history_app_tools_conflict");
  expect(await readFile(f.file(native.destinationSessionId), "utf8")).toBe(before);
  expect(f.bridge.finalizeConversationHistory).not.toHaveBeenCalled();
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledTimes(1);
});
it("does not install new tools on a fork of an unregistered native session", async () => {
  const f = await fixture(); await f.run("history.apply", change); await f.finalize();
  expect(await f.tools("fork-chat").forSession!(native.destinationSessionId)).toBeUndefined();
});
