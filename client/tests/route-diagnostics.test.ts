import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientCache, Identity } from "../src/storage.js";
import { setLocale } from "../src/i18n.js";
import { connectionErrorMessage } from "../src/connection-verification.js";
import { pairingInviteError } from "../src/pairing-invite-errors.js";
import { classifyRouteKind, classifyRouteTransportFailure, diagnoseRouteFailures, routeHealthStatusLabel } from "../src/route-diagnostics.js";

const io = vi.hoisted(() => ({ socket: vi.fn(), fetch: vi.fn() }));
vi.mock("../src/storage.js", () => ({ cache: {}, ClientCache: class {}, defaultPreferences: {} }));
vi.mock("../src/identity.js", () => ({ randomNonce: () => "fixture-nonce" }));
vi.mock("../src/transport.js", () => ({ hubSocket: io.socket, hubFetch: io.fetch, usesPinnedTransport: () => true }));
import { HubConnection } from "../src/connection.js";

describe("route-diagnostics", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  });
  afterEach(() => {
    setLocale("zh");
    vi.unstubAllGlobals();
  });

  it("classifies Tailscale, LAN, loopback, VPS, and public routes accurately", () => {
    expect(classifyRouteKind({ name: "Direct", url: "https://100.64.0.1:8788" })).toBe("tailscale");
    expect(classifyRouteKind({ name: "Direct", url: "https://macmini.tailnet." + "ts.net:8788" })).toBe("tailscale");
    expect(classifyRouteKind({ name: "Direct", url: "https://[fd7a:115c:a1e0::1]:8788" })).toBe("tailscale");
    expect(classifyRouteKind({ name: "Tailscale", url: "https://primary.invalid" })).toBe("tailscale");
    expect(classifyRouteKind({ name: "Direct", url: "https://192.168.1.100:8788" })).toBe("lan");
    expect(classifyRouteKind({ name: "Direct", url: "https://10.0.0.5:8788" })).toBe("lan");
    expect(classifyRouteKind({ name: "Direct", url: "https://172.16.5.2:8788" })).toBe("lan");
    expect(classifyRouteKind({ name: "Direct", url: "https://127.0.0.1:8788" })).toBe("loopback");
    expect(classifyRouteKind({ name: "Direct", url: "http://localhost:8788" })).toBe("loopback");
    expect(classifyRouteKind({ name: "VPS", url: "https://relay.example.test" })).toBe("vps");
    expect(classifyRouteKind({ name: "Direct", url: "https://hub.example.test" })).toBe("public");
  });

  it("classifies transport failure signals across native and web layers", () => {
    expect(classifyRouteTransportFailure("local_network_permission_denied")).toBe("local-network-denied");
    expect(classifyRouteTransportFailure(new Error("Local network prohibited"))).toBe("local-network-denied");
    expect(classifyRouteTransportFailure("native_network_offline")).toBe("client-offline");
    expect(classifyRouteTransportFailure("native_connection_refused")).toBe("connection-refused");
    expect(classifyRouteTransportFailure(new Error("connect ECONNREFUSED 100.64.0.1:8788"))).toBe("connection-refused");
    expect(classifyRouteTransportFailure("native_dns_failed")).toBe("dns-failed");
    expect(classifyRouteTransportFailure("native_host_unreachable")).toBe("host-unreachable");
    expect(classifyRouteTransportFailure(new DOMException("The operation timed out", "TimeoutError"))).toBe("timeout");
    expect(classifyRouteTransportFailure("native_request_timeout")).toBe("timeout");
    expect(classifyRouteTransportFailure("native_tls_untrusted")).toBe("tls-untrusted");
    expect(classifyRouteTransportFailure("tls_connection_failed")).toBe("unreachable");
    expect(classifyRouteTransportFailure(new TypeError("Failed to fetch"))).toBe("unreachable");
  });

  it("explains Tailscale unreachable, refused, and DNS failures without blaming unchecked causes (zh & en)", () => {
    const tailscaleRoute = { name: "Tailscale" as const, url: "https://100.64.0.1:8788" };
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const unreachable = diagnoseRouteFailures([{ route: tailscaleRoute, error: "native_request_timeout" }], { context: "pairing", online: true });
      expect(unreachable.code).toBe("tailscale-unreachable");
      expect(unreachable.actionRequired).toBe(false);
      expect(unreachable.message).toMatch(/Tailscale/);
      expect(unreachable.message).not.toMatch(/本地网络|Local Network permission|Wi-Fi/i);

      const refused = diagnoseRouteFailures([{ route: tailscaleRoute, error: "native_connection_refused" }], { context: "paired", hostName: "macmini", online: true });
      expect(refused.code).toBe("tailscale-refused");
      expect(refused.message).toContain("macmini");
      expect(refused.message).toMatch(/TaroBird/);

      const dns = diagnoseRouteFailures([{ route: { name: "Tailscale", url: "https://macmini.tailnet." + "ts.net:8788" }, error: "native_dns_failed" }], { context: "pairing", online: true });
      expect(dns.code).toBe("tailscale-dns-failed");
      expect(dns.message).toMatch(/Tailscale/);
    }
  });

  it("explains LAN away-from-Wi-Fi, configured remote options, refused host, and iOS local network permission denied", () => {
    const lan = { name: "Direct" as const, url: "https://192.168.1.100:8788" };
    const tailscale = { name: "Tailscale" as const, url: "https://100.64.0.1:8788" };
    const vps = { name: "VPS" as const, url: "https://relay.example.test" };

    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      const away = diagnoseRouteFailures([{ route: lan, error: "native_request_timeout" }], { context: "pairing", online: true });
      expect(away.code).toBe("lan-unreachable");
      expect(away.message).toMatch(/Wi-Fi/);
      expect(away.message).toMatch(/Tailscale/);
      expect(away.message).toMatch(/VPS/);
      expect(away.message).not.toMatch(/本地网络|Local Network permission/);

      const withUnprobed = diagnoseRouteFailures([{ route: lan, error: "native_request_timeout" }], { context: "paired", hostName: "macmini", configuredRoutes: [lan, tailscale, vps], online: true });
      expect(withUnprobed.code).toBe("lan-unreachable");
      expect(withUnprobed.message).toMatch(/Tailscale/);
      expect(withUnprobed.message).toMatch(/VPS/);

      const bothChecked = diagnoseRouteFailures([
        { route: lan, error: "native_request_timeout" },
        { route: tailscale, error: "native_request_timeout" },
      ], { context: "paired", hostName: "macmini", configuredRoutes: [lan, tailscale], online: true });
      expect(bothChecked.code).toBe("lan-and-tailscale-unreachable");
      expect(bothChecked.message).toContain("macmini");

      const denied = diagnoseRouteFailures([{ route: lan, error: "local_network_permission_denied" }], { context: "pairing", online: true });
      expect(denied.code).toBe("local-network-denied");
      expect(denied.actionRequired).toBe(true);
      expect(denied.message).toMatch(/本地网络|Local Network permission/);

      const refused = diagnoseRouteFailures([{ route: lan, error: "native_connection_refused" }], { context: "paired", hostName: "macmini", online: true });
      expect(refused.code).toBe("lan-refused");
      expect(refused.message).toContain("macmini");
    }
    expect(connectionErrorMessage("local_network_permission_denied")).toMatch(/Local Network permission/);
  });

  it("detects client offline, loopback host down, verification failures, and invite code errors", () => {
    const tailscale = { name: "Tailscale" as const, url: "https://100.64.0.1:8788" };
    const loopback = { name: "Direct" as const, url: "https://127.0.0.1:8788" };

    setLocale("zh");
    expect(diagnoseRouteFailures([{ route: tailscale, error: "native_network_offline" }], { context: "pairing", online: true }).code).toBe("client-offline");
    expect(diagnoseRouteFailures([{ route: tailscale, error: "native_request_timeout" }], { context: "paired", hostName: "macmini", online: false }).code).toBe("client-offline");
    expect(diagnoseRouteFailures([{ route: loopback, error: "native_connection_refused" }], { context: "paired", hostName: "macmini", online: false }).code).toBe("loopback-unreachable");

    const mismatch = diagnoseRouteFailures([{ route: tailscale, error: "tls_identity_mismatch" }], { context: "pairing", online: true });
    expect(mismatch.code).toBe("identity-mismatch");
    expect(mismatch.actionRequired).toBe(true);

    expect(pairingInviteError("pairing_invite_expired")).toMatch(/已过期或失效/);
    expect(pairingInviteError("pairing_invite_invalid")).toMatch(/已过期或失效/);
    expect(pairingInviteError("pairing_invite_used")).toMatch(/已用于另一份设备申请/);
    setLocale("en");
    expect(pairingInviteError("pairing_invite_expired")).toMatch(/expired or is no longer valid/);

    expect(routeHealthStatusLabel({ url: tailscale.url, status: "unreachable", reason: "local-network-denied" }).label).toBe("Local network permission denied");
    expect(routeHealthStatusLabel({ url: tailscale.url, status: "unreachable", reason: "connection-refused" }).label).toBe("Host refused connection");
  });
});

