// #53 across the Hub ⇄ Gateway seam: a real HubServer sends its own
// history.* calls over the instance socket; a real gatewayHistory handler
// (Bridge, session store, ledger, receipts) answers them. Only the engine is a
// stub: an in-memory thread whose older-run matching is the real
// resolveCodexHistoryAnchor. Synthetic data; no engine, no real Hub.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HISTORY_CAPABILITY, type EngineHistoryAnchor } from "../src/client-protocol/history.js";
import type { Block, Message } from "../src/client-protocol/index.js";
import { EngineHistoryUnconfirmedError, type CodexAdapter } from "../src/codex/adapter.js";
import { resolveCodexHistoryAnchor, type CodexHistoryTurn } from "../src/codex/app-server-adapter.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../src/core/message-normalizer.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { gatewayHistory } from "../src/gateway/history.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer, type HubServerOptions } from "../src/hub/server.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { findHistoryLedgerRun, readHistoryLedger } from "../src/runtime/history-ledger.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";

type Frame = Record<string, any>;
const access = { load: vi.fn(), issuePairingCode: vi.fn() } as unknown as AccessStoreLike;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const SID = "thr-seam";

/** The engine: one thread of user turns. */
class FakeThread {
  turns: CodexHistoryTurn[] = [];
  rewindError: string | undefined;
  /** Thrown after the change was applied: an answer that does not tell. */
  afterRevert: Error[] = [];
  created = 0;
  add(id: string, startedAtMs: number, text: string) { this.turns.push({ id, startedAt: Math.floor(startedAtMs / 1000), userMessage: true, clientId: null, text: `[host guidance]\n${text}` }); }
  has(id: string) { return this.turns.some(turn => turn.id === id); }
}

