import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { QuotaDirectory, QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";

type View = { connection: HubConnection; userId?: string; directory?: QuotaDirectory; loading: boolean; busy: string[]; errors: Record<string, string>; error?: string; notice?: string };
type Request = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
const request = (): Request => { const controller = new AbortController(); return { controller, timer: setTimeout(() => controller.abort(), 15_000) }; };
const finish = (value: Request) => clearTimeout(value.timer);
const cancel = (value: Request) => { finish(value); value.controller.abort(); };

/** Quota values live only in the currently authorized settings view. Opening
 * the page reads caches; native refresh is an explicit single-scope action. */
export function useEngineQuota(connection: HubConnection, options: { userId?: string; owner: boolean; online: boolean; supported: boolean; active: boolean }) {
  const { userId, owner, online, supported, active } = options;
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
  const [view, setView] = useState<View>({ connection, userId, loading: false, busy: [], errors: {} });
  const viewRef = useRef(view); viewRef.current = view;
  const version = useRef(0), directoryRequest = useRef<Request>(undefined), scopes = useRef(new Map<string, Request>());
  const allowed = owner && online && supported && active && visible;
  const current = useRef({ connection, userId, allowed }); current.current = { connection, userId, allowed };
  const stop = useCallback(() => {
    version.current++; if (directoryRequest.current) cancel(directoryRequest.current); directoryRequest.current = undefined;
    for (const value of scopes.current.values()) cancel(value); scopes.current.clear();
  }, []);
  const readDirectory = useCallback(async (notice?: string) => {
    if (!current.current.allowed) return;
    stop(); const generation = version.current, operation = request(); directoryRequest.current = operation;
    setView(previous => ({ connection, userId, directory: previous.connection === connection && previous.userId === userId ? previous.directory : undefined, loading: true, busy: [], errors: {}, notice }));
    try {
      const directory = await connection.readEngineQuotas(operation.controller.signal);
      if (generation !== version.current || directoryRequest.current !== operation) return;
      setView({ connection, userId, directory, loading: false, busy: [], errors: {}, notice });
    } catch (error) {
      if (generation !== version.current || directoryRequest.current !== operation) return;
      const denied = error instanceof HubHttpError && [401, 403].includes(error.status);
      setView(previous => ({ ...previous, directory: denied ? undefined : previous.directory, loading: false, error: denied ? "permission" : error instanceof HubHttpError && error.status === 404 ? "upgrade" : "read" }));
    } finally { finish(operation); if (directoryRequest.current === operation) directoryRequest.current = undefined; }
  }, [connection, userId, stop]);
  useEffect(() => {
    stop(); setView(previous => ({ connection, userId, directory: owner && supported && active && visible && previous.connection === connection && previous.userId === userId ? previous.directory : undefined, loading: false, busy: [], errors: {} }));
    if (allowed) void readDirectory();
    return stop;
  }, [connection, userId, owner, supported, active, visible, online, allowed, stop, readDirectory]);
  async function refresh(scope: QuotaScope) {
    if (!current.current.allowed || directoryRequest.current || scopes.current.has(scope.id) || scopes.current.size >= 2) return;
    const before = viewRef.current;
    if (before.connection !== connection || before.userId !== userId || before.error === "permission" || before.directory?.scopes.find(value => value.id === scope.id)?.revision !== scope.revision) return;
    const generation = version.current, operation = request(); scopes.current.set(scope.id, operation);
    setView(previous => ({ ...previous, busy: [...previous.busy, scope.id], errors: { ...previous.errors, [scope.id]: "" }, notice: undefined }));
    try {
      const value = await connection.refreshEngineQuota(scope, operation.controller.signal);
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      // A directory refresh or authorization change can retire this exact card.
      setView(previous => previous.directory?.scopes.find(item => item.id === scope.id)?.revision !== scope.revision ? previous
        : { ...previous, directory: { ...previous.directory, scopes: previous.directory.scopes.map(item => item.id === scope.id ? value : item) } });
    } catch (error) {
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      if (error instanceof HubHttpError && [401, 403].includes(error.status)) {
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
  const same = view.connection === connection && view.userId === userId && owner && supported && active && visible;
  return { directory: same ? view.directory : undefined, loading: same && view.loading, busy: same ? view.busy : [], errors: same ? view.errors : {}, error: same ? view.error : undefined, notice: same ? view.notice : undefined, visible, readDirectory, refresh };
}
