import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { gatewayEngineQuota } from "../src/gateway/engine-quota.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import { quotaDirectorySchema, quotaScopeSchema } from "../src/client-protocol/engine-quota.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { engineQuotaCommand } from "../src/host-cli/engine-quota.js";
import { ENGINE_QUOTA_CAPABILITY } from "../src/client-protocol/engine-quota.js";

let root: string, hub: HubServer, token: string, transport: GatewayTransport;
let read: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "quota-api-"));
  hub = await HubServer.start({ stateDir: root });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('quota_bot','Example Bot',?,'codex')", [hashSecret(secret)]);
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Example device", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  const challenge = await hub.auth.challenge("device", "device", nonce, "fixture");
  token = (await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
  read = vi.fn(async () => ({ revision: "revision_one", snapshot: unavailableQuota("codex", "not_loaded"), proof: { scopeStamp: "private_account_proof" } }));
  transport = new GatewayTransport({ stateDir: path.join(root, "gateway"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "quota_bot", secret, engine: "codex" });
  const handle = gatewayEngineQuota({ botId: "quota_bot", engine: "codex", read });
  transport.onCall = (method, params) => { if (method !== "quota.get") throw new Error("unexpected_method"); return handle(params); };
  let attached!: () => void;
  const ready = new Promise<void>(resolve => { attached = resolve; }); transport.onBoot = async () => attached();
  await transport.connect(); await ready;
});
afterEach(async () => { await transport?.disconnect(); await hub?.close(); await rm(root, { recursive: true, force: true }); });
const request = (route: string) => fetch(hub.url + route, { headers: { Authorization: `Bearer ${token}` } });

it("round trips cache and explicit refresh through actual HTTP and Gateway, without chat or durable outbox", async () => {
  const response = await request("/api/engine-quotas"); expect(response.status).toBe(200);
  const directory = quotaDirectorySchema.parse(await response.json());
  expect(directory.scopes).toHaveLength(1);
  expect(directory.scopes[0]).toMatchObject({ id: "quota_bot", label: "Example Bot", revision: "revision_one", reason: "not_loaded" });
  expect(JSON.stringify(directory)).not.toContain("private_account_proof");
  expect(read.mock.calls.map(args => args[0].refresh)).toEqual([false]);
  const refreshed = await request("/api/engine-quotas/quota_bot?refresh=1&revision=revision_one");
  expect(refreshed.status).toBe(200); expect(quotaScopeSchema.parse(await refreshed.json()).revision).toBe("revision_one");
  expect(read.mock.calls.map(args => args[0].refresh)).toEqual([false, false, true]);
  expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
  expect(await readdir(path.join(root, "gateway")).catch(() => [])).not.toContain("gateway-outbox.json");
});

it("requires authentication, owner access, an existing scope and a seen revision", async () => {
  expect((await fetch(hub.url + "/api/engine-quotas")).status).toBe(401);
  expect((await request("/api/engine-quotas?refresh=1")).status).toBe(400);
  expect((await request("/api/engine-quotas/quota_bot?refresh=1")).status).toBe(400);
  expect((await request("/api/engine-quotas/missing")).status).toBe(404);
  await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
  expect((await request("/api/engine-quotas")).status).toBe(403);
  expect((await request("/api/engine-quotas/quota_bot?refresh=1&revision=revision_one")).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});

it.each(["revoke", "demote"] as const)("does not disclose a late quota reply after %s", async action => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  read.mockImplementation(async () => { entered(); await held; return { revision: "one", snapshot: unavailableQuota("codex", "not_loaded") }; });
  const response = request("/api/engine-quotas");
  try {
    await reading;
    if (action === "revoke") await hub.auth.revoke("device", "local-owner");
    else await hub.store.db.serial(() => hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
  } finally { release(); }
  const result = await response; expect(result.status).toBe(action === "revoke" ? 401 : 403);
  expect(await result.text()).not.toContain("not_loaded");
});

it("uses the same authenticated HTTP quota contract from the headless CLI", async () => {
  const client = { ready: { serverCapabilities: [ENGINE_QUOTA_CAPABILITY] }, request: async (route: string) => {
    const response = await request(route); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json();
  } };
  const initial = quotaDirectorySchema.parse(await engineQuotaCommand(client as any, {}));
  expect(initial.scopes[0].revision).toBe("revision_one");
  const calls = read.mock.calls.length;
  await expect(engineQuotaCommand(client as any, { refresh: true, bot: "quota_bot" })).rejects.toThrow("--revision");
  expect(read.mock.calls).toHaveLength(calls);
  const refreshed = quotaScopeSchema.parse(await engineQuotaCommand(client as any, { bot: "quota_bot", refresh: true, revision: initial.scopes[0].revision }));
  expect(refreshed.id).toBe("quota_bot");
  expect(read.mock.calls.filter(args => args[0].refresh)).toHaveLength(1);
  expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
});
