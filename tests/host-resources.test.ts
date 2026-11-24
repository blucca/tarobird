import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatCpuPercent,
  formatMemoryBytes,
  HOST_RESOURCES_CAPABILITY,
  HOST_RESOURCES_PATH,
  HOST_RESOURCES_STOP_PATH,
  hostResourcesSnapshotSchema,
  sortResourceBots,
} from "../src/client-protocol/host-resources.js";
import { parsePosixPsOutput, parseWindowsProcessJson, type OsProcessSample } from "../src/hub/host-resources.js";
import { HubServer } from "../src/hub/server.js";

let tempRoot: string;
beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tarobird-resources-"));
});
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("host-resources parsers and formatting (#124)", () => {
  it("parses macOS/Linux ps output and Windows CIM/JSON output cleanly", () => {
    const posix = parsePosixPsOutput([
      "  100     1   2.5  102400 /usr/local/bin/node",
      "  200   100  18.4  262144 /opt/bin/codex",
      "  bad line",
      "  201   200  64.0  524288 python3",
    ].join("\n"));
    expect(posix).toHaveLength(3);
    expect(posix[0]).toEqual({ pid: 100, ppid: 1, cpuPercent: 2.5, memoryBytes: 102400 * 1024, name: "node" });
    expect(posix[1]).toEqual({ pid: 200, ppid: 100, cpuPercent: 18.4, memoryBytes: 262144 * 1024, name: "codex" });
    expect(posix[2]).toEqual({ pid: 201, ppid: 200, cpuPercent: 64, memoryBytes: 524288 * 1024, name: "python3" });

    const win = parseWindowsProcessJson(JSON.stringify([
      { ProcessId: 1000, ParentProcessId: 4, Name: "node.exe", WorkingSetSize: 90_000_000, CpuPercent: 3.2 },
      { ProcessId: 1200, ParentProcessId: 1000, Name: "claude.exe", WorkingSetSize: 310_000_000, CpuPercent: 41.7 },
    ]));
    expect(win).toHaveLength(2);
    expect(win[1]).toEqual({ pid: 1200, ppid: 1000, cpuPercent: 41.7, memoryBytes: 310_000_000, name: "claude.exe" });

    expect(formatMemoryBytes(0)).toBe("0 MB");
    expect(formatMemoryBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatMemoryBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
    expect(formatCpuPercent(12.34)).toBe("12.3%");
    expect(formatCpuPercent(142.8)).toBe("143%");
  });
});

describe("HubHostResources attribution, sparkline history, authorization and stopping (#124)", () => {
  it("attributes three concurrent Bots & conversations accurately, enforces owner-only stop, and routes stop through turn.stop", async () => {
    const hubPid = process.pid;
    let fakeSamples: OsProcessSample[] = [
      { pid: 50, ppid: 1, cpuPercent: 1.5, memoryBytes: 180 * 1024 * 1024, name: "TaroBird" },
      { pid: hubPid, ppid: 50, cpuPercent: 2.0, memoryBytes: 120 * 1024 * 1024, name: "node" },
      // Bot A gateway + active codex engine
      { pid: 7001, ppid: hubPid, cpuPercent: 0.8, memoryBytes: 40 * 1024 * 1024, name: "node" },
      { pid: 7101, ppid: 7001, cpuPercent: 32.5, memoryBytes: 420 * 1024 * 1024, name: "codex" },
      // Bot B gateway + active claude engine
      { pid: 7002, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 38 * 1024 * 1024, name: "node" },
      { pid: 7102, ppid: 7002, cpuPercent: 19.2, memoryBytes: 310 * 1024 * 1024, name: "claude" },
      // Bot C gateway + active pi engine + child helper
      { pid: 7003, ppid: hubPid, cpuPercent: 0.6, memoryBytes: 36 * 1024 * 1024, name: "node" },
      { pid: 7103, ppid: 7003, cpuPercent: 8.0, memoryBytes: 190 * 1024 * 1024, name: "pi" },
      // Unattributed child of Hub
      { pid: 7999, ppid: hubPid, cpuPercent: 0.4, memoryBytes: 24 * 1024 * 1024, name: "helper-worker" },
      // Unrelated system process (must NEVER appear!)
      { pid: 99999, ppid: 1, cpuPercent: 99.0, memoryBytes: 8 * 1024 * 1024 * 1024, name: "unrelated-system-app" },
    ];
    const botPidMap = new Map<string, number>([
      ["bot_a", 7001],
      ["bot_b", 7002],
      ["bot_c", 7003],
    ]);
    const killedPids: number[] = [];

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-attribution"),
      hostResourcesSampler: async () => fakeSamples,
      hostResourcesBotPids: () => new Map(botPidMap),
      hostResourcesKillPid: async (pid) => { killedPids.push(pid); },
    });

    try {
      // Create 3 bots + 3 conversations + 3 active streaming turns
      const now = Date.now();
      for (const [id, name, engine] of [
        ["bot_a", "Codex Bot", "codex"],
        ["bot_b", "Claude Bot", "claude"],
        ["bot_c", "Pi Bot", "pi"],
      ] as const) {
        await hub.store.db.run(
          "INSERT INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,?,?,1)",
          [id, name, engine, `hash_${id}`],
        );
      }
      const convA = await hub.store.createConversation("owner", ["bot_a"], "Alpha Refactor", "conv_a", "direct");
      const convB = await hub.store.createConversation("owner", ["bot_b"], "Beta Analysis", "conv_b", "direct");
      const convC = await hub.store.createConversation("owner", ["bot_c"], "Gamma Script", "conv_c", "direct");
      for (const [botId, conv] of [
        ["bot_a", convA],
        ["bot_b", convB],
        ["bot_c", convC],
      ] as const) {
        await hub.store.db.run(
          "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES(?,?,?,'bot',?,'streaming',1,?)",
          [`msg_${botId}`, conv.id, botId, JSON.stringify([{ type: "text", text: "working…" }]), now],
        );
      }

      // Create a non-owner member user + device to verify read-only permission
      await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member_1','Member','member')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','member_1',0)", [convA.id]);

      // Snapshot as owner: sees all 3 bots, exact conversation attribution, excludes unrelated PID 99999
      const ownerSnap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      expect(ownerSnap.canStop).toBe(true);
      expect(ownerSnap.summary.activeTasks).toBe(3);
      expect(ownerSnap.selfProcesses.some((p) => p.kind === "host" && p.pid === hubPid)).toBe(true);
      expect(ownerSnap.selfProcesses.some((p) => p.kind === "app" && p.pid === 50)).toBe(true);
      expect(ownerSnap.unattributed.map((p) => p.pid)).toEqual([7999]);
      expect(JSON.stringify(ownerSnap)).not.toContain("unrelated-system-app");

      const sortedByMem = sortResourceBots(ownerSnap.bots, "memory");
      expect(sortedByMem.map((b) => b.botId)).toEqual(["bot_a", "bot_b", "bot_c"]);
      expect(sortedByMem[0]!.conversations[0]!.title).toBe("Alpha Refactor");
      expect(sortedByMem[0]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7101]);
      expect(sortedByMem[1]!.conversations[0]!.title).toBe("Beta Analysis");
      expect(sortedByMem[1]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7102]);
      expect(sortedByMem[2]!.conversations[0]!.title).toBe("Gamma Script");
      expect(sortedByMem[2]!.conversations[0]!.processes.map((p) => p.pid)).toEqual([7103]);

      // Second forced sample appends sparkline history
      const ownerSnap2 = await hub.hostResources.snapshot("owner", true, true);
      expect(ownerSnap2.history.length).toBeGreaterThanOrEqual(2);

      // Member snapshot is strictly read-only (`canStop: false`)
      const memberSnap = await hub.hostResources.snapshot("member_1", false, false);
      expect(memberSnap.canStop).toBe(false);
      expect(memberSnap.bots.every((b) => b.conversations.every((c) => !c.stoppable))).toBe(true);

      // Stopping a specific runaway PID inside Bot B's process tree succeeds without touching Bot A/C
      const stopRes = await hub.hostResources.stop("owner", { botId: "bot_b", pid: 7102 });
      expect(stopRes).toEqual({ ok: true, stopped: true, method: "process_tree" });
      expect(killedPids).toEqual([7102]);

      // Refuses to kill a PID outside the Bot's process tree (e.g. Hub or unrelated system PID)
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 99999 })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: hubPid })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 7101 })).rejects.toThrow("resource_process_not_owned");

      // Verify HTTP endpoints: unauthorized fails 401; capability constant exported
      expect(HOST_RESOURCES_CAPABILITY).toBe("host.resources.v1");
      const unauthGet = await fetch(hub.url + HOST_RESOURCES_PATH);
      expect(unauthGet.status).toBe(401);
      const unauthStop = await fetch(hub.url + HOST_RESOURCES_STOP_PATH, { method: "POST", body: JSON.stringify({ botId: "bot_a", pid: 7101 }) });
      expect(unauthStop.status).toBe(401);
    } finally {
      await hub.close();
    }
  });
});
