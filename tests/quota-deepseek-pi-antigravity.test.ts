import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeBalanceDecimal, parseDeepSeekAccountBalance } from "../src/codex/deepseek-account-quota.js";
import { DeepSeekHarnessAdapter } from "../src/codex/deepseek-harness-adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import {
  classifyAntigravityProcessLine,
  decodeAntigravityLocalStatus,
  decodeAntigravityLocalSummary,
  parseLsofListeningPorts,
  parseNetstatListeningPorts,
  probeAntigravityLocalServerQuota,
} from "../src/codex/antigravity-local-server.js";
import { AntigravityAcpAdapter } from "../src/codex/antigravity-acp-adapter.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("DeepSeek Harness wallet balance quota (#78)", () => {
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("normalizes decimal and scientific balance strings and projects recharge + bonus wallets", () => {
    expect(normalizeBalanceDecimal("0E-16")).toBe("0.00");
    expect(normalizeBalanceDecimal("5.0000000000000000")).toBe("5.00");
    expect(normalizeBalanceDecimal("12.5")).toBe("12.50");
    expect(normalizeBalanceDecimal("NaN")).toBeNull();
    expect(normalizeBalanceDecimal("-1")).toBeNull();

    const snap = parseDeepSeekAccountBalance({
      status: "ready",
      value: [{ currency: "CNY", balance: "88.5000" }, { currency: "USD", balance: "10" }],
      bonusWallets: [{ currency: "CNY", balance: "5.25" }],
    }, { now });
    expect(snap).toMatchObject({ state: "ready", authMode: "subscription", capability: { mode: "active" }, help: "deepseek_balance" });
    expect(snap.pools[0]?.balances).toEqual([
      expect.objectContaining({ id: "recharge_cny", kind: "currency", amount: "88.50", unit: "CNY" }),
      expect.objectContaining({ id: "recharge_usd", kind: "currency", amount: "10.00", unit: "USD" }),
      expect.objectContaining({ id: "bonus_cny", kind: "currency", amount: "5.25", unit: "CNY" }),
    ]);

    expect(parseDeepSeekAccountBalance(null, { now, hasApiKey: false })).toMatchObject({ state: "login_required", reason: "login_required" });
    expect(parseDeepSeekAccountBalance(null, { now, hasApiKey: true })).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key" });
    expect(parseDeepSeekAccountBalance({ status: "failed" }, { now })).toMatchObject({ state: "unavailable", reason: "native_error" });
  });

  it("queries account.getBalance through the existing private DeepSeek Harness host", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dsh-balance-"));
    roots.push(root);
    const request = vi.fn(async (method: string) => {
      if (method === "account.getBalance") {
        return { status: "ready", value: [{ currency: "CNY", balance: "42.00" }], bonusWallets: [] };
      }
      return {};
    });
    const gateway = {
      connect: vi.fn(async () => {}),
      request,
      respond: vi.fn(async () => ({ accepted: true })),
      respondError: vi.fn(async () => ({ accepted: true })),
      close: vi.fn(async () => {}),
    };
    const adapter = new DeepSeekHarnessAdapter({
      workspacePath: root,
      gateway: gateway as never,
    });
    disposals.push(() => adapter.destroy());

    const cached = await adapter.getAccountQuota({ refresh: false });
    expect(cached.snapshot).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
    expect(request).not.toHaveBeenCalled();

    const refreshed = await adapter.getAccountQuota({ refresh: true, expectedRevision: cached.revision });
    expect(refreshed.snapshot.state).toBe("ready");
    expect(refreshed.snapshot.pools[0]?.balances[0]).toMatchObject({ id: "recharge_cny", amount: "42.00", unit: "CNY" });
    expect(request).toHaveBeenCalledWith("account.getBalance", expect.objectContaining({ client: expect.any(Object) }), undefined);
  });
});

describe("Pi provider quota status (#78)", () => {
  it("reports mode_not_supported explicitly instead of not_adapted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-quota-"));
    roots.push(root);
    const adapter = new PiRpcAdapter({
      launch: { command: "pi", args: ["--mode", "rpc"], env: { HOME: root } },
      workspacePath: root,
      stateDir: root,
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    const res = await adapter.getAccountQuota({ refresh: false });
    expect(res.snapshot).toMatchObject({
      state: "unsupported",
      reason: "mode_not_supported",
      capability: { mode: "unsupported", reason: "mode_not_supported" },
      pools: [],
    });
  });
});

