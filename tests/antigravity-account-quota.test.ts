import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaSnapshotSchema } from "../src/client-protocol/engine-quota.js";
import { isAntigravityQuotaSupportedVersion, parseAntigravityQuota } from "../src/codex/account-quota.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";

const now = Date.parse("2026-11-22T00:00:00Z");

const sampleUsagePayload = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t63%\t2026-11-28T09:14:35Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      description: "Private prose that should not leak into DTO",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini 4 Neon, Gemini 3.8 Flash",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.6286041140556335,
              reset_time: "2026-11-28T09:14:35Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9344972372055054,
              reset_time: "2026-11-22T04:00:04Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-28T23:42:11Z" },
            { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-22T04:42:11Z" },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            { id: "gemini-argon-wtu-weekly", name: "Gemini 4 Argon Weekly Limit", window: "weekly", remaining_fraction: 0, reset_time: "2026-11-28T23:42:11Z" },
          ],
        },
      ],
    },
  },
};

const roots: string[] = [];
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: () => true,
    end: () => undefined,
    on: () => undefined,
  };
  killed = false;
  closed = false;
  closeDelayMs = 5;
  kill() {
    this.killed = true;
    if (!this.closed) {
      setTimeout(() => {
        if (this.closed) return;
        this.closed = true;
        this.emit("close", null, "SIGTERM");
      }, this.closeDelayMs);
    }
  }
  finish(code: number | null, stdout = "", stderr = "") {
    queueMicrotask(() => {
      if (this.closed) return;
      if (stdout) this.stdout.emit("data", stdout);
      if (stderr) this.stderr.emit("data", stderr);
      this.closed = true;
      this.emit("close", code, null);
    });
  }
}

async function agyFixture(options: { withState?: boolean; extraEnv?: Record<string, string> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-quota-"));
  roots.push(root);
  const home = path.join(root, "home");
  const agyHome = path.join(home, ".gemini", "antigravity-cli");
  const cacheDir = path.join(agyHome, "cache");
  await mkdir(cacheDir, { recursive: true });
  if (options.withState !== false) {
    await writeFile(path.join(cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true }));
  }
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH, ...options.extraEnv };
  return { root, home, agyHome, cacheDir, env };
}

