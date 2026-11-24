import os from "node:os";
import { hostResourcesSchema, type HostResources } from "../client-protocol/host-resources.js";
import type { HubStore } from "./store.js";

function sampleCpuPercent(cores: number, loadAvg1m: number): number {
  if (cores <= 0) return 0;
  // On POSIX loadavg[0]/cores gives a smooth 1-minute utilization estimate.
  // On Windows loadavg() returns [0,0,0], so fall back to cumulative cpu times ratio.
  if (loadAvg1m > 0) {
    return Math.min(100, Math.max(0, Math.round((loadAvg1m / cores) * 100)));
  }
  const cpus = os.cpus();
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    const sum = t.user + t.nice + t.sys + t.irq + t.idle;
    busy += sum - t.idle;
    total += sum;
  }
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((busy / total) * 100)));
}

export async function readHostResources(store: HubStore): Promise<HostResources> {
  const cpus = os.cpus();
  const cpuCores = Math.max(1, cpus.length || 1);
  const loadAvg1m = Math.max(0, Math.round((os.loadavg()[0] ?? 0) * 100) / 100);
  const cpuPercent = sampleCpuPercent(cpuCores, loadAvg1m);

  const memoryTotalBytes = Math.max(1, Math.floor(os.totalmem()));
  const memoryFreeBytes = Math.max(0, Math.min(memoryTotalBytes, Math.floor(os.freemem())));
  const memoryUsedPercent = Math.min(
    100,
    Math.max(0, Math.round(((memoryTotalBytes - memoryFreeBytes) / memoryTotalBytes) * 100)),
  );

  const [turnsRow, ticketsRow] = await store.db.serial(async () => Promise.all([
    store.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE author_type='bot' AND status='streaming'",
    ),
    store.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM conversations WHERE archived=0 AND hidden=1",
    ).catch(() => ({ count: 0 })),
  ]));

  return hostResourcesSchema.parse({
    cpuPercent,
    cpuCores,
    loadAvg1m,
    memoryUsedPercent,
    memoryFreeBytes,
    memoryTotalBytes,
    activeTurns: Math.max(0, Number(turnsRow?.count ?? 0)),
    activeTickets: Math.max(0, Number(ticketsRow?.count ?? 0)),
    capturedAt: Date.now(),
  });
}
