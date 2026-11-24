import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  selectBalancedHost,
  type HostBalanceCandidate,
} from "../src/client-protocol/host-balancer.js";
import { HOST_RESOURCES_CAPABILITY, hostResourcesSchema } from "../src/client-protocol/host-resources.js";
import { SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import { runConversationsCommand } from "../src/host-cli/conversations.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function candidate(overrides: Partial<HostBalanceCandidate> & { hostId: string; hostName: string }): HostBalanceCandidate {
  return {
    online: true,
    preference: "normal",
    engineAvailable: true,
    quotaExhausted: false,
    latencyMs: 12,
    matchingBotId: `bot-${overrides.hostId}`,
    resources: {
      cpuPercent: 20,
      cpuCores: 8,
      loadAvg1m: 1.2,
      memoryUsedPercent: 40,
      memoryFreeBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
      activeTurns: 0,
      activeTickets: 0,
      capturedAt: Date.now(),
    },
    ...overrides,
  };
}

describe("Auto-select Host load balancing (#88)", () => {
  it("advertises host.resources.v1 capability", () => {
    expect(SERVER_CAPABILITIES).toContain(HOST_RESOURCES_CAPABILITY);
  });

  it("excludes offline, manual-only, engine-unavailable, quota-exhausted, and overloaded hosts", () => {
    const result = selectBalancedHost([
      candidate({ hostId: "h-offline", hostName: "offline-box", online: false }),
      candidate({ hostId: "h-manual", hostName: "manual-box", preference: "manual_only" }),
      candidate({ hostId: "h-no-engine", hostName: "no-cli-box", engineAvailable: false }),
      candidate({ hostId: "h-no-quota", hostName: "empty-quota-box", quotaExhausted: true }),
      candidate({ hostId: "h-full", hostName: "full-box", resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 97 } }),
      candidate({ hostId: "h-ok", hostName: "macmini" }),
    ]);

    expect(result.selected?.hostId).toBe("h-ok");
    expect(result.excluded.map((e) => [e.hostId, e.reason])).toEqual([
      ["h-offline", "offline"],
      ["h-manual", "manual_only"],
      ["h-no-engine", "engine_unavailable"],
      ["h-no-quota", "quota_exhausted"],
      ["h-full", "overloaded"],
    ]);
  });

  it("picks by load, latency, and preference across 3 hosts (one busy, one less_often, one idle)", () => {
    const busy = candidate({
      hostId: "h-busy",
      hostName: "busy-box",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 78, memoryUsedPercent: 80, activeTurns: 3, activeTickets: 2 },
    });
    const lessOften = candidate({
      hostId: "h-less",
      hostName: "less-box",
      preference: "less_often",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 18, memoryUsedPercent: 35, activeTurns: 0 },
    });
    const normalIdle = candidate({
      hostId: "h-idle",
      hostName: "macmini",
      preference: "normal",
      resources: { ...candidate({ hostId: "x", hostName: "x" }).resources!, cpuPercent: 22, memoryUsedPercent: 40, activeTurns: 0 },
    });

    const pick1 = selectBalancedHost([busy, lessOften, normalIdle]);
    expect(pick1.selected?.hostId).toBe("h-idle");

    // Once h-idle gets busy (2 active turns), lessOften wins over heavily busy host
    const idleNowBusy = { ...normalIdle, resources: { ...normalIdle.resources!, cpuPercent: 65, activeTurns: 2 } };
    const pick2 = selectBalancedHost([busy, lessOften, idleNowBusy]);
    expect(pick2.selected?.hostId).toBe("h-less");

    // A "prefer" host with spare resources beats an equal "normal" host
    const preferred = candidate({ hostId: "h-pref", hostName: "studio", preference: "prefer" });
    const pick3 = selectBalancedHost([normalIdle, preferred]);
    expect(pick3.selected?.hostId).toBe("h-pref");
  });

  it("spreads consecutive creations across equally idle hosts via recentAssignments and falls back to manual when none eligible", () => {
    const a = candidate({ hostId: "h-a", hostName: "macmini" });
    const b = candidate({ hostId: "h-b", hostName: "studio" });
    const first = selectBalancedHost([a, b], { recentAssignments: [] });
    expect(first.selected?.hostId).toBe("h-a");
    const second = selectBalancedHost([a, b], { recentAssignments: ["h-a"] });
    expect(second.selected?.hostId).toBe("h-b");

    // All unavailable -> selected is null with fallback reason
    const none = selectBalancedHost([
      candidate({ hostId: "h-1", hostName: "box-1", online: false }),
      candidate({ hostId: "h-2", hostName: "box-2", resources: undefined }),
    ], { requireResources: true });
    expect(none.selected).toBeNull();
    expect(none.reason).toBe("no_eligible_host");
    expect(none.excluded).toHaveLength(2);
  });

  it("serves read-only /api/host-resources to authorized devices and rejects unauthenticated callers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "host-res-"));
    tempDirs.push(stateDir);
    const hub = await HubServer.start({ stateDir });
    try {
      const unauth = await fetch(`${hub.url}/api/host-resources`);
      expect(unauth.status).toBe(401);

      const keys = generateKeyPairSync("ed25519");
      const pair = await hub.auth.pair({
        deviceId: "dev-res", name: "Owner", platform: "web",
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      }, "127.0.0.1");
      await hub.auth.approve(pair.code, "local-owner");
      const challenge = await hub.auth.challenge("conn_res", "dev-res", randomBytes(16).toString("hex"), "127.0.0.1");
      const nonceUsed = challenge.nonce;
      // Re-run with known clientNonce so proof matches
      const clientNonce = "res-client-nonce-1234567890";
      const ch2 = await hub.auth.challenge("conn_res_2", "dev-res", clientNonce, "127.0.0.1");
      expect(nonceUsed).toBeTruthy();
      const session = await hub.auth.authenticate("conn_res_2", sign(null, deviceProof("dev-res", ch2.nonce, clientNonce), keys.privateKey).toString("base64"));

      const res = await fetch(`${hub.url}/api/host-resources`, {
        headers: { Authorization: `Bearer ${session.token}` },
      });
      expect(res.status).toBe(200);
      const body = hostResourcesSchema.parse(await res.json());
      expect(body.cpuCores).toBeGreaterThan(0);
      expect(body.memoryTotalBytes).toBeGreaterThan(0);
      expect(body.activeTurns).toBe(0);
      expect(body.activeTickets).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("supports CLI conversations create --host auto reusing an existing matching Bot", async () => {
    const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
    const fakeClient = {
      ready: {
        serverCapabilities: [HOST_RESOURCES_CAPABILITY],
        bots: [{ id: "bot_claude", name: "Claude Bot", engine: "claude", online: true }],
      },
      request: async (reqPath: string, method?: string, body?: unknown) => {
        requests.push({ path: reqPath, method, body });
        if (reqPath === "/api/host-profile") return { name: "macmini", revision: 0 };
        if (reqPath === "/api/host-resources") {
          return { cpuPercent: 18, cpuCores: 8, loadAvg1m: 1.1, memoryUsedPercent: 36, memoryFreeBytes: 8e9, memoryTotalBytes: 16e9, activeTurns: 0, activeTickets: 0, capturedAt: Date.now() };
        }
        if (reqPath === "/api/conversations" && method === "POST") {
          return { id: "conv_auto_1", type: "direct", title: "CLI Auto Chat", ownerId: "owner", botIds: ["bot_claude"], archived: false, createdAt: Date.now() };
        }
        throw new Error(`Unexpected request: ${reqPath}`);
      },
    };
    const result = await runConversationsCommand(fakeClient as never, "create", { host: "auto", engine: "claude", title: "CLI Auto Chat" });
    expect(result).toMatchObject({
      host: "macmini",
      hostSelection: "auto",
      botId: "bot_claude",
      createdBot: false,
      conversation: { id: "conv_auto_1", title: "CLI Auto Chat" },
    });
    expect(requests.some((r) => r.path === "/api/host-resources")).toBe(true);
  });
});
