import { z } from "zod";
import { runEntrySchema, type RunEntry, type RunSummary } from "./run.js";

export const runPlanItemSchema = z.object({
  content: z.string().min(1).max(320),
  status: z.enum(["pending", "in_progress", "completed"]),
}).strict();
export type RunPlanItem = z.infer<typeof runPlanItemSchema>;

const runPlanPreviewSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  revision: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
  items: z.array(runPlanItemSchema).min(1).max(50),
}).strict();
export type RunPlanPreview = z.infer<typeof runPlanPreviewSchema>;

function normalizePlanStatus(raw: unknown): RunPlanItem["status"] {
  if (typeof raw !== "string") return "pending";
  const value = raw.toLowerCase();
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "inprogress" || value === "running") return "in_progress";
  return "pending";
}

export function parseRunPlanItems(rawInput: string | undefined): RunPlanItem[] {
  if (!rawInput) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(rawInput); } catch { return []; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const rec = parsed as Record<string, unknown>;
  const list = rec.todos ?? rec.entries ?? rec.plan;
  if (!Array.isArray(list)) return [];
  const items: RunPlanItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const text = typeof item.content === "string" ? item.content.trim() : typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    items.push({ content: text.slice(0, 320), status: normalizePlanStatus(item.status) });
    if (items.length >= 50) break;
  }
  return items;
}

/**
 * Latest bounded foreground plan snapshot, kept outside strict v1 run summaries
 * so older clients continue to read nativeRun normally.
 */
export function publicPlanPreview(entries: readonly RunEntry[], run: RunSummary): RunPlanPreview | undefined {
  if (!Array.isArray(entries)) return;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind !== "plan" || entry.scope) continue;
    const parsed = runEntrySchema.safeParse(entry);
    if (!parsed.success || parsed.data.revision > run.revision) continue;
    const items = parseRunPlanItems(parsed.data.input);
    if (!items.length) continue;
    return { version: 1 as const, runId: run.id, revision: run.revision, seq: parsed.data.seq, items };
  }
}

export function runPlanPreview(block: { extra?: Record<string, unknown> }, run: RunSummary): RunPlanPreview | undefined {
  if (block.extra?.scopedRun !== undefined) return;
  const parsed = runPlanPreviewSchema.safeParse(block.extra?.nativeRunPlan);
  return parsed.success && parsed.data.runId === run.id && parsed.data.revision === run.revision ? parsed.data : undefined;
}
