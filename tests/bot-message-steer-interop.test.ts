// Issue #62 review R18: process-level interop over real TLS. Explicit local runs only:
//   TAROBIRD_STEER_INTEROP_OLD_DIST=<dist built from a069365 (before this feature)>
//   TAROBIRD_STEER_INTEROP_NEW_DIST=<dist built from this branch>
// The receiving Host runs from that dist in a child process, listening with TLS
// on a LAN address; the sending Host is this branch in the test process.
// Evidence level: two processes on one machine, not two machines.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { networkId } from "../src/hub/private-network.js";
import type { NetworkManifest } from "../src/client-protocol/private-network.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });

class Receiver {
  private readonly replies: string[] = []; private waiting?: () => void;
  readonly child: ChildProcessWithoutNullStreams;
  constructor(dist: string, stateDir: string, cert: string, key: string, address: string) {
    this.child = spawn(process.execPath, [path.resolve("tests/helpers/bot-message-interop-receiver.mjs"), dist, stateDir, cert, key, address], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", line => { this.replies.push(line); this.waiting?.(); });
    this.child.stderr.on("data", () => undefined);
  }
  async next(): Promise<any> {
    const deadline = Date.now() + 30_000;
    while (!this.replies.length) { if (Date.now() > deadline) throw new Error("receiver_timeout"); await new Promise<void>(resolve => { this.waiting = resolve; setTimeout(resolve, 200); }); }
    return JSON.parse(this.replies.shift()!);
  }
  async request(op: string, args: Record<string, unknown> = {}): Promise<any> {
    this.child.stdin.write(`${JSON.stringify({ op, ...args })}\n`);
    const reply = await this.next(); if (!reply.ok) throw new Error(reply.error); return reply.result;
  }
}

async function pair(dist: string) {
  const root = await mkdtemp(path.join(tmpdir(), "bot-steer-interop-"));
  const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === "IPv4" && !entry.internal)!.address;
  const tls = await desktopTls(path.join(root, "tls"), [address]);
  const receiver = new Receiver(dist, path.join(root, "receiver"), tls.cert, tls.key, address);
  const ready = await receiver.next();
  const sender = await HubServer.start({ stateDir: path.join(root, "sender") });
  cleanups.push(async () => { await receiver.request("close").catch(() => undefined); receiver.child.kill(); await sender.close(); await rm(root, { recursive: true, force: true }); });
  await sender.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('sender','Sender','fixture','codex')");
  const routes = [{ name: "Direct" as const, url: ready.url, certificateAuthority: tls.certificateAuthority }];
  const hosts = [{ publicKey: sender.auth.publicKey, name: "A", routes: [], protocol: 2 as const, state: "active" as const, revoked: false },
    { publicKey: ready.publicKey, name: "B", routes, protocol: 2 as const, state: "active" as const, revoked: false }];
  const nonce = randomBytes(32).toString("base64url");
  const manifest: NetworkManifest = { v: 2, id: networkId(sender.auth.publicKey, nonce), authorityKey: sender.auth.publicKey, genesisNonce: nonce, name: "Interop", revision: 1, hosts, devices: [], revokedMembers: [], blockedBindings: [] };
  const membership = { manifest, signature: sender.auth.signNetworkManifest(manifest) };
  await sender.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
  await receiver.request("configure", { membership, routes, sourceHost: "A", sourceBot: "sender" });
  const invoke = (operation: string, data: Record<string, unknown> = {}, conversation?: string, requestId = randomUUID()) =>
    sender.botMessages.local({ operation, host: messageHostId(ready.publicKey), bot: "receiver", requestId, data, ...(conversation ? { conversation } : {}) } as never, "sender", async () => undefined, true) as Promise<any>;
  return { receiver, invoke };
}

