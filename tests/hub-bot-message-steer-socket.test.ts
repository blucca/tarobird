import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { BOT_MESSAGE_STEER_CAPABILITY } from "../src/client-protocol/bot-message-delivery.js";

type Frame = Record<string, any>;
class Peer {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on("message", raw => this.frames.push(JSON.parse(raw.toString()))); }
  static async connect(url: string) { const p = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { p.ws.once("open", r); p.ws.once("error", j); }); return p; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, pred: (f: Frame) => boolean = () => true) { const until = Date.now() + 5000; for (;;) { const i = this.frames.findIndex(f => f.type === type && pred(f)); if (i >= 0) return this.frames.splice(i, 1)[0]!; if (Date.now() > until) throw new Error("Missing " + type); await new Promise(r => setTimeout(r, 5)); } }
}

describe("Hub ↔ Gateway Bot steer wiring (#62)", () => {
  let dir: string, hub: HubServer; const sockets: WebSocket[] = [];
  const guard = async () => undefined, secret = randomBytes(32).toString("base64url");
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bot-steer-socket-")); hub = await HubServer.start({ stateDir: dir });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('source','Source',?,'claude'),('target','Target',?,'codex')", [hashSecret("unused-".repeat(8)), hashSecret(secret)]);
    await hub.botMessages.grant({ sourceHost: messageHostId(hub.auth.publicKey), sourceBot: "source", targetBot: "target" }, guard);
  });
  afterEach(async () => { sockets.splice(0).forEach(s => s.terminate()); await hub.close(); await rm(dir, { recursive: true, force: true }); });
  async function worker(capabilities: string[]) {
    const peer = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(peer.ws);
    peer.send({ type: "instance.hello", botId: "target", secret, engine: "codex", model: "", effort: "", capabilities: ["bot-messages.v1", ...capabilities] }); await peer.next("instance.ready");
    return peer;
  }
  const local = (operation: string, data: Record<string, unknown>, conversation?: string, requestId = `r_${randomBytes(6).toString("hex")}`) =>
    hub.botMessages.local({ operation, host: messageHostId(hub.auth.publicKey), bot: "target", requestId, data, ...(conversation ? { conversation } : {}) }, "source", guard, true) as Promise<any>;

  it("asks an advertising worker for this conversation's run, then merges into it", async () => {
    const peer = await worker([BOT_MESSAGE_STEER_CAPABILITY]);
    const chat = await local("resolve", {});
    const task = await local("send", { text: "Long task", attachments: [] }, chat.conversationId);
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
    const sending = local("send", { text: "Correction", attachments: [], delivery: "steer" }, chat.conversationId);
    const status = await peer.next("instance.call", f => f.method === "botMessage.steer.status");
    expect(status.params).toEqual({ conversationId: chat.conversationId });
    peer.send({ type: "instance.result", id: status.id, result: { supported: true, targetId: "run_live", sourceMessageId: task.messageId, receiptEpoch: "rs_fixture_store" } });
    const steer = await peer.next("instance.call", f => f.method === "botMessage.steer");
    expect(steer.params).toMatchObject({ conversationId: chat.conversationId, userId: "owner", targetId: "run_live", sourceMessageId: task.messageId, text: "Correction", source: { botId: "source", hops: 1 } });
    peer.send({ type: "instance.result", id: steer.id, result: { outcome: "accepted", sourceMessageId: task.messageId } });
    expect(await sending).toMatchObject({ status: "steered", delivery: { actual: "steered", turn: { messageId: task.messageId } } });
    // The worker never receives the steered text as a new delivery.
    expect(peer.frames.some(f => f.type === "message" && JSON.stringify(f).includes("Correction"))).toBe(false);
  });

  it("never calls a worker that does not advertise the capability", async () => {
    const peer = await worker([]);
    const chat = await local("resolve", {});
    const task = await local("send", { text: "Long task", attachments: [] }, chat.conversationId);
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
    expect(await local("send", { text: "Correction", attachments: [], delivery: "steer" }, chat.conversationId)).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "worker_update_required" } });
    expect(peer.frames.some(f => f.type === "instance.call" && String(f.method).startsWith("botMessage."))).toBe(false);
  });

  it("treats a worker timeout during the merge as uncertain, never queued", async () => {
    const peer = await worker([BOT_MESSAGE_STEER_CAPABILITY]);
    const chat = await local("resolve", {});
    const task = await local("send", { text: "Long task", attachments: [] }, chat.conversationId);
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [task.messageId]);
    const sending = local("send", { text: "Correction", attachments: [], delivery: "steer" }, chat.conversationId);
    const status = await peer.next("instance.call", f => f.method === "botMessage.steer.status");
    peer.send({ type: "instance.result", id: status.id, result: { supported: true, targetId: "run_live", sourceMessageId: task.messageId, receiptEpoch: "rs_fixture_store" } });
    await peer.next("instance.call", f => f.method === "botMessage.steer");
    peer.ws.terminate();
    const receipt = await sending;
    expect(receipt).toMatchObject({ status: "uncertain", delivery: { actual: "steer_uncertain" } });
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [receipt.messageId])).toEqual([]);
    // A replacement Gateway process reads its journal: this steer never started.
    const replacement = await worker([BOT_MESSAGE_STEER_CAPABILITY]);
    const waiting = local("wait", { messageId: receipt.messageId }, chat.conversationId);
    const reconcile = await replacement.next("instance.call", f => f.method === "botMessage.steer.reconcile");
    expect(reconcile.params).toEqual({ conversationId: chat.conversationId, requestId: expect.stringMatching(/^bm_/), targetId: "run_live", sourceMessageId: task.messageId, receiptEpoch: "rs_fixture_store" });
    replacement.send({ type: "instance.result", id: reconcile.id, result: { outcome: "rejected", reason: "stale" } });
    expect(await waiting).toMatchObject({ status: "pending", delivery: { actual: "fell_back_to_queue", reason: "turn_ended" } });
    // Queued once and handed to the replacement worker straight away (review B1).
    await replacement.next("instance.message", f => f.message?.id === receipt.messageId, 3000);
    expect(await hub.store.db.all("SELECT status,dispatched FROM deliveries WHERE message_id=?", [receipt.messageId])).toEqual([{ status: "pending", dispatched: 1 }]);
  });
});
