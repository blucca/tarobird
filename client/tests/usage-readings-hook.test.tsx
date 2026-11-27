import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaDirectory, QuotaScope, QuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "../src/connection.js";
import { HubHttpError } from "../src/http-error.js";
import {
  applyHostQuotaScope,
  resetQuotaStoreForTests,
} from "../src/quota-store.js";
import { useEngineQuota } from "../src/use-engine-quota.js";
import {
  resetUsageReadingsForTests,
  useUsageReadings,
} from "../src/use-usage-readings.js";
import {
  QUOTA_BACKGROUND_POLL_MS,
  QUOTA_SHOWN_FOR_MS,
  SAVED_QUOTA_KEY,
  type QuotaView,
} from "../src/usage-readings.js";

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));

const BASE_NOW = Date.parse("2026-11-22T10:00:00Z");
const isoAt = (now: number, deltaMs = 0) => new Date(now + deltaMs).toISOString();

const makeWindow = (now: number, usedPercent: number, resetDeltaMs = 4 * 60 * 60_000): QuotaWindow => ({
  id: "primary",
  label: "Primary",
  metric: "percent",
  usedPercent,
  availability: "unknown",
  observedAt: isoAt(now),
  expiresAt: isoAt(now, 60_000),
  resetsAt: isoAt(now, resetDeltaMs),
  periodSeconds: 18_000,
});

const makeScope = (
  now: number,
  usedPercent: number,
  extra: Partial<QuotaScope> = {},
  resetDeltaMs = 4 * 60 * 60_000,
): QuotaScope => ({
  id: "alpha",
  revision: "rev_1",
  engine: "codex",
  label: "Coding Bot",
  botIds: ["alpha"],
  sharing: "unverified",
  authMode: "subscription",
  capability: { mode: "active" },
  state: "ready",
  availability: "allowed",
  observedAt: isoAt(now),
  constraints: [],
  pools: [
    {
      id: "p0",
      label: "Codex",
      sharing: "shared",
      availability: "allowed",
      windows: [makeWindow(now, usedPercent, resetDeltaMs)],
      balances: [],
      constraints: [],
    },
  ],
  ...extra,
});

type FakeConnection = HubConnection & {
  readEngineQuota: ReturnType<typeof vi.fn>;
  refreshEngineQuota: ReturnType<typeof vi.fn>;
  readEngineQuotas: ReturnType<typeof vi.fn>;
  readContextUsage: ReturnType<typeof vi.fn>;
};

function makeConnection(hostKey: string): FakeConnection {
  return {
    identity: { hubPublicKey: hostKey },
    isReadOnly: false,
    readEngineQuota: vi.fn(),
    refreshEngineQuota: vi.fn(),
    readEngineQuotas: vi.fn(),
    readContextUsage: vi.fn(),
  } as unknown as FakeConnection;
}

