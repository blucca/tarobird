import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { ENGINE_QUOTA_HUB_REFRESH_MS, type QuotaDirectory, type QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import {
  applyHostQuotaScope,
  cachedQuotaDirectory,
  clearStoredQuotaHost,
  ingestQuotaDirectory,
  projectQuotaDirectory,
  subscribeQuotaStore,
} from "./quota-store.js";

type View = { connection: HubConnection; userId?: string; directory?: QuotaDirectory; loading: boolean; busy: string[]; errors: Record<string, string>; error?: string; notice?: string };
type Request = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
const EMPTY_CACHED: ReadonlySet<string> = new Set();
// Longer than the Hub waits for a refresh, so the page shows the Hub's answer (the engine's own "timeout" included).
const request = (): Request => { const controller = new AbortController(); return { controller, timer: setTimeout(() => controller.abort(), ENGINE_QUOTA_HUB_REFRESH_MS + 2_000) }; };
const finish = (value: Request) => clearTimeout(value.timer);
const cancel = (value: Request) => { finish(value); value.controller.abort(); };

/** Quota values live only in the currently authorized settings view. Opening
 * the page shows saved readings immediately (marked old) and reads live state;
 * updates stay synchronized with the in-conversation battery via pure store projection. */
export function useEngineQuota(connection: HubConnection, options: {
  userId?: string;
  owner: boolean;
  online: boolean;
  supported: boolean;
  unsupported?: boolean;
  active: boolean;
}) {
  const { userId, owner, online, supported, unsupported = false, active } = options;
  const pageVisible = () => document.visibilityState !== "hidden" && document.documentElement.dataset.mobileLocked !== "true";
  const [shown, setShown] = useState(pageVisible), [appActive, setAppActive] = useState(() => !Capacitor.isNativePlatform());
  const visible = shown && appActive;
  useEffect(() => {
    const update = () => setShown(pageVisible());
    const observer = new MutationObserver(update); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mobile-locked"] });
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false, events = 0, remove: (() => void) | undefined;
    void import("@capacitor/app").then(async ({ App }) => {
      const listener = await App.addListener("appStateChange", ({ isActive }) => { events++; if (!disposed) setAppActive(isActive); });
      if (disposed) { await listener.remove(); return; }
      remove = () => { void listener.remove(); };
      const before = events, state = await App.getState(); if (!disposed && before === events) setAppActive(state.isActive);
    }).catch(() => undefined);
    return () => { disposed = true; remove?.(); };
  }, []);
  const [view, setView] = useState<View>(() => ({
    connection,
    userId,
    loading: false,
    busy: [],
    errors: {},
  }));
  const [, setStoreVersion] = useState(0);
  const viewRef = useRef(view); viewRef.current = view;
  const version = useRef(0), directoryRequest = useRef<Request>(undefined), scopes = useRef(new Map<string, Request>());
  const canShow = owner && !unsupported && active && visible;
  const allowed = owner && online && supported && active && visible;
  const current = useRef({ connection, userId, allowed }); current.current = { connection, userId, allowed };
  const stop = useCallback(() => {
    version.current++; if (directoryRequest.current) cancel(directoryRequest.current); directoryRequest.current = undefined;
    for (const value of scopes.current.values()) cancel(value); scopes.current.clear();
  }, []);
  const readDirectory = useCallback(async (notice?: string) => {
    if (!current.current.allowed) return;
    stop(); const generation = version.current, operation = request(); directoryRequest.current = operation;
    setView(previous => ({
      connection,
      userId,
      directory: previous.connection === connection && previous.userId === userId ? previous.directory : undefined,
      loading: true,
      busy: [],
      errors: {},
      notice,
    }));
    try {
      const raw = await connection.readEngineQuotas(operation.controller.signal);
      if (generation !== version.current || directoryRequest.current !== operation) return;
      ingestQuotaDirectory(connection, raw, Date.now());
      setView({ connection, userId, directory: raw, loading: false, busy: [], errors: {}, notice });
    } catch (error) {
      if (generation !== version.current || directoryRequest.current !== operation) return;
      const denied = error instanceof HubHttpError && [401, 403].includes(error.status);
      if (denied) clearStoredQuotaHost(connection);
      setView(previous => ({ ...previous, directory: denied ? undefined : previous.directory, loading: false, error: denied ? "permission" : error instanceof HubHttpError && error.status === 404 ? "upgrade" : "read" }));
    } finally { finish(operation); if (directoryRequest.current === operation) directoryRequest.current = undefined; }
  }, [connection, userId, stop]);
  useEffect(() => {
    stop();
    setView(previous => ({
      connection,
      userId,
      directory: canShow && previous.connection === connection && previous.userId === userId ? previous.directory : undefined,
      loading: false,
      busy: [],
      errors: {},
    }));
    if (allowed) void readDirectory();
    return stop;
  }, [connection, userId, canShow, online, allowed, stop, readDirectory]);

  // Keep Settings → Model quotas synchronized when an open conversation updates a Bot's quota in the background.
  // Only bumps a render counter so the pure projection below re-reads the shared store without mutating it.
  useEffect(() => {
    if (!canShow) return;
    return subscribeQuotaStore(connection, () => {
      setStoreVersion(count => count + 1);
    });
  }, [connection, canShow]);

  async function refresh(scope: QuotaScope) {
    if (!current.current.allowed || directoryRequest.current || scopes.current.has(scope.id) || scopes.current.size >= 2) return;
    const before = viewRef.current;
    if (before.connection !== connection || before.userId !== userId || before.error === "permission" || before.directory?.scopes.find(value => value.id === scope.id)?.revision !== scope.revision) return;
    const generation = version.current, operation = request(); scopes.current.set(scope.id, operation);
    setView(previous => ({ ...previous, busy: [...previous.busy, scope.id], errors: { ...previous.errors, [scope.id]: "" }, notice: undefined }));
    try {
      const value = await connection.refreshEngineQuota(scope, operation.controller.signal);
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      applyHostQuotaScope(connection, scope.id, value, Date.now());
      // A directory refresh or authorization change can retire this exact card.
      setView(previous => previous.directory?.scopes.find(item => item.id === scope.id)?.revision !== scope.revision ? previous
        : { ...previous, directory: { ...previous.directory, scopes: previous.directory.scopes.map(item => item.id === scope.id ? value : item) } });
    } catch (error) {
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      if (error instanceof HubHttpError && [401, 403].includes(error.status)) {
        clearStoredQuotaHost(connection);
        stop(); setView({ connection, userId, loading: false, busy: [], errors: {}, error: "permission" });
      } else if (error instanceof HubHttpError && [404, 409].includes(error.status)) {
        // Only re-read the directory. Never replay the retired native refresh.
        void readDirectory("changed");
      } else setView(previous => ({ ...previous, errors: { ...previous.errors, [scope.id]: "read" } }));
    } finally {
      finish(operation);
      if (scopes.current.get(scope.id) === operation) { scopes.current.delete(scope.id); setView(previous => ({ ...previous, busy: previous.busy.filter(id => id !== scope.id) })); }
    }
  }
  const same = view.connection === connection && view.userId === userId && canShow;
  let directory: QuotaDirectory | undefined;
  let cachedScopeIds: ReadonlySet<string> = EMPTY_CACHED;
  if (same && view.error !== "permission" && view.error !== "upgrade") {
    const now = Date.now();
    if (view.directory) {
      const projected = projectQuotaDirectory(connection, view.directory, now);
      directory = projected.directory;
      cachedScopeIds = projected.cachedScopeIds;
    } else {
      const cached = cachedQuotaDirectory(connection, now);
      if (cached) {
        directory = cached;
        cachedScopeIds = new Set(cached.scopes.map(scope => scope.id));
      }
    }
  }
  return { directory, cachedScopeIds, loading: same && view.loading, busy: same ? view.busy : [], errors: same ? view.errors : {}, error: same ? view.error : undefined, notice: same ? view.notice : undefined, visible, readDirectory, refresh };
}
