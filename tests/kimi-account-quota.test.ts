import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseKimiManagedUsage, type KimiQuotaChildLike } from "../src/codex/kimi-account-quota.js";
import { KimiAcpAdapter } from "../src/codex/kimi-acp-adapter.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { quotaView } from "../client/src/usage-readings.js";

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class MockKimiWebChild extends EventEmitter implements KimiQuotaChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: () => undefined, on: () => undefined };
  killed = false;
  closed = false;
  kill() {
    this.killed = true;
    if (!this.closed) {
      queueMicrotask(() => {
        if (this.closed) return;
        this.closed = true;
        this.emit("close", 0, "SIGTERM");
      });
    }
  }
  emitReady(origin = "http://127.0.0.1:58999", token = "ephemeral-token") {
    queueMicrotask(() => {
      this.stdout.emit("data", JSON.stringify({ origin, ws_url: origin.replace("http", "ws") + "/ws", token }) + "\n");
    });
  }
}

async function kimiFixture(extraEnv: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-quota-"));
  roots.push(root);
  const home = path.join(root, "home");
  const kimiHome = path.join(home, ".kimi-code");
  await mkdir(kimiHome, { recursive: true });
  await writeFile(path.join(kimiHome, "config.toml"), 'default_model = "kimi-for-coding"\n');
  const env: NodeJS.ProcessEnv = { HOME: home, KIMI_CODE_HOME: kimiHome, PATH: process.env.PATH, ...extraEnv };
  return { root, home, kimiHome, env };
}

describe("Kimi Code managed quota parser (#76)", () => {
  const now = Date.parse("2026-11-24T08:00:00Z");

  it("parses normal 5h / 7d / monthly windows and top-up pack balance", () => {
    const snap = parseKimiManagedUsage({
      code: 0,
      msg: "success",
      data: {
        kind: "ok",
        quota: {
          usages: {
            limit5h: { usedRatio: 0.125, resetAt: "2026-11-24T12:30:00Z" },
            limit7d: { usedRatio: 0.4125, resetAt: "2026-11-30T08:00:00Z" },
            monthTotal: { usedRatio: 0.25, resetAt: "2026-12-01T00:00:00Z" },
            monthCode: { usedRatio: 0.3, resetAt: "2026-12-01T00:00:00Z" },
          },
          extraUsage: {
            balanceCents: 4550,
            totalCents: 10000,
            monthlyChargeLimitEnabled: true,
            monthlyChargeLimitCents: 20000,
            monthlyUsedCents: 5000,
            currency: "CNY",
          },
        },
      },
    }, now);

    expect(snap).toMatchObject({ state: "ready", authMode: "subscription", capability: { mode: "active" }, help: "kimi_usage" });
    expect(snap.pools).toHaveLength(1);
    expect(snap.pools[0]!.windows.map(w => [w.id, w.metric === "percent" ? w.usedPercent : null])).toEqual([
      ["five_hour", 12.5],
      ["seven_day", 41.25],
      ["month_total", 25],
      ["month_code", 30],
      ["extra_monthly", 25],
    ]);
    expect(snap.pools[0]!.balances).toEqual([
      expect.objectContaining({ id: "top_up", kind: "currency", amount: "45.50", unit: "CNY" }),
    ]);

    // Feeds seamlessly into the conversation battery view (`quotaView`).
    const view = quotaView({
      ...snap,
      id: "kimi-bot",
      revision: "rev1",
      engine: "kimi",
      label: "Kimi Bot",
      botIds: ["kimi-bot"],
      sharing: "unverified",
    }, "kimi-for-coding", now + 1000);
    expect(view?.left).toBe(59); // min remaining: 100 - 41.25 = 58.75 -> 59%
    expect(view?.windows).toHaveLength(5);
  });

  it("maps 404 (non-Kimi For Coding) and 401 (not signed in) to distinct reasons", () => {
    const notCoding = parseKimiManagedUsage({
      data: { kind: "error", status: 404, message: "Usage endpoint not available. Try Kimi For Coding." },
    }, now);
    expect(notCoding).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "other", pools: [] });

    const signedOut = parseKimiManagedUsage({
      data: { kind: "error", status: 401, message: "Authorization failed. Please check your API key (try /login)." },
    }, now);
    expect(signedOut).toMatchObject({ state: "login_required", reason: "login_required", pools: [] });
  });
});

