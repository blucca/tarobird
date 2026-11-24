import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  hostResourcesSnapshotSchema,
  type HostResourceStopRequest,
  type HostResourceStopResult,
  type HostResourcesSnapshot,
  type ResourceBotGroup,
  type ResourceConversationGroup,
  type ResourceProcess,
  type ResourceSparklinePoint,
} from "../client-protocol/host-resources.js";
import { isRunActive, anyRun, runSummarySchema } from "../client-protocol/run.js";
import { killProcessTree } from "../codex/process-tree.js";
import { HubError, type HubStore } from "./store.js";

const execFileAsync = promisify(execFile);
const HISTORY_LIMIT = 24;
const MIN_HISTORY_INTERVAL_MS = 1_500;
const ACTIVE_RUN_PHASES = runSummarySchema.shape.phase.options.filter(isRunActive);

export interface OsProcessSample {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryBytes: number;
  name: string;
}

export interface HostResourcesOptions {
  store: HubStore;
  hubPid?: number;
  platform?: NodeJS.Platform;
  childPids: () => Map<string, number>;
  stopBotTurn: (botId: string, conversationId: string, userId: string) => Promise<boolean>;
  sampleProcesses?: () => Promise<OsProcessSample[]>;
  killPid?: (pid: number) => Promise<void>;
}

function roundCpu(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : 0;
}

function sanitizeProcessName(raw: string): string {
  const trimmed = raw.trim().replace(/[\x00-\x1f\x7f]/g, "");
  if (!trimmed) return "process";
  const base = path.basename(trimmed.split(/\s+/)[0] || trimmed);
  return base.slice(0, 120) || "process";
}

export function parsePosixPsOutput(stdout: string): OsProcessSample[] {
  const result: OsProcessSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([0-9]+(?:[.,][0-9]+)?)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpu = Number(match[3]!.replace(",", "."));
    const rssKb = Number(match[4]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    result.push({
      pid,
      ppid,
      cpuPercent: roundCpu(cpu),
      memoryBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      name: sanitizeProcessName(match[5]!),
    });
  }
  return result;
}

export function parseWindowsProcessJson(stdout: string): OsProcessSample[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: OsProcessSample[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const pid = Number(row.ProcessId ?? row.Id ?? row.pid);
    const ppid = Number(row.ParentProcessId ?? row.ppid ?? 0);
    const cpu = Number(row.CpuPercent ?? row.cpuPercent ?? 0);
    const mem = Number(row.WorkingSetSize ?? row.WorkingSet64 ?? row.memoryBytes ?? 0);
    const name = typeof row.Name === "string" ? row.Name : typeof row.ProcessName === "string" ? row.ProcessName : "process";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    result.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : 0,
      cpuPercent: roundCpu(cpu),
      memoryBytes: Number.isFinite(mem) && mem > 0 ? mem : 0,
      name: sanitizeProcessName(name),
    });
  }
  return result;
}

async function sampleOsProcesses(platform: NodeJS.Platform): Promise<OsProcessSample[]> {
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize",
      "$perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = [double]$_.PercentProcessorTime }",
      "$out = foreach ($p in $procs) { [pscustomobject]@{ ProcessId=[int]$p.ProcessId; ParentProcessId=[int]$p.ParentProcessId; Name=$p.Name; WorkingSetSize=[double]$p.WorkingSetSize; CpuPercent=($perf[[int]$p.ProcessId] ?? 0) } }",
      "$out | ConvertTo-Json -Compress",
    ].join("; ");
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const rows = parseWindowsProcessJson(stdout);
      if (rows.length) return rows;
    } catch { /* Fall back to self memory sample below. */ }
    return [{ pid: process.pid, ppid: process.ppid, cpuPercent: 0, memoryBytes: process.memoryUsage().rss, name: "node" }];
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,%cpu=,rss=,comm="], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    const rows = parsePosixPsOutput(stdout);
    if (rows.length) return rows;
  } catch { /* Fall back to self memory sample below. */ }
  return [{ pid: process.pid, ppid: process.ppid, cpuPercent: 0, memoryBytes: process.memoryUsage().rss, name: "node" }];
}

