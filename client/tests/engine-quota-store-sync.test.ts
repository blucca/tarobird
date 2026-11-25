import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QuotaDirectory, QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "../src/connection.js";
import { applyHostQuotaScope, readStoredQuota, resetQuotaStoreForTests, syncQuotaDirectory } from "../src/quota-store.js";
import { useEngineQuota } from "../src/use-engine-quota.js";

// Bound the existing Settings feedback loop so the regression reports an assertion,
// rather than recursively updating React until it aborts the whole fixture.
const notifications = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/quota-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/quota-store.js")>();
  return { ...actual, subscribeQuotaStore: (connection: HubConnection, listener: () => void) =>
    actual.subscribeQuotaStore(connection, () => { if (++notifications.count <= 5) listener(); }) };
});

const now = Date.parse("2026-11-25T10:00:00Z");
const scope = (minutes: number, usedPercent: number): QuotaScope => ({
  id: "bot", revision: "login-one", engine: "codex", label: "Codex Bot", botIds: ["bot"], sharing: "unverified",
  authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown",
  observedAt: new Date(now + minutes * 60_000).toISOString(), constraints: [],
  pools: [{ id: "account", label: "Codex", sharing: "shared", availability: "unknown", balances: [], constraints: [],
    windows: [{ id: "weekly", label: "weekly", metric: "percent", usedPercent, availability: "unknown",
      observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), resetsAt: new Date(now + 7 * 86400_000).toISOString() }] }],
});
const directory = (reading: QuotaScope): QuotaDirectory => ({ generatedAt: new Date(now).toISOString(), scopes: [reading], truncated: false });
let root: Root | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now); resetQuotaStoreForTests(); notifications.count = 0;
  const { window, document } = parseHTML("<html><body></body></html>");
  for (const name of ["window", "document", "Node", "Element", "HTMLElement", "MutationObserver"] as const)
    vi.stubGlobal(name, name === "document" ? document : name === "window" ? window : window[name]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request in offline quota fixture"); }));
});
afterEach(async () => {
  await act(async () => { root?.unmount(); }); root = undefined;
  expect(fetch).not.toHaveBeenCalled();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("Settings consumes a conversation quota update without writing back into its store listener", async () => {
  const old = scope(-10, 30), fresh = scope(0, 12);
  const connection = { identity: { hubPublicKey: "host-one" }, readEngineQuotas: vi.fn(async () => directory(old)) } as unknown as HubConnection;
  let result!: ReturnType<typeof useEngineQuota>;
  function Settings() {
    result = useEngineQuota(connection, { userId: "owner", owner: true, online: true, supported: true, active: true });
    return createElement("output", {}, result.directory?.scopes[0]?.observedAt);
  }
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(createElement(Settings)); });
  expect(result.directory?.scopes[0].observedAt).toBe(old.observedAt);
  notifications.count = 0;
  await act(async () => { applyHostQuotaScope(connection, "bot", fresh, now); });
  expect(notifications.count).toBe(1);
  expect(result.directory?.scopes[0].observedAt).toBe(fresh.observedAt);
  expect(result.directory?.scopes[0].pools[0].windows[0]).toMatchObject({ usedPercent: 12 });
  // Same-revision auth invalidation must clear the Settings snapshot as well.
  await act(async () => { applyHostQuotaScope(connection, "bot", { ...fresh, observedAt: undefined, pools: [], state: "unknown", reason: "auth_changed" }, now); });
  expect(result.directory?.scopes[0].observedAt).toBeUndefined();
  expect(readStoredQuota(connection, "bot", now)).toBeUndefined();
  notifications.count = 0;
  const other = { ...scope(0, 42), revision: "login-two" };
  await act(async () => { applyHostQuotaScope(connection, "bot", other, now); });
  expect(result.directory?.scopes[0].revision).toBe("login-two");
  expect(result.directory?.scopes[0].pools[0].windows[0]).toMatchObject({ usedPercent: 42 });
});

it("an older directory reply keeps Settings and conversation quota on the newest same-login reading", () => {
  const connection = { identity: { hubPublicKey: "host-one" } } as unknown as HubConnection;
  const fresh = scope(0, 12), old = scope(-10, 30);
  applyHostQuotaScope(connection, "bot", fresh, now);
  const result = syncQuotaDirectory(connection, directory(old), now);
  expect(result.scopes[0].observedAt).toBe(fresh.observedAt);
  expect(result.scopes[0].pools[0].windows[0]).toMatchObject({ usedPercent: 12 });
  expect(readStoredQuota(connection, "bot", now)?.scope).toBe(fresh);
  // A changed login must still clear the prior account, not restore it by projection.
  expect(syncQuotaDirectory(connection, directory({ ...old, revision: "login-two", observedAt: undefined, pools: [], state: "login_required", reason: "login_required" }), now).scopes[0].observedAt).toBeUndefined();
  expect(readStoredQuota(connection, "bot", now)).toBeUndefined();
});