it.skipIf(!process.env.TAROBIRD_STEER_INTEROP_OLD_DIST)("a new sender's steer to a pre-#62 Host over real TLS is queued exactly once with receiver_update_required", async () => {
  const { receiver, invoke } = await pair(process.env.TAROBIRD_STEER_INTEROP_OLD_DIST!);
  const chat = await invoke("resolve");
  const receipt = await invoke("send", { text: "Steer to an old host", attachments: [], delivery: "steer" }, chat.conversationId);
  expect(receipt).toMatchObject({ status: "queued", duplicate: false, delivery: { requested: "steer", actual: "fell_back_to_queue", reason: "receiver_update_required" } });
  expect(await receiver.request("deliveries", { messageId: receipt.messageId })).toEqual([{ status: "pending", dispatched: 0 }]);
  const inputs = await receiver.request("inputs");
  expect(inputs).toHaveLength(1);
  expect(JSON.parse(inputs[0].blocks_json)).toEqual([{ type: "text", text: "Steer to an old host" }]);
  // The same request again: the old Host's own idempotency, still one message.
  expect(await invoke("send", { text: "Steer to an old host", attachments: [], delivery: "steer" }, chat.conversationId, receipt.requestId)).toMatchObject({ messageId: receipt.messageId, duplicate: true });
  expect(await receiver.request("inputs")).toHaveLength(1);
  // An explicit queue never reaches the old Host's strict schema (R14).
  expect(await invoke("send", { text: "Queue to an old host", attachments: [] , delivery: "queue" }, chat.conversationId)).toMatchObject({ status: "queued", delivery: { requested: "queue", actual: "queued" } });
  const audit = (await receiver.request("audit")).map((row: { kind: string; detail_json: string }) => ({ kind: row.kind, ...JSON.parse(row.detail_json) }));
  // Semantics review N5: each probe leaves one refusal line on the old Host; nothing else is written for it.
  expect(audit.filter((entry: { kind: string; reason?: string }) => entry.kind === "bot-message.rejected" && entry.reason === "bot_message_operation_forbidden").length).toBe(2);
  console.log(`INTEROP_OLD ${JSON.stringify({ receipt: { status: receipt.status, delivery: receipt.delivery }, oldHostInputs: (await receiver.request("inputs")).length, oldHostAudit: audit.map((entry: { kind: string; reason?: string }) => `${entry.kind}${entry.reason ? `:${entry.reason}` : ""}`) })}`);
}, 120_000);

it.skipIf(!process.env.TAROBIRD_STEER_INTEROP_NEW_DIST)("a new sender steers into a new Host over real TLS and waits for the merged turn's reply", async () => {
  const { receiver, invoke } = await pair(process.env.TAROBIRD_STEER_INTEROP_NEW_DIST!);
  const chat = await invoke("resolve");
  const task = await invoke("send", { text: "Interop task", attachments: [] }, chat.conversationId);
  await receiver.request("live", { messageId: task.messageId });
  const steered = await invoke("send", { text: "Interop correction", attachments: [], delivery: "steer" }, chat.conversationId);
  expect(steered).toMatchObject({ status: "steered", delivery: { requested: "steer", actual: "steered", turn: { messageId: task.messageId } } });
  const calls = await receiver.request("steerCalls");
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ text: "Interop correction", sourceMessageId: task.messageId, source: { botId: "sender", hostName: expect.any(String) } });
  expect(await receiver.request("deliveries", { messageId: steered.messageId })).toEqual([]);
  expect((await invoke("wait", { messageId: steered.messageId }, chat.conversationId)).status).toBe("pending");
  await receiver.request("finish", { messageId: task.messageId, text: "Interop final reply" });
  const done = await invoke("wait", { messageId: steered.messageId }, chat.conversationId);
  expect(done).toMatchObject({ status: "completed", text: "Interop final reply", reply: { kind: "merged_turn", turnMessageId: task.messageId }, delivery: { actual: "steered" } });
  console.log(`INTEROP_NEW ${JSON.stringify({ steered: steered.delivery, wait: { status: done.status, reply: done.reply, text: done.text } })}`);
}, 120_000);