describe("HubConnection route diagnostics", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("document", { documentElement: { lang: "zh-CN" }, get hidden() { return false; }, get visibilityState() { return "visible"; }, hasFocus: () => true, removeEventListener: () => {} });
    vi.stubGlobal("window", { removeEventListener: () => {} });
    vi.stubGlobal("navigator", { onLine: true });
  });
  afterEach(() => {
    setLocale("zh");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const makeConnection = (routes: Identity["routes"]) => {
    const identity: Identity = { deviceId: "fixture", name: "Fixture", publicKey: "fixture", hubPublicKey: "trusted", routes };
    const cache = { outbox: vi.fn().mockResolvedValue([]), saveIdentityRoutes: vi.fn().mockResolvedValue(undefined) };
    return new HubConnection(identity, cache as unknown as ClientCache, () => "macmini");
  };

  it("publishes tailscale-unreachable, lan-unreachable, and local-network-denied diagnoses on failed route probes", async () => {
    const tailscale = { name: "Tailscale" as const, url: "https://100.64.0.1:8788" };
    const lan = { name: "Direct" as const, url: "https://192.168.1.100:8788" };

    const tsConn = makeConnection([tailscale]);
    io.fetch.mockRejectedValue(new Error("native_request_timeout"));
    await (Reflect.get(tsConn, "connect") as () => Promise<void>).call(tsConn);
    expect(tsConn.state.routeDiagnosis?.code).toBe("tailscale-unreachable");
    expect(tsConn.state.error).toContain("macmini");
    expect(tsConn.state.error).toContain("Tailscale");
    expect(tsConn.state.routeHealth).toEqual([{ url: tailscale.url, status: "unreachable", reason: "timeout" }]);
    tsConn.close();

    const lanConn = makeConnection([lan]);
    io.fetch.mockRejectedValue(new Error("local_network_permission_denied"));
    await (Reflect.get(lanConn, "connect") as () => Promise<void>).call(lanConn);
    expect(lanConn.state.routeDiagnosis?.code).toBe("local-network-denied");
    expect(lanConn.state.routeDiagnosis?.actionRequired).toBe(true);
    expect(lanConn.state.error).toMatch(/本地网络/);
    lanConn.close();
  });

  it("keeps working fallback routes unchanged and clears prior routeDiagnosis when a probe succeeds", async () => {
    const lan = { name: "Direct" as const, url: "https://192.168.1.100:8788" };
    const tailscale = { name: "Tailscale" as const, url: "https://100.64.0.1:8788" };
    const conn = makeConnection([lan, tailscale]);
    io.socket.mockReturnValue({ readyState: 1, send: vi.fn(), close: vi.fn() });
    io.fetch.mockImplementation(async (url: string) => {
      if (url === lan.url) throw new Error("native_request_timeout");
      return Response.json({ ok: true, publicKey: "trusted" });
    });
    const pending = (Reflect.get(conn, "connect") as () => Promise<void>).call(conn);
    await vi.advanceTimersByTimeAsync(250);
    await pending;
    expect(conn.state.route?.url).toBe(tailscale.url);
    expect(conn.state.routeDiagnosis).toBeUndefined();
    expect(io.socket).toHaveBeenCalledWith(tailscale.url, "trusted");
    conn.close();
  });
});
