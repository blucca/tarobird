import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, verify } from "node:crypto";
import { HubServer } from "../src/hub/server.js";
import { parsePublicKey } from "../src/hub/auth.js";
import {
  deploymentMatchesRoutes,
  isDirectRoute,
  isEdgeTlsRoute,
  isRelayRoute,
  legacyV1Routes,
  localRoutesSchema,
  orderedRoutes,
  routeSchema,
  routesSchema,
} from "../src/client-protocol/routes.js";
import { sharedRoutesSchema } from "../src/client-protocol/private-network.js";
import { verifyEdgeIdentity } from "../src/client-protocol/tls-identity.js";
import { cloudflareCommands, HOST_CLOUDFLARE_PATH } from "../src/client-protocol/cloudflare.js";
import { rememberRouteTrust, routeTrust } from "../client/src/route-trust.js";

const dirs: string[] = [];
const hubs: HubServer[] = [];

afterEach(async () => {
  while (hubs.length) await hubs.pop()!.close();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function startHub() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-103-"));
  dirs.push(dir);
  const hub = await HubServer.start({ stateDir: dir });
  hubs.push(hub);
  return hub;
}

const verifySignature = (publicKey: string, signature: string, message: Uint8Array) =>
  verify(null, message, parsePublicKey(publicKey), Buffer.from(signature, "base64"));

describe("DIY Cloudflare route schema & backward compatibility (#103)", () => {
  it("allows LAN + Tailscale + VPS + Cloudflare coexistence and orders direct before VPS before Cloudflare", () => {
    const routes = localRoutesSchema.parse([
      { name: "Cloudflare", url: "https://hub.example.com/" },
      { name: "VPS", url: "https://relay.example.com/" },
      { name: "Tailscale", url: "https://192.0.2.10:8788/" },
      { name: "Direct", url: "https://192.168.1.20:8788/" },
    ]);
    expect(routes.map((r) => r.name)).toEqual(["Cloudflare", "VPS", "Tailscale", "Direct"]);
    expect(orderedRoutes(routes).map((r) => r.name)).toEqual(["Tailscale", "Direct", "VPS", "Cloudflare"]);
    expect(legacyV1Routes(routes).map((r) => r.name)).toEqual(["VPS", "Tailscale", "Direct"]);

    expect(isDirectRoute(routes[2]!)).toBe(true);
    expect(isRelayRoute(routes[0]!)).toBe(true);
    expect(isEdgeTlsRoute(routes[0]!)).toBe(true);
    expect(isEdgeTlsRoute(routes[1]!)).toBe(false);
    expect(deploymentMatchesRoutes("vps-relay", [{ name: "Cloudflare", url: "https://hub.example.com" }])).toBe(true);
    expect(deploymentMatchesRoutes("vps-direct", [{ name: "Cloudflare", url: "https://hub.example.com" }])).toBe(false);

    const v1SingleDirect = routesSchema.parse([
      { name: "Tailscale", url: "https://192.0.2.10:8788" },
      { name: "VPS", url: "https://relay.example.com" },
      { name: "Cloudflare", url: "https://hub.example.com" },
    ]);
    expect(v1SingleDirect).toHaveLength(3);
    expect(sharedRoutesSchema.parse(v1SingleDirect)).toHaveLength(3);
  });

  it("rejects custom CA or loopback/HTTP URLs on Cloudflare routes", () => {
    expect(routeSchema.safeParse({ name: "Cloudflare", url: "http://127.0.0.1:8788" }).success).toBe(false);
    expect(routeSchema.safeParse({ name: "Cloudflare", url: "https://127.0.0.1:8788" }).success).toBe(false);
    expect(routeSchema.safeParse({
      name: "Cloudflare",
      url: "https://hub.example.com",
      certificateAuthority: "A".repeat(120),
    }).success).toBe(false);
  });

  it("maps Cloudflare routes to edgeTls without custom CA in routeTrust while preserving CA pinning on Direct/VPS", () => {
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.alloc(32, 1)]).toString("base64");
    const ca = "B".repeat(128);
    rememberRouteTrust([
      { name: "Direct", url: "https://192.168.1.20:8788", certificateAuthority: ca },
      { name: "Cloudflare", url: "https://hub.example.com" },
    ], spki);
    expect(routeTrust("https://192.168.1.20:8788", spki)).toEqual({ certificateAuthority: ca });
    expect(routeTrust("https://hub.example.com", spki)).toEqual({ edgeTls: true });
  });

  it("generates loopback-only cloudflared commands with --protocol http2 recommendation", () => {
    const cmds = cloudflareCommands("http://127.0.0.1:8788");
    expect(cmds.quickHttp2).toBe("cloudflared tunnel --protocol http2 --url http://127.0.0.1:8788");
    expect(cmds.quickQuic).toBe("cloudflared tunnel --url http://127.0.0.1:8788");
    expect(cmds.namedHttp2).toContain("--protocol http2");
    expect(cmds.namedHttp2).toContain("http://127.0.0.1:8788");
  });
});

