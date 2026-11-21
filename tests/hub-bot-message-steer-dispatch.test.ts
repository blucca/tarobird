// Review B1 (issue #62): a steer that falls back to the queue after its record
// exists must reach the worker without waiting for an unrelated Host event.
// Adapted from the semantics reviewer's probes (probe-fallback-dispatch / probe-pull).
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
  frames: Frame[] = []; seen: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on("message", raw => { const f = JSON.parse(raw.toString()); this.frames.push(f); this.seen.push(f); }); }
  static async connect(url: string) { const p = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { p.ws.once("open", r); p.ws.once("error", j); }); return p; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, pred: (f: Frame) => boolean = () => true, ms = 5000) { const until = Date.now() + ms; for (;;) { const i = this.frames.findIndex(f => f.type === type && pred(f)); if (i >= 0) return this.frames.splice(i, 1)[0]!; if (Date.now() > until) throw new Error("Missing " + type); await new Promise(r => setTimeout(r, 5)); } }
  async request(method: string, params: unknown) { const id = `rq_${randomBytes(6).toString("hex")}`; this.send({ type: "instance.request", id, method, params }); return this.next("instance.result", f => f.id === id); }
}

describe("a fallen-back steer reaches the worker (B1)", () => {
  let dir: string, hub: HubServer; const sockets: WebSocket[] = [];
  const guard = async () => undefined, secret = randomBytes(32).toString("base64url");
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bot-steer-dispatch-")); hub = await HubServer.start({ stateDir: dir });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('source','Source',?,'claude'),('target','Target',?,'codex')", [hashSecret("unused-".repeat(8)), hashSecret(secret)]);
    await hub.botMessages.grant({ sourceHost: messageHostId(hub.auth.publicKey), sourceBot: "source", targetBot: "target" }, guard);
  });
  afterEach(async () => { sockets.splice(0).forEach(s => s.terminate()); await hub.close(); await rm(dir, { recursive: true, force: true }); });
  async function worker(capabilities: string[]) {
    const peer = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(peer.ws);
    peer.send({ type: "instance.hello", botId: "target", secret, engine: "codex", model: "", effort: "", capabilities: ["bot-messages.v1", BOT_MESSAGE_STEER_CAPABILITY, ...capabilities] }); await peer.next("instance.ready");
    return peer;
  }
  const local = (operation: string, data: Record<string, unknown>, conversation?: string, requestId = `r_${randomBytes(6).toString("hex")}`) =>
    hub.botMessages.local({ operation, host: messageHostId(hub.auth.publicKey), bot: "target", requestId, data, ...(conversation ? { conversation } : {}) }, "source", guard, true) as Promise<any>;
  const answerStatus = async (peer: Peer, sourceMessageId: string) => {
    const status = await peer.next("instance.call", f => f.method === "botMessage.steer.status");
    peer.send({ type: "instance.result", id: status.id, result: { supported: true, targetId: "run_live", sourceMessageId, receiptEpoch: "rs_fixture_store" } });
    return peer.next("instance.call", f => f.method === "botMessage.steer");
  };

  it("push worker: the turn is acknowledged, then the steer is refused — the queued record is delivered at once", async () => {
    const peer = await worker([]);
    const chat = await local("resolve", {});
    const task = await local("send", { text: "Long task", attachments: [] }, chat.conversationId);
    await peer.next("instance.message", f => f.message?.id === task.messageId);
    const sending = local("send", { text: "LateCorrection", attachments: [], delivery: "steer" }, chat.conversationId);
    const steer = await answerStatus(peer, task.messageId);
    expect((await peer.request("ack", { messageId: task.messageId })).error).toBeUndefined();
    peer.send({ type: "instance.result", id: steer.id, result: { outcome: "rejected", reason: "stale" } });
    const receipt = await sending;
    expect(receipt).toMatchObject({ status: "queued", delivery: { actual: "fell_back_to_queue", reason: "turn_ended" } });
    // No unrelated event: the fallback itself must dispatch.
    const delivered = await peer.next("instance.message", f => f.message?.id === receipt.messageId, 2000);
    expect(JSON.stringify(delivered)).toContain("LateCorrection");
    expect(await hub.store.db.all("SELECT status,dispatched FROM deliveries WHERE message_id=?", [receipt.messageId])).toEqual([{ status: "pending", dispatched: 1 }]);
  }, 20_000);

  it("pull worker: after its post-turn take came back empty, the fallback announces the conversation again", async () => {
    const peer = await worker(["prompt-queue.v1", "prompt-queue.pull.v1"]);
    const chat = await local("resolve", {});
    const task = await local("send", { text: "Long task", attachments: [] }, chat.conversationId);
    await peer.next("instance.queue", f => f.conversationId === chat.conversationId);
    expect((await peer.request("queue.take", { conversationId: chat.conversationId })).result?.message?.id).toBe(task.messageId);
    const sending = local("send", { text: "LateCorrection", attachments: [], delivery: "steer" }, chat.conversationId);
    const steer = await answerStatus(peer, task.messageId);
    await peer.request("ack", { messageId: task.messageId });
    expect((await peer.request("queue.take", { conversationId: chat.conversationId })).result ?? null).toBeNull();
    peer.send({ type: "instance.result", id: steer.id, result: { outcome: "rejected", reason: "stale" } });
    const receipt = await sending;
    expect(receipt.delivery.actual).toBe("fell_back_to_queue");
    await peer.next("instance.queue", f => f.conversationId === chat.conversationId, 2000);
    expect((await peer.request("queue.take", { conversationId: chat.conversationId })).result?.message?.id).toBe(receipt.messageId);
  }, 20_000);

  it("a refusal learned later by reconciliation is delivered as soon as it is queued", async () => {
    const peer = await worker([]);
    const chat = await local("resolve", {});
    const task = await local("send", { text: "Long task", attachments: [] }, chat.conversationId);
    await peer.next("instance.message", f => f.message?.id === task.messageId);
    const sending = local("send", { text: "Reconciled", attachments: [], delivery: "steer" }, chat.conversationId);
    await answerStatus(peer, task.messageId);
    await peer.request("ack", { messageId: task.messageId });
    // The Hub's call is lost with the socket; a new worker process attaches.
    peer.ws.terminate();
    const receipt = await sending;
    expect(receipt.delivery).toMatchObject({ actual: "pending", reason: "steer_unconfirmed" });
    const replacement = await worker([]);
    const reconcile = await replacement.next("instance.call", f => f.method === "botMessage.steer.reconcile");
    replacement.send({ type: "instance.result", id: reconcile.id, result: { outcome: "rejected", reason: "stale" } });
    await replacement.next("instance.message", f => f.message?.id === receipt.messageId, 3000);
  }, 20_000);
});
