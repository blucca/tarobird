// #53 Hub side: rewind/fork routes, receipts, dispatch hold and recovery.
// Synthetic data only; the Gateway is a scripted socket, never an engine.
import { randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer, type HubServerOptions } from "../src/hub/server.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { defaultForkTitle } from "../src/hub/history.js";
import { visibleRewindRanges } from "../src/hub/history-records.js";
import { CAPABILITIES, type Block, type Message } from "../src/client-protocol/index.js";
import { SNAPSHOT_ACTIVITY_CAPABILITY } from "../src/client-protocol/snapshot.js";
import { HISTORY_CAPABILITY, HISTORY_REWIND_RANGES_MAX, historyOperationSchema, historyStatusSchema, type RewindRange } from "../src/client-protocol/history.js";
import { deviceFields, enrollTrusted, loginFor, testDevice, type TestDevice } from "./helpers/pairing-invite.js";

type Frame = Record<string, any>;
class Peer {
  frames: Frame[] = [];
  constructor(readonly ws: WebSocket) { ws.on("message", raw => { const f = JSON.parse(raw.toString()); this.frames.push(f); if (f.type === "snapshot.message") this.send({ type: "snapshot.ack", id: f.id, count: Number(f.index) + 1 }); }); }
  static async connect(url: string) { const p = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { p.ws.once("open", r); p.ws.once("error", j); }); return p; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, pred: (f: Frame) => boolean = () => true, ms = 5000) { const until = Date.now() + ms; for (;;) { const i = this.frames.findIndex(f => f.type === type && pred(f)); if (i >= 0) return this.frames.splice(i, 1)[0]!; if (Date.now() > until) throw new Error("Missing " + type); await new Promise(r => setTimeout(r, 5)); } }
  calls(method: string) { return this.frames.filter(f => f.type === "instance.call" && f.method === method); }
  reply(call: Frame, result: unknown) { this.send({ type: "instance.result", id: call.id, result }); }
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, ms = 5000) { const end = Date.now() + ms; while (!await check()) { if (Date.now() > end) throw new Error("timed out"); await wait(10); } }

let dir: string, hub: HubServer, secret: string;
const sockets: WebSocket[] = [];
const fast = { rewindMs: 300, forkMs: 300, statusMs: 300, unknownAfterMs: 60_000 };
async function start(timings: HubServerOptions["historyTimings"] = fast) { hub = await HubServer.start({ stateDir: dir, historyTimings: timings }); }
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hub-history-")); await start();
  secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
});
afterEach(async () => { sockets.splice(0).forEach(s => s.terminate()); await hub.close(); await rm(dir, { recursive: true, force: true }); });

