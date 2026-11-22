import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONTEXT_USAGE_CAPABILITY } from "../src/client-protocol/context-usage.js";
import { SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import { gatewayContextUsage } from "../src/gateway/context-usage.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";

let root: string, hub: HubServer, token: string, transport: GatewayTransport, secret: string, chat: string, hidden: string;
let usage: ReturnType<typeof vi.fn>;
const sockets: WebSocket[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "context-api-"));
  hub = await HubServer.start({ stateDir: root });
  secret = randomBytes(32).toString("base64url");
  for (const id of ["context_bot", "old_bot", "foreign"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,'claude')", [id, id, hashSecret(secret)]);
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Example device", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
  const challenge = await hub.auth.challenge("device", "device", nonce, "fixture");
  token = (await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
  chat = (await hub.store.createConversation("owner", ["context_bot", "old_bot"], "Context", "context")).id;
  hidden = (await hub.store.createConversation("owner", ["context_bot"], "Hidden context", "hidden_context")).id;
  await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [hidden]);
  usage = vi.fn(async () => ({ pressureTokens: 1200, contextWindow: 200_000, autoCompactTokens: 167_000 }));
  // The real worker transport: its hello is what tells the Hub that this worker answers context.usage.
  transport = new GatewayTransport({ stateDir: path.join(root, "gateway"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "context_bot", secret, engine: "claude" });
  const handle = gatewayContextUsage({ handleAuthorizedMessage: vi.fn(), getContextUsage: usage as never }, { canSteerConversation: async () => true });
  transport.onCall = (method, params) => { if (method !== "context.usage") throw new Error("unexpected_method"); return handle(params); };
  let attached!: () => void;
  const ready = new Promise<void>(resolve => { attached = resolve; }); transport.onBoot = async () => attached();
  await transport.connect(); await ready;
});
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await transport?.disconnect(); await hub?.close(); await rm(root, { recursive: true, force: true }); });
const request = (route: string, init: RequestInit = {}) => fetch(hub.url + route, { ...init, headers: { Authorization: `Bearer ${token}` } });
const route = (conversation: string, bot: string) => `/api/conversations/${conversation}/context-usage?botId=${bot}`;

it("round trips one conversation's context usage through actual HTTP and the worker, without chat", async () => {
  expect(SERVER_CAPABILITIES).toContain(CONTEXT_USAGE_CAPABILITY);
  const response = await request(route(chat, "context_bot")); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ supported: true, usedTokens: 1200, windowTokens: 200_000, autoCompactTokens: 167_000 });
  expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversationKey: `lark:${chat}` }));
  expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
});

it("requires authentication, membership of that conversation and a Bot of that conversation", async () => {
  expect((await fetch(hub.url + route(chat, "context_bot"))).status).toBe(401);
  expect((await request(route(hidden, "context_bot"))).status).toBe(403);
  expect((await request(route(chat, "foreign"))).status).toBe(403);
  expect((await request(`/api/conversations/${chat}/context-usage`)).ok).toBe(false);
  expect((await request(route(chat, "context_bot"), { method: "POST" })).ok).toBe(false);
  expect(usage).not.toHaveBeenCalled();
});

it("has no reading, and no error, for an offline worker or one that does not offer it", async () => {
  expect(await (await request(route(chat, "old_bot"))).json()).toEqual({ supported: false });
  const old = new WebSocket(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(old);
  const frames: Array<{ type?: string }> = [];
  old.on("message", raw => { try { frames.push(JSON.parse(raw.toString())); } catch { /* a transfer fragment */ } });
  await new Promise<void>((resolve, reject) => { old.once("open", resolve); old.once("error", reject); });
  old.send(JSON.stringify({ v: 1, type: "instance.hello", botId: "old_bot", secret, engine: "claude", model: "", effort: "", capabilities: [] }));
  await vi.waitFor(() => expect(frames.some(frame => frame.type === "instance.ready")).toBe(true));
  expect(await (await request(route(chat, "old_bot"))).json()).toEqual({ supported: false });
  expect(frames.some(frame => frame.type === "instance.call")).toBe(false);
});

it("does not disclose a late reply after the session is revoked", async () => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  usage.mockImplementationOnce(async () => { entered(); await held; return { pressureTokens: 1200, contextWindow: 200_000 }; });
  const response = request(route(chat, "context_bot"));
  try { await reading; await hub.auth.revoke("device", "local-owner"); } finally { release(); }
  const result = await response; expect(result.status).toBe(401); expect(await result.text()).not.toContain("1200");
});
