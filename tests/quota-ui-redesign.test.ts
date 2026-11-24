import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotaScope } from "../src/client-protocol/engine-quota.js";
import { setLocale } from "../client/src/i18n.js";
import {
  formatQuotaWindowLabel,
  formatResetCountdown,
  groupQuotaScopesByAccount,
} from "../client/src/quota-ui.js";

const originalDocument = globalThis.document;
beforeAll(() => {
  if (!globalThis.document) {
    (globalThis as Record<string, unknown>).document = { documentElement: { lang: "" } };
  }
});
afterAll(() => {
  if (!originalDocument) {
    delete (globalThis as Record<string, unknown>).document;
  }
});

function makeScope(overrides: Partial<QuotaScope> & { id: string; label: string; engine: QuotaScope["engine"] }): QuotaScope {
  const now = "2026-11-24T04:00:00.000Z";
  return {
    id: overrides.id,
    revision: overrides.revision ?? `rev_${overrides.id}`,
    engine: overrides.engine,
    label: overrides.label,
    botIds: overrides.botIds ?? [overrides.id],
    sharing: overrides.sharing ?? "unverified",
    authMode: overrides.authMode ?? "subscription",
    capability: overrides.capability ?? { mode: "active" },
    state: overrides.state ?? "ready",
    availability: overrides.availability ?? "allowed",
    observedAt: overrides.observedAt ?? now,
    pools: overrides.pools ?? [],
    constraints: overrides.constraints ?? [],
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    ...(overrides.help ? { help: overrides.help } : {}),
  };
}

describe("Model quota UI redesign (#77)", () => {
  it("maps raw engine window names uniformly and keeps unknown names", () => {
    setLocale("en");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 18_000 })).toBe("5-hour window");
    expect(formatQuotaWindowLabel({ label: "Secondary", periodSeconds: 604_800 })).toBe("Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "5 hours", periodSeconds: 18_000 })).toBe("5-hour window");
    expect(formatQuotaWindowLabel({ label: "7 days", periodSeconds: 604_800 })).toBe("Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "Opus · 7 days", periodSeconds: 604_800 })).toBe("Opus · Weekly (7 days)");
    expect(formatQuotaWindowLabel({ label: "Gemini Models" })).toBe("Gemini Models");

    setLocale("zh");
    expect(formatQuotaWindowLabel({ label: "Primary", periodSeconds: 18_000 })).toBe("5 小时窗口");
    expect(formatQuotaWindowLabel({ label: "Secondary", periodSeconds: 604_800 })).toBe("周额度（7 天）");
    expect(formatQuotaWindowLabel({ label: "Opus · 7 days", periodSeconds: 604_800 })).toBe("Opus · 周额度（7 天）");
    expect(formatQuotaWindowLabel({ label: "Gemini Models" })).toBe("Gemini Models");
  });

  it("formats reset countdowns for days, hours+minutes, minutes, and already-passed reset times", () => {
    const now = Date.parse("2026-11-24T04:00:00.000Z");

    setLocale("en");
    expect(formatResetCountdown(new Date(now + 4 * 86_400_000 + 2 * 3_600_000).toISOString(), now)).toEqual({
      text: "Resets in 4 days",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 3 * 3_600_000 + 20 * 60_000).toISOString(), now)).toEqual({
      text: "Resets in 3 h 20 min",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 25 * 60_000).toISOString(), now)).toEqual({
      text: "Resets in 25 min",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now - 5_000).toISOString(), now)).toEqual({
      text: "Reset time reached; awaiting an update",
      expired: true,
    });

    setLocale("zh");
    expect(formatResetCountdown(new Date(now + 4 * 86_400_000).toISOString(), now)).toEqual({
      text: "4 天后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 3 * 3_600_000 + 20 * 60_000).toISOString(), now)).toEqual({
      text: "3 小时 20 分钟后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now + 25 * 60_000).toISOString(), now)).toEqual({
      text: "25 分钟后重置",
      expired: false,
    });
    expect(formatResetCountdown(new Date(now - 5_000).toISOString(), now)).toEqual({
      text: "已到重置时间，等待更新",
      expired: true,
    });
  });

  it("merges Bots confirmed on the same account into one card and keeps unconfirmed ones separate with reason", () => {
    const codexA = makeScope({
      id: "codex_a",
      label: "Codex Lead",
      engine: "codex",
      sharing: "verified",
      revision: "shared_codex_acct_1",
      observedAt: "2026-11-24T04:01:00.000Z",
    });
    const codexB = makeScope({
      id: "codex_b",
      label: "Code Reviewer",
      engine: "codex",
      sharing: "verified",
      revision: "shared_codex_acct_1",
      observedAt: "2026-11-24T04:02:00.000Z",
    });
    const claudeA = makeScope({
      id: "claude_a",
      label: "Claude Alpha",
      engine: "claude",
      sharing: "unverified",
      revision: "rev_claude_a",
    });
    const claudeB = makeScope({
      id: "claude_b",
      label: "Claude Beta",
      engine: "claude",
      sharing: "unverified",
      revision: "rev_claude_b",
    });
    const agySolo = makeScope({
      id: "agy_solo",
      label: "AGY Solo",
      engine: "antigravity",
      sharing: "unverified",
    });

    const cards = groupQuotaScopesByAccount([codexA, codexB, claudeA, claudeB, agySolo]);
    expect(cards).toHaveLength(4);

    // Merged Codex card lists both Bots and selects the fresher reading as primary
    expect(cards[0]!.merged).toBe(true);
    expect(cards[0]!.unconfirmedPeer).toBe(false);
    expect(cards[0]!.bots.map((b) => b.label)).toEqual(["Codex Lead", "Code Reviewer"]);
    expect(cards[0]!.primary.id).toBe("codex_b");

    // Two unverified Claude Bots stay separate and flag unconfirmedPeer so the UI explains why
    expect(cards[1]!.merged).toBe(false);
    expect(cards[1]!.unconfirmedPeer).toBe(true);
    expect(cards[1]!.bots.map((b) => b.label)).toEqual(["Claude Alpha"]);
    expect(cards[2]!.merged).toBe(false);
    expect(cards[2]!.unconfirmedPeer).toBe(true);
    expect(cards[2]!.bots.map((b) => b.label)).toEqual(["Claude Beta"]);

    // Solo Antigravity Bot has no peer to merge with
    expect(cards[3]!.merged).toBe(false);
    expect(cards[3]!.unconfirmedPeer).toBe(false);
  });
});
