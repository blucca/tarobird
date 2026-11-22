import { isIP } from "node:net";

// Origins identify the bundled WebViews, not authentication. Every protected
// endpoint still requires a device signature or short-lived session token.
export const NATIVE_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "capacitor://localhost", "https://localhost"];

export function isLoopback(host: string): boolean { return host === "::1" || host === "::ffff:127.0.0.1" || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host); }
export type ListenerExposure = "private" | "public";
/** A private-use address of the local network: RFC 1918, IPv4 link-local,
 * IPv6 unique-local and link-local, also in IPv4-mapped form. Loopback (where
 * relay peers arrive) and overlay ranges such as Tailscale's are not local. */
export function isLocalNetworkAddress(host: string): boolean {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/i.exec(host);
  if (v4) { const a = Number(v4[1]), b = Number(v4[2]); return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254; }
  // Tailscale's IPv6 range sits inside the unique-local block.
  return !isTailscaleAddress(host) && /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
}
export function isTailscaleAddress(host: string): boolean {
  const family = isIP(host), octets = host.split(".").map(Number);
  return (family === 4 && octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127) || (family === 6 && /^fd7a:115c:a1e0:/i.test(host));
}
export function assertSafeBind(host: string, tls: boolean, exposure: ListenerExposure = "private"): void {
  if (!isIP(host)) throw new Error("Hub bind address must be an explicit IP address");
  // Public listening is opt-in per listener. It never enables the instance API.
  if (exposure === "public") {
    if (!tls) throw new Error("Public Hub listeners require TLS; plaintext public access is forbidden");
    return;
  }
  if (isLoopback(host)) return;
  if (!isTailscaleAddress(host) || !tls) throw new Error("Private Hub listeners require loopback or TLS on a Tailscale address; public HTTPS requires explicit exposure: public");
}
