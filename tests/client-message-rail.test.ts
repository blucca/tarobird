import { describe, expect, it } from "vitest";
import type { Message } from "../src/client-protocol/index.js";
import {
  buildMessageRailItems,
  findActiveRailItemId,
  isRailAnchorMessage,
  sampleMessageRailItems,
} from "../client/src/message-rail.js";

function msg(overrides: Partial<Message> & { id: string; authorType: Message["authorType"] }): Message {
  return {
    conversationId: "conv_1",
    authorId: overrides.authorType === "user" ? "owner" : "bot_1",
    blocks: [{ type: "text", text: "Hello" }],
    status: "complete",
    version: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("message-rail pure helpers", () => {
  it("builds one rail item per non-deleted user turn with reply previews and excludes internal discussion inputs", () => {
    const messages: Message[] = [
      msg({ id: "u1", authorType: "user", blocks: [{ type: "text", text: "First question\nwith newline" }], createdAt: 1000 }),
      msg({ id: "b1", authorType: "bot", authorId: "bot_a", replyTo: "u1", blocks: [{ type: "text", text: "First reply summary" }], createdAt: 2000 }),
      msg({ id: "u_del", authorType: "user", status: "deleted", blocks: [{ type: "text", text: "Withdrawn" }], createdAt: 3000 }),
      msg({ id: "u_sched", authorType: "user", groupDiscussion: { runId: "r1", role: "input", botId: "bot_a" }, blocks: [{ type: "text", text: "Internal turn" }], createdAt: 3500 }),
      msg({ id: "u2", authorType: "user", blocks: [{ type: "image", attachmentId: "att1", name: "diagram.png", mime: "image/png" }], createdAt: 4000 }),
      msg({ id: "b2", authorType: "bot", authorId: "bot_b", blocks: [{ type: "text", text: "Second reply" }], createdAt: 5000 }),
      msg({
        id: "u3",
        authorType: "user",
        botSource: { hostId: "h1", hostName: "macmini", botId: "b_peer", botName: "Helper", hops: 1 },
        blocks: [{ type: "text", text: "Delegated task" }],
        createdAt: 6000,
      }),
    ];

    expect(isRailAnchorMessage(messages[2]!)).toBe(false);
    expect(isRailAnchorMessage(messages[3]!)).toBe(false);

    const items = buildMessageRailItems(messages, {
      isGroup: true,
      botName: (id) => id === "bot_a" ? "Architect" : id === "bot_b" ? "Reviewer" : id,
    });

    expect(items).toEqual([
      {
        id: "u1",
        index: 0,
        turnNumber: 1,
        prompt: "First question with newline",
        replyPreview: "First reply summary",
        replyAuthor: "Architect",
        createdAt: 1000,
      },
      {
        id: "u2",
        index: 4,
        turnNumber: 2,
        prompt: "diagram.png",
        replyPreview: "Second reply",
        replyAuthor: "Reviewer",
        createdAt: 4000,
      },
      {
        id: "u3",
        index: 6,
        turnNumber: 3,
        prompt: "Delegated task",
        sourceLabel: "macmini · Helper",
        createdAt: 6000,
      },
    ]);
  });

  it("samples long histories evenly while always preserving first, last, and active items", () => {
    const items = Array.from({ length: 120 }, (_, i) => ({
      id: `u_${i + 1}`,
      index: i * 2,
      turnNumber: i + 1,
      prompt: `Prompt ${i + 1}`,
      createdAt: 1000 + i * 1000,
    }));

    const sampled = sampleMessageRailItems(items, "u_37", 40);
    expect(sampled.length).toBe(40);
    expect(sampled[0]!.id).toBe("u_1");
    expect(sampled[sampled.length - 1]!.id).toBe("u_120");
    expect(sampled.some((item) => item.id === "u_37")).toBe(true);

    // Strictly ascending indices with no duplicates.
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled[i]!.turnNumber).toBeGreaterThan(sampled[i - 1]!.turnNumber);
    }
  });

  it("tracks active rail item accurately as anchor index moves through replies and tail", () => {
    const items = [
      { id: "u1", index: 0, turnNumber: 1, prompt: "One", createdAt: 1000 },
      { id: "u2", index: 3, turnNumber: 2, prompt: "Two", createdAt: 2000 },
      { id: "u3", index: 6, turnNumber: 3, prompt: "Three", createdAt: 3000 },
    ];

    expect(findActiveRailItemId(items, 0, false)).toBe("u1");
    expect(findActiveRailItemId(items, 2, false)).toBe("u1"); // still inside turn 1's replies
    expect(findActiveRailItemId(items, 3, false)).toBe("u2");
    expect(findActiveRailItemId(items, 5, false)).toBe("u2");
    expect(findActiveRailItemId(items, 0, true)).toBe("u3"); // scrolled to bottom
    expect(findActiveRailItemId([], 0, false)).toBeUndefined();
  });

  it("matches explicit replyTo bot replies even when user follow-ups arrive first", () => {
    const messages: Message[] = [
      msg({ id: "u1", authorType: "user", blocks: [{ type: "text", text: "First prompt" }], createdAt: 1000 }),
      msg({ id: "u2", authorType: "user", blocks: [{ type: "text", text: "Second prompt" }], createdAt: 1000 }),
      msg({ id: "b1", authorType: "bot", authorId: "bot_a", replyTo: "u1", blocks: [{ type: "text", text: "Late reply to first" }], createdAt: 1000 }),
    ];
    const items = buildMessageRailItems(messages, { isGroup: true, botName: () => "Architect" });
    expect(items[0]?.replyPreview).toBe("Late reply to first");
    expect(items[0]?.replyAuthor).toBe("Architect");
  });
});
