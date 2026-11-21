import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineSteeringRejectedError } from "../src/codex/adapter.js";
import { gatewaySteering } from "../src/gateway/steering.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { CoreGoalRunController } from "../src/core/bus.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { STEERING_OUTCOME_CAPABILITY } from "../src/client-protocol/steering-outcome.js";

const source = { hostId: "hub_source", hostName: "Mac", botId: "coordinator", botName: "Coordinator \"A\"", requestId: "req_1", hops: 1 };

describe("Gateway Bot-message steering (#62)", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "gateway-bot-steer-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  function fixture(engine = "codex") {
    const runtime = createCoreServiceRuntime(), key = buildCoreConversationKey("gw_chat");
    runtime.activeRuns.set(key, { abortController: new AbortController(), startedAt: Date.now() - 100_000, sourceMessageId: "msg_turn" });
    const bridge = { supportsSteering: vi.fn(() => true), steerActiveTurn: vi.fn(async (_input: { text: string; onOutcome?: (outcome: unknown) => void }) => true), handleAuthorizedMessage: vi.fn(async () => ({ text: "" })) };
    const requests: { method: string; params: unknown }[] = [];
    const channel = { canSteerConversation: vi.fn(async () => true), transport: { capabilities: [STEERING_OUTCOME_CAPABILITY], options: {}, request: vi.fn(async (method: string, params: unknown) => { requests.push({ method, params }); return null; }) } };
    const create = () => gatewaySteering(bridge, runtime, channel as unknown as GatewayChannel, root, engine);
    const run = create();
    const status = () => run("botMessage.steer.status", { conversationId: "gw_chat" }) as Promise<{ supported: boolean; targetId?: string; sourceMessageId?: string; reason?: string }>;
    const call = async (extra: Record<string, unknown> = {}) => ({ conversationId: "gw_chat", userId: "owner", requestId: "bm_one", targetId: (await status()).targetId!, sourceMessageId: "msg_turn", text: "Use staging", source, ...extra });
    return { runtime, key, bridge, channel, requests, run, create, status, call };
  }

  it("reports the live run of exactly this conversation with its source input", async () => {
    const f = fixture();
    expect(await f.status()).toEqual({ supported: true, targetId: expect.any(String), sourceMessageId: "msg_turn" });
    expect(await f.run("botMessage.steer.status", { conversationId: "gw_other" })).toEqual({ supported: true, reason: "no_active_turn" });
    await expect(f.run("botMessage.steer.status", { conversationId: "gw_chat", backgroundReview: true })).rejects.toThrow();
  });

  it("is unavailable for engines other than Codex and Claude, even with an adapter steering path", async () => {
    for (const engine of ["pi", "deepseek", "kimi", "antigravity"]) {
      const f = fixture(engine);
      expect(await f.status()).toEqual({ supported: false, reason: "unsupported_engine" });
      expect(await f.run("botMessage.steer", { ...await fixture("codex").call(), requestId: `bm_${engine}` })).toEqual({ outcome: "rejected", reason: "unsupported" });
      expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
    }
    expect((await fixture("claude").status()).supported).toBe(true);
  });

  it("never offers an autonomous goal or a background-review turn", async () => {
    const f = fixture();
    f.runtime.activeRuns.set(f.key, { abortController: new CoreGoalRunController(), goalWatch: true, sourceMessageId: "msg_goal" });
    expect(await f.status()).toEqual({ supported: true, reason: "no_active_turn" });
  });

  it("appends attributed plain text to the live run exactly once and reports adoption to the Hub record", async () => {
    const f = fixture(), request = await f.call();
    const results = await Promise.all([f.run("botMessage.steer", request), f.run("botMessage.steer", request)]);
    expect(results).toEqual([{ outcome: "accepted", sourceMessageId: "msg_turn" }, { outcome: "accepted", sourceMessageId: "msg_turn" }]);
    expect(await f.create()("botMessage.steer", request)).toEqual({ outcome: "accepted", sourceMessageId: "msg_turn" });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
    const sent = f.bridge.steerActiveTurn.mock.calls[0]![0] as { text: string; nativeInput?: unknown; throwOnError?: boolean; onOutcome?: (o: unknown) => void };
    expect(sent.text.endsWith("\nUse staging")).toBe(true);
    expect(sent.text).toContain("hub_source"); expect(sent.text).toContain("coordinator"); expect(sent.text).toContain("not typed by the owner");
    expect(sent.text.split("\n")[0]).not.toContain("\"A\"\n");
    expect(sent.nativeInput).toBeUndefined(); expect(sent.throwOnError).toBe(true);
    sent.onOutcome!({ status: "applied", via: "fold" });
    expect(f.requests).toEqual([{ method: "steer.outcome", params: { conversationId: "gw_chat", userId: "owner", requestId: "bm_one", targetId: request.targetId, application: { status: "applied", via: "fold" } } }]);
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    expect(f.runtime.chatQueue.pendingCount(f.key)).toBe(0);
  });

  it("refuses control text, another run, another source input and a changed binding before writing anything", async () => {
    const f = fixture(), request = await f.call();
    for (const text of ["/stop", " /approve", "/new task"]) expect(await f.run("botMessage.steer", { ...request, requestId: `bm_${text.trim().slice(1, 4)}`, text })).toEqual({ outcome: "rejected", reason: "unsupported" });
    expect(await f.run("botMessage.steer", { ...request, requestId: "bm_src", sourceMessageId: "msg_other" })).toEqual({ outcome: "rejected", reason: "stale" });
    expect(await f.run("botMessage.steer", { ...request, requestId: "bm_tok", targetId: "other_run" })).toEqual({ outcome: "rejected", reason: "stale" });
    f.channel.canSteerConversation.mockResolvedValueOnce(false);
    expect(await f.run("botMessage.steer", { ...request, requestId: "bm_bind" })).toEqual({ outcome: "rejected", reason: "binding_changed" });
    await expect(f.run("botMessage.steer", { ...request, requestId: "bm_mode", mode: "message" })).rejects.toThrow();
    expect(f.bridge.steerActiveTurn).not.toHaveBeenCalled();
  });

  it("rejects definitively when the run ends during the call, and stays uncertain on an ambiguous failure", async () => {
    const f = fixture(), request = await f.call();
    f.channel.canSteerConversation.mockImplementationOnce(async () => { f.runtime.activeRuns.delete(f.key); return true; });
    expect(await f.run("botMessage.steer", request)).toEqual({ outcome: "rejected", reason: "stale" });
    const g = fixture(), late = await g.call({ requestId: "bm_late" });
    g.bridge.steerActiveTurn.mockRejectedValueOnce(new EngineSteeringRejectedError("stale"));
    expect(await g.run("botMessage.steer", late)).toEqual({ outcome: "rejected", reason: "stale" });
    const h = fixture(), lost = await h.call({ requestId: "bm_lost" });
    h.bridge.steerActiveTurn.mockRejectedValueOnce(new Error("reply lost"));
    expect(await h.run("botMessage.steer", lost)).toEqual({ outcome: "unknown", reason: "uncertain", sourceMessageId: "msg_turn" });
    expect(await h.run("botMessage.steer", lost)).toEqual({ outcome: "unknown", reason: "uncertain", sourceMessageId: "msg_turn" });
    expect(h.bridge.steerActiveTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps Bot steer receipts apart from owner steer receipts", async () => {
    const f = fixture(), request = await f.call();
    expect(await f.run("botMessage.steer", request)).toEqual({ outcome: "accepted", sourceMessageId: "msg_turn" });
    expect(await f.run("steer", { conversationId: "gw_chat", userId: "owner", requestId: "bm_one", targetId: request.targetId, text: "Owner note" })).toEqual({ outcome: "accepted", sourceMessageId: "msg_turn" });
    expect(f.bridge.steerActiveTurn).toHaveBeenCalledTimes(2);
    expect((f.bridge.steerActiveTurn.mock.calls[1]![0] as { text: string }).text).toBe("Owner note");
  });
});
