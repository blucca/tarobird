import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, type ChildProcess, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import tls from "node:tls";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import WebSocket from "ws";
import { HubServer } from "../src/hub/server.js";
import { parsePublicKey } from "../src/hub/auth.js";
import { HubCloudflareTunnel } from "../src/hub/cloudflare-tunnel.js";
import { forgetPeerPin, peerPin } from "../src/hub/peer-tls.js";
import { exchangeNetworkPeer } from "../src/hub/network-peer.js";
import { exchangeBotMessage } from "../src/hub/bot-message-transport.js";
import { messageHostId } from "../src/hub/bot-messages.js";
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
import {
  networkGenesisText,
  networkHostDescriptorSchema,
  networkHostRoutes,
  networkManifestSchema,
  sharedRoutesSchema,
  type NetworkHost,
  type NetworkManifest,
  type SignedNetworkManifest,
  type SignedNetworkPeerRequest,
} from "../src/client-protocol/private-network.js";
import { edgeOriginSchema, verifyEdgeIdentity } from "../src/client-protocol/tls-identity.js";
import { cloudflareCommands, HOST_CLOUDFLARE_PATH } from "../src/client-protocol/cloudflare.js";
import type { BotPassport } from "../src/client-protocol/bot-messages.js";
import { rememberRouteTrust, routeTrust } from "../client/src/route-trust.js";
import { connectionPairingPayload } from "../client/src/pairing-link.js";

const dirs: string[] = [];
const hubs: HubServer[] = [];
const httpsServers: HttpsServer[] = [];
const defaultCaCertificates = tls.getCACertificates("default");

afterEach(async () => {
  tls.setDefaultCACertificates(defaultCaCertificates);
  await Promise.all(httpsServers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
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

function tryOpenWs(url: string, headers: Record<string, string> = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 2000 });
    let done = false;
    const finish = (opened: boolean) => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch { /* ignore */ }
      resolve(opened);
    };
    ws.once("open", () => finish(true));
    ws.once("error", () => finish(false));
    ws.once("unexpected-response", () => finish(false));
    ws.once("close", () => finish(false));
  });
}

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  signals: Array<NodeJS.Signals | number | undefined> = [];
  constructor(private readonly ignoreSigterm = false) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (this.exitCode !== null || this.signalCode !== null) return false;
    if (signal === "SIGTERM" && this.ignoreSigterm) return true;
    queueMicrotask(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = (typeof signal === "string" ? signal : "SIGTERM") as NodeJS.Signals;
      this.emit("exit", null, this.signalCode);
      this.emit("close", null, this.signalCode);
    });
    return true;
  }
}