describe("useUsageReadings and useEngineQuota hook regression tests (#137)", () => {
  let root: Root | undefined;
  let container: HTMLElement | undefined;
  let mem: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_NOW);
    mem = new Map();
    resetQuotaStoreForTests();
    resetUsageReadingsForTests();
    const dom = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("HTMLElement", dom.HTMLElement);
    vi.stubGlobal("Node", dom.Node);
    vi.stubGlobal("MutationObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => mem.get(key) ?? null,
      setItem: (key: string, value: string) => { mem.set(key, value); },
      removeItem: (key: string) => { mem.delete(key); },
    });
    container = dom.document.getElementById("root") as HTMLElement;
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => { root!.unmount(); });
      root = undefined;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-arms stale redraw timer every minute and auto-hides the battery right at window reset (Bug 3)", async () => {
    const conn = makeConnection("host-bug3");
    // Persisted reading observed 30m ago whose single window resets in 3m30s.
    const observedMs = BASE_NOW - QUOTA_SHOWN_FOR_MS;
    const resetMs = BASE_NOW + 3 * 60_000 + 30_000;
    const savedScope = makeScope(observedMs, 35, {}, resetMs - observedMs);
    applyHostQuotaScope(conn, "alpha", savedScope, BASE_NOW);
    resetQuotaStoreForTests();
    const conn2 = makeConnection("host-bug3");

    let latest: QuotaView | undefined;
    let renders = 0;
    function Harness() {
      const reading = useUsageReadings(conn2, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: false, // Offline so only the redraw/reset timers operate
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      renders++;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness)); });
    expect(latest).toMatchObject({ left: 65, stale: true, fromCache: true });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(30);

    // Advance 1 minute -> age updates to 31m
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(31);

    // Advance a SECOND minute -> previously froze permanently at 31m; must advance to 32m!
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(32);

    // Advance a THIRD minute -> 33m, still before reset (3m30s)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(Math.floor(latest!.ageMs / 60_000)).toBe(33);
    expect(latest).toBeDefined();

    // Advance past 3m30s window reset (+100ms) -> battery auto-hides without any unrelated re-render!
    const rendersBeforeReset = renders;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_200); });
    expect(renders).toBeGreaterThan(rendersBeforeReset);
    expect(latest).toBeUndefined();
  });

  it("keeps polling when deps stay unchanged, pauses offline, and resets backoff on reconnect (Bug 4 & Bug 5)", async () => {
    const conn = makeConnection("host-bug5");
    // Gateway marks cached reading state="stale" after 60s while keeping the same observedAt.
    let currentScope = makeScope(BASE_NOW - 90_000, 20, { state: "stale" });
    conn.readEngineQuota.mockImplementation(async () => currentScope);
    conn.refreshEngineQuota.mockImplementation(async () => {
      // Simulate failing refresh after initial fresh period or when triggered
      throw new Error("network_error");
    });

    let latest: QuotaView | undefined;
    function Harness({ online }: { online: boolean }) {
      const reading = useUsageReadings(conn, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: online,
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness, { online: true })); });
    // Even though Gateway returned state="stale" (90s old), UI keeps it fresh (< 30m)!
    expect(latest).toMatchObject({ left: 80, stale: false });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(1);

    // Advance 5m + 100ms: poll #2 runs; refreshEngineQuota throws -> failCount=1 (60s backoff).
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(2);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(1);

    // Advance 60s + 100ms: retry #1 runs (failCount=2, 2m backoff) even though observedAt/stale did not change!
    await act(async () => { await vi.advanceTimersByTimeAsync(60_100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(3);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(2);

    // Go offline: polling pauses completely; no retries fire over 20 minutes.
    await act(async () => { root!.render(createElement(Harness, { online: false })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(3);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(2);

    // Reconnect online: backoff resets and a fresh read + refresh runs immediately!
    conn.refreshEngineQuota.mockImplementation(async () => {
      currentScope = makeScope(Date.now(), 15, { state: "ready" });
      return currentScope;
    });
    await act(async () => { root!.render(createElement(Harness, { online: true })); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(4);
    expect(conn.refreshEngineQuota).toHaveBeenCalledTimes(3);
    expect(latest).toMatchObject({ left: 85, stale: false });

    // Even if subsequent healthy polls keep returning the exact same observedAt (unchanged deps),
    // polling continues at every 5-minute interval and never silently dies!
    const unchanged = currentScope;
    conn.readEngineQuota.mockImplementation(async () => unchanged);
    conn.refreshEngineQuota.mockImplementation(async () => unchanged);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(6);
  });

  it("renews 20s before window reset, triggers an immediate post-reset read if reset arrives, and re-arms across connection switches (Bug 5)", async () => {
    const conn1 = makeConnection("host-reset-1");
    const conn2 = makeConnection("host-reset-2");
    const firstResetMs = 45_000;
    const preReset = makeScope(BASE_NOW, 30, {}, firstResetMs);
    let afterReset = false;
    conn1.readEngineQuota.mockImplementation(async () => (afterReset ? makeScope(Date.now(), 5, {}, 4 * 60 * 60_000) : preReset));
    conn1.refreshEngineQuota.mockImplementation(async () => (afterReset ? makeScope(Date.now(), 5, {}, 4 * 60 * 60_000) : preReset));
    conn2.readEngineQuota.mockResolvedValue(makeScope(BASE_NOW, 40, {}, 4 * 60 * 60_000));
    conn2.refreshEngineQuota.mockResolvedValue(makeScope(BASE_NOW, 40, {}, 4 * 60 * 60_000));

    let latest: QuotaView | undefined;
    function Harness({ conn }: { conn: HubConnection }) {
      const reading = useUsageReadings(conn, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: true,
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness, { conn: conn1 })); });
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ left: 70, stale: false });

    // 25s later (20s before 45s reset): pre-reset renewal fires automatically!
    await act(async () => { await vi.advanceTimersByTimeAsync(25_100); });
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(2);

    // Suppose the engine only reports the refilled window once resetsAt actually passes (at 45s):
    afterReset = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_100); });
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(3);
    expect(latest).toMatchObject({ left: 95, stale: false });

    // Switching connection with the same botId re-arms cleanly on conn2 without leaking conn1's timer.
    await act(async () => { root!.render(createElement(Harness, { conn: conn2 })); });
    expect(conn2.readEngineQuota).toHaveBeenCalledTimes(1);
    expect(latest).toMatchObject({ left: 60, stale: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(QUOTA_BACKGROUND_POLL_MS + 100); });
    expect(conn2.readEngineQuota).toHaveBeenCalledTimes(2);
    expect(conn1.readEngineQuota).toHaveBeenCalledTimes(3);
  });

  it("evicts cached quota and stops all polling on HTTP 403 revocation in useUsageReadings (Bug 9)", async () => {
    const conn = makeConnection("host-bug9");
    applyHostQuotaScope(conn, "alpha", makeScope(BASE_NOW - 60_000, 25), BASE_NOW);
    expect(mem.get(SAVED_QUOTA_KEY)).toContain("alpha");

    conn.readEngineQuota.mockRejectedValue(new HubHttpError(403, "forbidden"));

    let latest: QuotaView | undefined;
    function Harness() {
      const reading = useUsageReadings(conn, {
        conversationId: "c1",
        botId: "alpha",
        model: "gpt-6.1",
        quota: true,
        quotaLive: true,
        context: false,
        turn: undefined,
      });
      latest = reading.quota;
      return null;
    }

    await act(async () => { root!.render(createElement(Harness)); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(1);
    expect(latest).toBeUndefined();
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("alpha");

    // Advance 30 minutes: zero further background polls after 403 revocation!
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000); });
    expect(conn.readEngineQuota).toHaveBeenCalledTimes(1);
  });

  it("shows cached readings on cold offline start and never loops or resurrects auth_changed in useEngineQuota (Bugs 1, 2, 8, 9)", async () => {
    const conn = makeConnection("host-settings-1");
    const initial = makeScope(BASE_NOW - 5 * 60_000, 40);
    const second = makeScope(BASE_NOW - 5 * 60_000, 55, { id: "beta", botIds: ["beta"], label: "Review Bot" });
    applyHostQuotaScope(conn, "alpha", initial, BASE_NOW);
    applyHostQuotaScope(conn, "beta", second, BASE_NOW);
    resetQuotaStoreForTests();

    const conn2 = makeConnection("host-settings-1");
    let liveDir: QuotaDirectory = { generatedAt: isoAt(BASE_NOW), scopes: [initial, second], truncated: false };
    conn2.readEngineQuotas.mockImplementation(async () => liveDir);

    let hookResult: ReturnType<typeof useEngineQuota> | undefined;
    let renderCount = 0;
    function Harness({ online, supported }: { online: boolean; supported: boolean }) {
      renderCount++;
      const value = useEngineQuota(conn2, {
        userId: "owner",
        owner: true,
        online,
        supported,
        unsupported: false,
        active: true,
      });
      useEffect(() => { hookResult = value; });
      hookResult = value;
      return null;
    }

    // Cold offline start (online=false, supported=false, unsupported=false): cached scopes appear immediately with zero HTTP calls.
    await act(async () => { root!.render(createElement(Harness, { online: false, supported: false })); });
    expect(conn2.readEngineQuotas).not.toHaveBeenCalled();
    expect(hookResult?.directory?.scopes).toHaveLength(2);
    expect(hookResult?.cachedScopeIds.has("alpha")).toBe(true);

    // Come online: loads live directory with 2 scopes without any infinite loop!
    const rendersBeforeOnline = renderCount;
    await act(async () => { root!.render(createElement(Harness, { online: true, supported: true })); });
    expect(conn2.readEngineQuotas).toHaveBeenCalledTimes(1);
    expect(renderCount - rendersBeforeOnline).toBeLessThan(10);
    expect(hookResult?.directory?.scopes).toHaveLength(2);
    expect(hookResult?.cachedScopeIds.size).toBe(0);

    // Background conversation refreshes alpha with a newer reading -> Settings updates in place!
    const fresher = makeScope(BASE_NOW + 10_000, 12);
    await act(async () => { applyHostQuotaScope(conn2, "alpha", fresher, BASE_NOW + 10_000); });
    const alphaCard = hookResult?.directory?.scopes.find(s => s.id === "alpha");
    expect(alphaCard?.observedAt).toBe(fresher.observedAt);
    expect(alphaCard?.pools[0]?.windows[0]).toMatchObject({ usedPercent: 12 });

    // Refresh returns auth_changed -> old reading is cleared and never resurrected!
    const authChanged: QuotaScope = {
      ...makeScope(BASE_NOW, 0, { revision: "rev_2", observedAt: undefined, state: "unknown", pools: [], constraints: [] }),
      reason: "auth_changed",
    };
    conn2.refreshEngineQuota.mockResolvedValueOnce(authChanged);
    await act(async () => { await hookResult!.refresh(alphaCard!); });
    const afterAuth = hookResult?.directory?.scopes.find(s => s.id === "alpha");
    expect(afterAuth).toMatchObject({ reason: "auth_changed", observedAt: undefined });
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("\"alpha\"");

    // 403 on refresh evicts the entire host from store + localStorage!
    conn2.refreshEngineQuota.mockRejectedValueOnce(new HubHttpError(403, "forbidden"));
    const betaCard = hookResult?.directory?.scopes.find(s => s.id === "beta")!;
    await act(async () => { await hookResult!.refresh(betaCard); });
    expect(hookResult?.error).toBe("permission");
    expect(hookResult?.directory).toBeUndefined();
    expect(mem.get(SAVED_QUOTA_KEY) ?? "{}").not.toContain("beta");
  });
});
