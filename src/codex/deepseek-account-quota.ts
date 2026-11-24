import { quotaSnapshotSchema, type QuotaBalance, type QuotaSnapshot } from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError, unavailableQuota } from "./account-quota.js";

export type DeepSeekWallet = {
  currency: string;
  balance: string;
};

export type DeepSeekBalanceOutcome =
  | { status: "ready"; value: readonly DeepSeekWallet[]; bonusWallets?: readonly DeepSeekWallet[] }
  | { status: "failed" };

/** Normalize Platform decimal / scientific balance strings (e.g. "0E-16", "5.000000", "12.5")
 * into a clean unsigned decimal string accepted by `quotaBalanceSchema`. */
export function normalizeBalanceDecimal(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed === 0) return "0.00";
  // Keep 2..6 significant fractional digits cleanly without scientific notation.
  const fixed = Math.abs(parsed) < 1e-6 ? "0.00" : parsed.toFixed(Math.abs(parsed) < 0.01 ? 4 : 2);
  return /^\d+(?:\.\d+)?$/.test(fixed) ? fixed : null;
}

function mapWallets(
  wallets: readonly unknown[],
  prefix: "recharge" | "bonus",
  observedAt: string,
  expiresAt: string,
): QuotaBalance[] {
  const out: QuotaBalance[] = [];
  const seen = new Set<string>();
  for (const item of wallets.slice(0, 8)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const currencyRaw = typeof row.currency === "string" ? row.currency.trim().toUpperCase() : "";
    const balanceRaw = typeof row.balance === "string" ? row.balance : typeof row.balance === "number" ? String(row.balance) : "";
    if (!/^[A-Za-z0-9._-]{1,16}$/.test(currencyRaw)) continue;
    const amount = normalizeBalanceDecimal(balanceRaw);
    if (amount === null) continue;
    const id = `${prefix}_${currencyRaw.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: "currency",
      amount,
      unit: currencyRaw,
      observedAt,
      expiresAt,
    });
  }
  return out;
}

/** Parse DeepSeek Harness `account.getBalance` outcome into a TaroBird `QuotaSnapshot`. */
export function parseDeepSeekAccountBalance(
  outcome: unknown,
  options: { now?: number; hasApiKey?: boolean } = {},
): QuotaSnapshot {
  const now = options.now ?? Date.now();
  if (outcome === null || outcome === undefined) {
    if (options.hasApiKey) {
      return unavailableQuota("deepseek", "mode_not_supported", now, "api_key");
    }
    return unavailableQuota("deepseek", "login_required", now, "unknown");
  }
  if (typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new QuotaReadError("invalid_response");
  }
  const obj = outcome as Record<string, unknown>;
  if (obj.status === "failed") {
    return unavailableQuota("deepseek", "native_error", now, "subscription");
  }
  if (obj.status !== "ready" || !Array.isArray(obj.value)) {
    throw new QuotaReadError("invalid_response");
  }

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const recharge = mapWallets(obj.value, "recharge", observedAt, expiresAt);
  const bonus = Array.isArray(obj.bonusWallets) ? mapWallets(obj.bonusWallets, "bonus", observedAt, expiresAt) : [];
  const balances = [...recharge, ...bonus];

  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: balances.length ? "ready" : "unknown",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools: balances.length ? [{
      id: "deepseek_wallet",
      label: "DeepSeek",
      sharing: "shared",
      availability: "unknown",
      windows: [],
      balances,
      constraints: [],
    }] : [],
    constraints: [],
    help: "deepseek_balance",
  };

  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}
