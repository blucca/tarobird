import { describe, expect, it } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import { ConversationMessageCache } from "../src/message-lru-cache.js";

function msg(id: string, conversationId: string, createdAt: number, text = id, version = 1): Message {
  return {
    id,
    conversationId,
    authorId: "bot_1",
    authorType: "bot",
    blocks: [{ type: "text", text }],
    status: "complete",
    version,
    createdAt,
  };
}

describe("ConversationMessageCache", () => {
  it("evicts least recently used conversations when exceeding maxConversations", () => {
    const cache = new ConversationMessageCache(2, 100);
    cache.set("c1", [msg("m1", "c1", 1)], 1);
    cache.set("c2", [msg("m2", "c2", 2)], 2);
    // Touch c1 so c2 becomes LRU
    expect(cache.peek("c1")?.messages).toHaveLength(1);
    cache.set("c3", [msg("m3", "c3", 3)], 3);

    expect(cache.peek("c1")).toBeDefined();
    expect(cache.peek("c2")).toBeUndefined();
    expect(cache.peek("c3")).toBeDefined();
    expect(cache.stats()).toEqual({ conversations: 2, totalMessages: 2 });
  });

  it("evicts older entries to stay within maxMessages and skips oversized entries", () => {
    const cache = new ConversationMessageCache(10, 5);
    cache.set("c1", [msg("a1", "c1", 1), msg("a2", "c1", 2), msg("a3", "c1", 3)]);
    cache.set("c2", [msg("b1", "c2", 1), msg("b2", "c2", 2), msg("b3", "c2", 3)]);

    expect(cache.peek("c1")).toBeUndefined();
    expect(cache.peek("c2")?.messages).toHaveLength(3);
    expect(cache.stats()).toEqual({ conversations: 1, totalMessages: 3 });

    // Oversized conversation (> maxMessages) is not cached
    expect(cache.set("huge", Array.from({ length: 6 }, (_, i) => msg(`h${i}`, "huge", i)))).toBe(false);
    expect(cache.peek("huge")).toBeUndefined();
  });

  it("patches streamed/new messages in-place while preserving unchanged message identities", () => {
    const cache = new ConversationMessageCache(4, 100);
    const m1 = msg("m1", "c1", 10, "hello");
    const m2 = { ...msg("m2", "c1", 20, "stream 1", 1), status: "streaming" as const };
    cache.set("c1", [m1, m2], 1);

    const m2Updated = { ...msg("m2", "c1", 20, "stream 2", 2), status: "complete" as const };
    expect(cache.patchMessage("c1", m2Updated)).toBe(true);

    const hit = cache.peek("c1")!;
    expect(hit.messages).toHaveLength(2);
    expect(hit.messages[0]).toBe(m1);
    expect(hit.messages[1]).toBe(m2Updated);

    // Out-of-order append inserts in createdAt order
    const mEarly = msg("m0", "c1", 5, "early");
    expect(cache.patchMessage("c1", mEarly)).toBe(true);
    expect(cache.peek("c1")!.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);

    // Patching an uncached conversation does not create partial history
    expect(cache.patchMessage("uncached", msg("x", "uncached", 1))).toBe(false);
    expect(cache.peek("uncached")).toBeUndefined();
  });

  it("invalidates single conversations and full cache cleanly", () => {
    const cache = new ConversationMessageCache(4, 100);
    cache.set("c1", [msg("m1", "c1", 1)]);
    cache.set("c2", [msg("m2", "c2", 2)]);

    cache.invalidate("c1");
    expect(cache.peek("c1")).toBeUndefined();
    expect(cache.stats()).toEqual({ conversations: 1, totalMessages: 1 });

    cache.invalidate();
    expect(cache.stats()).toEqual({ conversations: 0, totalMessages: 0 });
  });
});