describe("DIY Cloudflare route schema & backward compatibility (#103)", () => {
  it("allows LAN + Tailscale + VPS + Cloudflare coexistence, orders direct before VPS before Cloudflare, and preserves v1.6.0 manifest compat", () => {
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

    // v1.6.0 sharedRoutesSchema stays strictly Direct/Tailscale/VPS so v1.6.0 peers never reject manifests.
    expect(sharedRoutesSchema.safeParse(v1SingleDirect).success).toBe(false);
    expect(sharedRoutesSchema.parse(legacyV1Routes(v1SingleDirect))).toHaveLength(2);

    // Additive edgeRoutes on networkHostDescriptorSchema carries Cloudflare routes on v2+ hosts and is forbidden on v1 manifests.
    const hostKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const hostDesc = networkHostDescriptorSchema.parse({
      publicKey: hostKey,
      name: "Host",
      routes: [{ name: "VPS", url: "https://relay.example.com" }],
      edgeRoutes: [{ name: "Cloudflare", url: "https://hub.example.com" }],
    });
    expect(networkHostRoutes(hostDesc).map((r) => r.name)).toEqual(["VPS", "Cloudflare"]);
    const genesis = randomBytes(32).toString("base64url");
    const netId = `net_${createHash("sha256").update(networkGenesisText(hostKey, genesis)).digest("hex")}`;
    expect(networkManifestSchema.safeParse({
      v: 1,
      id: netId,
      name: "Net",
      authorityKey: hostKey,
      genesisNonce: genesis,
      revision: 1,
      hosts: [{ ...hostDesc, state: "active", revoked: false }],
      devices: [],
      revokedMembers: [],
      blockedBindings: [],
    }).success).toBe(false);

    // Relay activeUrl ordering in pairing payloads differentiates VPS vs Cloudflare selection.
    const cfFirst = connectionPairingPayload(
      hostKey,
      [
        { name: "VPS", url: "https://relay.example.com" },
        { name: "Cloudflare", url: "https://hub.example.com" },
      ],
      undefined,
      "https://hub.example.com",
    );
    expect(cfFirst.routes.map((r) => r.name)).toEqual(["Cloudflare", "VPS"]);
  });

  it("rejects custom CA, HTTP, and all loopback/unspecified/localhost forms on Cloudflare and edge origins", () => {
    for (const bad of [
      "http://127.0.0.1:8788",
      "https://127.0.0.1:8788",
      "https://127.0.0.2:8788",
      "https://0.0.0.0:8788",
      "https://[::]:8788",
      "https://[::1]:8788",
      "https://[::ffff:127.0.0.1]:8788",
      "https://[::ffff:0.0.0.0]:8788",
      "https://localhost:8788",
      "https://foo.localhost:8788",
    ]) {
      expect(edgeOriginSchema.safeParse(bad).success, `edgeOriginSchema should reject ${bad}`).toBe(false);
      expect(routeSchema.safeParse({ name: "Cloudflare", url: bad }).success, `routeSchema should reject ${bad}`).toBe(false);
    }
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

  it("generates loopback-only cloudflared commands for both http2 and quic in quick and named modes", () => {
    const cmds = cloudflareCommands("http://127.0.0.1:8788");
    expect(cmds.quickHttp2).toBe("cloudflared tunnel --protocol http2 --url http://127.0.0.1:8788");
    expect(cmds.quickQuic).toBe("cloudflared tunnel --url http://127.0.0.1:8788");
    expect(cmds.namedHttp2).toContain("--protocol http2");
    expect(cmds.namedHttp2).toContain("http://127.0.0.1:8788");
    expect(cmds.namedQuic).not.toContain("--protocol http2");
    expect(cmds.namedQuic).toContain("http://127.0.0.1:8788");
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

  it("blocks proxied loopback requests on all six loopback-only privileged endpoints while allowing direct loopback", async () => {
    const hub = await startHub();
    const wsBase = hub.url.replace(/^http/, "ws");
    const proxyVariants: Array<{ label: string; headers: Record<string, string> }> = [
      {
        label: "cloudflare proxy headers",
        headers: {
          Host: "hub.example.com",
          "CF-Ray": "8a1b2c3d4e5f6789-SJC",
          "CF-Connecting-IP": "203.0.113.10",
          "X-Forwarded-For": "203.0.113.10",
        },
      },
      {
        label: "Forwarded header only",
        headers: { Forwarded: "for=203.0.113.10;proto=https" },
      },
      {
        label: "non-loopback Host header only",
        headers: { Host: "hub.example.com" },
      },
    ];

    // Direct loopback still opens local privileged WS channels.
    expect(await tryOpenWs(`${wsBase}/screen/v1/target`)).toBe(true);
    expect(await tryOpenWs(`${wsBase}/screen/v1/target-media`)).toBe(true);
    expect(await tryOpenWs(`${wsBase}/instance`)).toBe(true);

    for (const variant of proxyVariants) {
      expect(await tryOpenWs(`${wsBase}/screen/v1/target`, variant.headers), `/screen/v1/target (${variant.label})`).toBe(false);
      expect(await tryOpenWs(`${wsBase}/screen/v1/target-media`, variant.headers), `/screen/v1/target-media (${variant.label})`).toBe(false);
      expect(await tryOpenWs(`${wsBase}/instance`, variant.headers), `/instance (${variant.label})`).toBe(false);

      // Node fetch forbids overriding the Host header, so use raw http.request to test Host spoofing accurately.
      const sendHttp = (method: string, routePath: string, headers: Record<string, string>) =>
        new Promise<{ status: number; body: unknown }>((resolve, reject) => {
          const target = new URL(routePath, hub.url);
          import("node:http").then(({ request }) => {
            const req = request({
              hostname: target.hostname,
              port: target.port,
              path: target.pathname,
              method,
              headers: { "Content-Type": "application/json", ...headers },
            }, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
              });
            });
            req.on("error", reject);
            if (method === "POST") req.write("{}");
            req.end();
          }, reject);
        });

      const inst = await sendHttp("GET", "/api/instance/nonexistent", variant.headers);
      expect(inst.status, `/api/instance/* (${variant.label})`).toBe(403);
      expect(inst.body).toEqual({ error: "instance_loopback_only" });

      const grant = await sendHttp("POST", "/api/bot-messages/grant", variant.headers);
      expect(grant.status, `/api/bot-messages/grant (${variant.label})`).toBe(403);
      expect(grant.body).toEqual({ error: "local_controller_required" });

      const local = await sendHttp("POST", "/api/bot-messages/local", variant.headers);
      expect(local.status, `/api/bot-messages/local (${variant.label})`).toBe(403);
      expect(local.body).toEqual({ error: "local_controller_required" });
    }
  });

  it("serves owner-authenticated Cloudflare configuration view & updates", async () => {
    const hub = await startHub();
    const view = await hub.cloudflare.view();
    expect(view.mode).toBe("named");
    expect(view.protocol).toBe("http2");
    expect(view.commands.quickHttp2).toContain("--protocol http2");
    expect(view.commands.namedQuic).toContain(hub.url);
    expect(view.loopbackTarget).toBe(hub.url);

    // Unauthenticated HTTP requests to owner Cloudflare API must fail with 401.
    const unauth = await fetch(`${hub.url}${HOST_CLOUDFLARE_PATH}`);
    expect(unauth.status).toBe(401);
  });
});

describe("Host-to-Host PrivateNetwork & Bot messaging over Cloudflare edgeRoutes (#103)", () => {
  it("verifies peerPin via /api/edge-identity and completes exchangeNetworkPeer + exchangeBotMessage over WebPKI HTTPS without leaf pins", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cf-peer-"));
    dirs.push(dir);
    const address = Object.values(os.networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal)!.address;

    const openssl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=Cloudflare Edge Fixture CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
    await writeFile(path.join(dir, "edge.ext"), `subjectAltName=IP:${address}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "edge.key", "-out", "edge.csr", "-subj", "/CN=edge.test"]);
    openssl(["x509", "-req", "-in", "edge.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "edge.crt", "-days", "1", "-extfile", "edge.ext"]);
    const caPem = await readFile(path.join(dir, "ca.crt"), "utf8");
    const edgeTls = { key: await readFile(path.join(dir, "edge.key")), cert: await readFile(path.join(dir, "edge.crt")) };
    // Simulate Cloudflare's WebPKI cert being trusted by the OS root store (no custom route.certificateAuthority).
    tls.setDefaultCACertificates([...defaultCaCertificates, caPem]);

    const peerHub = await startHub();
    const callerHub = await startHub();
    let edgeUrl = "";
    let spoofOrigin: string | undefined;
    let peerPosts = 0;
    let botPosts = 0;

    const server = createHttpsServer(edgeTls, (req, res) => {
      const parsed = new URL(req.url!, edgeUrl);
      if (req.method === "GET" && parsed.pathname === "/api/edge-identity") {
        const nonce = parsed.searchParams.get("nonce")!;
        const origin = spoofOrigin ?? parsed.searchParams.get("origin")!;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(peerHub.auth.edgeIdentity(nonce, origin, "127.0.0.1")));
        return;
      }
      if (req.method === "POST" && parsed.pathname === "/api/network/peer") {
        peerPosts++;
        req.resume();
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(signedManifest));
        });
        return;
      }
      if (req.method === "POST" && parsed.pathname === "/api/bot-messages/conversations") {
        botPosts++;
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const header = JSON.parse(Buffer.from(String(req.headers["x-tarobot-message-passport"]), "base64url").toString("utf8")) as { passport: BotPassport };
          const result = { conversationId: "conv_cf_1" };
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ result, signature: peerHub.auth.signBotReply(header.passport.nonce, result) }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    httpsServers.push(server);
    await new Promise<void>(resolve => server.listen(0, address, resolve));
    edgeUrl = `https://${address}:${(server.address() as { port: number }).port}`;

    const genesisNonce = randomBytes(32).toString("base64url");
    const netId = `net_${createHash("sha256").update(networkGenesisText(peerHub.auth.publicKey, genesisNonce)).digest("hex")}`;
    const cfHost: NetworkHost = {
      publicKey: peerHub.auth.publicKey,
      name: "EdgePeer",
      routes: [],
      edgeRoutes: [{ name: "Cloudflare", url: edgeUrl }],
      protocol: 2,
      state: "active",
      revoked: false,
    };
    const manifest: NetworkManifest = {
      v: 2,
      id: netId,
      name: "Edge Network",
      authorityKey: peerHub.auth.publicKey,
      genesisNonce,
      revision: 1,
      hosts: [cfHost],
      devices: [],
      revokedMembers: [],
      blockedBindings: [],
    };
    const signedManifest: SignedNetworkManifest = {
      manifest,
      signature: peerHub.auth.signNetworkManifest(manifest),
    };
    const peerReqValue = {
      v: 1 as const,
      networkId: netId,
      publicKey: callerHub.auth.publicKey,
      nonce: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 30_000,
      host: { publicKey: callerHub.auth.publicKey, name: "Caller", routes: [] },
      devices: [],
      revoked: [],
    };
    const signedPeerReq: SignedNetworkPeerRequest = {
      request: peerReqValue,
      signature: callerHub.auth.signNetworkPeer(peerReqValue),
    };

    // 1. Direct peerPin check over Cloudflare route returns pin: undefined and caches.
    const route = { name: "Cloudflare" as const, url: edgeUrl };
    forgetPeerPin(peerHub.auth.publicKey, route);
    const first = await peerPin(peerHub.auth.publicKey, route, async (probePath) => {
      const q = new URL(probePath, edgeUrl);
      return peerHub.auth.edgeIdentity(q.searchParams.get("nonce")!, q.searchParams.get("origin")!, "127.0.0.1");
    });
    expect(first).toEqual({ pin: undefined, cached: false });
    const second = await peerPin(peerHub.auth.publicKey, route, async () => { throw new Error("should_use_cache"); });
    expect(second).toEqual({ pin: undefined, cached: true });
    forgetPeerPin(peerHub.auth.publicKey, route);

    // 2. Host-to-Host PrivateNetwork sync succeeds over edgeRoutes Cloudflare URL.
    expect(await exchangeNetworkPeer(cfHost, signedPeerReq)).toEqual(signedManifest);
    expect(peerPosts).toBe(1);

    // 3. Cross-host Bot messaging succeeds over edgeRoutes Cloudflare URL.
    const body = Buffer.from(JSON.stringify({ hello: "cf" }));
    const passport: BotPassport = {
      v: 1,
      sourceKey: callerHub.auth.publicKey,
      targetKey: peerHub.auth.publicKey,
      source: {
        hostId: messageHostId(callerHub.auth.publicKey),
        hostName: "Caller",
        botId: "sender",
        botName: "Sender",
        hops: 1,
        requestId: randomUUID(),
      },
      targetBot: "receiver",
      method: "POST",
      path: "/api/bot-messages/conversations",
      digest: createHash("sha256").update(body).digest("hex"),
      expiresAt: Date.now() + 60_000,
      nonce: randomUUID(),
    };
    expect(await exchangeBotMessage(cfHost, { passport, signature: callerHub.auth.signBotPassport(passport) }, body))
      .toEqual({ conversationId: "conv_cf_1" });
    expect(botPosts).toBe(1);

    // 4. Negative: spoofed origin in /api/edge-identity fails BEFORE sending POST payload.
    forgetPeerPin(peerHub.auth.publicKey, route);
    spoofOrigin = "https://wrong.example.com";
    await expect(exchangeNetworkPeer(cfHost, signedPeerReq)).rejects.toThrow("network_peer_response_invalid");
    await expect(exchangeBotMessage(cfHost, { passport, signature: callerHub.auth.signBotPassport(passport) }, body))
      .rejects.toThrow("unavailable_or_upgrade_required");
    expect(peerPosts).toBe(1);
    expect(botPosts).toBe(1);

    // 5. Negative: Cloudflare route with custom CA is rejected by peerPin.
    await expect(peerPin(peerHub.auth.publicKey, { name: "Cloudflare", url: edgeUrl, certificateAuthority: "A".repeat(120) }, async () => ({})))
      .rejects.toThrow("network_peer_certificate_invalid");
  }, 20_000);
});

describe("HubCloudflareTunnel process lifecycle hardening (#103)", () => {
  it("serializes concurrent starts, parses split chunks, aborts cleanly on stop, and escalates SIGKILL on close", async () => {
    const hub = await startHub();
    const spawned: FakeChild[] = [];
    let ignoreSigterm = false;
    const tunnel = new HubCloudflareTunnel({
      store: hub.store,
      loopbackTarget: () => hub.url,
      detect: async () => ({ installed: true, path: "/usr/bin/cloudflared", version: "2026.1.0" }),
      spawnProcess: (() => {
        const child = new FakeChild(ignoreSigterm);
        spawned.push(child);
        return child as unknown as ChildProcess;
      }) as unknown as typeof spawn,
      startTimeoutMs: 2000,
      stopTimeoutMs: 60,
    });

    // 1. Concurrent startQuickTunnel calls spawn only ONE process and parse a URL split across chunks.
    const p1 = tunnel.startQuickTunnel("http2");
    const p2 = tunnel.startQuickTunnel("http2");
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0]!.stderr.write("INF |  https://split-");
    spawned[0]!.stderr.write("chunk-test.trycloudflare.com  |\n");
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(spawned).toHaveLength(1);
    expect(v1.activeUrl).toBe("https://split-chunk-test.trycloudflare.com");
    expect(v2.activeUrl).toBe("https://split-chunk-test.trycloudflare.com");
    expect(tunnel.isOriginAllowed("https://split-chunk-test.trycloudflare.com")).toBe(true);

    // 2. stopQuickTunnel during a slow start aborts startup, kills the child, and never authorizes a phantom URL.
    await tunnel.stopQuickTunnel();
    expect(tunnel.isOriginAllowed("https://split-chunk-test.trycloudflare.com")).toBe(false);
    const slowStart = tunnel.startQuickTunnel("quic");
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    const stopped = tunnel.stopQuickTunnel();
    await expect(slowStart).rejects.toThrow("cloudflared_stopped");
    const afterStop = await stopped;
    expect(afterStop.running).toBe(false);
    expect(afterStop.activeUrl).toBeUndefined();
    spawned[1]!.stderr.write("https://phantom-after-stop.trycloudflare.com\n");
    expect(tunnel.isOriginAllowed("https://phantom-after-stop.trycloudflare.com")).toBe(false);

    // 3. close() awaits child exit and escalates SIGTERM -> SIGKILL if the child ignores SIGTERM.
    ignoreSigterm = true;
    const p3 = tunnel.startQuickTunnel("http2");
    await vi.waitFor(() => expect(spawned).toHaveLength(3));
    spawned[2]!.stdout.write("https://sigkill-test.trycloudflare.com\n");
    await p3;
    await tunnel.close();
    expect(spawned[2]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawned[2]!.signalCode).toBe("SIGKILL");
    await expect(tunnel.startQuickTunnel("http2")).rejects.toThrow("hub_stopping");
  });
});
