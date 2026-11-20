import { describe, expect, it } from "vitest";
import { CAPABILITIES, type Conversation, type Message } from "../../src/client-protocol/index.js";
import { SNAPSHOT_ACTIVITY_CAPABILITY } from "../../src/client-protocol/snapshot.js";
import { HISTORY_CAPABILITY, type HistoryStatus, type RewindRange, type UpstreamRejection } from "../../src/client-protocol/history.js";
import en from "../src/locales/en.json" with { type: "json" };
import {
  buildTimelineRows,
  computeRewindSummary,
  conversationHistoryEntries,
  findLastUpstreamRejectionMessageId,
  historyBlockedReasonKey,
  historyErrorKey,
  isMessageRewound,
  messageHistoryEntries,
  resolveUpstreamRejectionActions,
} from "../src/conversation-history.js";

function msg(overrides: Partial<Message> & { id: string; createdAt: number }): Message {
  return {
    conversationId: "gw_chat",
    authorId: "owner",
    authorType: "user",
    blocks: [{ type: "text", text: `message ${overrides.id}` }],
    status: "complete",
    version: 1,
    ...overrides,
  };
}

function botMsg(overrides: Partial<Message> & { id: string; createdAt: number }): Message {
  return msg({ authorId: "bot_1", authorType: "bot", ...overrides });
}

function rejectionCard(id: string, createdAt: number, rejection: UpstreamRejection): Message {
  return botMsg({
    id,
    createdAt,
    blocks: [{
      type: "card",
      title: "上游拒收了这段对话",
      template: "orange",
      elements: [{ type: "markdown", text: "请求无效" }],
      extra: { upstreamRejection: rejection },
    }],
  });
}

function conv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "gw_chat",
    type: "direct",
    title: "示例对话",
    ownerId: "owner",
    botIds: ["bot_1"],
    archived: false,
    createdAt: 1000,
    ...overrides,
  };
}

