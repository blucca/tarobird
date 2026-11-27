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
import {
  buildWindowsProcessSampleScript,
  parsePosixPsOutput,
  parseWindowsProcessJson,
  sanitizeProcessName,
  type OsProcessSample,
} from "../src/hub/host-resources.js";
import { HubServer } from "../src/hub/server.js";

let tempRoot: string;
beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tarobird-resources-"));
});
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("host-resources parsers, Windows PS5.1 script, and formatting (#124)", () => {
  it("parses macOS/Linux ps output (including paths with spaces) and Windows CIM/JSON output cleanly", () => {
    const posix = parsePosixPsOutput([
      "  100     1   2.5  102400 /usr/local/bin/node",
      "  200   100  18.4  262144 /opt/bin/codex",
      "  bad line",
      "  201   200  64.0  524288 python3",
      "  300     1   3.1  150000 /Applications/TaroBird.app/Contents/Frameworks/TaroBird Helper (Renderer).app/Contents/MacOS/TaroBird Helper (Renderer)",
      "  301   300   1.2   80000 /opt/Application Support/TaroBird/node",
    ].join("\n"));
    expect(posix).toHaveLength(5);
    expect(posix[0]).toEqual({ pid: 100, ppid: 1, cpuPercent: 2.5, memoryBytes: 102400 * 1024, name: "node" });
    expect(posix[1]).toEqual({ pid: 200, ppid: 100, cpuPercent: 18.4, memoryBytes: 262144 * 1024, name: "codex" });
    expect(posix[2]).toEqual({ pid: 201, ppid: 200, cpuPercent: 64, memoryBytes: 524288 * 1024, name: "python3" });
    expect(posix[3]).toEqual({ pid: 300, ppid: 1, cpuPercent: 3.1, memoryBytes: 150000 * 1024, name: "TaroBird Helper (Renderer)" });
    expect(posix[4]).toEqual({ pid: 301, ppid: 300, cpuPercent: 1.2, memoryBytes: 80000 * 1024, name: "node" });

    expect(sanitizeProcessName("C:\\Program Files\\TaroBird\\tarocub-client.exe")).toBe("tarocub-client.exe");

    const win = parseWindowsProcessJson(JSON.stringify([
      { ProcessId: 1000, ParentProcessId: 4, Name: "node.exe", WorkingSetSize: 90_000_000, CpuPercent: 3.2 },
      { ProcessId: 1200, ParentProcessId: 1000, Name: "claude.exe", WorkingSetSize: 310_000_000, CpuPercent: 41.7 },
    ]));
    expect(win).toHaveLength(2);
    expect(win[1]).toEqual({ pid: 1200, ppid: 1000, cpuPercent: 41.7, memoryBytes: 310_000_000, name: "claude.exe" });

    // Single-object ConvertTo-Json output (no array wrapper) is also supported.
    const singleWin = parseWindowsProcessJson(JSON.stringify(
      { ProcessId: 1000, ParentProcessId: 4, Name: "C:\\Program Files\\TaroBird\\tarocub-client.exe", WorkingSetSize: 120_000_000, CpuPercent: 5.5 },
    ));
    expect(singleWin).toEqual([{ pid: 1000, ppid: 4, cpuPercent: 5.5, memoryBytes: 120_000_000, name: "tarocub-client.exe" }]);

    expect(formatMemoryBytes(0)).toBe("0 MB");
    expect(formatMemoryBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(formatMemoryBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.50 GB");
    expect(formatCpuPercent(12.34)).toBe("12.3%");
    expect(formatCpuPercent(142.8)).toBe("143%");
  });

  it("builds a Windows PowerShell 5.1-compatible sampling script without PS7-only operators", () => {
    const script = buildWindowsProcessSampleScript();
    // PowerShell 7-only operators (`??`, `??=`, `&&`, `||`) cause ParserError on Windows PowerShell 5.1.
    expect(script).not.toContain("??");
    expect(script).not.toContain("&&");
    expect(script).not.toContain("||");
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Win32_PerfFormattedData_PerfProc_Process");
    expect(script).toContain("$perf.ContainsKey(");
    expect(script).toContain("ConvertTo-Json -Compress");
  });
});

describe("HubHostResources attribution, isolation, bounds, desktop detection, and stopping (#124)", () => {
  it("attributes concurrent Bots accurately, isolates non-owner members and history, and separates turn_stop from process_tree kills", async () => {
    const hubPid = process.pid;
    const fakeSamples: OsProcessSample[] = [
      { pid: 50, ppid: 1, cpuPercent: 1.5, memoryBytes: 180 * 1024 * 1024, name: "TaroBird" },
      { pid: hubPid, ppid: 50, cpuPercent: 2.0, memoryBytes: 120 * 1024 * 1024, name: "node" },
      // Bot A gateway + active codex engine
      { pid: 7001, ppid: hubPid, cpuPercent: 0.8, memoryBytes: 40 * 1024 * 1024, name: "node" },
      { pid: 7101, ppid: 7001, cpuPercent: 32.5, memoryBytes: 420 * 1024 * 1024, name: "codex" },
      // Bot B gateway + active claude engine
      { pid: 7002, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 38 * 1024 * 1024, name: "node" },
      { pid: 7102, ppid: 7002, cpuPercent: 19.2, memoryBytes: 310 * 1024 * 1024, name: "claude" },
      // Bot C gateway + active pi engine
      { pid: 7003, ppid: hubPid, cpuPercent: 0.6, memoryBytes: 36 * 1024 * 1024, name: "node" },
      { pid: 7103, ppid: 7003, cpuPercent: 8.0, memoryBytes: 190 * 1024 * 1024, name: "pi" },
      // Unattributed child of Hub (visible to owner only)
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
    const stoppedTurns: Array<{ botId: string; conversationId: string; userId: string }> = [];
    let stopBotTurnBehavior: "true" | "false" | "throw" = "true";

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-attribution"),
      hostResourcesSampler: async () => fakeSamples,
      hostResourcesBotPids: () => new Map(botPidMap),
      hostResourcesKillPid: async (pid) => { killedPids.push(pid); },
      hostResourcesStopBotTurn: async (botId, conversationId, userId) => {
        stoppedTurns.push({ botId, conversationId, userId });
        if (stopBotTurnBehavior === "throw") throw new Error("bot_offline");
        return stopBotTurnBehavior === "true";
      },
    });

    try {
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
      const convA = await hub.store.createConversation("owner", ["bot_a"], "Alpha Refactor", "conv_a", { type: "direct" });
      const convB = await hub.store.createConversation("owner", ["bot_b"], "Beta Analysis", "conv_b", { type: "direct" });
      const convC = await hub.store.createConversation("owner", ["bot_c"], "Gamma Script", "conv_c", { type: "direct" });
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

      // Create a non-owner member with ZERO bot_grants
      await hub.store.db.run("INSERT INTO users(id,name,role) VALUES('member_1','Member','member')");

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

      // Second forced sample appends owner's sparkline history
      const ownerSnap2 = await hub.hostResources.snapshot("owner", true, true);
      expect(ownerSnap2.history).toHaveLength(2);

      // Member with zero bot_grants MUST NOT leak ungranted Bots, Hub unattributed helpers, or owner's history!
      const memberSnap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_1", false, true));
      expect(memberSnap.canStop).toBe(false);
      expect(memberSnap.bots).toEqual([]);
      expect(memberSnap.unattributed).toEqual([]);
      expect(memberSnap.summary.activeTasks).toBe(0);
      expect(memberSnap.summary.engineMemoryBytes).toBe(0);
      for (const forbiddenPid of [7001, 7002, 7003, 7101, 7102, 7103, 7999, 99999]) {
        expect(JSON.stringify(memberSnap)).not.toContain(`"pid":${forbiddenPid}`);
      }
      // Member gets their own isolated history buffer, and ?force=1 does not bypass MIN_HISTORY_INTERVAL_MS or pollute owner
      expect(memberSnap.history).toHaveLength(1);
      const memberSnap2 = await hub.hostResources.snapshot("member_1", false, true);
      expect(memberSnap2.history).toHaveLength(1);
      expect(memberSnap2.history[0]!.memoryBytes).toBe(memberSnap.summary.totalMemoryBytes);
      expect(memberSnap2.history[0]!.memoryBytes).toBeLessThan(ownerSnap2.summary.totalMemoryBytes);

      // Owner's history remains untouched by member calls
      const ownerSnapCheck = await hub.hostResources.snapshot("owner", true, false);
      expect(ownerSnapCheck.history).toHaveLength(2);
      expect(ownerSnapCheck.history.every((pt) => pt.memoryBytes === ownerSnap.summary.totalMemoryBytes)).toBe(true);

      // Grant member_1 access to shared bot_a while owner has a private active turn (convA) on bot_a:
      // member_1 must NOT see owner's engine subprocess (7101) in bot.unattributed!
      await hub.store.db.run("INSERT INTO bot_grants(user_id,bot_id) VALUES('member_1','bot_a')");
      const memberSharedIdle = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_1", false, false));
      expect(memberSharedIdle.bots).toHaveLength(1);
      expect(memberSharedIdle.bots[0]!.botId).toBe("bot_a");
      expect(memberSharedIdle.bots[0]!.activeTurns).toBe(0);
      expect(memberSharedIdle.bots[0]!.conversations).toEqual([]);
      expect(memberSharedIdle.bots[0]!.unattributed.map((p) => p.pid)).toEqual([7001]);
      expect(JSON.stringify(memberSharedIdle)).not.toContain(`"pid":7101`);

      // When member_1 ALSO runs a conversation on shared bot_a alongside owner's private turn on a single shared worker (7101),
      // owner's engine process (7101) must NOT be misattributed to member_1's conversation!
      const memberConv = await hub.store.createConversation("member_1", ["bot_a"], "Member Chat", "conv_member_a", { type: "direct" });
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES(?,?,?,'bot',?,'streaming',1,?)",
        ["msg_member_a", memberConv.id, "bot_a", JSON.stringify([{ type: "text", text: "member working…" }]), now + 500],
      );
      const memberSharedActive = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("member_1", false, false));
      expect(memberSharedActive.bots[0]!.activeTurns).toBe(1);
      expect(memberSharedActive.bots[0]!.conversations).toHaveLength(1);
      expect(memberSharedActive.bots[0]!.conversations[0]!.conversationId).toBe(memberConv.id);
      expect(memberSharedActive.bots[0]!.conversations[0]!.processes).toEqual([]);
      expect(memberSharedActive.bots[0]!.unattributed.map((p) => p.pid)).toEqual([7001]);
      expect(JSON.stringify(memberSharedActive)).not.toContain(`"pid":7101`);

      // Graceful conversation stop routes through stopBotTurn and never kills PIDs
      stopBotTurnBehavior = "true";
      const turnStopOk = await hub.hostResources.stop("owner", { botId: "bot_a", conversationId: convA.id });
      expect(turnStopOk).toEqual({ ok: true, stopped: true, method: "turn_stop" });
      expect(stoppedTurns).toEqual([{ botId: "bot_a", conversationId: convA.id, userId: "owner" }]);
      expect(killedPids).toEqual([]);

      // Even if a caller passes both conversationId and pid and stopBotTurn returns false,
      // stop() MUST NOT fall through to killProcessTree (protecting shared persistent engine workers)!
      stopBotTurnBehavior = "false";
      const turnStopFalse = await hub.hostResources.stop("owner", { botId: "bot_a", conversationId: convA.id, pid: 7101 });
      expect(turnStopFalse).toEqual({ ok: true, stopped: false, method: "turn_stop" });
      expect(killedPids).toEqual([]);

      // And if stopBotTurn throws, stop() propagates the error instead of killing the persistent PID!
      stopBotTurnBehavior = "throw";
      await expect(hub.hostResources.stop("owner", { botId: "bot_a", conversationId: convA.id, pid: 7101 })).rejects.toThrow("bot_offline");
      expect(killedPids).toEqual([]);

      // Explicit PID stop (without conversationId) kills ONLY that verified descendant process tree
      const stopRes = await hub.hostResources.stop("owner", { botId: "bot_b", pid: 7102 });
      expect(stopRes).toEqual({ ok: true, stopped: true, method: "process_tree" });
      expect(killedPids).toEqual([7102]);

      // Refuses to kill a PID outside the Bot's process tree (e.g. Hub, gateway, other Bot, or unrelated system PID)
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 99999 })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: hubPid })).rejects.toThrow("resource_process_not_owned");
      await expect(hub.hostResources.stop("owner", { botId: "bot_b", pid: 7002 })).rejects.toThrow("resource_process_not_owned");
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

  it("caps >64 descendant processes and long IDs to schema bounds while keeping accurate summary totals", async () => {
    const hubPid = process.pid;
    const longBotId = `bot_${"a".repeat(120)}`;
    const longConvTitle = "Runaway build storm ".repeat(12).trim();
    const samples: OsProcessSample[] = [
      { pid: hubPid, ppid: 1, cpuPercent: 1.0, memoryBytes: 100 * 1024 * 1024, name: "node" },
      { pid: 8000, ppid: hubPid, cpuPercent: 0.5, memoryBytes: 40 * 1024 * 1024, name: "node" },
    ];
    // 75 child processes under bot gateway 8000 (exceeds schema .max(64))
    let expectedChildMem = 0;
    for (let i = 1; i <= 75; i += 1) {
      const mem = i * 1024 * 1024;
      expectedChildMem += mem;
      samples.push({ pid: 8100 + i, ppid: 8000, cpuPercent: 0.5, memoryBytes: mem, name: `worker-${i}` });
    }
    // 70 unattributed children under hubPid (exceeds schema .max(64))
    let expectedHubUnattrMem = 0;
    for (let i = 1; i <= 70; i += 1) {
      const mem = i * 512 * 1024;
      expectedHubUnattrMem += mem;
      samples.push({ pid: 9100 + i, ppid: hubPid, cpuPercent: 0.1, memoryBytes: mem, name: `hub-child-${i}` });
    }

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-bounds"),
      hostResourcesSampler: async () => samples,
      hostResourcesBotPids: () => new Map([[longBotId, 8000]]),
    });

    try {
      await hub.store.db.run(
        "INSERT INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,?,?,1)",
        [longBotId, "LongBot ".repeat(30), "codex-custom-engine-name-".repeat(3), "hash_long"],
      );
      const longConvId = `conv_${"b".repeat(120)}`;
      await hub.store.db.run(
        "INSERT INTO conversations(id,type,title,owner_id,created_at) VALUES(?,'direct',?,'owner',?)",
        [longConvId, longConvTitle, Date.now()],
      );
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [longConvId]);
      await hub.store.db.run("INSERT INTO conversation_members VALUES(?,'bot',?,0)", [longConvId, longBotId]);
      await hub.store.db.run(
        "INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,created_at) VALUES('msg_long',?,?,'bot',?,'streaming',1,?)",
        [longConvId, longBotId, JSON.stringify([{ type: "text", text: "running" }]), Date.now()],
      );

      // Must parse cleanly with zero ZodError!
      const snap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      expect(snap.bots).toHaveLength(1);
      expect(snap.bots[0]!.conversations).toHaveLength(1);
      expect(snap.bots[0]!.conversations[0]!.processes).toHaveLength(64);
      // Highest-memory processes are retained when capped
      expect(snap.bots[0]!.conversations[0]!.processes[0]!.pid).toBe(8175);
      // All process IDs stay within schema max(200)
      expect(snap.bots[0]!.conversations[0]!.processes.every((p) => p.id.length <= 200)).toBe(true);
      expect(snap.unattributed).toHaveLength(64);
      expect(snap.unattributed[0]!.pid).toBe(9170);

      // Summary totals reflect ALL 75 bot children + 70 unattributed children + gateway + host!
      expect(snap.summary.processCount).toBe(1 + 1 + 75 + 70);
      expect(snap.bots[0]!.conversations[0]!.memoryBytes).toBe(expectedChildMem);
      expect(snap.summary.engineMemoryBytes).toBe(40 * 1024 * 1024 + expectedChildMem + expectedHubUnattrMem);
    } finally {
      await hub.close();
    }
  });

  it("detects detached desktop App (`tarocub-client` and helpers) when Hub has ppid=1 without capturing unrelated apps", async () => {
    const hubPid = process.pid;
    const samples: OsProcessSample[] = [
      // Detached Hub (ppid=1, as spawned by desktop-host service)
      { pid: hubPid, ppid: 1, cpuPercent: 1.5, memoryBytes: 110 * 1024 * 1024, name: "node" },
      // Packaged desktop App + macOS helpers + native helper
      { pid: 4000, ppid: 1, cpuPercent: 2.2, memoryBytes: 160 * 1024 * 1024, name: "tarocub-client" },
      { pid: 4001, ppid: 4000, cpuPercent: 4.1, memoryBytes: 240 * 1024 * 1024, name: "TaroBird Helper (Renderer)" },
      { pid: 4002, ppid: 4000, cpuPercent: 1.3, memoryBytes: 95 * 1024 * 1024, name: "TaroBird Helper (GPU)" },
      { pid: 4003, ppid: 4000, cpuPercent: 0.2, memoryBytes: 18 * 1024 * 1024, name: "tarobot-desktop-core" },
      // Unrelated Electron app on the same machine (must NOT be captured!)
      { pid: 8888, ppid: 1, cpuPercent: 12.0, memoryBytes: 500 * 1024 * 1024, name: "Electron" },
      { pid: 8889, ppid: 8888, cpuPercent: 8.0, memoryBytes: 300 * 1024 * 1024, name: "Code Helper (Renderer)" },
    ];

    const hub = await HubServer.start({
      stateDir: path.join(tempRoot, "hub-detached-app"),
      hostResourcesSampler: async () => samples,
      hostResourcesBotPids: () => new Map(),
    });

    try {
      const snap = hostResourcesSnapshotSchema.parse(await hub.hostResources.snapshot("owner", true, true));
      const appPids = snap.selfProcesses.filter((p) => p.kind === "app").map((p) => p.pid).sort((a, b) => a - b);
      expect(appPids).toEqual([4000, 4001, 4002, 4003]);
      expect(snap.summary.appMemoryBytes).toBe((160 + 240 + 95 + 18) * 1024 * 1024);
      expect(JSON.stringify(snap)).not.toContain(`"pid":8888`);
      expect(JSON.stringify(snap)).not.toContain(`"pid":8889`);
    } finally {
      await hub.close();
    }
  });
});
