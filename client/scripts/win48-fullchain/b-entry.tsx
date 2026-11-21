// ACCEPTANCE-ONLY controller page: the real RemoteScreenPanel. Its connection
// is a minimal adapter with the same three screen calls and parsing as
// HubConnection (connection.ts screenStatus/screenOpen/screenStop); the
// requests carry the viewer device's real token through the main process.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { RemoteScreenPanel } from "../../src/RemoteScreenPanel.js";
import { setLocale } from "../../src/i18n.js";
import { screenJoinSchema, screenStatusSchema } from "../../../src/client-protocol/remote-screen.js";
import type { HubConnection } from "../../src/connection.js";
import "../../src/styles.css";
import "../../src/side-conversation.css";
const q = new URLSearchParams(location.search);
setLocale(q.get("lang") === "en" ? "en" : "zh");
const hub = (window as any).accHub as { request(route: string, init?: { method?: string; body?: string }): Promise<{ status: number; body: any }> };
const call = async (route: string, init?: { method?: string; body?: string }) => {
  const { status, body } = await hub.request(route, init);
  if (status < 200 || status > 299) throw new Error(typeof body?.error === "string" ? body.error : `http_${status}`);
  return body;
};
const url = q.get("url")!, hubPublicKey = q.get("hpk")!;
const connection = { identity: { hubPublicKey }, state: { screenAvailable: true, screenQualityAvailable: true },
  screenStatus: async () => screenStatusSchema.parse(await call("/api/screens/status?includeWindows=1")),
  screenOpen: async (input: unknown) => ({ join: screenJoinSchema.parse(await call("/api/screens/sessions?includeWindows=1", { method: "POST", body: JSON.stringify(input) })), network: { url, publicKey: hubPublicKey } }),
  screenStop: async (sessionId?: string) => call("/api/screens/stop", { method: "POST", body: JSON.stringify({ sessionId }) }),
} as unknown as HubConnection;
(window as any).accRefresh = () => window.dispatchEvent(new Event("focus"));
// The product's standalone screen dialog (screen-connection-dialog): the side
// layout needs sidebar + conversation + panel (≈760px), wider than B's half of
// the runner's 1024px desktop next to A's test window.
function App() {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="screen-connection-dialog" ref={dialog} onCancel={e => e.preventDefault()}>
    <RemoteScreenPanel connection={connection} hostName="Windows runner" visible={true} standalone close={() => {}} />
  </dialog>;
}
createRoot(document.getElementById("root")!).render(<App />);