async function gateway(capabilities = [HISTORY_CAPABILITY]) {
  const peer = await Peer.connect(hub.instanceUrl.replace("http", "ws") + "/instance"); sockets.push(peer.ws);
  peer.send({ type: "instance.hello", botId: "alpha", secret, engine: "codex", model: "", effort: "", capabilities }); await peer.next("instance.ready");
  return peer;
}
async function login(device: TestDevice, userId = "owner") {
  await enrollTrusted(hub.auth, device, userId);
  const { token } = await loginFor(hub.auth, device);
  return { Authorization: `Bearer ${token}` };
}
/** An App socket, to observe ready and conversation.updated frames. */
async function app(device: TestDevice) {
  const peer = await Peer.connect(hub.url.replace("http", "ws") + "/ws"); sockets.push(peer.ws);
  const nonce = randomBytes(32).toString("base64url");
  peer.send({ type: "hello", deviceId: device.deviceId, nonce, protocolVersions: [1], capabilities: ["cards.v1"], cursors: {} });
  const challenge = await peer.next("challenge");
  peer.send({ type: "auth", signature: sign(null, deviceProof(device.deviceId, challenge.nonce, nonce), device.privateKey).toString("base64") });
  const ready = await peer.next("ready"); await peer.next("sync.complete");
  return { peer, ready };
}
const runCard = (startedAt: number): Block => ({ type: "card", elements: [{ type: "markdown", text: "answer" }], extra: { nativeRun: { version: 1, id: `run_${startedAt}`, revision: 2, phase: "done", startedAt, updatedAt: startedAt + 5, count: 0, completed: 0, failed: 0, truncated: false } } });
let clock = Date.now() - 1_000_000;
/** Settled turns: an accepted user input and the Bot's finished run card. */
async function turns(conversationId: string, texts: string[], userId = "owner") {
  const result: { input: Message; reply: Message }[] = [];
  for (const text of texts) {
    const { message: input } = await hub.store.sendMessage(userId, { conversationId, clientMsgId: `c_${randomBytes(6).toString("hex")}`, text, attachments: [] });
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [input.id]);
    const at = clock += 1000; await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [at, input.id]);
    const reply = await hub.store.publishBotMessage("alpha", { conversationId, blocks: [runCard(at + 10)], replyTo: input.id });
    await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [clock += 1000, reply.id]);
    result.push({ input: { ...input, createdAt: at }, reply: { ...reply, createdAt: clock } });
  }
  return result;
}
async function fixture(texts = ["first", "second", "third"]) {
  const device = testDevice("owner_dev"), headers = await login(device);
  const chat = await hub.store.createConversation("owner", ["alpha"], "Source chat", "direct");
  const seeded = await turns(chat.id, texts);
  return { device, headers, chat, seeded, last: seeded.at(-1)!.reply.id };
}
const api = (headers: Record<string, string>, route: string, body?: unknown) => fetch(`${hub.url}${route}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
async function json(response: Promise<Response> | Response) { const r = await response; return { status: r.status, body: await r.json() as any }; }
const rows = () => hub.store.db.all<{ request_id: string; state: string; error: string | null; kind: string }>("SELECT request_id,state,error,kind FROM conversation_history_ops ORDER BY rowid");

describe("capability advertisement", () => {
  it("adds history only to ready.serverCapabilities, never to the App hello list", async () => {
    expect(CAPABILITIES).not.toContain(HISTORY_CAPABILITY);
    expect([...CAPABILITIES, SNAPSHOT_ACTIVITY_CAPABILITY].length).toBeLessThanOrEqual(64);
    const device = testDevice("owner_dev"); await login(device);
    const { ready } = await app(device);
    expect(ready.serverCapabilities).toContain(HISTORY_CAPABILITY);
    expect(ready.serverCapabilities).toEqual(expect.arrayContaining([...CAPABILITIES]));
  });
});

describe("status", () => {
  it("reports unsupported for an older Gateway without calling it, and bot_offline without one", async () => {
    const { headers, chat, last, seeded } = await fixture();
    expect(await json(api(headers, `/api/conversations/${chat.id}/history?botId=alpha`))).toEqual({ status: 503, body: { error: "bot_offline" } });
    expect(await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "r_off", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last }))).toEqual({ status: 503, body: { error: "bot_offline" } });
    expect(await rows()).toEqual([]);
    const old = await gateway([]);
    expect(await json(api(headers, `/api/conversations/${chat.id}/history?botId=alpha`))).toEqual({ status: 200, body: { supported: false, rewind: "none", fork: "none", reason: "unsupported" } });
    const refused = await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "r_old", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last }));
    expect(refused.body).toMatchObject({ requestId: "r_old", kind: "rewind", state: "failed", error: "unsupported" });
    expect(old.frames.filter(f => f.type === "instance.call" && String(f.method).startsWith("history."))).toEqual([]);
  });
  it("merges the Gateway's answer with the Hub's own blocks, which win", async () => {
    const { headers, chat } = await fixture();
    // A paused queued input, sent before the Gateway attaches so it is never claimed.
    const { message: queued } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "queued_1", text: "later", attachments: [] });
    await hub.store.db.run("UPDATE deliveries SET queue_paused=1 WHERE message_id=?", [queued.id]);
    const bot = await gateway();
    const pending = json(api(headers, `/api/conversations/${chat.id}/history?botId=alpha`));
    const call = await bot.next("instance.call", f => f.method === "history.status");
    expect(call.params).toEqual({ conversationId: chat.id, userId: "owner" });
    bot.reply(call, { supported: true, rewind: "turn", fork: "turn", blocked: "goal_active", sinceMessageId: "msg_since" });
    expect(historyStatusSchema.parse((await pending).body)).toEqual({ supported: true, rewind: "turn", fork: "turn", blocked: "queued", sinceMessageId: "msg_since" });
    // Without a Hub-side block the Gateway's reason stands.
    await hub.store.db.run("UPDATE deliveries SET status='cancelled' WHERE message_id=?", [queued.id]);
    const second = json(api(headers, `/api/conversations/${chat.id}/history?botId=alpha`));
    bot.reply(await bot.next("instance.call", f => f.method === "history.status"), { supported: true, rewind: "none", fork: "head", blocked: "goal_active" });
    expect(await second).toEqual({ status: 200, body: { supported: true, rewind: "none", fork: "head", blocked: "goal_active" } });
  });
});

describe("rewind", () => {
  it("records the range after the engine answers, replays idempotently and refuses conflicts", async () => {
    const { device, headers, chat, seeded, last } = await fixture();
    const bot = await gateway(), { peer: watcher } = await app(device);
    const body = { botId: "alpha", requestId: "r_1", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last };
    const pending = json(api(headers, `/api/conversations/${chat.id}/history/rewind`, body));
    const call = await bot.next("instance.call", f => f.method === "history.rewind");
    expect(call.params).toEqual({ conversationId: chat.id, userId: "owner", requestId: "r_1", beforeMessageId: seeded[1]!.input.id,
      hints: { target: { sourceMessageId: seeded[1]!.input.id, text: "second", createdAt: seeded[1]!.input.createdAt, startedAt: seeded[1]!.input.createdAt + 10 } } });
    bot.reply(call, { ok: true });
    const done = await pending;
    expect(done.status).toBe(200);
    const range = { id: done.body.id, fromMessageId: seeded[1]!.input.id, fromCreatedAt: seeded[1]!.input.createdAt, throughMessageId: last, throughCreatedAt: seeded[2]!.reply.createdAt, at: expect.any(Number), by: "owner" };
    expect(historyOperationSchema.parse(done.body)).toEqual({ id: expect.stringMatching(/^hop_/), requestId: "r_1", kind: "rewind", state: "completed", rewind: range });
    const updated = await watcher.next("conversation.updated", f => f.conversation.id === chat.id && f.conversation.history);
    expect(updated.conversation.history).toEqual({ rewinds: [range] });
    expect((await hub.store.conversations("owner")).find(c => c.id === chat.id)?.history?.rewinds).toEqual([range]);

    // Same request: the stored receipt, no second engine call.
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, body))).body).toEqual({ ...done.body, replayed: true });
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/operations/r_1`))).body).toEqual(done.body);
    expect(await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { ...body, beforeMessageId: seeded[2]!.input.id }))).toEqual({ status: 409, body: { error: "idempotency_conflict" } });
    expect(await json(api(headers, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "r_1", expectedLastMessageId: last }))).toEqual({ status: 409, body: { error: "idempotency_conflict" } });

    // Inside the range: refused before any call.
    const inside = await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { ...body, requestId: "r_2", beforeMessageId: seeded[2]!.input.id }));
    expect(inside.body).toMatchObject({ state: "failed", error: "already_rewound" });
    expect(bot.calls("history.rewind")).toEqual([]);

    // A later rewind covering the first leaves one range.
    const wider = json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { ...body, requestId: "r_3", beforeMessageId: seeded[0]!.input.id }));
    bot.reply(await bot.next("instance.call", f => f.method === "history.rewind"), { ok: true, restarted: true });
    const widened = await wider;
    expect(widened.body).toMatchObject({ state: "completed", rewind: { fromMessageId: seeded[0]!.input.id, throughMessageId: last } });
    expect((await hub.store.conversations("owner")).find(c => c.id === chat.id)?.history).toEqual({ rewinds: [widened.body.rewind] });
  });
  it("refuses a busy conversation, a changed history and non-anchors with stored failed receipts", async () => {
    const { headers, chat, seeded, last } = await fixture();
    const bot = await gateway();
    const route = `/api/conversations/${chat.id}/history/rewind`, base = { botId: "alpha", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last };
    expect((await json(api(headers, route, { ...base, requestId: "stale", expectedLastMessageId: seeded[1]!.reply.id }))).body).toMatchObject({ state: "failed", error: "history_changed" });
    expect((await json(api(headers, route, { ...base, requestId: "botmsg", beforeMessageId: seeded[1]!.reply.id }))).body).toMatchObject({ state: "failed", error: "not_an_anchor" });
    // A command input is not a run start either.
    const [command] = await turns(chat.id, ["/compact"]);
    const lastNow = command!.reply.id;
    expect((await json(api(headers, route, { ...base, requestId: "cmd", beforeMessageId: command!.input.id, expectedLastMessageId: lastNow }))).body).toMatchObject({ state: "failed", error: "not_an_anchor" });
    // A streaming reply: busy.
    const streaming = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "…" }], status: "streaming" });
    expect((await json(api(headers, route, { ...base, requestId: "busy_1", expectedLastMessageId: streaming.id }))).body).toMatchObject({ state: "failed", error: "busy" });
    await hub.store.publishBotMessage("alpha", { id: streaming.id, conversationId: chat.id, blocks: [{ type: "text", text: "done" }], status: "complete" });
    // A dispatched (running) input: busy, and status says running.
    const { message: running } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "run_1", text: "go", attachments: [] });
    await bot.next("instance.message", f => f.message.id === running.id);
    expect((await json(api(headers, route, { ...base, requestId: "busy_2", expectedLastMessageId: running.id }))).body).toMatchObject({ state: "failed", error: "busy" });
    const status = json(api(headers, `/api/conversations/${chat.id}/history?botId=alpha`));
    bot.reply(await bot.next("instance.call", f => f.method === "history.status"), { supported: true, rewind: "turn", fork: "turn" });
    expect((await status).body).toMatchObject({ blocked: "running" });
    expect(bot.calls("history.rewind")).toEqual([]);
    // Each refusal is a stored receipt: the same request answers the same.
    expect((await json(api(headers, route, { ...base, requestId: "stale", expectedLastMessageId: seeded[1]!.reply.id }))).body).toMatchObject({ state: "failed", error: "history_changed", replayed: true });
    expect((await rows()).every(row => row.state === "failed")).toBe(true);
  });
  it("allows one started operation per conversation; a second device gets busy", async () => {
    const { headers, chat, seeded, last } = await fixture();
    const bot = await gateway(), second = await login(testDevice("second_dev"));
    const first = json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "a_1", beforeMessageId: seeded[2]!.input.id, expectedLastMessageId: last }));
    const call = await bot.next("instance.call", f => f.method === "history.rewind");
    const other = await json(api(second, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "b_1", expectedLastMessageId: last }));
    expect(other.body).toMatchObject({ kind: "fork", state: "failed", error: "busy" });
    const status = json(api(second, `/api/conversations/${chat.id}/history?botId=alpha`));
    bot.reply(await bot.next("instance.call", f => f.method === "history.status"), { supported: true, rewind: "turn", fork: "turn" });
    expect((await status).body).toMatchObject({ blocked: "operation_active", operation: { requestId: "a_1", kind: "rewind", state: "started" } });
    bot.reply(call, { ok: true });
    expect((await first).body).toMatchObject({ state: "completed" });
  });
  it("maps explicit Gateway refusals and interruption", async () => {
    const { headers, chat, seeded, last } = await fixture();
    const bot = await gateway();
    const refused = json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "x_1", beforeMessageId: seeded[2]!.input.id, expectedLastMessageId: last }));
    bot.reply(await bot.next("instance.call", f => f.method === "history.rewind"), { ok: false, error: "turn_unresolved" });
    expect((await refused).body).toMatchObject({ state: "failed", error: "turn_unresolved" });
    const interrupted = json(api(headers, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "x_2", throughMessageId: seeded[0]!.input.id, expectedLastMessageId: last }));
    bot.reply(await bot.next("instance.call", f => f.method === "history.fork"), { ok: false, error: "operation_interrupted" });
    expect((await interrupted).body).toMatchObject({ kind: "fork", state: "failed", error: "uncertain" });
    expect((await hub.store.conversations("owner")).map(c => c.id)).toEqual([chat.id]);
    expect((await hub.store.conversations("owner"))[0]!.history).toBeUndefined();
  });
});

