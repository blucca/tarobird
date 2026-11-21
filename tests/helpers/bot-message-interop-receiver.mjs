// Receiving Host for the opt-in process-level interop test (issue #62, R18).
// Runs HubServer from a built dist (an older release or this branch) in its own
// process, behind real TLS. Line-delimited JSON commands on stdin; one JSON
// reply per command on stdout. Synthetic fixture data only.
//   node bot-message-interop-receiver.mjs <dist dir> <state dir> <cert> <key> <bind address>
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [distDir, stateDir, cert, key, address] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(path.join(distDir, relative)).href);
const { HubServer } = await load("src/hub/server.js");
const { loadHubTls } = await load("src/hub/tls.js");
const tls = await loadHubTls({ cert, key });
const hub = await HubServer.start({ stateDir, host: address, tls, exposure: "public" });
await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('receiver','Receiver','fixture','codex')");
const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
reply({ ready: true, publicKey: hub.auth.publicKey, url: hub.url });

const guard = async () => undefined;
const commands = {
  async configure({ membership, routes, sourceHost, sourceBot }) {
    await hub.store.db.run("INSERT INTO meta(key,value) VALUES('private-network:v1',?)", [JSON.stringify({ v: 1, routes, membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })]);
    await hub.botMessages.grant({ sourceHost, sourceBot, targetBot: "receiver" }, guard);
    return { configured: true };
  },
  async deliveries({ messageId }) { return hub.store.db.all("SELECT status,dispatched FROM deliveries WHERE message_id=?", [messageId]); },
  async inputs() { return hub.store.db.all("SELECT id,blocks_json FROM messages WHERE author_type='user' AND bot_source_json IS NOT NULL ORDER BY rowid"); },
  async audit() { return hub.store.db.all("SELECT kind,detail_json FROM audit_log WHERE kind LIKE 'bot-message.%' ORDER BY id"); },
  // New build only: the Gateway is a fixture that reports this input's live run and accepts the steer.
  async live({ messageId }) {
    await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=?", [messageId]);
    const calls = [];
    hub.botMessages.steering = {
      capable: () => true,
      status: async () => ({ supported: true, targetId: "run_interop", sourceMessageId: messageId, receiptEpoch: "rs_interop_store" }),
      steer: async (_bot, call) => { calls.push(call); return { outcome: "accepted", sourceMessageId: messageId }; },
      reconcile: async () => ({ outcome: "unknown", reason: "uncertain" }),
      dispatch: () => undefined,
    };
    commands.steerCalls = async () => calls;
    return { live: true };
  },
  async finish({ messageId, text }) {
    await hub.store.publishBotMessage("receiver", { conversationId: (await hub.store.db.get("SELECT conversation_id FROM messages WHERE id=?", [messageId])).conversation_id, replyTo: messageId, blocks: [{ type: "text", text }] });
    await hub.store.acknowledgeDelivery("receiver", messageId);
    return { finished: true };
  },
  async close() { await hub.close(); setImmediate(() => process.exit(0)); return { closed: true }; },
};
for await (const line of createInterface({ input: process.stdin })) {
  const { op, ...args } = JSON.parse(line);
  try { reply({ ok: true, result: await commands[op](args) }); }
  catch (error) { reply({ ok: false, error: String(error?.message ?? error) }); }
}
