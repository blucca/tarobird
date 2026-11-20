import { useEffect, useRef, useState } from "react";

/** Native gates remain authoritative while JavaScript is suspended. This hook
 * retires the renderer too; foreground never reconnects or regains control. */
export function useScreenMobileLifecycle(mobile: boolean, visible: boolean, retire: () => void) {
  const latest = useRef(retire); latest.current = retire;
  const [foreground, setForeground] = useState(!mobile);
  useEffect(() => {
    if (!mobile) return;
    let disposed = false, nativeActive = false, events = 0, remove: (() => void) | undefined;
    const update = () => {
      if (disposed) return;
      const active = nativeActive && document.visibilityState !== "hidden" && document.documentElement.dataset.mobileLocked !== "true";
      setForeground(active); if (!active) latest.current();
    };
    const observer = new MutationObserver(update); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mobile-locked"] });
    document.addEventListener("visibilitychange", update);
    void import("@capacitor/app").then(async ({ App }) => {
      const listener = await App.addListener("appStateChange", ({ isActive }) => { events++; nativeActive = isActive; update(); });
      if (disposed) { await listener.remove(); return; }
      remove = () => { void listener.remove(); };
      const before = events, state = await App.getState(); if (!disposed && before === events) { nativeActive = state.isActive; update(); }
    }).catch(() => { nativeActive = false; update(); });
    return () => { disposed = true; observer.disconnect(); document.removeEventListener("visibilitychange", update); remove?.(); };
  }, [mobile]);
  useEffect(() => { if (mobile && !visible) latest.current(); }, [mobile, visible]);
  return foreground;
}