describe("KimiAcpAdapter account quota lifecycle (#76)", () => {
  it("reads plan quota via short-lived kimi web --port 0 --json, stops process, and clears cache on account switch", async () => {
    const f = await kimiFixture();
    const children: MockKimiWebChild[] = [];
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      expect(args).toEqual(["web", "--port", "0", "--json"]);
      const child = new MockKimiWebChild();
      children.push(child);
      child.emitReady("http://127.0.0.1:59123", "ephemeral-secret");
      return child;
    });
    const fetchCalls: Array<{ url: string; auth: string | null }> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      fetchCalls.push({ url: String(url), auth: headers.get("authorization") });
      return new Response(JSON.stringify({
        code: 0,
        msg: "success",
        data: {
          kind: "ok",
          quota: {
            usages: {
              limit5h: { usedRatio: 0.1, resetAt: new Date(Date.now() + 3_600_000).toISOString() },
              limit7d: { usedRatio: 0.25, resetAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
            },
            extraUsage: { balanceCents: 1250, totalCents: 2000, monthlyChargeLimitEnabled: false, monthlyChargeLimitCents: 0, monthlyUsedCents: 0, currency: "CNY" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
      quotaFetchFn: fetchFn,
    });
    disposals.push(() => adapter.destroy());

    const run = gatewayEngineQuota({ botId: "kimi-1", engine: "kimi", read: opts => adapter.getAccountQuota(opts) });
    const initial = await run({ scopeId: "kimi-1", refresh: false });
    expect(initial.value).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" } });
    expect(spawnFn).not.toHaveBeenCalled();

    const refreshed = await run({ scopeId: "kimi-1", refresh: true, expectedRevision: initial.revision });
    expect(refreshed.value.state).toBe("ready");
    expect(refreshed.value.pools[0]?.windows).toHaveLength(2);
    expect(refreshed.value.pools[0]?.balances[0]).toMatchObject({ kind: "currency", amount: "12.50", unit: "CNY" });
    expect(fetchCalls).toEqual([{ url: "http://127.0.0.1:59123/api/v1/oauth/usage", auth: "Bearer ephemeral-secret" }]);
    expect(children[0]?.closed).toBe(true);
    expect(JSON.stringify(refreshed)).not.toContain("ephemeral-secret");

    // Switching Kimi account (metadata change on credentials file) invalidates the old reading immediately.
    const credsMarker = path.join(f.kimiHome, "credentials.json");
    await writeFile(credsMarker, "account-b");
    const later = new Date(Date.now() + 5000);
    await utimes(credsMarker, later, later);
    const afterSwitch = await run({ scopeId: "kimi-1", refresh: false });
    expect(afterSwitch.revision).not.toBe(initial.revision);
    expect(afterSwitch.value.pools).toEqual([]);
  });

  it("reports API-key-only Kimi configuration as unsupported without spawning kimi web", async () => {
    const f = await kimiFixture({ KIMI_API_KEY: "sk-synthetic-only" });
    const spawnFn = vi.fn(() => { throw new Error("must_not_spawn"); });
    const adapter = new KimiAcpAdapter("kimi", {
      childEnv: f.env,
      spawnFn: spawnFn as never,
      workspacePath: f.root,
      idleSweepIntervalMs: 0,
    });
    disposals.push(() => adapter.destroy());

    const res = await adapter.getAccountQuota({ refresh: true });
    expect(res.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key", pools: [] });
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
