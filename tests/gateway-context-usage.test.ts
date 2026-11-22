import { describe, expect, it, vi } from "vitest";
import { contextUsageSchema } from "../src/client-protocol/context-usage.js";
import { gatewayContextUsage } from "../src/gateway/context-usage.js";

describe("context usage of one conversation", () => {
  function fixture(usage: unknown = { pressureTokens: 1200, contextWindow: 200_000 }) {
    const bridge = { handleAuthorizedMessage: vi.fn(), getContextUsage: vi.fn(async () => usage as never) };
    const channel = { canSteerConversation: vi.fn(async () => true) };
    return { bridge, channel, run: gatewayContextUsage(bridge, channel) };
  }
  it("reports what the engine says for the bound session and starts nothing", async () => {
    const f = fixture({ pressureTokens: 1200.4, contextWindow: 200_000, autoCompactTokens: 167_000 });
    expect(await f.run({ conversationId: "chat" })).toEqual({ supported: true, usedTokens: 1200, windowTokens: 200_000, autoCompactTokens: 167_000 });
    expect(f.bridge.getContextUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationKey: "lark:chat" }));
    expect(f.bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });
  it("prefers the engine's projection over its last sample, as /context does", async () => {
    expect(await fixture({ pressureTokens: 100, projectedTokens: 900, contextWindow: 1000 }).run({ conversationId: "chat" })).toEqual({ supported: true, usedTokens: 900, windowTokens: 1000 });
  });
  it("has no numbers before the engine has a sample", async () => {
    for (const usage of [null, {}, { pressureTokens: 5 }, { contextWindow: 1000 }, { pressureTokens: 5, contextWindow: 0 }, { pressureTokens: Number.NaN, contextWindow: 1000 }, { pressureTokens: -1, contextWindow: 1000 }])
      expect(await fixture(usage).run({ conversationId: "chat" })).toEqual({ supported: true });
  });
  it("leaves out a compaction point that is not below the window", async () => {
    expect(await fixture({ pressureTokens: 5, contextWindow: 1000, autoCompactTokens: 1000 }).run({ conversationId: "chat" })).toEqual({ supported: true, usedTokens: 5, windowTokens: 1000 });
  });
  it("does not ask the engine for a conversation whose session binding is not applied", async () => {
    const f = fixture(); f.channel.canSteerConversation.mockResolvedValue(false);
    expect(await f.run({ conversationId: "chat" })).toEqual({ supported: true });
    expect(f.bridge.getContextUsage).not.toHaveBeenCalled();
  });
  it("discards a reading if the binding changes while the engine answers", async () => {
    const f = fixture(); f.channel.canSteerConversation.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await f.run({ conversationId: "chat" })).toEqual({ supported: true });
  });
  it("is unsupported for a runtime without a source, not an error", async () => {
    expect(await gatewayContextUsage({ handleAuthorizedMessage: vi.fn() }, {})({ conversationId: "chat" })).toEqual({ supported: false });
    const f = fixture(); f.bridge.getContextUsage.mockRejectedValue(new Error("Context usage is not available for this runtime"));
    expect(await f.run({ conversationId: "chat" })).toEqual({ supported: false });
  });
  it("accepts only a conversation id and returns only the public fields", async () => {
    const f = fixture();
    await expect(f.run({ conversationId: "chat", sessionId: "other" })).rejects.toThrow();
    await expect(f.run({ conversationId: "../chat" })).rejects.toThrow();
    expect(contextUsageSchema.safeParse({ supported: true, usedTokens: 1, windowTokens: 2, model: "x" }).success).toBe(false);
    expect(contextUsageSchema.safeParse({ supported: true, usedTokens: 1, windowTokens: 0 }).success).toBe(false);
  });
});
