import { z } from "zod";
import { idSchema } from "./index.js";
import { hostEngineSchema } from "./engine-settings.js";

/** Advertised in `ready.serverCapabilities` by Hubs that serve the owner-only
 * `GET /api/engines/quota` read and `POST /api/engines/quota/refresh`. Older
 * Hubs omit it; the App hides the entry instead of guessing. */
export const ENGINE_QUOTA_CAPABILITY = "engines.quota.v1";

/**
 * What the Host knows about one engine login. Never infer a value the
 * upstream did not return: `unknown` is not 0 %, and a missing limit is not
 * "unlimited". Host offline / stale are App-side states derived from the
 * connection and `updatedAt`, not statuses sent here.
 */
export const engineQuotaStatusSchema = z.enum([
  "ok",             // fresh upstream reading
  "exhausted",      // upstream reports at least one pool used up or over
  "unknown",        // supported, nothing observed yet (e.g. passive source before the first turn)
  "login_required", // the CLI is not signed in or the login was rejected
  "unsupported",    // this login / integration mode does not expose quota (e.g. API-key mode)
  "not_adapted",    // TaroBird has not adapted this engine's quota source yet
  "engine_missing", // the engine CLI is not installed on this Host
  "error",          // the read failed; see `reason`
]);
export type EngineQuotaStatus = z.infer<typeof engineQuotaStatusSchema>;
export const engineQuotaReasonSchema = z.enum(["timeout", "rate_limited", "invalid_response", "upstream_error"]);

/** One upstream quota pool / window, shown with the upstream's own meaning.
 * Overlapping windows (e.g. 5 h and weekly) are separate rows, never summed. */
export const engineQuotaWindowSchema = z.object({
  id: z.string().min(1).max(64),
  /** Upstream pool name shown verbatim (model group, plan bucket). */
  label: z.string().min(1).max(80).optional(),
  /** Window length when the upstream states it: 300 = 5 h, 10080 = 7 days. */
  windowMinutes: z.number().int().positive().max(60 * 24 * 62).optional(),
  /** Percentage of the pool already used. Above 100 means over the limit. */
  usedPercent: z.number().finite().min(0).max(10_000).optional(),
  /** Epoch ms. When it passes the App asks again; it never resets the bar itself. */
  resetsAt: z.number().int().positive().optional(),
  /** Models the upstream says this pool covers. Absent = the whole login. */
  models: z.array(z.string().min(1).max(120)).max(32).optional(),
}).strict();
export type EngineQuotaWindow = z.infer<typeof engineQuotaWindowSchema>;

/** Money or credit balance, in the upstream's own unit. Decimal string, no float rounding. */
export const engineQuotaBalanceSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80).optional(),
  amount: z.string().regex(/^-?\d{1,15}(?:\.\d{1,8})?$/),
  /** ISO 4217 code (CNY, USD) or "credits". */
  unit: z.string().regex(/^(?:[A-Z]{3}|credits)$/),
}).strict();
export type EngineQuotaBalance = z.infer<typeof engineQuotaBalanceSchema>;

/** One engine login on this Host. Several Bots that use the same login share
 * the same entry (`bots`); a Bot with its own login gets its own entry. */
export const engineQuotaEntrySchema = z.object({
  /** Opaque, stable within this Host (e.g. "codex:default"). Never an account id. */
  id: z.string().min(1).max(80),
  engine: hostEngineSchema,
  status: engineQuotaStatusSchema,
  reason: engineQuotaReasonSchema.optional(),
  /** query = active read-only call that starts no model turn; event = observed during normal turns. */
  source: z.enum(["query", "event"]).optional(),
  /** Upstream plan name when returned (e.g. "Pro"); shown verbatim. */
  plan: z.string().min(1).max(80).optional(),
  windows: z.array(engineQuotaWindowSchema).max(16),
  balances: z.array(engineQuotaBalanceSchema).max(8),
  /** Epoch ms of the last successful reading. */
  updatedAt: z.number().int().positive().optional(),
  /** Epoch ms of the last attempt (success or not). */
  checkedAt: z.number().int().positive().optional(),
  /** Bots on this Host that use this login and therefore share these pools. */
  bots: z.array(z.object({ id: idSchema, name: z.string().min(1).max(200) }).strict()).max(256),
  /** Verified official page where the owner can check usage by hand. */
  guideUrl: z.string().url().max(300).optional(),
}).strict();
export type EngineQuotaEntry = z.infer<typeof engineQuotaEntrySchema>;

export const engineQuotaViewSchema = z.object({
  /** Host clock, epoch ms. */
  generatedAt: z.number().int().positive(),
  /** True while a refresh started by this or another owner device is still running. */
  refreshing: z.boolean(),
  entries: z.array(engineQuotaEntrySchema).max(32),
}).strict();
export type EngineQuotaView = z.infer<typeof engineQuotaViewSchema>;