describe("Antigravity local language server quota without spawning agy (#78)", () => {
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("classifies processes, parses listening ports on POSIX and Windows, and decodes Connect-RPC summary + status", () => {
    expect(classifyAntigravityProcessLine("6441 agy acp --dangerously-skip-permissions")).toEqual({ pid: "6441", cli: true, csrf: undefined, extPort: undefined });
    expect(classifyAntigravityProcessLine("9100 /Applications/Antigravity.app/language_server_macos_arm --app_data_dir antigravity --csrf_token tok123 --extension_server_port 51234"))
      .toEqual({ pid: "9100", cli: false, csrf: "tok123", extPort: 51234 });
    expect(classifyAntigravityProcessLine("9101 /Applications/Antigravity-IDE/language_server_macos_arm --app_data_dir antigravity --csrf_token tok123")).toBeNull();

    expect(parseLsofListeningPorts("agy 6441 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:63643 (LISTEN)\nagy 6441 user 13u IPv4 0x2 0t0 TCP 127.0.0.1:63645 (LISTEN)\n")).toEqual([63643, 63645]);
    expect(parseNetstatListeningPorts("  TCP    127.0.0.1:54321   0.0.0.0:0   LISTENING   9100\r\n", "9100")).toEqual([54321]);

    const summary = decodeAntigravityLocalSummary({
      response: {
        groups: [{
          displayName: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon, Gemini 3.8 Flash",
          buckets: [
            { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", remainingFraction: 0.82, resetTime: "2026-11-30T22:28:38Z" },
            { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", remainingFraction: 0.35, resetTime: "2026-11-24T13:28:38Z" },
          ],
        }],
      },
    }, now);
    expect(summary?.state).toBe("ready");
    expect(summary?.pools[0]).toMatchObject({ label: "Gemini Models", models: ["Gemini 4 Neon", "Gemini 3.8 Flash"] });
    expect(summary?.pools[0]?.windows.map(w => [w.id, w.label, w.metric === "percent" ? w.usedPercent : null])).toEqual([
      ["gemini-weekly", "7 days", 18],
      ["gemini-5h", "5 hours", 65],
    ]);

    const status = decodeAntigravityLocalStatus({
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [{ label: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-25T08:00:00Z" } }],
        },
      },
    }, now);
    expect(status?.pools[0]?.label).toBe("Gemini 2.5 Pro");
    expect(status?.pools[0]?.windows[0]).toMatchObject({ metric: "percent", usedPercent: 40 });
  });

  it("reads quota from running agy acp embedded local server with zero spawned agy processes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agy-local-quota-"));
    roots.push(root);
    const cacheDir = path.join(root, ".gemini", "antigravity-cli", "cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true }));

    const quotaSpawnFn = vi.fn(() => { throw new Error("must_not_spawn_agy"); });
    const adapter = new AntigravityAcpAdapter("agy", {
      workspacePath: root,
      childEnv: { HOME: root, PATH: process.env.PATH },
      quotaSpawnFn,
      localQuotaProbe: {
        platform: "darwin",
        execFile: async (file) => {
          if (file === "ps") return { stdout: "6441 agy acp --dangerously-skip-permissions\n" };
          if (file === "lsof") return { stdout: "agy 6441 user 13u IPv4 0x2 0t0 TCP 127.0.0.1:63645 (LISTEN)\n" };
          return { stdout: "" };
        },
        request: async (port, tls, pathName) => {
          if (port === 63645 && !tls && pathName.endsWith("RetrieveUserQuotaSummary")) {
            return {
              status: 200,
              text: JSON.stringify({
                response: {
                  groups: [{
                    displayName: "Gemini Models",
                    description: "Models within this group: Gemini 4 Neon",
                    buckets: [{ bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", remainingFraction: 0.75, resetTime: new Date(Date.now() + 3_600_000).toISOString() }],
                  }],
                },
              }),
            };
          }
          return null;
        },
      },
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    const res = await adapter.getAccountQuota({ refresh: true });
    expect(quotaSpawnFn).not.toHaveBeenCalled();
    expect(res.snapshot.state).toBe("ready");
    expect(res.snapshot.pools[0]?.windows[0]).toMatchObject({ id: "gemini-5h", usedPercent: 25 });

    // When no local server responds, probeAntigravityLocalServerQuota returns null so caller can fall back.
    const miss = await probeAntigravityLocalServerQuota({
      deps: { platform: "darwin", execFile: async () => ({ stdout: "" }), request: async () => null },
    });
    expect(miss).toBeNull();
  });
});
