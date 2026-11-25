import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaScope, QuotaWindow } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "../src/connection.js";
import { loadSavedQuota, quotaView, saveQuota, SAVED_QUOTA_KEY } from "../src/usage-readings.js";
import { useUsageReadings } from "../src/use-usage-readings.js";
import { QuotaMark, UsageDetails, UsageIndicators } from "../src/UsageIndicators.js";
import { setLocale } from "../src/i18n.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-24T10:00:00Z");
const at = (minutes: number) => new Date(START + minutes * MINUTE).toISOString();
const windowReading = (id: string, usedPercent: number, resetMinutes: number): QuotaWindow => ({
  id, label: id, metric: "percent", usedPercent, availability: "unknown",
  observedAt: at(0), expiresAt: at(5), resetsAt: at(resetMinutes),
});
const reading = (extra: Partial<QuotaScope> = {}): QuotaScope => ({
  id: "bot", revision: "login-one", engine: "codex", label: "Quota test Bot", botIds: ["bot"], sharing: "unverified",
  authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown", observedAt: at(0),
  pools: [{ id: "shared", label: "Codex", sharing: "shared", availability: "unknown", windows: [windowReading("weekly", 30, 7 * 24 * 60)], balances: [], constraints: [] }],
  constraints: [], ...extra,
});
const withoutReading = (extra: Partial<QuotaScope> = {}): QuotaScope => reading({ observedAt: undefined, pools: [], state: "unknown", reason: "not_loaded", ...extra });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};

let roots: Root[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START);
  const { window, document } = parseHTML("<html><body></body></html>");
  for (const name of ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver"] as const) vi.stubGlobal(name, name === "document" ? document : name === "window" ? window : window[name]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("The quota regression fixture must not make network requests"); }));
});
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); setLocale("zh"); }); roots = [];
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function connection() {
  const readEngineQuota = vi.fn(async (_bot: string) => reading());
  const refreshEngineQuota = vi.fn(async (_scope: QuotaScope) => reading());
  const value = {
    identity: { hubPublicKey: "host-one" },
    state: { status: "online", user: { id: "owner", role: "owner" }, engineQuotaAvailable: true },
    subscribe: vi.fn(() => () => {}), readEngineQuota, refreshEngineQuota,
    readContextUsage: vi.fn(async () => ({ supported: false })),
  };
  return { value: value as unknown as HubConnection, readEngineQuota, refreshEngineQuota };
}
async function mount(connection: HubConnection) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  let result!: ReturnType<typeof useUsageReadings>;
  const renders: Array<ReturnType<typeof useUsageReadings>["quota"]> = [];
  let quota = true;
  function Probe() {
    result = useUsageReadings(connection, { conversationId: "conversation", botId: "bot", model: "gpt-5.3-codex", quota, context: false, turn: undefined });
    renders.push(result.quota);
    return createElement("output", { "data-left": result.quota?.left }, result.quota?.left);
  }
  await act(async () => { root.render(createElement(Probe)); });
  return {
    result: () => result, renders,
    details: async () => { await act(async () => { result.readForDetails(); }); },
    disable: async () => { quota = false; await act(async () => { root.render(createElement(Probe)); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); roots = roots.filter(value => value !== root); },
  };
}
const advance = async (minutes: number) => {
  // Flush React after each minute so effects can schedule the next retry at its actual completion time.
  for (let i = 0; i < minutes; i++) await act(async () => { await vi.advanceTimersByTimeAsync(MINUTE); });
};

