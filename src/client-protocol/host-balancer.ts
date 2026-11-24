import { z } from "zod";
import type { HostResources } from "./host-resources.js";

export const hostBalancePreferenceSchema = z.enum(["normal", "prefer", "less_often", "manual_only"]);
export type HostBalancePreference = z.infer<typeof hostBalancePreferenceSchema>;

export const loadBalancingPreferencesSchema = z.object({
  enabled: z.boolean().default(false),
  hostPreferences: z.record(z.string().max(128), hostBalancePreferenceSchema).default({}),
  botTemplate: z.object({
    namePrefix: z.string().max(48).default(""),
    workspace: z.string().max(1024).default(""),
  }).default({ namePrefix: "", workspace: "" }),
}).strict();
export type LoadBalancingPreferences = z.infer<typeof loadBalancingPreferencesSchema>;

export const defaultLoadBalancingPreferences: LoadBalancingPreferences = {
  enabled: false,
  hostPreferences: {},
  botTemplate: { namePrefix: "", workspace: "" },
};

export type HostBalanceExclusionReason =
  | "offline"
  | "manual_only"
  | "engine_unavailable"
  | "quota_exhausted"
  | "resources_unavailable"
  | "overloaded";

export interface HostBalanceCandidate {
  hostId: string;
  hostName: string;
  hostKey?: string;
  online: boolean;
  preference: HostBalancePreference;
  engineAvailable: boolean;
  quotaExhausted: boolean;
  latencyMs?: number;
  resources?: HostResources;
  /** Existing online/usable Bot on this Host matching the chosen engine, if any. */
  matchingBotId?: string;
  matchingBotName?: string;
}

export interface RankedHostCandidate {
  candidate: HostBalanceCandidate;
  score: number;
}

export interface ExcludedHostCandidate {
  hostId: string;
  hostName: string;
  reason: HostBalanceExclusionReason;
}

export interface HostBalanceSelection {
  selected: HostBalanceCandidate | null;
  ranked: RankedHostCandidate[];
  excluded: ExcludedHostCandidate[];
  reason?: "no_eligible_host";
}

export interface HostBalanceOptions {
  /** Recent hostIds chosen for new conversations (newest last), used to spread equal ties. */
  recentAssignments?: readonly string[];
  /** Require live Host resource telemetry to consider a Host eligible. */
  requireResources?: boolean;
  /** CPU % threshold above which a Host is treated as overloaded (default 92). */
  maxCpuPercent?: number;
  /** Memory % threshold above which a Host is treated as overloaded (default 95). */
  maxMemoryPercent?: number;
}

const DEFAULT_MAX_CPU = 92;
const DEFAULT_MAX_MEM = 95;

/**
 * Pick the best Host for a new conversation based on availability, engine/quota
 * readiness, real-time CPU/memory/active-task load, latency, and per-Host
 * preference (Normal / Prefer / Less often / Manual only).
 *
 * Preferences act as soft weights (not fixed ratios): a "Prefer" host receives
 * a bonus when it has spare CPU (<75%) and memory (<85%), and "Less often" gets
 * a penalty so it is only picked when normal/preferred hosts are busier.
 */
export function selectBalancedHost(
  candidates: readonly HostBalanceCandidate[],
  options: HostBalanceOptions = {},
): HostBalanceSelection {
  const maxCpu = options.maxCpuPercent ?? DEFAULT_MAX_CPU;
  const maxMem = options.maxMemoryPercent ?? DEFAULT_MAX_MEM;
  const requireResources = options.requireResources ?? false;
  const recent = options.recentAssignments ?? [];

  const excluded: ExcludedHostCandidate[] = [];
  const eligible: RankedHostCandidate[] = [];

  for (const item of candidates) {
    if (!item.online) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "offline" });
      continue;
    }
    if (item.preference === "manual_only") {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "manual_only" });
      continue;
    }
    if (!item.engineAvailable) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "engine_unavailable" });
      continue;
    }
    if (item.quotaExhausted) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "quota_exhausted" });
      continue;
    }
    if (!item.resources && requireResources) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "resources_unavailable" });
      continue;
    }
    if (item.resources && (item.resources.cpuPercent >= maxCpu || item.resources.memoryUsedPercent >= maxMem)) {
      excluded.push({ hostId: item.hostId, hostName: item.hostName, reason: "overloaded" });
      continue;
    }

    const res = item.resources;
    const cpu = res ? res.cpuPercent : 35;
    const mem = res ? res.memoryUsedPercent : 50;
    const activeTurns = res ? res.activeTurns : 0;
    const activeTickets = res ? res.activeTickets : 0;
    const latencyPenalty = Math.min(Math.max(0, item.latencyMs ?? 25), 500) / 10;

    // Lower score = better candidate
    let score = cpu * 0.45 + mem * 0.25 + activeTurns * 18 + activeTickets * 10 + latencyPenalty;

    const hasSpareCapacity = cpu < 75 && mem < 85;
    if (item.preference === "prefer" && hasSpareCapacity) {
      score -= 18;
    } else if (item.preference === "less_often") {
      score += 28;
    }

    // Slight preference for reusing an already-ready matching Bot on that Host
    if (item.matchingBotId) {
      score -= 4;
    }

    // Spread consecutive creations across equally idle Hosts
    const recentCount = recent.filter((id) => id === item.hostId).length;
    const lastIndex = recent.lastIndexOf(item.hostId);
    score += recentCount * 8 + (lastIndex >= 0 && lastIndex === recent.length - 1 ? 6 : 0);

    eligible.push({ candidate: item, score: Math.round(score * 100) / 100 });
  }

  eligible.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.candidate.hostId.localeCompare(b.candidate.hostId);
  });

  if (!eligible.length) {
    return { selected: null, ranked: [], excluded, reason: "no_eligible_host" };
  }
  return { selected: eligible[0]!.candidate, ranked: eligible, excluded };
}
