import { z } from "zod";

export const HOST_RESOURCES_CAPABILITY = "host.resources.v1";

/**
 * Read-only resource snapshot reported by a Host to authorized devices.
 * Intentionally contains only CPU, memory, and active task counts — no hostnames,
 * paths, environment variables, or conversation contents.
 */
export const hostResourcesSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  cpuCores: z.number().int().positive().max(1024),
  loadAvg1m: z.number().min(0).max(10_000),
  memoryUsedPercent: z.number().min(0).max(100),
  memoryFreeBytes: z.number().int().nonnegative().safe(),
  memoryTotalBytes: z.number().int().positive().safe(),
  activeTurns: z.number().int().nonnegative().max(10_000),
  activeTickets: z.number().int().nonnegative().max(10_000),
  capturedAt: z.number().int().nonnegative().safe(),
}).strict();

export type HostResources = z.infer<typeof hostResourcesSchema>;