describe("Antigravity quota version check and parser", () => {
  it("accepts CLI versions >= 1.1.11 and rejects older or malformed versions", () => {
    for (const ok of ["1.1.11", "1.1.12\n", "1.2.0", "1.5.14", "2.0.0", "v1.5.14", "1.5.14-beta.1"]) {
      expect(isAntigravityQuotaSupportedVersion(ok)).toBe(true);
    }
    for (const bad of ["1.1.10", "1.1.0", "1.0.99", "0.9.9", "", "unknown", "1.1"]) {
      expect(isAntigravityQuotaSupportedVersion(bad)).toBe(false);
    }
  });

  it("parses valid /usage JSON with num_turns === 0 into pools and windows", () => {
    const snapshot = parseAntigravityQuota(sampleUsagePayload, now);
    expect(quotaSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      authMode: "subscription",
      capability: { mode: "active" },
      state: "ready",
      availability: "unknown",
      help: "antigravity_usage",
    });
    expect(snapshot.pools).toHaveLength(3);
    expect(snapshot.pools[0]).toMatchObject({ label: "Gemini Models", sharing: "shared" });
    expect(snapshot.pools[0]!.windows[0]).toMatchObject({
      id: "gemini-weekly",
      label: "7 days",
      metric: "percent",
      usedPercent: 37.14,
      periodSeconds: 604800,
      resetsAt: "2026-11-28T09:14:35.000Z",
    });
    expect(snapshot.pools[0]!.windows[1]).toMatchObject({
      id: "gemini-5h",
      label: "5 hours",
      metric: "percent",
      usedPercent: 6.55,
      periodSeconds: 18000,
      resetsAt: "2026-11-22T04:00:04.000Z",
    });
    expect(snapshot.pools[1]!.windows[0]).toMatchObject({ usedPercent: 0 });
    expect(snapshot.pools[2]!.windows[0]).toMatchObject({ usedPercent: 100 });
    expect(JSON.stringify(snapshot)).not.toContain("Private prose");
  });

  it.each([1, 2, -1, undefined, null, "0", 0.5])("rejects num_turns = %s", numTurns => {
    expect(() => parseAntigravityQuota({ ...sampleUsagePayload, num_turns: numTurns }, now)).toThrow("invalid_response");
  });

  it.each([-0.01, 1.01, NaN, Infinity, "0.5"])("rejects malformed remaining_fraction = %s", value => {
    const bad = structuredClone(sampleUsagePayload);
    (bad.command.data.groups[0]!.buckets[0] as Record<string, unknown>).remaining_fraction = value;
    expect(() => parseAntigravityQuota(bad, now)).toThrow("invalid_response");
  });

  it("keeps missing or null remaining_fraction as metric unknown instead of 0 or 100", () => {
    const sparse = structuredClone(sampleUsagePayload);
    sparse.command.data.groups = [{ name: "Gemini Models", buckets: [{ id: "gemini-5h", name: "Five Hour", window: "5h", remaining_fraction: null as any, reset_time: "2026-11-22T04:00:04Z" }] }];
    const snapshot = parseAntigravityQuota(sparse, now);
    expect(snapshot.pools[0]!.windows[0]).toMatchObject({ id: "gemini-5h", metric: "unknown" });
    expect(snapshot.pools[0]!.windows[0]).not.toHaveProperty("usedPercent");
  });

  it("rejects non-SUCCESS status or wrong command name", () => {
    expect(() => parseAntigravityQuota({ ...sampleUsagePayload, status: "ERROR" }, now)).toThrow("invalid_response");
    expect(() => parseAntigravityQuota({ ...sampleUsagePayload, command: { name: "other", data: { groups: [] } } }, now)).toThrow("invalid_response");
  });
});

