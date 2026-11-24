import { Capacitor } from "@capacitor/core";
import { isDesktop } from "./desktop-bridge.js";
import { MAX_PAIRING_LINK_LENGTH, parsePairingLink, type PairingPayload } from "./pairing-link.js";
import type { Route } from "../../src/client-protocol/routes.js";

type ConnectPayload = Extract<PairingPayload, { kind: "connect" }>;

/** True when running inside a regular desktop or mobile web browser (not Electron, Tauri, iOS, or Android App). */
export function isWebBrowser(): boolean {
  return !isDesktop() && !Capacitor.isNativePlatform();
}

/** Browsers enforce system WebPKI HTTPS trust (or loopback Secure Context).
 * Routes carrying a private self-signed Host CA (`certificateAuthority`) are not trusted by browsers. */
export function isBrowserTrustedRoute(route: Pick<Route, "url" | "certificateAuthority">): boolean {
  if (route.certificateAuthority) return false;
  try {
    const parsed = new URL(route.url);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Build a one-time browser pairing URL on `routeUrl`.
 * Uses the URL fragment (`#pair=...`) so the one-time invitation token is never
 * sent in HTTP request paths, server logs, reverse-proxy logs, or Referer headers. */
export function browserPairingLink(routeUrl: string, payload: ConnectPayload): string {
  const origin = new URL(routeUrl).origin;
  const { invite, ...data } = payload;
  if (!invite) throw new Error("invite_required");
  const hash = `#pair=${encodeURIComponent(JSON.stringify(data))}&invite=${encodeURIComponent(invite)}`;
  const full = `${origin}/${hash}`;
  if (full.length > MAX_PAIRING_LINK_LENGTH) throw new Error("pairing_link_too_long");
  return full;
}

/** Parse a `#pair=...&invite=...` browser pairing hash using the same strict
 * schema validation as `tarocub://pair` links. Returns undefined if absent or invalid. */
export function parseBrowserPairingHash(hash: string): ConnectPayload | undefined {
  if (!hash || !hash.startsWith("#")) return undefined;
  const params = new URLSearchParams(hash.slice(1));
  const data = params.get("pair");
  const invite = params.get("invite");
  if (!data || !invite) return undefined;
  try {
    const parsed = parsePairingLink(`tarocub://pair?data=${encodeURIComponent(data)}&invite=${encodeURIComponent(invite)}`);
    return parsed.kind === "connect" && parsed.invite ? parsed : undefined;
  } catch {
    return undefined;
  }
}
