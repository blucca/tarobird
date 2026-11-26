import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { ENGINE_QUOTA_HUB_REFRESH_MS, quotaReadingExpired, type QuotaDirectory, type QuotaScope } from "../../src/client-protocol/engine-quota.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";

export const MAX_CONCURRENT_QUOTA_REFRESH = 8;
const LATE_POLL_INTERVAL_MS = 2_500;
const LATE_POLL_MAX_MS = 90_000;
const LATE_POLL_REQUEST_MS = 10_000;

type View = { connection: HubConnection; userId?: string; directory?: QuotaDirectory; loading: boolean; busy: string[]; waitingLate: string[]; errors: Record<string, string>; error?: string; notice?: string };
type Request = { controller: AbortController; timer: ReturnType<typeof setTimeout> };
type LatePoll = { timer?: ReturnType<typeof setTimeout>; request?: Request };
// Longer than the Hub waits for a refresh, so the page shows the Hub's answer (the engine's own "timeout" included).
const request = (timeoutMs = ENGINE_QUOTA_HUB_REFRESH_MS + 2_000): Request => {
  const controller = new AbortController();
  return { controller, timer: setTimeout(() => controller.abort(), timeoutMs) };
};
const finish = (value: Request) => clearTimeout(value.timer);
const cancel = (value: Request) => { finish(value); value.controller.abort(); };

export function shouldAutoRefreshScope(scope: QuotaScope, now: number): boolean {
  if (scope.capability.mode !== "active") return false;
  if (scope.state === "offline" || scope.state === "unsupported" || scope.state === "login_required") return false;
  if (scope.reason === "host_upgrade_required") return false;
  if (scope.nextRefreshAt && Date.parse(scope.nextRefreshAt) > now) return false;
  return !scope.observedAt || scope.state === "unknown" || scope.state === "stale" || quotaReadingExpired(scope, now);
}

/** Decide what one cache-only poll in `watchLateAnswer` means for a slow Claude refresh.
 * Real `ClaudeStreamAdapter` leaves `get_usage` in flight after its initial 7 s timeout
 * and returns `"not_loaded"` (no prior reading) or the prior reading (same `observedAt`,
 * `reason: undefined`) on `refresh: false` until the late answer lands. */
export function evaluateLatePoll(
  scope: Pick<QuotaScope, "revision">,
  previousObservedAt: string | undefined,
  latest: QuotaScope,
): "update" | "wait" | "stop" {
  // Transient Hub cache-read timeout fallback: keep waiting without overwriting the real scope revision.
  if (latest.revision === "timeout" && latest.reason === "timeout") return "wait";
  if (latest.revision !== scope.revision) return "update";
  const newer = Boolean(
    latest.observedAt
    && latest.observedAt !== previousObservedAt
    && (latest.state === "ready" || latest.state === "stale"),
  );
  if (newer) return "update";
  if (latest.capability.mode !== "active" || latest.state === "offline" || latest.state === "unsupported" || latest.state === "login_required") {
    return "update";
  }
  if (latest.reason === undefined || latest.reason === "timeout" || latest.reason === "not_loaded") {
    return "wait";
  }
  return "stop";
}

/** Drain `items` with at most `concurrency` workers in flight, stopping before
 * starting new items once `shouldContinue()` turns false. */