describe("fork", () => {
  it("creates the reserved conversation with its origin and replays it", async () => {
    const { device, headers, chat, seeded, last } = await fixture();
    const bot = await gateway(), { peer: watcher } = await app(device);
    const body = { botId: "alpha", requestId: "f_1", throughMessageId: seeded[0]!.input.id, expectedLastMessageId: last };
    const pending = json(api(headers, `/api/conversations/${chat.id}/history/fork`, body));
    const call = await bot.next("instance.call", f => f.method === "history.fork");
    const reserved = call.params.targetConversationId as string;
    expect(reserved).toMatch(/^gw_/);
    expect(call.params).toEqual({ conversationId: chat.id, userId: "owner", requestId: "f_1", targetConversationId: reserved, throughMessageId: seeded[0]!.input.id,
      hints: { target: { sourceMessageId: seeded[0]!.input.id, text: "first", createdAt: seeded[0]!.input.createdAt, startedAt: seeded[0]!.input.createdAt + 10 },
        next: { sourceMessageId: seeded[1]!.input.id, text: "second", createdAt: seeded[1]!.input.createdAt, startedAt: seeded[1]!.input.createdAt + 10 } } });
    bot.reply(call, { ok: true, mode: "turn" });
    const done = await pending;
    expect(done.body).toEqual({ id: expect.stringMatching(/^hop_/), requestId: "f_1", kind: "fork", state: "completed", conversationId: reserved });
    const created = (await hub.store.conversations("owner")).find(c => c.id === reserved)!;
    expect(created).toMatchObject({ type: "direct", title: "Source chat · 分叉", botIds: ["alpha"], archived: false,
      history: { forkedFrom: { opId: done.body.id, conversationId: chat.id, title: "Source chat", mode: "turn", throughMessageId: seeded[0]!.input.id, excerpt: "first", at: expect.any(Number) } } });
    expect(created.sessionId).toBeUndefined(); expect(created.bindingId).toBeUndefined();
    expect((await watcher.next("conversation.updated", f => f.conversation.id === reserved)).conversation.history.forkedFrom.mode).toBe("turn");
    // The source is unchanged; a replay neither calls nor creates again.
    expect((await hub.store.conversations("owner")).find(c => c.id === chat.id)?.history).toBeUndefined();
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/fork`, body))).body).toEqual({ ...done.body, replayed: true });
    expect(bot.calls("history.fork")).toEqual([]);
    expect((await hub.store.conversations("owner")).length).toBe(2);

    // A head fork with its own title carries no anchor.
    const head = json(api(headers, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "f_2", expectedLastMessageId: last, title: "Try another way" }));
    const headCall = await bot.next("instance.call", f => f.method === "history.fork");
    expect(headCall.params.throughMessageId).toBeUndefined(); expect(headCall.params.hints).toBeUndefined();
    bot.reply(headCall, { ok: true, mode: "head" });
    const headDone = await head;
    expect((await hub.store.conversations("owner")).find(c => c.id === headDone.body.conversationId)).toMatchObject({ title: "Try another way", history: { forkedFrom: { mode: "head", excerpt: "", title: "Source chat" } } });
    expect((await hub.store.conversations("owner")).find(c => c.id === headDone.body.conversationId)?.history?.forkedFrom?.throughMessageId).toBeUndefined();
  });
  it("keeps the default title within 256 units", () => {
    expect(defaultForkTitle("A")).toBe("A · 分叉");
    const long = defaultForkTitle("长".repeat(300)); expect(long.length).toBe(256); expect(long.endsWith(" · 分叉")).toBe(true);
    const astral = defaultForkTitle("😀".repeat(200)); expect(astral.length).toBeLessThanOrEqual(256); expect(astral).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("no answer", () => {
  it("keeps started, holds dispatch, resends on reconnect and then dispatches", async () => {
    const { headers, chat, seeded, last } = await fixture();
    let bot = await gateway();
    const body = { botId: "alpha", requestId: "n_1", beforeMessageId: seeded[2]!.input.id, expectedLastMessageId: last };
    const pending = json(api(headers, `/api/conversations/${chat.id}/history/rewind`, body));
    await bot.next("instance.call", f => f.method === "history.rewind");
    // No answer within the call limit: the receipt says started.
    expect((await pending).body).toMatchObject({ requestId: "n_1", state: "started" });
    // Sending still works; the input is only held.
    const { message: held } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "held_1", text: "meanwhile", attachments: [] });
    await wait(150);
    expect(bot.frames.some(f => f.type === "instance.message" && f.message.id === held.id)).toBe(false);
    expect(await new HubPromptQueue(hub.store).take("alpha", chat.id, () => true)).toBeUndefined();
    // The Hub resends with the same requestId while the Gateway is connected.
    const again = await bot.next("instance.call", f => f.method === "history.rewind");
    expect(again.params.requestId).toBe("n_1");
    bot.ws.terminate(); await until(async () => (await hub.store.bots("owner"))[0]!.online === 0);
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/operations/n_1`))).body).toMatchObject({ state: "started" });
    bot = await gateway();
    const resent = await bot.next("instance.call", f => f.method === "history.rewind");
    expect(resent.params).toMatchObject({ requestId: "n_1", beforeMessageId: seeded[2]!.input.id });
    bot.reply(resent, { ok: true });
    await until(async () => (await json(api(headers, `/api/conversations/${chat.id}/history/operations/n_1`))).body.state === "completed");
    // Its range stops at the message that was last when the rewind started.
    expect((await hub.store.conversations("owner"))[0]!.history?.rewinds?.[0]).toMatchObject({ throughMessageId: last });
    await bot.next("instance.message", f => f.message.id === held.id);
  });
  it("becomes unknown after the expiry, releases dispatch and can be asked again", async () => {
    await hub.close(); await start({ ...fast, unknownAfterMs: 1200 });
    const { headers, chat, seeded, last } = await fixture();
    const bot = await gateway();
    const body = { botId: "alpha", requestId: "u_1", throughMessageId: seeded[1]!.input.id, expectedLastMessageId: last };
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/fork`, body))).body).toMatchObject({ state: "started" });
    const { message: held } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "held_2", text: "meanwhile", attachments: [] });
    await until(async () => (await json(api(headers, `/api/conversations/${chat.id}/history/operations/u_1`))).body.state === "unknown", 5000);
    await bot.next("instance.message", f => f.message.id === held.id);
    // Let the send that was in flight at expiry run out.
    await wait(450);
    // While that input runs, the same request stays unknown.
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/fork`, body))).body).toMatchObject({ state: "unknown", replayed: true });
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [held.id]);
    bot.frames.length = 0;
    const retried = json(api(headers, `/api/conversations/${chat.id}/history/fork`, body));
    const call = await bot.next("instance.call", f => f.method === "history.fork");
    expect(call.params.requestId).toBe("u_1");
    bot.reply(call, { ok: true, mode: "turn" });
    const done = await retried;
    expect(done.body).toMatchObject({ state: "completed", replayed: true, conversationId: call.params.targetConversationId });
  });
  it("an unknown rewind retried later marks through the messages sent meanwhile", async () => {
    await hub.close(); await start({ ...fast, unknownAfterMs: 1200 });
    const { headers, chat, seeded, last } = await fixture();
    const bot = await gateway();
    const body = { botId: "alpha", requestId: "u_r", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last };
    expect((await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, body))).body).toMatchObject({ state: "started" });
    const { message: later } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "later_r", text: "kept chatting", attachments: [] });
    await until(async () => (await json(api(headers, `/api/conversations/${chat.id}/history/operations/u_r`))).body.state === "unknown", 5000);
    await bot.next("instance.message", f => f.message.id === later.id);
    await wait(450);
    await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=?", [later.id]);
    bot.frames.length = 0;
    const retried = json(api(headers, `/api/conversations/${chat.id}/history/rewind`, body));
    const call = await bot.next("instance.call", f => f.method === "history.rewind");
    bot.reply(call, { ok: true });
    expect((await retried).body).toMatchObject({ state: "completed", replayed: true, rewind: { throughMessageId: later.id } });
  });
  it("re-drives started operations after a Hub restart", async () => {
    const { headers, chat, seeded, last } = await fixture();
    let bot = await gateway();
    const rewind = json(api(headers, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "s_1", throughMessageId: seeded[0]!.input.id, expectedLastMessageId: last }));
    const before = await bot.next("instance.call", f => f.method === "history.fork");
    expect((await rewind).body).toMatchObject({ state: "started" });
    sockets.splice(0).forEach(s => s.terminate());
    await hub.close(); await start();
    expect((await rows()).map(row => row.state)).toEqual(["started"]);
    // Dispatch stays held across the restart.
    const { message: held } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "held_3", text: "after restart", attachments: [] });
    expect(await new HubPromptQueue(hub.store).claim("alpha", false, true)).toEqual([]);
    bot = await gateway();
    const call = await bot.next("instance.call", f => f.method === "history.fork");
    expect(call.params).toEqual(before.params);
    bot.reply(call, { ok: true, mode: "turn" });
    await until(async () => (await rows())[0]!.state === "completed");
    expect((await hub.store.conversations("owner")).some(c => c.id === before.params.targetConversationId)).toBe(true);
    await bot.next("instance.message", f => f.message.id === held.id);
  });
});