describe("ProcessAntigravityAdapter account quota", () => {
  it("never spawns on cached read, checks version then reads /usage on refresh, and caches result", async () => {
    const f = await agyFixture();
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else child.finish(0, JSON.stringify(sampleUsagePayload));
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const run = gatewayEngineQuota({ botId: "bot-agy", engine: "antigravity", read: opts => adapter.getAccountQuota?.(opts) });
    const cached = await run({ scopeId: "bot-agy", refresh: false });
    expect(spawn).not.toHaveBeenCalled();
    expect(cached.value).toMatchObject({ state: "unknown", reason: "not_loaded", capability: { mode: "active" }, help: "antigravity_usage" });

    const refreshed = await run({ scopeId: "bot-agy", refresh: true, expectedRevision: cached.revision });
    expect(calls).toEqual([["--version"], ["-p", "/usage", "--output-format", "json"]]);
    expect(refreshed.value).toMatchObject({ state: "ready", authMode: "subscription", help: "antigravity_usage" });
    expect(refreshed.value.pools[0]?.windows[0]).toMatchObject({ id: "gemini-weekly", usedPercent: 37.14 });

    const again = await run({ scopeId: "bot-agy", refresh: false });
    expect(again.value.state).toBe("ready");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("refuses to call /usage when agy version is below 1.1.11 and keeps antigravity_usage hint", async () => {
    const f = await agyFixture();
    const calls: string[][] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      const child = new MockChild();
      child.finish(0, "1.1.10\n");
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(calls).toEqual([["--version"]]);
    expect(result.snapshot).toMatchObject({ state: "unsupported", reason: "native_unverified", pools: [], help: "antigravity_usage" });
  });

  it("rejects /usage responses with num_turns > 0 and keeps antigravity_usage hint", async () => {
    const f = await agyFixture();
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else child.finish(0, JSON.stringify({ ...sampleUsagePayload, num_turns: 1 }));
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(result.snapshot).toMatchObject({ state: "unavailable", reason: "invalid_response", pools: [], help: "antigravity_usage" });
  });

  it("never spawns agy when local login state is missing (reports login_required without browser OAuth popup)", async () => {
    const f = await agyFixture({ withState: false });
    const spawn = vi.fn();
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const cached = await adapter.getAccountQuota!({ refresh: false });
    expect(cached.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "antigravity_usage" });
    const refreshed = await adapter.getAccountQuota!({ refresh: true, expectedRevision: cached.revision });
    expect(refreshed.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "antigravity_usage" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills interactive login prompt immediately if an onboarded session expired and never leaks OAuth URL", async () => {
    const f = await agyFixture({ withState: true });
    const children: MockChild[] = [];
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      children.push(child);
      if (args.includes("--version")) {
        child.finish(0, "1.5.14\n");
      } else {
        queueMicrotask(() => {
          child.stderr.emit("data", "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?client_id=secret\nWaiting for authentication");
        });
      }
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(children[1]?.killed).toBe(true);
    expect(children[1]?.closed).toBe(true);
    expect(result.snapshot).toMatchObject({ state: "login_required", reason: "login_required", pools: [], help: "antigravity_usage" });
    expect(JSON.stringify(result)).not.toMatch(/accounts\.google\.com|oauth2|secret/i);
  });

  it("reports mode_not_supported for GEMINI_API_KEY without subscription state", async () => {
    const f = await agyFixture({ withState: false, extraEnv: { GEMINI_API_KEY: "synthetic-api-key" } });
    const spawn = vi.fn();
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const result = await adapter.getAccountQuota!({ refresh: true });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.snapshot).toMatchObject({ state: "unsupported", reason: "mode_not_supported", authMode: "api_key", pools: [], help: "antigravity_usage" });
  });

  it("invalidates cache and rejects old revision when Antigravity auth state changes", async () => {
    const f = await agyFixture();
    const spawn = vi.fn((_cmd: string, args: string[]) => {
      const child = new MockChild();
      if (args.includes("--version")) child.finish(0, "1.5.14\n");
      else child.finish(0, JSON.stringify(sampleUsagePayload));
      return child;
    });
    const adapter = new ProcessAntigravityAdapter("agy", f.env, spawn as any, undefined, undefined, f.root);
    disposals.push(() => adapter.destroy());

    const first = await adapter.getAccountQuota!({ refresh: true });
    expect(first.snapshot.state).toBe("ready");
    await writeFile(path.join(f.cacheDir, "onboarding.json"), JSON.stringify({ onboardingComplete: true, consumerOnboardingComplete: true }));
    const next = await adapter.getAccountQuota!({ refresh: false, expectedRevision: first.revision });
    expect(next.revision).not.toBe(first.revision);
    expect(next.snapshot).toMatchObject({ reason: "auth_changed", pools: [], help: "antigravity_usage" });
  });

  it("reports cli_unavailable on ENOENT and cancels in-flight read cleanly on destroy", async () => {
    const f = await agyFixture();
    const enoentSpawn = vi.fn(() => {
      const child = new MockChild();
      queueMicrotask(() => {
        const err = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
        child.closed = true;
        child.emit("error", err);
      });
      return child;
    });
    const missingAdapter = new ProcessAntigravityAdapter("agy-missing", f.env, enoentSpawn as any, undefined, undefined, f.root);
    disposals.push(() => missingAdapter.destroy());
    expect((await missingAdapter.getAccountQuota!({ refresh: true })).snapshot).toMatchObject({
      state: "unavailable",
      reason: "cli_unavailable",
      help: "antigravity_usage",
    });

    const slowChild = new MockChild();
    slowChild.closeDelayMs = 40;
    const slowAdapter = new ProcessAntigravityAdapter("agy", f.env, (() => slowChild) as any, undefined, undefined, f.root);
    const pending = slowAdapter.getAccountQuota!({ refresh: true });
    const stopped = slowAdapter.destroy();
    expect(slowChild.closed).toBe(false);
    await stopped;
    expect(slowChild.closed).toBe(true);
    expect((await pending).snapshot).toMatchObject({ reason: "cancelled", help: "antigravity_usage" });
  });
});
