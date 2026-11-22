import type { ContextUsage } from "../../src/client-protocol/context-usage.js";
import type { QuotaConstraint, QuotaScope } from "../../src/client-protocol/engine-quota.js";

/** How long the last quota reading stays on screen. An older one counts as not readable:
 * the symbol disappears instead of showing a number nobody has confirmed since. */
export const QUOTA_SHOWN_FOR_MS = 30 * 60_000;
/** At or below these shares of what is left the symbol turns amber, then red. */
export const USAGE_LOW_PERCENT = 20, USAGE_EMPTY_PERCENT = 5;
export type UsageTone = "ok" | "low" | "empty";
export const usageTone = (left: number): UsageTone => left <= USAGE_EMPTY_PERCENT ? "empty" : left <= USAGE_LOW_PERCENT ? "low" : "ok";
const percent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

export type ContextView = { left: number; usedTokens: number; windowTokens: number; /** Share of the window in use at which the engine compacts by itself. */ compactAt?: number };
/** What is left of a conversation's context window, from the engine's own numbers only. */
export function contextView(usage: ContextUsage | undefined): ContextView | undefined {
  if (!usage?.supported || usage.usedTokens === undefined || !usage.windowTokens) return undefined;
  const { usedTokens, windowTokens, autoCompactTokens } = usage;
  return { left: percent(100 - usedTokens / windowTokens * 100), usedTokens, windowTokens, ...(autoCompactTokens ? { compactAt: percent(autoCompactTokens / windowTokens * 100) } : {}) };
}

const plain = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max|ultra)$/;
/** Whether one of a pool's model names is the Bot's model: the same id (Codex), or an Antigravity
 * display name ("Claude Opus 5.5") against its id with the effort preset removed ("claude-opus-5-5-high"). */
export function poolCoversModel(models: readonly string[], model: string): boolean {
  if (!model) return false;
  const id = plain(model), base = plain(model.replace(EFFORT_SUFFIX, ""));
  return models.some(name => { const value = plain(name); return value !== "" && (value === id || value === base); });
}
// Claude reports its per-model weekly windows beside the shared ones; extra-usage windows are not quota left.
const CLAUDE_MODEL_WINDOWS: Record<string, string> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet" };
const CLAUDE_EXTRA_WINDOWS = new Set(["seven_day_overage_included", "overage"]);

export type QuotaWindowView = { id: string; pool: string; label: string; periodSeconds?: number; left: number; resetsAt?: string };
/** Engine limits that refuse ordinary use whatever the windows say. Disabled extra usage is not one of them. */
export type QuotaBlock = Exclude<QuotaConstraint["code"], "overage_disabled">;
export type QuotaView = { left: number; windows: QuotaWindowView[]; blocked: QuotaBlock[]; observedAt: string };
/** The quota that counts for a Bot on `model`: the windows of the pools that cover that model, and
 * the tightest of them. A pool that names models counts only for a Bot on one of them, so one
 * exhausted model group does not alarm every Bot of the account; when the Bot's group cannot be
 * told, nothing is shown. A window past its reset time is left out: its number is no longer true.
 * When the engine reports that ordinary use is refused, nothing is left whatever the windows say. */
