import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EngineQuotaWindow } from "../client-protocol/engine-quota.js";
import { epochMs, type QuotaReading } from "./engine-quota-readers.js";

/**
 * Passive quota observations. Claude Code reports rate-limit state only as a
 * `rate_limit_event` inside normal turns, so a Bot process writes the latest
 * public fields per window to its own state directory and the Host merges
 * them. TaroBird never starts a turn just to refresh this.
 *
 * Only the documented top-level fields of `rate_limit_info` are kept
 * (status, rateLimitType, utilization, resetsAt). Fields marked internal by
 * the CLI are ignored on purpose.
 */
export const ENGINE_QUOTA_EVENTS_FILE = "engine-quota-events.json";
const CLAUDE_WINDOWS = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_overage_included: 10080 } as const;
const CLAUDE_LABELS: Record<string, string> = { seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };

const observationSchema = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  utilization: z.number().finite().min(0).max(100).optional(),
  resetsAt: z.number().int().positive().optional(),
  observedAt: z.number().int().positive(),
}).strict();
const eventsFileSchema = z.object({
  v: z.literal(1),
  claude: z.object({
    /** Latest observation per window type. */
    windows: z.record(z.string().regex(/^[a-z_]{1,40}$/), observationSchema),
    /** Overall request status from the latest event, whatever its window. */
    last: observationSchema.optional(),
  }).strict().optional(),
}).strict();
export type EngineQuotaEvents = z.infer<typeof eventsFileSchema>;

type RateLimitInfo = { status?: unknown; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown };

/** Merge one `rate_limit_event.rate_limit_info` into the observations. Pure. */
export function mergeClaudeRateLimit(current: EngineQuotaEvents | undefined, info: RateLimitInfo, now: number): EngineQuotaEvents | undefined {
  if (!info || typeof info !== "object" || !["allowed", "allowed_warning", "rejected"].includes(info.status as string)) return undefined;
  const status = info.status as "allowed" | "allowed_warning" | "rejected";
  const utilization = typeof info.utilization === "number" && Number.isFinite(info.utilization) && info.utilization >= 0 ? Math.min(100, info.utilization) : undefined;
  const resetsAt = epochMs(info.resetsAt);
  const observation = { status, ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt ? { resetsAt } : {}), observedAt: now };
  const claude = { windows: { ...(current?.claude?.windows ?? {}) }, last: observation };
  const type = typeof info.rateLimitType === "string" && /^[a-z_]{1,40}$/.test(info.rateLimitType) ? info.rateLimitType : undefined;
  if (type) claude.windows[type] = observation;
  return { v: 1, ...current, claude };
}

/** Atomic per-Bot write; the Bot is the only writer of its own file. */
export async function recordClaudeRateLimit(stateDir: string, info: RateLimitInfo, now = Date.now()): Promise<void> {
  const file = path.join(stateDir, ENGINE_QUOTA_EVENTS_FILE);
  const next = mergeClaudeRateLimit(await readEngineQuotaEvents(stateDir), info, now);
  if (!next) return;
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${now}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

export async function readEngineQuotaEvents(stateDir: string): Promise<EngineQuotaEvents | undefined> {
  try {
    const parsed = eventsFileSchema.safeParse(JSON.parse(await readFile(path.join(stateDir, ENGINE_QUOTA_EVENTS_FILE), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/**
 * Combine every Claude Bot's observations into one reading for the shared
 * login: per window the newest observation wins. A window whose reset time
 * has passed is dropped rather than shown as recovered.
 */
export function claudeQuotaFromEvents(files: Array<EngineQuotaEvents | undefined>, now: number): QuotaReading & { updatedAt?: number } {
  const newest = new Map<string, z.infer<typeof observationSchema>>();
  let last: z.infer<typeof observationSchema> | undefined;
  for (const file of files) {
    for (const [type, observation] of Object.entries(file?.claude?.windows ?? {})) if (!newest.has(type) || newest.get(type)!.observedAt < observation.observedAt) newest.set(type, observation);
    const candidate = file?.claude?.last;
    if (candidate && (!last || last.observedAt < candidate.observedAt)) last = candidate;
  }
  const windows: EngineQuotaWindow[] = [];
  let updatedAt = last?.observedAt;
  for (const [type, observation] of [...newest].sort(([a], [b]) => a.localeCompare(b))) {
    if (observation.resetsAt && observation.resetsAt <= now) continue;
    updatedAt = Math.max(updatedAt ?? 0, observation.observedAt);
    const usedPercent = observation.utilization !== undefined ? Math.round(observation.utilization * 1000) / 10 : observation.status === "rejected" ? 100 : undefined;
    if (usedPercent === undefined) continue;
    const minutes = CLAUDE_WINDOWS[type as keyof typeof CLAUDE_WINDOWS];
    windows.push({ id: type, ...(CLAUDE_LABELS[type] ? { label: CLAUDE_LABELS[type] } : {}), ...(minutes ? { windowMinutes: minutes } : {}), usedPercent, ...(observation.resetsAt ? { resetsAt: observation.resetsAt } : {}) });
  }
  const rejected = last?.status === "rejected" && (!last.resetsAt || last.resetsAt > now);
  if (!windows.length && !rejected) return { status: "unknown", windows: [], balances: [], ...(updatedAt ? { updatedAt } : {}) };
  return { status: rejected ? "exhausted" : "ok", windows, balances: [], ...(updatedAt ? { updatedAt } : {}) };
}
