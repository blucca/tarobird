import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { CONVERSATION_HISTORY_CAPABILITY } from "../src/client-protocol/conversation-history.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const read = { userId: "owner", botId: "bot", conversationId: "source" };
const change = { ...read, operationId: "fork-operation", expectedRevision: "revision", action: { kind: "fork" as const, scope: "whole" as const } };
const result = { outcome: "applied" as const, sourceSessionId: "native-source", destinationSessionId: "native-fork" };
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "history-workspace-")); roots.push(dir);
  const configure = (value: object | string) => writeFile(path.join(dir, "config.json"), typeof value === "string" ? value : JSON.stringify(value));
  const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
    getConversationHistory: vi.fn(async () => ({ supported: true, revision: "revision", sourceSessionId: "native-source", capabilities: { rewind: false, fork: true, anchoredFork: false } })),
    applyConversationHistory: vi.fn(async () => result), finalizeConversationHistory: vi.fn(async () => ({ revision: "next" })) };
  const channel = { transport: { capabilities: [CONVERSATION_HISTORY_CAPABILITY], requestLive: async () => ({ allowed: true }),
    enqueue: () => ({ persisted: Promise.resolve(), response: Promise.resolve(null) }) }, canSteerConversation: async () => true, isConversationProcessing: () => false } as unknown as GatewayChannel;
  const make = () => gatewayConversationHistory(bridge, channel, createCoreServiceRuntime(), dir, "bot");
  return { configure, bridge, make, run: make() };
}
it("uses the Bot's configured workspace for snapshot and apply, not its adapter default", async () => {
  const f = await fixture(); await f.configure({ workspacePath: " /srv/custom-project " });
  await f.run("history.snapshot", read); await f.run("history.apply", change);
  expect(f.bridge.getConversationHistory).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: "/srv/custom-project" }));
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: "/srv/custom-project" }));
});
it("finalizes a fork in its reserved workspace after restart even if Bot settings changed", async () => {
  const f = await fixture(); await f.configure({ workspacePath: "/srv/original-project" });
  await f.run("history.apply", change); await f.configure({ workspacePath: "/srv/later-project" });
  const restarted = f.make();
  await restarted("history.apply", change);
  await restarted("history.finalize", { ...change, result, destinationConversationId: "fork" });
  expect(f.bridge.applyConversationHistory).toHaveBeenCalledTimes(1);
  expect(f.bridge.finalizeConversationHistory).toHaveBeenCalledWith(expect.objectContaining({ workspaceOverride: "/srv/original-project" }));
  await restarted("history.snapshot", read);
  expect(f.bridge.getConversationHistory).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceOverride: "/srv/later-project" }));
});
it("leaves scoped resume fallback to the controller when no explicit workspace is configured", async () => {
  const f = await fixture(); await f.configure({ resume: { sessionId: "other-session", workspacePath: "/srv/other-conversation", dirName: "other" } });
  await f.run("history.snapshot", read);
  expect(f.bridge.getConversationHistory.mock.calls[0]?.[0]).not.toHaveProperty("workspaceOverride");
  await expect(f.run("history.snapshot", { ...read, workspaceOverride: "/srv/untrusted" })).rejects.toThrow();
});
it("records unreadable config as a definite pre-mutation refusal and allows receipt/finalization", async () => {
  const f = await fixture(); await f.configure("{broken");
  const refusal = { outcome: "rejected", reason: "storage_unavailable" };
  expect(await f.run("history.apply", change)).toEqual(refusal);
  expect(f.bridge.applyConversationHistory).not.toHaveBeenCalled();
  expect(await f.run("history.receipt", change)).toEqual({ result: refusal });
  await f.run("history.finalize", { ...change, result: refusal });
  expect(f.bridge.finalizeConversationHistory).toHaveBeenCalledOnce();
});
