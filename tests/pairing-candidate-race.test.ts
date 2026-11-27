import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { multipathConfiguration } from "../client/src/connection-routes.js";
import { PairingCandidateRaceError, racePairingCandidates } from "../client/src/pairing-candidate-race.js";
import { connectionPairingPayload, pairingLink, parsePairingLink } from "../client/src/pairing-link.js";
import { hostPairingLink } from "../src/host-cli/pairing.js";
import type { Route } from "../src/client-protocol/routes.js";

const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const ca = "A".repeat(160);
const invite = randomBytes(32).toString("base64url");

describe("concurrent pairing candidate race", () => {
  it("connects immediately on the reachable LAN address and aborts slow/blackholed probes", async () => {
    const routes: Route[] = [
      { name: "Direct", url: "https://172.17.0.1:23456", certificateAuthority: ca },
      { name: "Direct", url: "https://192.168.50.2:23456", certificateAuthority: ca },
      { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca },
      { name: "VPS", url: "https://relay.example:8443" },
    ];
    const aborted: string[] = [];

    const started = performance.now();
    const winner = await racePairingCandidates(routes, {
      probe: (route, signal) => new Promise((resolve, reject) => {
        if (route.url.includes("192.168.1.10")) {
          setTimeout(() => resolve({ route, publicKey: key, supportsInvites: true }), 10);
          return;
        }
        // Simulate blackholed / slow interfaces that would otherwise wait 6000ms.
        const timer = setTimeout(() => reject(new Error("timeout")), 5000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted.push(route.url);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      }),
    });
    const elapsed = performance.now() - started;

    expect(winner.route.url).toBe("https://192.168.1.10:23456");
    expect(elapsed).toBeLessThan(500);
    expect(aborted.sort()).toEqual([
      "https://172.17.0.1:23456",
      "https://192.168.50.2:23456",
      "https://relay.example:8443",
    ]);
  });

  it("prefers direct over relay on a close tie and falls back to relay when direct fails", async () => {
    const direct: Route = { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca };
    const relay: Route = { name: "VPS", url: "https://relay.example:8443" };

    // Simultaneous tie: direct wins deterministically.
    const tieWinner = await racePairingCandidates([direct, relay], {
      probe: async (route) => ({ route, publicKey: key, supportsInvites: true }),
    });
    expect(tieWinner.route.url).toBe(direct.url);

    // Relay arrives 5ms before direct within the 50ms tie grace window: direct still wins.
    const closeTieWinner = await racePairingCandidates([direct, relay], {
      directTieGraceMs: 50,
      probe: (route) => new Promise((resolve) => {
        setTimeout(() => resolve({ route, publicKey: key, supportsInvites: true }), route.name === "VPS" ? 5 : 15);
      }),
    });
    expect(closeTieWinner.route.url).toBe(direct.url);

    // Direct is unreachable / client-isolated: relay wins as soon as direct fails without waiting out grace.
    const relayFallback = await racePairingCandidates([direct, relay], {
      directTieGraceMs: 200,
      probe: async (route) => {
        if (route.name === "Direct") throw new Error("connect ECONNREFUSED");
        return { route, publicKey: key, supportsInvites: true };
      },
    });
    expect(relayFallback.route.url).toBe(relay.url);
  });

  it("never accepts a wrong host answering first on another address", async () => {
    const wrongDirect: Route = { name: "Direct", url: "https://192.168.50.2:23456", certificateAuthority: ca };
    const rightDirect: Route = { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca };

    const winner = await racePairingCandidates([wrongDirect, rightDirect], {
      probe: (route) => new Promise((resolve, reject) => {
        if (route.url === wrongDirect.url) {
          // Wrong host responds immediately! Must be rejected.
          reject(new Error("tls_identity_mismatch"));
          return;
        }
        setTimeout(() => resolve({ route, publicKey: key, supportsInvites: true }), 15);
      }),
    });
    expect(winner.route.url).toBe(rightDirect.url);

    // If wrong host answers and all other candidates fail, report identity-mismatch.
    await expect(
      racePairingCandidates([wrongDirect, rightDirect], {
        probe: async (route) => {
          throw new Error(route.url === wrongDirect.url ? "tls_identity_mismatch" : "connect ECONNREFUSED");
        },
      }),
    ).rejects.toMatchObject({
      kind: "verification",
      verificationFailure: "identity-mismatch",
    } satisfies Partial<PairingCandidateRaceError>);
  });

  it("distinguishes direct-only vs direct-and-relay failures", async () => {
    const direct: Route = { name: "Direct", url: "https://192.168.1.10:23456" };
    const relay: Route = { name: "VPS", url: "https://relay.example:8443" };

    await expect(
      racePairingCandidates([direct], { probe: async () => { throw new Error("timeout"); } }),
    ).rejects.toMatchObject({ kind: "direct-failed" });

    await expect(
      racePairingCandidates([direct, relay], { probe: async () => { throw new Error("timeout"); } }),
    ).rejects.toMatchObject({ kind: "direct-and-relay-failed" });
  });
});

describe("v1 and v2 pairing payload compatibility", () => {
  const routes: Route[] = [
    { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca },
    { name: "Direct", url: "https://192.168.1.20:23456", certificateAuthority: ca },
    { name: "Direct", url: "https://10.0.0.5:23456", certificateAuthority: ca },
    { name: "VPS", url: "https://relay.example:8443" },
  ];

  it("emits compact v2 QR with shared CA hoisting and hydrates all routes on parse", () => {
    const payload = connectionPairingPayload(key, routes, "computer", routes[0]!.url);
    expect(payload.v).toBe(2);
    const link = pairingLink({ ...payload, invite });
    // Shared CA is hoisted once instead of duplicated across 3 routes.
    expect(link.length).toBeLessThan(1500);
    const decoded = parsePairingLink(link);
    expect(decoded).toEqual({
      v: 2,
      kind: "connect",
      hubPublicKey: key,
      routes,
      deployment: "computer",
      invite,
    });

    const cliLink = hostPairingLink(key, routes, invite);
    expect(parsePairingLink(cliLink)).toEqual({
      v: 2,
      kind: "connect",
      hubPublicKey: key,
      routes,
      invite,
    });
  });

  it("preserves exact v1 format for old Apps and single-route hosts", () => {
    const single: Route[] = [{ name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca }, routes[3]!];
    const autoSingle = connectionPairingPayload(key, single, "computer");
    expect(autoSingle.v).toBe(1);

    const compat = connectionPairingPayload(key, routes, "computer", routes[1]!.url, { version: 1 });
    expect(compat.v).toBe(1);
    expect(compat.routes).toEqual([routes[1]!, routes[3]!]);

    expect(() => hostPairingLink(key, routes, invite, { version: 1 })).toThrow();
    const validCliV1 = hostPairingLink(key, single, invite, { version: 1 });
    expect(parsePairingLink(validCliV1)).toMatchObject({ v: 1, kind: "connect", routes: single, invite });
  });

  it("does not hoist a shared CA onto system-CA direct or Tailscale routes in v2 payloads", () => {
    const mixed: Route[] = [
      { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca },
      { name: "Direct", url: "https://192.168.2.10:23456", certificateAuthority: ca },
      { name: "Tailscale", url: "https://tailscale.example.test" },
    ];
    const clientLink = pairingLink({ ...connectionPairingPayload(key, mixed, "computer", mixed[0]!.url), invite });
    const clientDecoded = parsePairingLink(clientLink);
    expect(clientDecoded).toEqual({
      v: 2,
      kind: "connect",
      hubPublicKey: key,
      routes: mixed,
      deployment: "computer",
      invite,
    });
    expect(clientDecoded.kind === "connect" && clientDecoded.routes[2]!.certificateAuthority).toBeUndefined();

    const cliLink = hostPairingLink(key, mixed, invite);
    const cliDecoded = parsePairingLink(cliLink);
    expect(cliDecoded).toEqual({
      v: 2,
      kind: "connect",
      hubPublicKey: key,
      routes: mixed,
      invite,
    });
    expect(cliDecoded.kind === "connect" && cliDecoded.routes[2]!.certificateAuthority).toBeUndefined();

    // When every non-VPS route has its own CA (with two sharing ca), hoisting still preserves a distinct CA.
    const distinctCa = "B".repeat(160);
    const allPinned: Route[] = [
      { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca },
      { name: "Direct", url: "https://192.168.2.10:23456", certificateAuthority: ca },
      { name: "Tailscale", url: "https://100.64.0.1:23456", certificateAuthority: distinctCa },
    ];
    expect(parsePairingLink(pairingLink({ ...connectionPairingPayload(key, allPinned, "computer", allPinned[0]!.url), invite }))).toEqual({
      v: 2,
      kind: "connect",
      hubPublicKey: key,
      routes: allPinned,
      deployment: "computer",
      invite,
    });
    expect(parsePairingLink(hostPairingLink(key, allPinned, invite))).toEqual({
      v: 2,
      kind: "connect",
      hubPublicKey: key,
      routes: allPinned,
      invite,
    });
  });

  it("preserves private-CA VPS relays during v2 multipath configuration while stripping CA on edited relay URLs", () => {
    const relayCa = "C".repeat(160);
    const importedDirects: Route[] = [
      { name: "Direct", url: "https://192.168.1.10:23456", certificateAuthority: ca },
      { name: "Direct", url: "https://192.168.1.20:23456", certificateAuthority: ca },
    ];
    const importedRelays: Route[] = [
      { name: "VPS", url: "https://relay.example:8443", certificateAuthority: relayCa },
    ];
    const importedRoutes = [...importedDirects, ...importedRelays];

    const kept = multipathConfiguration(importedDirects, importedRelays, importedRoutes, "computer");
    expect(kept.routes).toEqual(importedRoutes);

    const edited = multipathConfiguration(
      importedDirects,
      [{ ...importedRelays[0]!, url: "https://other-relay.example:8443" }],
      importedRoutes,
      "computer",
    );
    expect(edited.routes[2]).toEqual({ name: "VPS", url: "https://other-relay.example:8443" });
  });
});
