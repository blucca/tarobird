import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import type { BridgeAuthorizedMessageInput } from "../src/runtime/bridge.js";

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(batchWindowMs = 0) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "core-history-")); roots.push(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", locale: "en", approvalMode: "bypass" }));
  const runtime = createCoreServiceRuntime({ queuePolicy: { batchWindowMs } });
  const channel = { send: vi.fn(async () => ({ messageId: "reply" })), recallMessage: vi.fn(async () => {}), addReaction: vi.fn(async () => "reaction"), removeReaction: vi.fn(async () => {}), canSteerConversation: vi.fn(async () => true), prepareConversation: vi.fn(async () => {}) };
  const calls: BridgeAuthorizedMessageInput[] = [];
  const bridge = { checkAccess: vi.fn(async () => ({ kind: "allow" as const })), handleAuthorizedMessage: vi.fn(async (input: BridgeAuthorizedMessageInput) => { calls.push(input); return { text: "engine answer" }; }) };
  let sequence = 0;
  const send = (content: string, extra: Record<string, unknown> = {}, profile: "gateway" | "feishu" = "gateway") => {
    const messageId = `input-${++sequence}`;
    return withChannelProfile(profile, () => handleCoreMessage({ stateDir, runtime, bridge: bridge as never, channel: channel as never,
      message: { messageId, chatId: "owner-chat", chatType: "p2p", senderId: "owner", content, rawContentType: "text", resources: [], mentions: [], mentionedBot: false, ...extra } as never,
    }));
  };
  return { runtime, calls, send };
}

describe("owner message native history boundaries", () => {
  it("marks a normal direct App message with its actual input ID", async () => {
    const f = await fixture(); await f.send("Please explain this result");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.historyInputMessageId).toBe("input-1");
  });
  it.each(["/skill:review", "/extension argument"])("does not guess a model boundary for native command %s", async command => {
    const f = await fixture(); await f.send(command);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.historyInputMessageId).toBeUndefined();
  });
  it("does not treat a signed Bot input as an owner's history point", async () => {
    const f = await fixture(); await f.send("Review this work", { botSource: { hostId: "host-fixture", hostName: "Example", botId: "bot-fixture", botName: "Reviewer", requestId: "request-fixture", hops: 1 } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.historyInputMessageId).toBeUndefined();
  });
  it("does not publish App point metadata for another channel", async () => {
    const f = await fixture(); await f.send("Ordinary message", {}, "feishu");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.historyInputMessageId).toBeUndefined();
  });
  it("does not map a merged burst to only its last App message", async () => {
    const f = await fixture(10_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const first = f.send("First part");
    await vi.waitFor(() => expect(f.runtime.pendingBatches.size).toBe(1), { timeout: 5000 });
    const second = f.send("Second part");
    await vi.waitFor(() => expect([...f.runtime.pendingBatches.values()][0]?.members).toHaveLength(2), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, second]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.text).toContain("First part");
    expect(f.calls[0]?.text).toContain("Second part");
    expect(f.calls[0]?.historyInputMessageId).toBeUndefined();
  });
});