describe("permissions and scope", () => {
  it("requires membership, a member's Bot grant to fork, and the side-question scope", async () => {
    const { headers, chat, last } = await fixture();
    const bot = await gateway();
    await hub.store.db.run("INSERT INTO users VALUES('member','Member','member')");
    const memberDevice = testDevice("member_dev"), member = await login(memberDevice, "member");
    // Not a member of the owner's chat.
    expect(await json(api(member, `/api/conversations/${chat.id}/history?botId=alpha`))).toEqual({ status: 403, body: { error: "conversation_forbidden" } });
    expect(await json(api(member, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "m_1", expectedLastMessageId: last }))).toEqual({ status: 403, body: { error: "conversation_forbidden" } });
    // A member's own chat: rewind is membership, fork also needs the Bot grant.
    await hub.store.db.run("INSERT INTO bot_grants VALUES('member','alpha')");
    const own = await hub.store.createConversation("member", ["alpha"], "Mine", "mine");
    const [turn] = await turns(own.id, ["hello"], "member");
    await hub.store.db.run("DELETE FROM bot_grants WHERE user_id='member'");
    expect(await json(api(member, `/api/conversations/${own.id}/history/fork`, { botId: "alpha", requestId: "m_2", expectedLastMessageId: turn!.reply.id }))).toEqual({ status: 403, body: { error: "bot_forbidden" } });
    const rewind = json(api(member, `/api/conversations/${own.id}/history/rewind`, { botId: "alpha", requestId: "m_3", beforeMessageId: turn!.input.id, expectedLastMessageId: turn!.reply.id }));
    bot.reply(await bot.next("instance.call", f => f.method === "history.rewind"), { ok: true });
    expect((await rewind).body).toMatchObject({ state: "completed" });
    const status = json(api(member, `/api/conversations/${own.id}/history?botId=alpha`));
    bot.reply(await bot.next("instance.call", f => f.method === "history.status"), { supported: true, rewind: "turn", fork: "turn" });
    expect((await status).body).toMatchObject({ supported: true, rewind: "turn", fork: "none" });
    // A Bot that is not in the conversation.
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('beta','Beta','x')");
    expect(await json(api(headers, `/api/conversations/${chat.id}/history?botId=beta`))).toEqual({ status: 403, body: { error: "bot_forbidden" } });

    const reason = async (id: string) => (await json(api(headers, `/api/conversations/${id}/history?botId=alpha`))).body;
    await hub.store.db.run("UPDATE conversations SET archived=1 WHERE id=?", [chat.id]);
    expect(await reason(chat.id)).toEqual({ supported: false, rewind: "none", fork: "none", reason: "archived" });
    expect(await json(api(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "o_1", beforeMessageId: turn!.input.id, expectedLastMessageId: last }))).toEqual({ status: 409, body: { error: "history_unavailable" } });
    await hub.store.db.run("UPDATE conversations SET archived=0,hidden=1 WHERE id=?", [chat.id]);
    expect(await reason(chat.id)).toMatchObject({ supported: false, reason: "dispatcher" });
    await hub.store.db.run("UPDATE conversations SET hidden=0 WHERE id=?", [chat.id]);
    await hub.store.db.run("UPDATE bots SET role='dispatcher' WHERE id='alpha'");
    expect(await reason(chat.id)).toMatchObject({ supported: false, reason: "dispatcher" });
    await hub.store.db.run("UPDATE bots SET role='' WHERE id='alpha'");
    const group = await hub.store.createConversation("owner", ["alpha", "beta"], "Group", "group");
    expect(await reason(group.id)).toEqual({ supported: false, rewind: "none", fork: "none", reason: "conversation_kind" });
    expect(await json(api(headers, `/api/conversations/${group.id}/history/fork`, { botId: "alpha", requestId: "g_1", expectedLastMessageId: last }))).toEqual({ status: 409, body: { error: "history_unavailable" } });
    expect(bot.calls("history.status")).toEqual([]);
  });
  it("is not reachable with a Bot message passport", async () => {
    const { chat } = await fixture();
    const passport = Buffer.from(JSON.stringify({ passport: {}, signature: "" })).toString("base64url");
    const response = await fetch(`${hub.url}/api/conversations/${chat.id}/history/rewind`, { method: "POST", headers: { "x-tarobot-message-passport": passport }, body: "{}" });
    expect(response.status).toBe(403);
    expect(await rows()).toEqual([]);
  });
});

