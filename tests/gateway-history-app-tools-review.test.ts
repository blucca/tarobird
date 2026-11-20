import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { JsonStore } from "../src/state/json-store.js";
import { CONVERSATION_HISTORY_CAPABILITY } from "../src/client-protocol/conversation-history.js";
import type { GatewayChannel } from "../src/gateway/channel.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const request = { userId: "owner", botId: "bot", conversationId: "source-chat", operationId: "fork-op", expectedRevision: "source-revision", action: { kind: "fork" as const, scope: "whole" as const } };
const result = { outcome: "applied" as const, sourceSessionId: "source-native", destinationSessionId: "fork-native" };
const version = "8ef5114a6d1726e315c98b2f864bcd5fda7518204122312ae1454e722942972b";
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-tools-review-")); roots.push(directory);
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const registration = (id: string) => path.join(directory, "app-tool-threads", `${hash(id)}.json`);
  await mkdir(path.dirname(registration(result.sourceSessionId)), { recursive: true });
  await writeFile(path.join(directory, "config.json"), "{}");
  await writeFile(registration(result.sourceSessionId), JSON.stringify({ toolVersion: version }));
  let allowed = true;
  const bridge = {
    handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
    getConversationHistory: vi.fn(async () => ({ supported: true, revision: request.expectedRevision, sourceSessionId: result.sourceSessionId, bindingGeneration: "generation", capabilities: { rewind: false, fork: true, anchoredFork: false } })),
    applyConversationHistory: vi.fn(async () => result), finalizeConversationHistory: vi.fn(async () => ({ revision: "final" })),
  };
  const channel = { transport: { capabilities: [CONVERSATION_HISTORY_CAPABILITY], requestLive: async () => ({ allowed }),
    enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }) }, canSteerConversation: async () => true, isConversationProcessing: () => false } as unknown as GatewayChannel;
  const make = () => gatewayConversationHistory(bridge, channel, createCoreServiceRuntime(), directory, "bot");
  const run = make(); await run("history.apply", request);
  const finalize = () => make()("history.finalize", { ...request, result, destinationConversationId: "fork-chat" });
  return { directory, hash, registration, bridge, run, make, finalize, revoke: () => { allowed = false; } };
}

it("does not release the source fence or bind a fork after authorization is revoked during registration persistence", async () => {
  const f = await fixture();
  const original = JsonStore.prototype.write;
  vi.spyOn(JsonStore.prototype, "write").mockImplementation(async function (this: JsonStore<unknown>, value: unknown) {
    await original.call(this, value);
    if ((value as { toolVersion?: string })?.toolVersion === version) f.revoke();
  });
  await expect(f.finalize()).rejects.toThrow("history_forbidden");
  expect(f.bridge.finalizeConversationHistory).not.toHaveBeenCalled();
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledTimes(1);
});
it("does not overwrite a corrupt destination registration or bind the destination", async () => {
  const f = await fixture(), destination = f.registration(result.destinationSessionId);
  await writeFile(destination, "{broken");
  await expect(f.finalize()).rejects.toThrow();
  expect(await readFile(destination, "utf8")).toBe("{broken");
  expect(f.bridge.finalizeConversationHistory).not.toHaveBeenCalled();
  expect(await f.make()("history.apply", request)).toEqual(result);
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledTimes(1);
});
it("keeps a confirmed native receipt read-only when the required tool-contract receipt is corrupt", async () => {
  const f = await fixture();
  const file = path.join(f.directory, "gateway-receipts", `${f.hash(`history:${request.userId}:${request.operationId}:app-tools`)}.json`);
  await writeFile(file, "{broken");
  await expect(f.finalize()).rejects.toThrow();
  expect(await f.make()("history.receipt", request)).toEqual({ result });
  expect(await readFile(file, "utf8")).toBe("{broken");
  expect(f.bridge.finalizeConversationHistory).not.toHaveBeenCalled();
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledTimes(1);
  expect(await new GatewayReceipts(f.directory).inspect(`history:${request.userId}:${request.operationId}:native`)).toMatchObject({ state: "complete", result: { ok: true, result } });
});