export function quotaView(scope: QuotaScope | undefined, model: string, now: number): QuotaView | undefined {
  if (!scope?.observedAt || scope.state !== "ready" && scope.state !== "stale") return undefined;
  const age = now - Date.parse(scope.observedAt);
  if (!(age < QUOTA_SHOWN_FOR_MS)) return undefined;
  // Claude names a model family ("Fable"), which a Bot's model id contains; other engines name whole models.
  const covers = (models: readonly string[]) => scope.engine === "claude" ? models.some(name => plain(name) !== "" && plain(model).includes(plain(name))) : poolCoversModel(models, model);
  const windows: QuotaWindowView[] = [], blocks = (constraints: readonly QuotaConstraint[]) => constraints.flatMap(item =>
    item.availability === "blocked" && item.code !== "overage_disabled" && !(item.resetsAt && Date.parse(item.resetsAt) <= now) ? [item.code] : []);
  const blocked = new Set<QuotaBlock>(blocks(scope.constraints));
  let counted = 0;
  for (const pool of scope.pools) {
    // Every Antigravity group is for certain models. One that names none (an older Host) cannot be attributed.
    if (pool.models?.length ? !covers(pool.models) : scope.engine === "antigravity") continue;
    counted++;
    for (const code of blocks(pool.constraints)) blocked.add(code);
    for (const window of pool.windows) {
      if (window.metric !== "percent" || window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
      if (scope.engine === "claude") {
        const family = CLAUDE_MODEL_WINDOWS[window.id];
        if (CLAUDE_EXTRA_WINDOWS.has(window.id) || family && !model.toLowerCase().includes(family)) continue;
      }
      windows.push({ id: `${pool.id}:${window.id}`, pool: pool.label, label: window.label, left: percent(100 - window.usedPercent), ...(window.periodSeconds ? { periodSeconds: window.periodSeconds } : {}), ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) });
    }
  }
  // An account-wide block counts only where some pool of the reading counts for this Bot.
  if (!windows.length && !(blocked.size && (counted || !scope.pools.length))) return undefined;
  return { left: blocked.size ? 0 : Math.min(...windows.map(window => window.left)), windows, blocked: [...blocked], observedAt: scope.observedAt };
}

/** Replies the Hub makes up when a worker did not answer in time or is away; they say nothing about the account. */
const NO_ANSWER = new Set(["offline", "timeout", "invalid_response", "host_upgrade_required"]);
const workerAnswered = (scope: QuotaScope) => !(scope.reason !== undefined && scope.revision === scope.reason && NO_ANSWER.has(scope.reason));
/** What the App holds for a Bot after a reply from its Host. */
export function nextHeldQuota(previous: QuotaScope | undefined, scope: QuotaScope): QuotaScope | undefined {
  if (!workerAnswered(scope)) return previous;
  // A reading replaces the held one unless it is the same login's older answer: another process of the Bot
  // may still hold an earlier one.
  if (scope.observedAt) return previous?.revision === scope.revision && previous.observedAt && previous.observedAt > scope.observedAt ? previous : scope;
  // Another login, or a login without quota: the earlier number is not about it.
  return previous && (previous.revision !== scope.revision || ["auth_changed", "login_required", "mode_not_supported", "not_adapted"].includes(scope.reason ?? "")) ? undefined : previous;
}
/** After "sign in first" the engine is left alone this long: asking again can open a browser sign-in. */
export const QUOTA_SIGN_IN_RETRY_MS = 30 * 60_000;
export type QuotaAttempt = { revision: string; at: number; signIn: boolean };
/** Whether the engine itself may be asked now: not while the held reading is newer than `olderThan`, and not
 * sooner than that after the last attempt for this login, so a failing read is not repeated each time a
 * conversation opens. */
export function mayAskEngine(scope: QuotaScope, held: QuotaScope | undefined, attempt: QuotaAttempt | undefined, now: number, olderThan: number): boolean {
  if (!workerAnswered(scope) || scope.capability.mode !== "active" || scope.state === "login_required") return false;
  if (held?.observedAt && held.revision === scope.revision && now - Date.parse(held.observedAt) < olderThan) return false;
  return !(attempt && attempt.revision === scope.revision && now - attempt.at < (attempt.signIn ? Math.max(olderThan, QUOTA_SIGN_IN_RETRY_MS) : olderThan));
}

/** When a shown reading stops counting (its age limit or its next reset), so the view can drop it then. */
export function quotaViewEndsAt(view: QuotaView): number {
  return Math.min(Date.parse(view.observedAt) + QUOTA_SHOWN_FOR_MS, ...view.windows.flatMap(window => window.resetsAt ? [Date.parse(window.resetsAt)] : []));
}

/** "76k", "1.2M": the engine's token counts, shortened. */
export function shortTokens(value: number): string {
  if (value < 1000) return String(Math.round(value));
  if (value < 999_500) return `${value < 9950 ? Math.round(value / 100) / 10 : Math.round(value / 1000)}k`;
  return `${Math.round(value / 100_000) / 10}M`;
}