describe("last quota reading (issue 137)", () => {
  it("shows saved quota on the first render while the Host reply is pending, then drops a changed login", async () => {
    localStorage.setItem(SAVED_QUOTA_KEY, JSON.stringify({ "host-one": { bot: reading({ observedAt: at(-65) }) } }));
    const pending = deferred<QuotaScope>(), host = connection(); host.readEngineQuota.mockReturnValue(pending.promise);
    const view = await mount(host.value);
    expect(view.renders[0]).toMatchObject({ left: 70, stale: true, observedAt: at(-65) });
    expect(host.refreshEngineQuota).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(withoutReading({ revision: "login-two", state: "login_required", reason: "login_required" })); });
    expect(view.result().quota).toBeUndefined();
    expect(loadSavedQuota(localStorage.getItem(SAVED_QUOTA_KEY), "host-one", START).has("bot")).toBe(false);
  });


  it("keeps a quiet conversation visible over an hour and retries with increasing, capped failure intervals", async () => {
    const host = connection(), refreshTimes: number[] = [];
    host.refreshEngineQuota.mockImplementation(async () => { refreshTimes.push(Date.now()); throw new Error("Synthetic quota timeout"); });
    const view = await mount(host.value);
    await advance(65);
    expect(view.result().quota).toMatchObject({ left: 70, stale: true, observedAt: at(0) });
    await advance(55);
    expect(refreshTimes.length).toBeGreaterThanOrEqual(4);
    const intervals = refreshTimes.slice(1).map((time, index) => time - refreshTimes[index]);
    expect(Math.min(...intervals)).toBeGreaterThanOrEqual(MINUTE);
    expect(Math.max(...intervals)).toBeLessThanOrEqual(30 * MINUTE);
    expect(intervals.some((gap, index) => index > 0 && gap > intervals[index - 1])).toBe(true);
    const calls = host.readEngineQuota.mock.calls.length;
    await view.unmount(); await advance(35);
    expect(host.readEngineQuota).toHaveBeenCalledTimes(calls);
  });

  it("rearms the five-minute poll even when a successful reply keeps the same observedAt", async () => {
    const host = connection(), readTimes: number[] = [];
    host.readEngineQuota.mockImplementation(async () => { readTimes.push(Date.now() - START); return reading(); });
    await mount(host.value); await advance(15);
    expect(readTimes).toEqual([0, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE]);
  });

  it("removes an old saved reading at window reset while background reads fail", async () => {
    const sample = reading({ observedAt: at(-65) });
    sample.pools[0].windows = [windowReading("five-hour", 30, 2)];
    localStorage.setItem(SAVED_QUOTA_KEY, JSON.stringify({ "host-one": { bot: sample } }));
    const host = connection(); host.readEngineQuota.mockRejectedValue(new Error("Synthetic offline Host"));
    const view = await mount(host.value);
    expect(view.result().quota).toMatchObject({ left: 70, stale: true });
    await advance(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result().quota).toBeUndefined();
  });

  it("keeps ticking old reading age each minute between background attempts", async () => {
    const host = connection();
    host.refreshEngineQuota.mockRejectedValue(new Error("Synthetic quota timeout"));
    const view = await mount(host.value); await advance(33);
    expect(view.result().quota).toMatchObject({ left: 70, stale: true });
    expect(view.result().quota!.ageMs).toBeGreaterThanOrEqual(33 * MINUTE);
  });

  it("updates after a successful background retry and resets failure backoff", async () => {
    const host = connection(), attempts: Array<{ at: number; success: boolean }> = [];
    let succeed = false, newest = reading();
    host.readEngineQuota.mockImplementation(async () => newest);
    host.refreshEngineQuota.mockImplementation(async () => {
      attempts.push({ at: Date.now(), success: succeed });
      if (!succeed) throw new Error("Synthetic quota timeout");
      newest = reading({ observedAt: new Date(Date.now()).toISOString() });
      newest.pools[0].windows = [windowReading("weekly", 12, 7 * 24 * 60)];
      return newest;
    });
    const view = await mount(host.value); await advance(90);
    const failures = attempts.map(value => value.at);
    expect(failures.length).toBeGreaterThanOrEqual(3);
    succeed = true;
    for (let elapsed = 0; !attempts.some(value => value.success) && elapsed < 31; elapsed++) await advance(1);
    const successful = attempts.find(value => value.success)!;
    expect(successful).toBeDefined();
    expect(view.result().quota).toMatchObject({ left: 88, stale: false, observedAt: new Date(successful.at).toISOString() });
    await advance(6);
    expect(attempts.at(-1)!.at - successful.at).toBeLessThanOrEqual(5 * MINUTE + MINUTE);
    expect(attempts.at(-1)!.at).toBeGreaterThan(successful.at);
    const calls = host.readEngineQuota.mock.calls.length;
    await view.disable(); await advance(35);
    expect(view.result().quota).toBeUndefined();
    expect(host.readEngineQuota).toHaveBeenCalledTimes(calls);
  });
});


describe("old quota presentation on desktop and phone", () => {
  it.each(["zh", "en"] as const)("shows old age in %s labels/details and removes old styling after refresh", async locale => {
    vi.setSystemTime(START + 12 * MINUTE);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const context = { left: 96, usedTokens: 4000, windowTokens: 100000 };
    const render = async (old: boolean) => {
      const quota = quotaView(reading({ observedAt: old ? at(0) : at(12) }), "gpt-5.3-codex", Date.now(), { fromCache: old })!;
      await act(async () => {
        setLocale(locale);
        root.render(createElement("div", {},
          createElement(UsageIndicators, { context, quota }),
          createElement(QuotaMark, { left: quota.left, stale: quota.stale, observedAt: quota.observedAt, onOpen: () => {} }),
          createElement(UsageDetails, { context, quota })));
      });
    };
    await render(true);
    const desktop = container.querySelector<HTMLButtonElement>(".usage-indicators")!;
    const phone = container.querySelector<HTMLButtonElement>(".quota-mark")!;
    const quotaPair = container.querySelector('[data-usage="quota"]')!;
    const age = locale === "zh" ? "12 分钟前" : "12 min ago";
    expect(desktop.title).toContain(age); expect(phone.title).toContain(age);
    expect(desktop.getAttribute("aria-label")).toBe(desktop.title);
    expect(phone.getAttribute("aria-label")).toBe(phone.title);
    expect(quotaPair.getAttribute("data-stale")).toBe("true");
    expect(phone.getAttribute("data-stale")).toBe("true");
    expect(quotaPair.textContent).toBe("70%");
    expect(container.querySelector('[data-usage="context"]')!.hasAttribute("data-stale")).toBe(false);
    expect(container.querySelector(".usage-stale-banner")!.textContent).toContain(locale === "zh" ? "上次读数" : "Last reading");
    expect(container.querySelector(".usage-stale-banner")!.textContent).toContain(age);
    expect(container.querySelector(".usage-read-at")!.textContent).toContain(age);
    await render(false);
    expect(quotaPair.hasAttribute("data-stale")).toBe(false);
    expect(phone.hasAttribute("data-stale")).toBe(false);
    expect(desktop.title).not.toContain(age); expect(phone.title).not.toContain(age);
    expect(container.querySelector(".usage-stale-banner")).toBeNull();
  });
});