let hubDir: string, gwDir: string, hub: HubServer, secret: string, socket: WebSocket | undefined;
async function start(timings: HubServerOptions["historyTimings"] = { rewindMs: 2000, forkMs: 2000, statusMs: 2000, unknownAfterMs: 60_000 }) { hub = await HubServer.start({ stateDir: hubDir, historyTimings: timings }); }
beforeEach(async () => {
  hubDir = await mkdtemp(path.join(os.tmpdir(), "history-seam-hub-"));
  gwDir = await mkdtemp(path.join(os.tmpdir(), "history-seam-gw-"));
  await writeFile(path.join(gwDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  await start();
  secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
});
afterEach(async () => { socket?.terminate(); socket = undefined; await hub.close(); await rm(hubDir, { recursive: true, force: true }); await rm(gwDir, { recursive: true, force: true }); });

/** A Gateway socket whose history.* calls are answered by the real handler. */
async function gateway(conversationId: string, thread: FakeThread) {
  const adapter = {
    createSession: vi.fn(), sendUserMessage: vi.fn(),
    historyCapability: vi.fn(async () => ({ rewind: "turn", fork: "turn" })),
    getThreadGoal: vi.fn(async () => ({ goal: null })),
    resolveHistoryAnchor: vi.fn(async (_sid: string, input: Parameters<typeof resolveCodexHistoryAnchor>[1]) => resolveCodexHistoryAnchor(thread.turns, input)),
    // The adapter's contract: gone already → reverted: false, no record;
    // otherwise the caller's record, then the engine change.
    rewindSession: vi.fn(async (sessionId: string, input: { anchor: EngineHistoryAnchor; beforeRevert?: () => Promise<void> }) => {
      const index = thread.turns.findIndex(turn => turn.id === input.anchor.firstTurnId);
      if (index < 0) return { sessionId, reverted: false };
      await input.beforeRevert?.();
      if (thread.rewindError) throw new Error(thread.rewindError);
      thread.turns.splice(index);
      const after = thread.afterRevert.shift();
      if (after) throw after;
      return { sessionId, reverted: true };
    }),
    forkSession: vi.fn(async () => ({ sessionId: "thr-forked" })),
  } as unknown as CodexAdapter & Record<"resolveHistoryAnchor" | "rewindSession" | "forkSession", ReturnType<typeof vi.fn>>;
  const store = new SessionStore(path.join(gwDir, "session.json"));
  const key = buildCoreConversationKey(conversationId);
  await store.upsert({ telegramChatId: stableCoreNumericId(key), conversationKey: key, codexSessionId: SID, status: "idle", updatedAt: new Date(0).toISOString() });
  const bridge = new Bridge(access, new SessionManager(store, adapter), adapter).createAuthenticatedSurface();
  const handler = gatewayHistory({ bridge, runtime: createCoreServiceRuntime(), stateDir: gwDir, bindingReady: async () => true });
  const calls: { method: string; params: any; result?: unknown; error?: string }[] = [];
  /** While set, answers are computed but never sent (a lost reply). */
  const lose = { replies: false };
  const ws = new WebSocket(hub.instanceUrl.replace("http", "ws") + "/instance"); socket = ws;
  const frames: Frame[] = [];
  const send = (frame: object) => ws.send(JSON.stringify({ v: 1, ...frame }));
  ws.on("message", raw => {
    const frame = JSON.parse(raw.toString()) as Frame;
    frames.push(frame);
    if (frame.type !== "instance.call" || !String(frame.method).startsWith("history.")) return;
    const call: (typeof calls)[number] = { method: frame.method, params: frame.params };
    calls.push(call);
    // Exactly what the Gateway transport does: a thrown handler is an error frame.
    void handler(frame.method, frame.params).then(
      result => { call.result = result; if (!lose.replies) send({ type: "instance.result", id: frame.id, result: result ?? null }); },
      error => { call.error = String(error); send({ type: "instance.result", id: frame.id, error: "gateway_call_failed" }); });
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  send({ type: "instance.hello", botId: "alpha", secret, engine: "codex", model: "", effort: "", capabilities: [HISTORY_CAPABILITY] });
  for (let i = 0; !frames.some(f => f.type === "instance.ready"); i++) { if (i > 500) throw new Error("no ready"); await wait(5); }
  return { adapter, calls, key, frames, lose };
}

const runCard = (startedAt: number): Block => ({ type: "card", elements: [{ type: "markdown", text: "answer" }], extra: { nativeRun: { version: 1, id: `run_${startedAt}`, revision: 2, phase: "done", startedAt, updatedAt: startedAt + 5, count: 0, completed: 0, failed: 0, truncated: false } } });
let clock = Date.now() - 3_600_000;
/** Settled Hub turns, each also a turn of the engine thread (no ledger line: older runs). */
async function turns(conversationId: string, thread: FakeThread, texts: string[]) {
  const result: { input: Message; reply: Message; turnId: string }[] = [];
  for (const text of texts) {
    const { message: input } = await hub.store.sendMessage("owner", { conversationId, clientMsgId: `c_${randomBytes(6).toString("hex")}`, text, attachments: [] });
    await hub.store.db.run("UPDATE deliveries SET status='accepted',dispatched=1 WHERE message_id=?", [input.id]);
    const at = clock += 60_000; await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [at, input.id]);
    const reply = await hub.store.publishBotMessage("alpha", { conversationId, blocks: [runCard(at + 1000)], replyTo: input.id });
    await hub.store.db.run("UPDATE messages SET created_at=? WHERE id=?", [clock += 5000, reply.id]);
    // Turn ids are never reused, also after a rewind.
    const turnId = `t${++thread.created}`;
    thread.add(turnId, at + 2000, text);
    result.push({ input: { ...input, createdAt: at }, reply: { ...reply, createdAt: clock }, turnId });
  }
  return result;
}
async function fixture(texts: string[]) {
  const device = testDevice("owner_dev"); await enrollTrusted(hub.auth, device, "owner");
  const headers = { Authorization: `Bearer ${(await loginFor(hub.auth, device)).token}` };
  const chat = await hub.store.createConversation("owner", ["alpha"], "Seam chat", "direct");
  const thread = new FakeThread();
  const seeded = await turns(chat.id, thread, texts);
  return { headers, chat, thread, seeded };
}
const post = async (headers: Record<string, string>, route: string, body: unknown) => {
  const response = await fetch(`${hub.url}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const lastId = async (conversationId: string) => (await hub.store.db.get<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1", [conversationId]))!.id;

describe("Hub calls answered by the real Gateway handler (#53)", () => {
  it("a failed rewind of an older run leaves an anchor that a later fork can trust", async () => {
    const { headers, chat, thread, seeded } = await fixture(["first question", "second question", "third question"]);
    const gw = await gateway(chat.id, thread);
    thread.rewindError = "engine_busy";
    const rewind = await post(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "s_rw", beforeMessageId: seeded[0]!.input.id, expectedLastMessageId: await lastId(chat.id) });
    expect(rewind.body).toMatchObject({ state: "failed", error: "engine_busy" });
    // The matched run ends before the next run, not at the thread's tail.
    expect(findHistoryLedgerRun(await readHistoryLedger(gwDir, gw.key), seeded[0]!.input.id)?.last.anchor).toEqual({ firstTurnId: "t1", lastTurnId: "t1" });
    const fork = await post(headers, `/api/conversations/${chat.id}/history/fork`, { botId: "alpha", requestId: "s_fk", throughMessageId: seeded[0]!.input.id, expectedLastMessageId: await lastId(chat.id) });
    expect(fork.body).toMatchObject({ state: "completed" });
    expect(gw.adapter.forkSession).toHaveBeenCalledWith(SID, expect.objectContaining({ through: { lastTurnId: "t1" } }));
    // Every call the Hub made was accepted by the Gateway's strict schemas.
    expect(gw.calls.map(call => [call.method, call.error])).toEqual([["history.rewind", undefined], ["history.fork", undefined]]);
  });

  it("a rewind whose answer was lost, retried after later chat, keeps its confirmed range", async () => {
    await hub.close(); await start({ rewindMs: 300, forkMs: 300, statusMs: 300, unknownAfterMs: 1200 });
    const { headers, chat, thread, seeded } = await fixture(["first question", "second question", "third question"]);
    const gw = await gateway(chat.id, thread);
    const last = await lastId(chat.id);
    gw.lose.replies = true;
    const body = { botId: "alpha", requestId: "s_lost", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last };
    expect((await post(headers, `/api/conversations/${chat.id}/history/rewind`, body)).body).toMatchObject({ state: "started" });
    // The Gateway rewound the engine; no answer reached the Hub.
    await vi.waitFor(() => expect(thread.turns.map(turn => turn.id)).toEqual(["t1"]));
    const status = async () => (await (await fetch(`${hub.url}/api/conversations/${chat.id}/history/operations/s_lost`, { headers })).json() as any).state;
    await vi.waitFor(async () => expect(await status()).toBe("unknown"), { timeout: 5000 });
    // Let the send in flight at expiry run out.
    await wait(450);
    gw.lose.replies = false;
    // The user chats on: this run is on the rewound thread and stays live.
    const [later] = await turns(chat.id, thread, ["kept chatting"]);
    const retried = await post(headers, `/api/conversations/${chat.id}/history/rewind`, body);
    expect(gw.calls.at(-1)!.params).toMatchObject({ requestId: "s_lost", replayOnly: true });
    expect(retried.body).toMatchObject({ state: "completed", replayed: true, rewind: { fromMessageId: seeded[1]!.input.id, throughMessageId: last } });
    expect(later!.input.createdAt).toBeGreaterThan(retried.body.rewind.throughCreatedAt);
    expect(gw.adapter.rewindSession).toHaveBeenCalledTimes(1);
    expect(thread.has(later!.turnId)).toBe(true);
  });

  it("a rewind recorded failed although the engine applied it: a new request marks only what it removed", async () => {
    const { headers, chat, thread, seeded } = await fixture(["first question", "second question", "third question"]);
    const gw = await gateway(chat.id, thread);
    const first = await lastId(chat.id);
    // The engine reverted; the check after it failed.
    thread.afterRevert.push(new Error("socket closed"));
    const one = await post(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "s_b1", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: first });
    expect(one.body).toMatchObject({ state: "failed", error: "engine_failed" });
    expect(thread.turns.map(turn => turn.id)).toEqual(["t1"]);
    const [later] = await turns(chat.id, thread, ["kept chatting"]);
    const two = await post(headers, `/api/conversations/${chat.id}/history/rewind`, { botId: "alpha", requestId: "s_b2", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: await lastId(chat.id) });
    expect(two.body).toMatchObject({ state: "completed", rewind: { fromMessageId: seeded[1]!.input.id, throughMessageId: first } });
    expect(later!.input.createdAt).toBeGreaterThan(two.body.rewind.throughCreatedAt);
    expect(thread.has(later!.turnId)).toBe(true);
    expect(gw.calls.map(call => call.result)).toEqual([{ ok: false, error: "engine_failed" }, { ok: true, throughMessageId: first }]);
  });
  it("a rewind the engine left unconfirmed stays started and resolves on the next ask", async () => {
    await hub.close(); await start({ rewindMs: 2000, forkMs: 2000, statusMs: 2000, unknownAfterMs: 60_000, pendingResendMs: 50 });
    const { headers, chat, thread, seeded } = await fixture(["first question", "second question", "third question"]);
    const gw = await gateway(chat.id, thread);
    const last = await lastId(chat.id);
    // The engine call timed out; the change landed afterwards.
    thread.afterRevert.push(new EngineHistoryUnconfirmedError());
    const body = { botId: "alpha", requestId: "s_p", beforeMessageId: seeded[1]!.input.id, expectedLastMessageId: last };
    const first = await post(headers, `/api/conversations/${chat.id}/history/rewind`, body);
    expect(first.body.state === "started" || first.body.state === "completed").toBe(true);
    await vi.waitFor(async () => expect((await (await fetch(`${hub.url}/api/conversations/${chat.id}/history/operations/s_p`, { headers })).json() as any)).toMatchObject({ state: "completed", rewind: { throughMessageId: last } }));
    expect(gw.calls.map(call => call.result)).toEqual([{ ok: false, error: "operation_pending" }, { ok: true, throughMessageId: last }]);
    expect(gw.adapter.rewindSession).toHaveBeenCalledTimes(2);
  });
});