describe("dispatch hold and ranges", () => {
  it("claims nothing for a conversation with a started operation, until it ends", async () => {
    const chat = await hub.store.createConversation("owner", ["alpha"], "Direct", "direct");
    const other = await hub.store.createConversation("owner", ["alpha"], "Other", "other");
    await hub.store.db.run("INSERT INTO conversation_history_ops(id,user_id,request_id,payload_hash,conversation_id,bot_id,kind,state,created_at,updated_at) VALUES('hop_q','owner','q','x',?,'alpha','rewind','started',1,1)", [chat.id]);
    const { message } = await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "q_1", text: "held", attachments: [] });
    const { message: free } = await hub.store.sendMessage("owner", { conversationId: other.id, clientMsgId: "q_2", text: "free", attachments: [] });
    const queue = new HubPromptQueue(hub.store);
    expect((await queue.claim("alpha", false, false)).map(m => m.id)).toEqual([free.id]);
    expect(await queue.take("alpha", chat.id, () => true)).toBeUndefined();
    await hub.store.db.run("UPDATE conversation_history_ops SET state='unknown' WHERE id='hop_q'");
    expect((await queue.claim("alpha", false, false)).map(m => m.id)).toEqual([message.id]);
  });
  it("drops ranges covered by a later one and caps the list", () => {
    const range = (n: number, from: number, through: number): RewindRange => ({ id: `hop_${n}`, fromMessageId: `msg_${from}`, fromCreatedAt: from, throughMessageId: `msg_${through}`, throughCreatedAt: through, at: n, by: "owner" });
    expect(visibleRewindRanges([range(1, 20, 30), range(2, 10, 40)]).map(r => r.id)).toEqual(["hop_2"]);
    // A later, narrower range does not hide an earlier wider one.
    expect(visibleRewindRanges([range(1, 10, 40), range(2, 20, 30)]).map(r => r.id)).toEqual(["hop_1", "hop_2"]);
    const many = Array.from({ length: HISTORY_REWIND_RANGES_MAX + 6 }, (_, i) => range(i, i * 10, i * 10 + 5));
    const visible = visibleRewindRanges(many);
    expect(visible.length).toBe(HISTORY_REWIND_RANGES_MAX); expect(visible[0]!.id).toBe("hop_6");
  });
});
