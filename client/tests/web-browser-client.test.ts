import { describe, expect, it } from "vitest";
import { browserPairingLink, isBrowserTrustedRoute, parseBrowserPairingHash } from "../src/web-browser.js";

const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 7)]).toString("base64");
const invite = "a".repeat(43);

describe("Official web browser client pairing & route trust (#120)", () => {
  it("builds a fragment-only browser pairing URL and round-trips through parseBrowserPairingHash", () => {
    const payload = {
      v: 1 as const,
      kind: "connect" as const,
      hubPublicKey: spki,
      routes: [{ name: "VPS" as const, url: "https://hub.example.com" }],
      invite,
    };
    const link = browserPairingLink("https://hub.example.com", payload);
    const url = new URL(link);
    // Security invariant: invite and pairing data stay strictly in the fragment, never query params.
    expect(url.origin).toBe("https://hub.example.com");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash.startsWith("#pair=")).toBe(true);
    expect(url.hash).toContain(`invite=${invite}`);

    const parsed = parseBrowserPairingHash(url.hash);
    expect(parsed).toEqual(payload);
  });

  it("fails closed on missing, malformed, or invite-less browser hashes", () => {
    expect(parseBrowserPairingHash("")).toBeUndefined();
    expect(parseBrowserPairingHash("#unrelated=1")).toBeUndefined();
    expect(parseBrowserPairingHash("#pair=%7B%7D")).toBeUndefined();
    expect(parseBrowserPairingHash("#pair=not-json&invite=" + invite)).toBeUndefined();
  });

  it("distinguishes browser-trusted HTTPS/loopback routes from private self-signed LAN routes", () => {
    expect(isBrowserTrustedRoute({ url: "https://hub.example.com" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "https://relay.example.org:8443" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "http://127.0.0.1:8788" })).toBe(true);
    expect(isBrowserTrustedRoute({ url: "http://localhost:8788" })).toBe(true);
    // Private Host CA routes cannot be trusted by standard browsers without unsafe cert bypass.
    expect(isBrowserTrustedRoute({ url: "https://192.168.1.20:8788", certificateAuthority: "A".repeat(128) })).toBe(false);
    // Non-loopback plain HTTP is never trusted.
    expect(isBrowserTrustedRoute({ url: "http://192.168.1.20:8788" })).toBe(false);
  });
});