describe("Edge-terminated Hub Ed25519 identity proof & proxy isolation (#103 / #98)", () => {
  it("rejects unauthorized origins and issues valid origin-bound proof for authorized Cloudflare origins", async () => {
    const hub = await startHub();
    const otherHub = await startHub();
    const nonce = randomBytes(32).toString("base64url");
    const targetOrigin = "https://my-hub.example.com";

    // Unauthorized origin is rejected even on loopback.
    const denied = await fetch(`${hub.url}/api/edge-identity?nonce=${nonce}&origin=${encodeURIComponent(targetOrigin)}`);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "edge_origin_not_allowed" });

    // Authorize origin in Hub Cloudflare config.
    await hub.cloudflare.update({ mode: "named", protocol: "http2", origins: [targetOrigin] });

    const ok = await fetch(`${hub.url}/api/edge-identity?nonce=${nonce}&origin=${encodeURIComponent(targetOrigin)}`);
    expect(ok.status).toBe(200);
    const proof = await ok.json();

    // Valid verification succeeds.
    const verified = verifyEdgeIdentity(proof, { publicKey: hub.auth.publicKey, nonce, origin: targetOrigin }, verifySignature);
    expect(verified.origin).toBe(targetOrigin);

    // Negative tests: wrong hub key, wrong origin (proxy forwarding), wrong nonce, tampered signature.
    expect(() => verifyEdgeIdentity(proof, { publicKey: otherHub.auth.publicKey, nonce, origin: targetOrigin }, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyEdgeIdentity(proof, { publicKey: hub.auth.publicKey, nonce, origin: "https://evil-proxy.example.com" }, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyEdgeIdentity(proof, { publicKey: hub.auth.publicKey, nonce: randomBytes(32).toString("base64url"), origin: targetOrigin }, verifySignature)).toThrow("tls_identity_mismatch");
    expect(() => verifyEdgeIdentity({ ...proof, signature: "A".repeat(86) + "==" }, { publicKey: hub.auth.publicKey, nonce, origin: targetOrigin }, verifySignature)).toThrow("tls_identity_mismatch");
  });

  it("isolates proxied loopback traffic so spoofed X-Forwarded-For headers cannot bypass rate limits", async () => {
    const hub = await startHub();
    const targetOrigin = "https://rate-test.example.com";
    await hub.cloudflare.update({ mode: "named", protocol: "http2", origins: [targetOrigin] });

    // Exhaust the 60/min anonymous rate bucket even while rotating spoofed X-Forwarded-For & CF-Connecting-IP headers.
    let limited = false;
    for (let i = 0; i < 65; i++) {
      const nonce = randomBytes(32).toString("base64url");
      const res = await fetch(`${hub.url}/api/edge-identity?nonce=${nonce}&origin=${encodeURIComponent(targetOrigin)}`, {
        headers: {
          "CF-Ray": `ray-${i}`,
          "CF-Connecting-IP": `203.0.113.${(i % 200) + 1}`,
          "X-Forwarded-For": `198.51.100.${(i % 200) + 1}`,
        },
      });
      if (res.status === 429) {
        limited = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBe(true);
  });

  it("serves owner-authenticated Cloudflare configuration view & updates", async () => {
    const hub = await startHub();
    const view = await hub.cloudflare.view();
    expect(view.mode).toBe("named");
    expect(view.protocol).toBe("http2");
    expect(view.commands.quickHttp2).toContain("--protocol http2");
    expect(view.loopbackTarget).toBe(hub.url);

    // Unauthenticated HTTP requests to owner Cloudflare API must fail with 401.
    const unauth = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`);
    expect(unauth.status).toBe(401);
  });
});
