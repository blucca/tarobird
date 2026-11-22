import type { ContextUsage } from "../../src/client-protocol/context-usage.js";
import type { QuotaScope } from "../../src/client-protocol/engine-quota.js";

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
export type QuotaView = { left: number; windows: QuotaWindowView[]; observedAt: string };
/** The quota that counts for a Bot on `model`: the windows of the pools that cover that model, and
 * the tightest of them. A pool that names models counts only for a Bot on one of them, so one
 * exhausted model group does not alarm every Bot of the account; when the Bot's group cannot be
 * told, nothing is shown. A window past its reset time is left out: its number is no longer true. */
export function quotaView(scope: QuotaScope | undefined, model: string, now: number): QuotaView | undefined {
  if (!scope?.observedAt || scope.state !== "ready" && scope.state !== "stale") return undefined;
  const age = now - Date.parse(scope.observedAt);
  if (!(age < QUOTA_SHOWN_FOR_MS)) return undefined;
  const windows: QuotaWindowView[] = [];
  // Claude names a model family ("Fable"), which a Bot's model id contains; other engines name whole models.
  const covers = (models: readonly string[]) => scope.engine === "claude" ? models.some(name => plain(name) !== "" && plain(model).includes(plain(name))) : poolCoversModel(models, model);
  for (const pool of scope.pools) {
    if (pool.models?.length && !covers(pool.models)) continue;
    for (const window of pool.windows) {
      if (window.metric !== "percent" || window.resetsAt && Date.parse(window.resetsAt) <= now) continue;
      if (scope.engine === "claude") {
        const family = CLAUDE_MODEL_WINDOWS[window.id];
        if (CLAUDE_EXTRA_WINDOWS.has(window.id) || family && !model.toLowerCase().includes(family)) continue;
      }
      windows.push({ id: `${pool.id}:${window.id}`, pool: pool.label, label: window.label, left: percent(100 - window.usedPercent), ...(window.periodSeconds ? { periodSeconds: window.periodSeconds } : {}), ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}) });
    }
  }
  return windows.length ? { left: Math.min(...windows.map(window => window.left)), windows, observedAt: scope.observedAt } : undefined;
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