export async function drainBoundedQueue<T>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const workers = Math.min(Math.max(1, concurrency), items.length);
  if (workers <= 0) return;
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      if (!shouldContinue()) return;
      const item = items[nextIndex++]!;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/** Quota values live only in the currently authorized settings view. Opening
 * the page reads caches and automatically starts one read for each readable card
 * that lacks fresh data (respecting cooldowns and never sending model turns). */
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
  const [view, setView] = useState<View>({ connection, userId, loading: false, busy: [], waitingLate: [], errors: {} });
  const viewRef = useRef(view); viewRef.current = view;
  const version = useRef(0), directoryRequest = useRef<Request>(undefined), scopes = useRef(new Map<string, Request>());
  const latePolls = useRef(new Map<string, LatePoll>());
  const allowed = owner && online && supported && active && visible;
  const current = useRef({ connection, userId, allowed }); current.current = { connection, userId, allowed };
  const clearLatePoll = useCallback((id: string) => {
    const poll = latePolls.current.get(id);
    if (!poll) return;
    if (poll.timer) clearTimeout(poll.timer);
    if (poll.request) cancel(poll.request);
    latePolls.current.delete(id);
  }, []);
  const stop = useCallback(() => {
    version.current++; if (directoryRequest.current) cancel(directoryRequest.current); directoryRequest.current = undefined;
    for (const value of scopes.current.values()) cancel(value); scopes.current.clear();
    for (const poll of latePolls.current.values()) {
      if (poll.timer) clearTimeout(poll.timer);
      if (poll.request) cancel(poll.request);
    }
    latePolls.current.clear();
  }, []);

  const watchLateAnswer = useCallback((scope: QuotaScope, previousObservedAt: string | undefined, generation: number) => {
    clearLatePoll(scope.id);
    const deadline = Date.now() + LATE_POLL_MAX_MS;
    const poll: LatePoll = {};
    latePolls.current.set(scope.id, poll);
    setView(previous => previous.waitingLate.includes(scope.id) ? previous : { ...previous, waitingLate: [...previous.waitingLate, scope.id] });
    const tick = async () => {
      poll.timer = undefined;
      if (generation !== version.current || !current.current.allowed || latePolls.current.get(scope.id) !== poll) return;
      const operation = request(LATE_POLL_REQUEST_MS);
      poll.request = operation;
      try {
        const latest = await connection.readEngineQuota(scope.id, operation.controller.signal);
        poll.request = undefined;
        if (generation !== version.current || !current.current.allowed || latePolls.current.get(scope.id) !== poll) return;
        const outcome = evaluateLatePoll(scope, previousObservedAt, latest);
        if (outcome === "update") {
          clearLatePoll(scope.id);
          setView(previous => ({
            ...previous,
            directory: previous.directory?.scopes.find(item => item.id === scope.id)?.revision === scope.revision
              ? { ...previous.directory, scopes: previous.directory.scopes.map(item => item.id === scope.id ? latest : item) }
              : previous.directory,
            waitingLate: previous.waitingLate.filter(id => id !== scope.id),
          }));
          return;
        }
        if (outcome === "stop" || Date.now() >= deadline) {
          clearLatePoll(scope.id);
          setView(previous => ({ ...previous, waitingLate: previous.waitingLate.filter(id => id !== scope.id) }));
          return;
        }
      } catch (error) {
        poll.request = undefined;
        if (generation !== version.current || !current.current.allowed || latePolls.current.get(scope.id) !== poll) return;
        if (error instanceof HubHttpError && [401, 403].includes(error.status)) {
          stop();
          setView({ connection, userId, loading: false, busy: [], waitingLate: [], errors: {}, error: "permission" });
          return;
        }
        if (error instanceof HubHttpError && error.status === 404 || Date.now() >= deadline) {
          clearLatePoll(scope.id);
          setView(previous => ({ ...previous, waitingLate: previous.waitingLate.filter(id => id !== scope.id) }));
          return;
        }
      } finally {
        finish(operation);
        if (poll.request === operation) poll.request = undefined;
      }
      if (generation === version.current && current.current.allowed && latePolls.current.get(scope.id) === poll) {
        poll.timer = setTimeout(() => void tick(), LATE_POLL_INTERVAL_MS);
      }
    };
    poll.timer = setTimeout(() => void tick(), LATE_POLL_INTERVAL_MS);
  }, [connection, userId, clearLatePoll, stop]);

  const refreshRef = useRef<(scope: QuotaScope) => Promise<void>>(async () => undefined);

  const readDirectory = useCallback(async (notice?: string) => {
    if (!current.current.allowed) return;
    stop(); const generation = version.current, operation = request(); directoryRequest.current = operation;
    setView(previous => ({ connection, userId, directory: previous.connection === connection && previous.userId === userId ? previous.directory : undefined, loading: true, busy: [], waitingLate: [], errors: {}, notice }));
    let loaded: QuotaDirectory | undefined;
    try {
      const directory = await connection.readEngineQuotas(operation.controller.signal);
      if (generation !== version.current || directoryRequest.current !== operation) return;
      loaded = directory;
      const nextView: View = { connection, userId, directory, loading: false, busy: [], waitingLate: [], errors: {}, notice };
      viewRef.current = nextView;
      setView(nextView);
    } catch (error) {
      if (generation !== version.current || directoryRequest.current !== operation) return;
      const denied = error instanceof HubHttpError && [401, 403].includes(error.status);
      setView(previous => ({ ...previous, directory: denied ? undefined : previous.directory, loading: false, error: denied ? "permission" : error instanceof HubHttpError && error.status === 404 ? "upgrade" : "read" }));
    } finally { finish(operation); if (directoryRequest.current === operation) directoryRequest.current = undefined; }
    if (loaded && notice !== "changed" && generation === version.current && current.current.allowed) {
      const now = Date.now() + (connection.state.serverTimeOffset ?? 0);
      const queue = loaded.scopes.filter(scope => shouldAutoRefreshScope(scope, now));
      void drainBoundedQueue(
        queue,
        MAX_CONCURRENT_QUOTA_REFRESH,
        scope => refreshRef.current(scope),
        () => generation === version.current && current.current.allowed,
      );
    }
  }, [connection, userId, stop]);
  useEffect(() => {
    stop(); setView(previous => ({ connection, userId, directory: owner && supported && active && visible && previous.connection === connection && previous.userId === userId ? previous.directory : undefined, loading: false, busy: [], waitingLate: [], errors: {} }));
    if (allowed) void readDirectory();
    return stop;
  }, [connection, userId, owner, supported, active, visible, online, allowed, stop, readDirectory]);
  async function refresh(scope: QuotaScope) {
    if (!current.current.allowed || directoryRequest.current || scopes.current.has(scope.id) || scopes.current.size >= MAX_CONCURRENT_QUOTA_REFRESH) return;
    const before = viewRef.current;
    if (before.connection !== connection || before.userId !== userId || before.error === "permission" || before.directory?.scopes.find(value => value.id === scope.id)?.revision !== scope.revision) return;
    clearLatePoll(scope.id);
    const generation = version.current, operation = request(); scopes.current.set(scope.id, operation);
    setView(previous => ({ ...previous, busy: [...previous.busy, scope.id], waitingLate: previous.waitingLate.filter(id => id !== scope.id), errors: { ...previous.errors, [scope.id]: "" }, notice: undefined }));
    try {
      const value = await connection.refreshEngineQuota(scope, operation.controller.signal);
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      // A directory refresh or authorization change can retire this exact card.
      setView(previous => previous.directory?.scopes.find(item => item.id === scope.id)?.revision !== scope.revision ? previous
        : { ...previous, directory: { ...previous.directory, scopes: previous.directory.scopes.map(item => item.id === scope.id ? value : item) } });
      // Slow Claude `get_usage` keeps running in the background and saves its late answer on the Host.
      // Watch the cache briefly instead of showing a timeout error right away.
      if (value.reason === "timeout" && value.engine === "claude" && value.revision === scope.revision) {
        watchLateAnswer(value, value.observedAt ?? scope.observedAt, generation);
      }
    } catch (error) {
      if (generation !== version.current || scopes.current.get(scope.id) !== operation) return;
      if (error instanceof HubHttpError && [401, 403].includes(error.status)) {
        stop(); setView({ connection, userId, loading: false, busy: [], waitingLate: [], errors: {}, error: "permission" });
      } else if (error instanceof HubHttpError && [404, 409].includes(error.status)) {
        // Only re-read the directory. Never replay the retired native refresh.
        void readDirectory("changed");
      } else setView(previous => ({ ...previous, errors: { ...previous.errors, [scope.id]: "read" } }));
    } finally {
      finish(operation);
      if (scopes.current.get(scope.id) === operation) { scopes.current.delete(scope.id); setView(previous => ({ ...previous, busy: previous.busy.filter(id => id !== scope.id) })); }
    }
  }
  refreshRef.current = refresh;
  const same = view.connection === connection && view.userId === userId && owner && supported && active && visible;
  return { directory: same ? view.directory : undefined, loading: same && view.loading, busy: same ? view.busy : [], waitingLate: same ? view.waitingLate : [], errors: same ? view.errors : {}, error: same ? view.error : undefined, notice: same ? view.notice : undefined, visible, readDirectory, refresh };
}
