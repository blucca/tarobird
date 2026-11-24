import type { QuotaEngine, QuotaScope } from "../../src/client-protocol/engine-quota.js";
import { t } from "./i18n.js";

const UNVERIFIED_FALLBACK_REVISIONS = new Set([
  "offline",
  "timeout",
  "invalid_response",
  "host_upgrade_required",
]);

export interface QuotaWindowLabelInput {
  id?: string;
  label: string;
  periodSeconds?: number;
}

/** Map raw engine window names (Primary, Secondary, 5 hours, 7 days, Opus · 7 days)
 * into uniform window names so window lengths are never misread as time remaining.
 * Names that cannot be mapped retain their original engine label. */
export function formatQuotaWindowLabel(window: QuotaWindowLabelInput): string {
  const raw = window.label.trim();
  const split = /^(.+?)\s*·\s*(.+)$/.exec(raw);
  const prefix = split?.[1]?.trim();
  const tail = (split?.[2] ?? raw).trim();
  const period = window.periodSeconds;

  let mapped: string | undefined;
  if (period === 18_000 || /^(?:primary|5\s*h(?:ours?)?|5\s*小时(?:窗口)?|session)$/i.test(tail)) {
    mapped = t("5 小时窗口");
  } else if (period === 604_800 || /^(?:secondary|weekly|7\s*d(?:ays?)?|7\s*天|周额度(?:（7 天）)?)$/i.test(tail)) {
    mapped = t("周额度（7 天）");
  } else if (period !== undefined && period > 0) {
    const hours = period / 3600;
    if (hours >= 48 && hours % 24 === 0) {
      mapped = t("{0} 天窗口", hours / 24);
    } else if (hours >= 1 && Number.isInteger(hours)) {
      mapped = t("{0} 小时窗口", hours);
    }
  }

  if (!mapped) return raw;
  if (prefix && prefix.toLowerCase() !== mapped.toLowerCase()) {
    return `${prefix} · ${mapped}`;
  }
  return mapped;
}

export interface ResetCountdown {
  text: string;
  expired: boolean;
}

/** Format a reset timestamp as a countdown ("Resets in 4 days", "Resets in 3 h 20 min",
 * "Resets in 25 min", or already-passed wording). */
export function formatResetCountdown(resetsAt: string, now: number): ResetCountdown {
  const targetMs = Date.parse(resetsAt);
  if (!Number.isFinite(targetMs)) return { text: "", expired: false };
  const remainingMs = targetMs - now;
  if (remainingMs <= 0) {
    return { text: t("已到重置时间，等待更新"), expired: true };
  }
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  if (days >= 1) {
    return {
      text: days === 1 ? t("1 天后重置") : t("{0} 天后重置", days),
      expired: false,
    };
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 1) {
    return {
      text: minutes > 0
        ? t("{0} 小时 {1} 分钟后重置", hours, minutes)
        : t("{0} 小时后重置", hours),
      expired: false,
    };
  }
  return {
    text: t("{0} 分钟后重置", Math.max(1, minutes)),
    expired: false,
  };
}

export interface QuotaAccountBot {
  id: string;
  label: string;
  scope: QuotaScope;
}

export interface QuotaAccountCard {
  key: string;
  engine: QuotaEngine;
  primary: QuotaScope;
  scopes: QuotaScope[];
  bots: QuotaAccountBot[];
  /** True when multiple Bots are confirmed to share this account. */
  merged: boolean;
  /** True when other Bots of the same engine exist, but account sharing could not be confirmed. */
  unconfirmedPeer: boolean;
}

function scopeFreshnessRank(scope: QuotaScope): [number, number] {
  const stateScore = scope.state === "ready" ? 3 : scope.state === "stale" ? 2 : scope.observedAt ? 1 : 0;
  const observed = scope.observedAt ? Date.parse(scope.observedAt) : 0;
  return [stateScore, Number.isFinite(observed) ? observed : 0];
}

function pickPrimaryScope(scopes: readonly QuotaScope[]): QuotaScope {
  let best = scopes[0]!;
  let bestRank = scopeFreshnessRank(best);
  for (let i = 1; i < scopes.length; i++) {
    const candidate = scopes[i]!;
    const rank = scopeFreshnessRank(candidate);
    if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
      best = candidate;
      bestRank = rank;
    }
  }
  return best;
}

/** Group scopes by confirmed account. Multiple Bots with `sharing === "verified"` and
 * identical `(engine, revision)` merge into one card listing every Bot; unverified scopes
 * stay separate and set `unconfirmedPeer: true` whenever other Bots use the same engine. */
export function groupQuotaScopesByAccount(scopes: readonly QuotaScope[]): QuotaAccountCard[] {
  const engineCounts = new Map<QuotaEngine, number>();
  for (const scope of scopes) {
    engineCounts.set(scope.engine, (engineCounts.get(scope.engine) ?? 0) + 1);
  }

  const cards: QuotaAccountCard[] = [];
  const verifiedGroups = new Map<string, QuotaScope[]>();
  const verifiedOrder: string[] = [];

  for (const scope of scopes) {
    const canVerify = scope.sharing === "verified"
      && Boolean(scope.revision)
      && !UNVERIFIED_FALLBACK_REVISIONS.has(scope.revision);
    if (canVerify) {
      const groupKey = `verified:${scope.engine}:${scope.revision}`;
      let list = verifiedGroups.get(groupKey);
      if (!list) {
        list = [];
        verifiedGroups.set(groupKey, list);
        verifiedOrder.push(groupKey);
        cards.push({
          key: groupKey,
          engine: scope.engine,
          primary: scope,
          scopes: list,
          bots: [],
          merged: false,
          unconfirmedPeer: false,
        });
      }
      list.push(scope);
    } else {
      cards.push({
        key: `scope:${scope.id}`,
        engine: scope.engine,
        primary: scope,
        scopes: [scope],
        bots: [{ id: scope.id, label: scope.label, scope }],
        merged: false,
        unconfirmedPeer: (engineCounts.get(scope.engine) ?? 0) > 1,
      });
    }
  }

  for (const card of cards) {
    if (!verifiedGroups.has(card.key)) continue;
    card.primary = pickPrimaryScope(card.scopes);
    card.bots = card.scopes.map((scope) => ({ id: scope.id, label: scope.label, scope }));
    card.merged = card.scopes.length > 1 || card.primary.botIds.length > 1;
    card.unconfirmedPeer = false;
  }

  return cards;
}
