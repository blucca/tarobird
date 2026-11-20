import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { GatewayChannel } from "../src/gateway/channel.js";
import { gatewayConversationHistory } from "../src/gateway/conversation-history.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { bootstrapTrusted } from "./helpers/pairing-invite.js";
import { CONVERSATION_HISTORY_CAPABILITY } from "../src/client-protocol/conversation-history.js";

it("uses signed owner HTTP and real GatewayChannel receipts without replaying a mutation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "history-roundtrip-")), hub = await HubServer.start({ stateDir: directory });
  let socket: WebSocket | undefined, channel: GatewayChannel | undefined;
  try {
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Fixture',?,'codex')", [hashSecret(secret)]);
    const conversationId = (await hub.store.createConversation("owner", ["bot"], "Source", "create")).id;
    const keys = generateKeyPairSync("ed25519");
    await bootstrapTrusted(hub.auth, { deviceId: "device", name: "Fixture", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") });
    socket = new WebSocket(hub.url.replace("http", "ws") + "/ws");
    const frames: any[] = [];
    socket.on("message", data => { const frame = JSON.parse(data.toString()); frames.push(frame); if (frame.type === "snapshot.message") socket!.send(JSON.stringify({ v: 1, type: "snapshot.ack", id: frame.id, count: frame.index + 1 })); });
    const next = async (type: string) => { for (let tries = 0; tries < 1000; tries++) { const index = frames.findIndex(frame => frame.type === type); if (index >= 0) return frames.splice(index, 1)[0]; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error(`missing_${type}`); };
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    const nonce = randomBytes(32).toString("base64url");
    socket.send(JSON.stringify({ v: 1, type: "hello", deviceId: "device", nonce, protocolVersions: [1], capabilities: [], cursors: {} }));
    const challenge = await next("challenge");
    socket.send(JSON.stringify({ v: 1, type: "auth", signature: sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64") }));
    const ready = await next("ready"); await next("sync.complete");
    expect(ready.serverCapabilities).toContain(CONVERSATION_HISTORY_CAPABILITY);
    const headers = { Authorization: `Bearer ${ready.sessionToken}` };
    const transport = new GatewayTransport({ stateDir: path.join(directory, "worker"), url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "codex" });
    await mkdir(transport.options.stateDir, { recursive: true });
    await writeFile(path.join(transport.options.stateDir, "config.json"), "{}");
    channel = new GatewayChannel(transport); channel.canSteerConversation = async () => true;
    const bridge = { handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })),
      getConversationHistory: vi.fn(async () => ({ supported: true, revision: "revision", sourceSessionId: "native", bindingGeneration: "generation", capabilities: { rewind: false, fork: true, anchoredFork: false } })),
      applyConversationHistory: vi.fn(async () => ({ outcome: "applied" as const, sourceSessionId: "native", destinationSessionId: "native_fork" })),
      finalizeConversationHistory: vi.fn(async () => ({ revision: "next_revision" })),
    };
    channel.onCall = gatewayConversationHistory(bridge, channel, createCoreServiceRuntime(), transport.options.stateDir, "bot");
    let attached!: () => void; const attachedPromise = new Promise<void>(resolve => { attached = resolve; }); transport.onBoot = async () => attached();
    await channel.connect(); await attachedPromise;
    const base = `${hub.url}/api/conversations/${conversationId}/history`;
    const snapshot = await (await fetch(`${base}?botId=bot`, { headers })).json();
    expect(snapshot).toEqual({ supported: true, revision: "revision", capabilities: { rewind: false, fork: true, anchoredFork: false } });
    const input = { botId: "bot", requestId: "request", expectedRevision: "revision", action: { kind: "fork", scope: "whole" } };
    const result = await (await fetch(`${base}/operations`, { method: "POST", headers, body: JSON.stringify(input) })).json();
    expect(result).toMatchObject({ state: "applied", requestId: "request", resultingRevision: "next_revision" });
    expect(await (await fetch(`${base}/operations/request?botId=bot`, { headers })).json()).toEqual(result);
    expect(await (await fetch(`${base}/operations`, { method: "POST", headers, body: JSON.stringify(input) })).json()).toEqual(result);
    expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
    expect((await hub.store.conversations("owner")).find(conversation => conversation.id === result.destinationConversationId)?.historyOrigin).toMatchObject({ sourceConversationId: conversationId, boundary: "whole" });
    const unsent = { ...input, requestId: "unsent" };
    const tombstone = await (await fetch(`${base}/operations/unsent/reconcile`, { method: "POST", headers, body: JSON.stringify(unsent) })).json();
    expect(tombstone).toMatchObject({ state: "rejected", reason: "cancelled" });
    expect(await (await fetch(`${base}/operations`, { method: "POST", headers, body: JSON.stringify(unsent) })).json()).toEqual(tombstone);
    expect(bridge.applyConversationHistory).toHaveBeenCalledOnce();
    await hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    expect((await fetch(`${base}/operations/request?botId=bot`, { headers })).status).toBe(403);
  } finally { socket?.terminate(); await channel?.disconnect(); await hub.close(); await rm(directory, { recursive: true, force: true }); }
});