describe("conversation history helpers (#53)", () => {
  it("keeps client hello capabilities at or below 64 and excludes conversations.history.v1", () => {
    const hello = [...CAPABILITIES, SNAPSHOT_ACTIVITY_CAPABILITY];
    expect(hello.length).toBeLessThanOrEqual(64);
    expect(hello).not.toContain(HISTORY_CAPABILITY);
  });

  it("evaluates rewind ranges across boundaries, unions, nested ranges and empty lists", () => {
    expect(isMessageRewound({ id: "m1", createdAt: 100 }, undefined)).toBe(false);
    expect(isMessageRewound({ id: "m1", createdAt: 100 }, [])).toBe(false);

    const ranges: RewindRange[] = [
      { id: "hop_1", fromMessageId: "m2", fromCreatedAt: 200, throughMessageId: "m3", throughCreatedAt: 300, at: 350, by: "owner" },
      { id: "hop_2", fromMessageId: "m5", fromCreatedAt: 500, throughMessageId: "m7", throughCreatedAt: 700, at: 750, by: "owner" },
      // Nested inside hop_2
      { id: "hop_3", fromMessageId: "m6", fromCreatedAt: 550, throughMessageId: "m6", throughCreatedAt: 650, at: 660, by: "owner" },
    ];
    expect(isMessageRewound({ id: "m1", createdAt: 199 }, ranges)).toBe(false);
    expect(isMessageRewound({ id: "m2", createdAt: 200 }, ranges)).toBe(true);
    expect(isMessageRewound({ id: "m2b", createdAt: 250 }, ranges)).toBe(true);
    expect(isMessageRewound({ id: "m3", createdAt: 300 }, ranges)).toBe(true);
    expect(isMessageRewound({ id: "m4", createdAt: 301 }, ranges)).toBe(false);
    expect(isMessageRewound({ id: "m4b", createdAt: 499 }, ranges)).toBe(false);
    expect(isMessageRewound({ id: "m5", createdAt: 500 }, ranges)).toBe(true);
    expect(isMessageRewound({ id: "m6", createdAt: 600 }, ranges)).toBe(true);
    expect(isMessageRewound({ id: "m7", createdAt: 700 }, ranges)).toBe(true);
    expect(isMessageRewound({ id: "m8", createdAt: 701 }, ranges)).toBe(false);
  });

  it("matches every row of the §5.1 capability & single-message visibility table", () => {
    const m1 = msg({ id: "m1", createdAt: 100 });
    const m2 = msg({ id: "m2", createdAt: 200 });
    const b1 = botMsg({ id: "b1", createdAt: 150 });
    const list = [m1, b1, m2];
    const c = conv();

    // Host without capability -> everything hidden
    const fullStatus: HistoryStatus = { supported: true, rewind: "turn", fork: "turn" };
    expect(conversationHistoryEntries({ historyAvailable: false, status: fullStatus, conversation: c, online: true })).toEqual({ showForkHead: false, disabled: false });
    expect(messageHistoryEntries({ historyAvailable: false, status: fullStatus, conversation: c, message: m1, messages: list, online: true })).toEqual({ showForkTurn: false, showRewind: false, disabled: false });

    // supported: false -> everything hidden
    const unsupported: HistoryStatus = { supported: false, rewind: "none", fork: "none", reason: "unsupported" };
    expect(conversationHistoryEntries({ historyAvailable: true, status: unsupported, conversation: c, online: true }).showForkHead).toBe(false);
    expect(messageHistoryEntries({ historyAvailable: true, status: unsupported, conversation: c, message: m1, messages: list, online: true })).toEqual({ showForkTurn: false, showRewind: false, disabled: false });

    // Codex: rewind: turn, fork: turn
    expect(conversationHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, online: true })).toEqual({ showForkHead: true, disabled: false });
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, message: m2, messages: list, online: true })).toEqual({ showForkTurn: true, showRewind: true, disabled: false });

    // DeepSeek: rewind: none, fork: turn
    const forkTurnOnly: HistoryStatus = { supported: true, rewind: "none", fork: "turn" };
    expect(conversationHistoryEntries({ historyAvailable: true, status: forkTurnOnly, conversation: c, online: true }).showForkHead).toBe(true);
    expect(messageHistoryEntries({ historyAvailable: true, status: forkTurnOnly, conversation: c, message: m2, messages: list, online: true })).toEqual({ showForkTurn: true, showRewind: false, disabled: false });

    // Claude / Kimi: rewind: none, fork: head
    const forkHeadOnly: HistoryStatus = { supported: true, rewind: "none", fork: "head" };
    expect(conversationHistoryEntries({ historyAvailable: true, status: forkHeadOnly, conversation: c, online: true }).showForkHead).toBe(true);
    expect(messageHistoryEntries({ historyAvailable: true, status: forkHeadOnly, conversation: c, message: m2, messages: list, online: true })).toEqual({ showForkTurn: false, showRewind: false, disabled: false });

    // rewind: turn, fork: none (hypothetical / unauthorized fork)
    const rewindOnly: HistoryStatus = { supported: true, rewind: "turn", fork: "none" };
    expect(conversationHistoryEntries({ historyAvailable: true, status: rewindOnly, conversation: c, online: true }).showForkHead).toBe(false);
    expect(messageHistoryEntries({ historyAvailable: true, status: rewindOnly, conversation: c, message: m2, messages: list, online: true })).toEqual({ showForkTurn: false, showRewind: true, disabled: false });

    // Single-message exclusions (§5.1)
    // 1. Bot message
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, message: b1, messages: list, online: true })).toEqual({ showForkTurn: false, showRewind: false, disabled: false });
    // 2. Steering block
    const steering = msg({ id: "ms", createdAt: 210, blocks: [{ type: "text", text: "steer" }, { type: "steering", botId: "bot_1", targetId: "b1", outcome: "accepted" }] });
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, message: steering, messages: [...list, steering], online: true }).showRewind).toBe(false);
    // 3. Slash command vs Unix path
    const slash = msg({ id: "mc", createdAt: 220, blocks: [{ type: "text", text: "/reset" }] });
    const unixPath = msg({ id: "mp", createdAt: 225, blocks: [{ type: "text", text: "/tmp/log please check" }] });
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, message: slash, messages: [...list, slash], online: true }).showRewind).toBe(false);
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, message: unixPath, messages: [...list, unixPath], online: true }).showRewind).toBe(true);
    // 4. Non-complete status
    const pending = msg({ id: "mpend", createdAt: 230, status: "pending" });
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: c, message: pending, messages: [...list, pending], online: true }).showRewind).toBe(false);
    // 5. Already rewound
    const rewoundConv = conv({ history: { rewinds: [{ id: "hop_1", fromMessageId: "m2", fromCreatedAt: 200, throughMessageId: "m2", throughCreatedAt: 200, at: 250, by: "owner" }] } });
    expect(messageHistoryEntries({ historyAvailable: true, status: fullStatus, conversation: rewoundConv, message: m2, messages: list, online: true }).showRewind).toBe(false);
    // 6. Earlier than sinceMessageId
    const sinceStatus: HistoryStatus = { supported: true, rewind: "turn", fork: "turn", sinceMessageId: "m2" };
    expect(messageHistoryEntries({ historyAvailable: true, status: sinceStatus, conversation: c, message: m1, messages: list, online: true }).showRewind).toBe(false);
    expect(messageHistoryEntries({ historyAvailable: true, status: sinceStatus, conversation: c, message: m2, messages: list, online: true }).showRewind).toBe(true);
    // 7. Blocked -> shown but disabled with exact reason key
    const blockedStatus: HistoryStatus = { supported: true, rewind: "turn", fork: "turn", blocked: "running" };
    expect(messageHistoryEntries({ historyAvailable: true, status: blockedStatus, conversation: c, message: m2, messages: list, online: true })).toEqual({
      showForkTurn: true,
      showRewind: true,
      disabled: true,
      blockedReasonKey: "当前轮结束或停止后可用",
    });
    expect(conversationHistoryEntries({ historyAvailable: true, status: blockedStatus, conversation: c, online: true })).toEqual({
      showForkHead: true,
      disabled: true,
      blockedReasonKey: "当前轮结束或停止后可用",
    });
  });

  it("computes rewind confirmation message counts and first-in-context flag", () => {
    const u1 = msg({ id: "u1", createdAt: 100 });
    const b1 = botMsg({ id: "b1", createdAt: 110 });
    const u2 = msg({ id: "u2", createdAt: 200 });
    const b2 = botMsg({ id: "b2", createdAt: 210 });
    const u3 = msg({ id: "u3", createdAt: 300 });
    const b3 = botMsg({ id: "b3", createdAt: 310 });
    const messages = [u1, b1, u2, b2, u3, b3];
    const status: HistoryStatus = { supported: true, rewind: "turn", fork: "turn" };

    expect(computeRewindSummary(messages, "u1", status, undefined)).toEqual({ isFirstInContext: true, laterCount: 5 });
    expect(computeRewindSummary(messages, "u2", status, undefined)).toEqual({ isFirstInContext: false, laterCount: 3 });
    expect(computeRewindSummary(messages, "u3", status, undefined)).toEqual({ isFirstInContext: false, laterCount: 1 });

    // With sinceMessageId at u2, u2 is now the first message of the current session
    expect(computeRewindSummary(messages, "u2", { ...status, sinceMessageId: "u2" }, undefined)).toEqual({ isFirstInContext: true, laterCount: 3 });

    // Already-rewound tail (u3, b3) is excluded from laterCount when rewinding u2
    const rewinds: RewindRange[] = [{ id: "hop_1", fromMessageId: "u3", fromCreatedAt: 300, throughMessageId: "b3", throughCreatedAt: 310, at: 320, by: "owner" }];
    expect(computeRewindSummary(messages, "u2", status, rewinds)).toEqual({ isFirstInContext: false, laterCount: 1 });
  });

  it("collapses consecutive rewound messages by default and expands locally on toggle", () => {
    const u1 = msg({ id: "u1", createdAt: 100 });
    const b1 = botMsg({ id: "b1", createdAt: 110 });
    const u2 = msg({ id: "u2", createdAt: 200 });
    const b2 = botMsg({ id: "b2", createdAt: 210 });
    const u3 = msg({ id: "u3", createdAt: 300 });
    const rewinds: RewindRange[] = [{ id: "hop_1", fromMessageId: "u2", fromCreatedAt: 200, throughMessageId: "b2", throughCreatedAt: 210, at: 250, by: "owner" }];

    const collapsed = buildTimelineRows([u1, b1, u2, b2, u3], rewinds, new Set());
    expect(collapsed.rows.map(r => r.kind === "rewind-group" ? `group:${r.count}:${r.expanded}` : r.message.id)).toEqual([
      "u1", "b1", "group:2:false", "u3",
    ]);
    expect(collapsed.groupByMessageId.get("u2")).toBe("rewind:u2");
    expect(collapsed.groupByMessageId.get("b2")).toBe("rewind:u2");

    const expanded = buildTimelineRows([u1, b1, u2, b2, u3], rewinds, new Set(["rewind:u2"]));
    expect(expanded.rows.map(r => r.kind === "rewind-group" ? `group:${r.count}:${r.expanded}` : `${r.message.id}:${r.rewound}`)).toEqual([
      "u1:false", "b1:false", "group:2:true", "u2:true", "b2:true", "u3:false",
    ]);
  });

  it("places upstreamRejection actions only on the last marked message and varies by capability (§5.6)", () => {
    const u1 = msg({ id: "u1", createdAt: 100 });
    const b1 = botMsg({ id: "b1", createdAt: 110 });
    const u2 = msg({ id: "u2", createdAt: 200 });
    const r1 = rejectionCard("r1", 210, { v: 1, streak: 2, firstMessageId: "u2" });
    const u3 = msg({ id: "u3", createdAt: 300 });
    const r2 = rejectionCard("r2", 310, { v: 1, streak: 3, firstMessageId: "u2" });
    const messages = [u1, b1, u2, r1, u3, r2];

    expect(findLastUpstreamRejectionMessageId(messages, undefined)).toBe("r2");

    // Rewound r2 is ignored; falls back to earlier non-rewound r1 (or undefined if all rewound)
    const rewoundR2: RewindRange[] = [{ id: "hop_1", fromMessageId: "u3", fromCreatedAt: 300, throughMessageId: "r2", throughCreatedAt: 310, at: 320, by: "owner" }];
    expect(findLastUpstreamRejectionMessageId(messages, rewoundR2)).toBe("r1");

    const rej: UpstreamRejection = { v: 1, streak: 3, firstMessageId: "u2" };

    // 1. rewind: "turn" -> primary rewind(u2) + secondary new-chat
    expect(resolveUpstreamRejectionActions({
      messages, rejection: rej, historyAvailable: true,
      status: { supported: true, rewind: "turn", fork: "turn" },
      online: true, canCreateChat: true,
    })).toEqual({
      primary: { kind: "rewind", targetMessageId: "u2", disabled: false, blockedReasonKey: undefined },
      secondary: { kind: "new-chat" },
    });

    // 2. rewind: "none", fork: "turn" -> primary fork(u1, the previous run before u2) + secondary new-chat
    expect(resolveUpstreamRejectionActions({
      messages, rejection: rej, historyAvailable: true,
      status: { supported: true, rewind: "none", fork: "turn" },
      online: true, canCreateChat: true,
    })).toEqual({
      primary: { kind: "fork", targetMessageId: "u1", disabled: false, blockedReasonKey: undefined },
      secondary: { kind: "new-chat" },
    });

    // 2b. rewind: "none", fork: "turn", but NO earlier run before firstMessageId -> only new-chat
    expect(resolveUpstreamRejectionActions({
      messages, rejection: { v: 1, streak: 2, firstMessageId: "u1" }, historyAvailable: true,
      status: { supported: true, rewind: "none", fork: "turn" },
      online: true, canCreateChat: true,
    })).toEqual({
      primary: { kind: "new-chat" },
    });

    // 3. Claude/Kimi (fork: "head") or Antigravity (supported: false) -> only new-chat
    expect(resolveUpstreamRejectionActions({
      messages, rejection: rej, historyAvailable: true,
      status: { supported: true, rewind: "none", fork: "head" },
      online: true, canCreateChat: true,
    })).toEqual({
      primary: { kind: "new-chat" },
    });
    expect(resolveUpstreamRejectionActions({
      messages, rejection: rej, historyAvailable: true,
      status: { supported: false, rewind: "none", fork: "none", reason: "unsupported" },
      online: true, canCreateChat: true,
    })).toEqual({
      primary: { kind: "new-chat" },
    });
  });

  it("provides English translations for every dynamic blocked and error reason key", () => {
    const dictionary = en as Record<string, string>;
    for (const blocked of ["running", "queued", "pending_action", "goal_active", "background_work", "operation_active", "no_main_session"] as const) {
      expect(dictionary[historyBlockedReasonKey(blocked)]).toBeTruthy();
    }
    for (const err of ["unsupported", "busy", "goal_active", "no_main_session", "history_changed", "not_an_anchor", "already_rewound", "session_changed", "turn_unresolved", "engine_busy", "engine_failed", "uncertain"] as const) {
      expect(dictionary[historyErrorKey(err)]).toBeTruthy();
    }
  });
});