function collectDescendants(rootPid: number, byParent: Map<number, OsProcessSample[]>): OsProcessSample[] {
  const result: OsProcessSample[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [...(byParent.get(rootPid) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.pid)) continue;
    visited.add(current.pid);
    result.push(current);
    const children = byParent.get(current.pid);
    if (children) queue.push(...children);
  }
  return result;
}

interface ActiveConversationTurn {
  botId: string;
  conversationId: string;
  conversationTitle: string;
  startedAt: number;
}

export class HubHostResources {
  private readonly history: ResourceSparklinePoint[] = [];
  private lastSampleAt = 0;

  constructor(private readonly options: HostResourcesOptions) {}

  private async activeTurnsForUser(userId: string, allowedConversationIds: Set<string>, titles: Map<string, string>): Promise<ActiveConversationTurn[]> {
    const rows = await this.options.store.db.serial(() => this.options.store.db.all<{
      conversation_id: string;
      author_id: string;
      status: string;
      blocks_json: string;
      created_at: number;
    }>(
      "SELECT conversation_id, author_id, status, blocks_json, created_at FROM messages WHERE author_type='bot' AND status IN ('pending','streaming') ORDER BY created_at ASC LIMIT 256",
    ));
    const seen = new Set<string>();
    const turns: ActiveConversationTurn[] = [];
    for (const row of rows) {
      if (!allowedConversationIds.has(row.conversation_id)) continue;
      let active = row.status === "pending" || row.status === "streaming";
      let startedAt = row.created_at;
      try {
        const blocks = JSON.parse(row.blocks_json) as unknown[];
        for (const block of blocks) {
          if (!block || typeof block !== "object" || (block as { type?: string }).type !== "card") continue;
          const run = anyRun(block as Parameters<typeof anyRun>[0]);
          if (run) {
            active = ACTIVE_RUN_PHASES.includes(run.phase);
            if (run.startedAt) startedAt = run.startedAt;
          }
        }
      } catch { /* Keep status-based activity */ }
      if (!active) continue;
      const key = `${row.author_id}\0${row.conversation_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      turns.push({
        botId: row.author_id,
        conversationId: row.conversation_id,
        conversationTitle: titles.get(row.conversation_id) ?? row.conversation_id,
        startedAt,
      });
    }
    return turns;
  }

  async snapshot(userId: string, canStop: boolean, force = false): Promise<HostResourcesSnapshot> {
    const platform = this.options.platform ?? process.platform;
    const hubPid = this.options.hubPid ?? process.pid;
    const [samples, bots, conversations] = await Promise.all([
      (this.options.sampleProcesses ?? (() => sampleOsProcesses(platform)))(),
      this.options.store.bots(userId),
      this.options.store.conversations(userId),
    ]);

    const byPid = new Map<number, OsProcessSample>();
    const byParent = new Map<number, OsProcessSample[]>();
    for (const sample of samples) {
      byPid.set(sample.pid, sample);
      const list = byParent.get(sample.ppid);
      if (list) list.push(sample);
      else byParent.set(sample.ppid, [sample]);
    }

    const conversationIds = new Set(conversations.map((c) => c.id));
    const conversationTitles = new Map(conversations.map((c) => [c.id, c.title]));
    const activeTurns = await this.activeTurnsForUser(userId, conversationIds, conversationTitles);
    const activeTurnsByBot = new Map<string, ActiveConversationTurn[]>();
    for (const turn of activeTurns) {
      const list = activeTurnsByBot.get(turn.botId);
      if (list) list.push(turn);
      else activeTurnsByBot.set(turn.botId, [turn]);
    }

    const botPids = this.options.childPids();
    const visibleBots = bots.filter((b) => !b.deletedAt);
    const ownedPids = new Set<number>();

    const hostSample = byPid.get(hubPid) ?? {
      pid: hubPid,
      ppid: process.ppid,
      cpuPercent: 0,
      memoryBytes: process.memoryUsage().rss,
      name: "tarobot-host",
    };
    ownedPids.add(hostSample.pid);

    const selfProcesses: ResourceProcess[] = [{
      id: `host:${hostSample.pid}`,
      pid: hostSample.pid,
      ppid: hostSample.ppid,
      name: "TaroBird Host",
      kind: "host",
      cpuPercent: roundCpu(hostSample.cpuPercent),
      memoryBytes: hostSample.memoryBytes,
      stoppable: false,
    }];

    // Detect local desktop App (Electron main/renderer) if it spawned this Host.
    const parentSample = hostSample.ppid > 1 ? byPid.get(hostSample.ppid) : undefined;
    if (parentSample && /electron|tarobird|tarobot/i.test(parentSample.name)) {
      ownedPids.add(parentSample.pid);
      selfProcesses.push({
        id: `app:${parentSample.pid}`,
        pid: parentSample.pid,
        ppid: parentSample.ppid,
        name: "TaroBird App",
        kind: "app",
        cpuPercent: roundCpu(parentSample.cpuPercent),
        memoryBytes: parentSample.memoryBytes,
        stoppable: false,
      });
      for (const sibling of byParent.get(parentSample.pid) ?? []) {
        if (sibling.pid === hostSample.pid || ownedPids.has(sibling.pid)) continue;
        if (/electron|helper|renderer|gpu|tarobird|tarobot/i.test(sibling.name)) {
          ownedPids.add(sibling.pid);
          selfProcesses.push({
            id: `app:${sibling.pid}`,
            pid: sibling.pid,
            ppid: sibling.ppid,
            name: sibling.name,
            kind: "app",
            cpuPercent: roundCpu(sibling.cpuPercent),
            memoryBytes: sibling.memoryBytes,
            stoppable: false,
          });
        }
      }
    }

    const botGroups: ResourceBotGroup[] = [];
    for (const bot of visibleBots) {
      const gatewayPid = botPids.get(bot.id);
      const gatewaySample = gatewayPid ? byPid.get(gatewayPid) : undefined;
      const turns = activeTurnsByBot.get(bot.id) ?? [];
      if (!gatewaySample && !turns.length && !bot.online) continue;

      const descendants = gatewayPid ? collectDescendants(gatewayPid, byParent) : [];
      if (gatewayPid) ownedPids.add(gatewayPid);
      for (const proc of descendants) ownedPids.add(proc.pid);

      const convGroups: ResourceConversationGroup[] = [];
      const botUnattributed: ResourceProcess[] = [];

      if (gatewaySample) {
        botUnattributed.push({
          id: `gateway:${bot.id}:${gatewaySample.pid}`,
          pid: gatewaySample.pid,
          ppid: gatewaySample.ppid,
          name: `${bot.engine || "bot"} gateway`,
          kind: "gateway",
          cpuPercent: roundCpu(gatewaySample.cpuPercent),
          memoryBytes: gatewaySample.memoryBytes,
          botId: bot.id,
          botName: bot.name,
          engine: bot.engine,
          stoppable: false,
        });
      }

      if (turns.length === 1) {
        const turn = turns[0]!;
        const turnProcesses: ResourceProcess[] = descendants.map((proc) => ({
          id: `engine:${bot.id}:${turn.conversationId}:${proc.pid}`,
          pid: proc.pid,
          ppid: proc.ppid,
          name: proc.name,
          kind: "engine",
          cpuPercent: roundCpu(proc.cpuPercent),
          memoryBytes: proc.memoryBytes,
          botId: bot.id,
          botName: bot.name,
          engine: bot.engine,
          conversationId: turn.conversationId,
          conversationTitle: turn.conversationTitle,
          startedAt: turn.startedAt,
          stoppable: canStop,
        }));
        convGroups.push({
          conversationId: turn.conversationId,
          title: turn.conversationTitle,
          active: true,
          cpuPercent: roundCpu(turnProcesses.reduce((sum, p) => sum + p.cpuPercent, 0)),
          memoryBytes: turnProcesses.reduce((sum, p) => sum + p.memoryBytes, 0),
          stoppable: canStop,
          processes: turnProcesses,
        });
      } else if (turns.length > 1) {
        // Group top-level direct children of gateway (each representing a spawned engine tree)
        // in ascending PID order alongside turns in ascending start order.
        const directChildren = (gatewayPid ? byParent.get(gatewayPid) ?? [] : []).slice().sort((a, b) => a.pid - b.pid);
        const assignedPids = new Set<number>();
        turns.forEach((turn, index) => {
          const root = directChildren[index];
          const tree = root ? [root, ...collectDescendants(root.pid, byParent)] : [];
          for (const proc of tree) assignedPids.add(proc.pid);
          const turnProcesses: ResourceProcess[] = tree.map((proc) => ({
            id: `engine:${bot.id}:${turn.conversationId}:${proc.pid}`,
            pid: proc.pid,
            ppid: proc.ppid,
            name: proc.name,
            kind: "engine",
            cpuPercent: roundCpu(proc.cpuPercent),
            memoryBytes: proc.memoryBytes,
            botId: bot.id,
            botName: bot.name,
            engine: bot.engine,
            conversationId: turn.conversationId,
            conversationTitle: turn.conversationTitle,
            startedAt: turn.startedAt,
            stoppable: canStop,
          }));
          convGroups.push({
            conversationId: turn.conversationId,
            title: turn.conversationTitle,
            active: true,
            cpuPercent: roundCpu(turnProcesses.reduce((sum, p) => sum + p.cpuPercent, 0)),
            memoryBytes: turnProcesses.reduce((sum, p) => sum + p.memoryBytes, 0),
            stoppable: canStop,
            processes: turnProcesses,
          });
        });
        for (const proc of descendants) {
          if (assignedPids.has(proc.pid)) continue;
          botUnattributed.push({
            id: `engine:${bot.id}:unattributed:${proc.pid}`,
            pid: proc.pid,
            ppid: proc.ppid,
            name: proc.name,
            kind: "engine",
            cpuPercent: roundCpu(proc.cpuPercent),
            memoryBytes: proc.memoryBytes,
            botId: bot.id,
            botName: bot.name,
            engine: bot.engine,
            stoppable: canStop,
          });
        }
      } else {
        // Idle persistent engine workers (e.g., Codex app-server / Claude stream / Pi RPC)
        for (const proc of descendants) {
          botUnattributed.push({
            id: `engine:${bot.id}:idle:${proc.pid}`,
            pid: proc.pid,
            ppid: proc.ppid,
            name: proc.name,
            kind: "engine",
            cpuPercent: roundCpu(proc.cpuPercent),
            memoryBytes: proc.memoryBytes,
            botId: bot.id,
            botName: bot.name,
            engine: bot.engine,
            stoppable: canStop,
          });
        }
      }

      const botCpu = roundCpu(
        convGroups.reduce((s, c) => s + c.cpuPercent, 0) + botUnattributed.reduce((s, p) => s + p.cpuPercent, 0),
      );
      const botMem = convGroups.reduce((s, c) => s + c.memoryBytes, 0) + botUnattributed.reduce((s, p) => s + p.memoryBytes, 0);

      botGroups.push({
        botId: bot.id,
        botName: bot.name,
        engine: bot.engine,
        online: Boolean(bot.online),
        ...(gatewayPid ? { gatewayPid } : {}),
        cpuPercent: botCpu,
        memoryBytes: botMem,
        activeTurns: turns.length,
        conversations: convGroups,
        unattributed: botUnattributed,
      });
    }

    // Any remaining descendants of the Hub not attributed to a Bot gateway
    const unattributed: ResourceProcess[] = [];
    for (const proc of collectDescendants(hubPid, byParent)) {
      if (ownedPids.has(proc.pid)) continue;
      ownedPids.add(proc.pid);
      unattributed.push({
        id: `unattributed:${proc.pid}`,
        pid: proc.pid,
        ppid: proc.ppid,
        name: proc.name,
        kind: "unattributed",
        cpuPercent: roundCpu(proc.cpuPercent),
        memoryBytes: proc.memoryBytes,
        stoppable: false,
      });
    }

    const hostCpu = roundCpu(selfProcesses.filter((p) => p.kind === "host").reduce((s, p) => s + p.cpuPercent, 0));
    const hostMem = selfProcesses.filter((p) => p.kind === "host").reduce((s, p) => s + p.memoryBytes, 0);
    const appCpu = roundCpu(selfProcesses.filter((p) => p.kind === "app").reduce((s, p) => s + p.cpuPercent, 0));
    const appMem = selfProcesses.filter((p) => p.kind === "app").reduce((s, p) => s + p.memoryBytes, 0);
    const engineCpu = roundCpu(botGroups.reduce((s, b) => s + b.cpuPercent, 0) + unattributed.reduce((s, p) => s + p.cpuPercent, 0));
    const engineMem = botGroups.reduce((s, b) => s + b.memoryBytes, 0) + unattributed.reduce((s, p) => s + p.memoryBytes, 0);
    const totalCpu = roundCpu(hostCpu + appCpu + engineCpu);
    const totalMem = hostMem + appMem + engineMem;
    const now = Date.now();

    if (force || !this.history.length || now - this.lastSampleAt >= MIN_HISTORY_INTERVAL_MS) {
      this.lastSampleAt = now;
      this.history.push({ at: now, cpuPercent: totalCpu, memoryBytes: totalMem });
      while (this.history.length > HISTORY_LIMIT) this.history.shift();
    }

    const processCount =
      selfProcesses.length +
      botGroups.reduce((s, b) => s + b.unattributed.length + b.conversations.reduce((cs, c) => cs + c.processes.length, 0), 0) +
      unattributed.length;

    return hostResourcesSnapshotSchema.parse({
      v: 1,
      sampledAt: now,
      platform,
      canStop,
      summary: {
        totalCpuPercent: totalCpu,
        totalMemoryBytes: totalMem,
        hostCpuPercent: hostCpu,
        hostMemoryBytes: hostMem,
        appCpuPercent: appCpu,
        appMemoryBytes: appMem,
        engineCpuPercent: engineCpu,
        engineMemoryBytes: engineMem,
        activeTasks: activeTurns.length,
        processCount,
      },
      history: [...this.history],
      selfProcesses,
      bots: botGroups,
      unattributed,
    });
  }

  async stop(userId: string, request: HostResourceStopRequest): Promise<HostResourceStopResult> {
    if (request.conversationId) {
      const conversations = await this.options.store.conversations(userId);
      const conversation = conversations.find((c) => c.id === request.conversationId);
      if (!conversation || !conversation.botIds.includes(request.botId)) {
        throw new HubError("bot_forbidden", 403);
      }
      try {
        const stopped = await this.options.stopBotTurn(request.botId, request.conversationId, userId);
        await this.options.store.audit("host_resources.stopped", userId, {
          botId: request.botId,
          conversationId: request.conversationId,
          method: "turn_stop",
          stopped,
        });
        if (stopped || !request.pid) {
          return { ok: true, stopped, method: "turn_stop" };
        }
      } catch (error) {
        if (!request.pid) throw error;
      }
    }

    if (!request.pid) {
      throw new HubError("invalid_request", 400);
    }

    // Security boundary: only terminate a verified descendant of this Bot's gateway.
    const gatewayPid = this.options.childPids().get(request.botId);
    if (!gatewayPid || request.pid === gatewayPid || request.pid === (this.options.hubPid ?? process.pid)) {
      throw new HubError("resource_process_not_owned", 403);
    }
    const platform = this.options.platform ?? process.platform;
    const samples = await (this.options.sampleProcesses ?? (() => sampleOsProcesses(platform)))();
    const byParent = new Map<number, OsProcessSample[]>();
    for (const sample of samples) {
      const list = byParent.get(sample.ppid);
      if (list) list.push(sample);
      else byParent.set(sample.ppid, [sample]);
    }
    const descendants = collectDescendants(gatewayPid, byParent);
    if (!descendants.some((p) => p.pid === request.pid)) {
      throw new HubError("resource_process_not_owned", 403);
    }
    if (this.options.killPid) {
      await this.options.killPid(request.pid);
    } else {
      await killProcessTree(request.pid);
    }
    await this.options.store.audit("host_resources.stopped", userId, {
      botId: request.botId,
      ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      pid: request.pid,
      method: "process_tree",
    });
    return { ok: true, stopped: true, method: "process_tree" };
  }
}
