import { useSyncExternalStore } from "react";

// Device-local App setting, on by default: chat widgets may use https/wss.
// Off restores self-contained widgets (no network, no external resources).
let allowed = true;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => allowed;
export function setWidgetNetworkAllowed(value: boolean): void {
  if (allowed === value) return;
  allowed = value;
  for (const listener of listeners) listener();
}
export function useWidgetNetworkAllowed(): boolean { return useSyncExternalStore(subscribe, snapshot, snapshot); }
