import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubStore } from "../src/hub/store.js";
import { HISTORY_RELEASE_AFTER_MS, HubConversationHistory } from "../src/hub/conversation-history.js";

let directory: string, store: HubStore;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "tarobird-history-release-"));
  store = await HubStore.open(directory);
  for (const id of ["bot", "away"]) await store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,'unused','codex')", [id, id]);
});
afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });

it("releases an online Bot's expired operation even when older ones of an offline Bot fill a whole batch", async () => {
  const call = vi.fn(async (_bot: string, method: string): Promise<any> => {
    if (method === "history.apply") throw new Error("gateway_gone");
    if (method === "history.receipt") return {};
    if (method === "history.finalize") return { revision: "next_revision" };
    throw new Error(method);
  });
  const history = new HubConversationHistory(store, { available: botId => botId === "bot" ? "ready" : "offline", busy: () => false, call, changed: async () => {} });
  const start = Date.now(), clock = vi.spyOn(Date, "now");
  try {
    // Twenty-five older unconfirmed operations of a Bot that stays offline, one per conversation.
    for (let index = 0; index < 25; index++) {
      clock.mockReturnValue(start + index);
      const conversation = await store.createConversation("owner", ["away"], `Away ${index}`, `away_${index}`);
      await store.db.run("INSERT INTO history_operations(id,owner_id,request_id,payload_hash,bot_id,source_conversation_id,expected_revision,action_json,state,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        [`history_away_${index}`, "owner", `away_${index}`, "hash", "away", conversation.id, "revision", JSON.stringify({ kind: "fork", scope: "whole" }), "unknown",
          JSON.stringify({ requestId: `away_${index}`, operationId: `history_away_${index}`, sourceRevision: "revision", state: "unknown", reason: "uncertain" }), start + index, start + index]);
    }
    clock.mockReturnValue(start + 1_000);
    const conversationId = (await store.createConversation("owner", ["bot"], "Online", "online")).id;
    const lost = await history.start("owner", conversationId, { botId: "bot", requestId: "lost", expectedRevision: "revision", action: { kind: "fork", scope: "whole" } });
    expect(lost.state).toBe("unknown");
    clock.mockReturnValue(start + 1_000 + HISTORY_RELEASE_AFTER_MS + 1);
    await history.releaseExpired();
  } finally { clock.mockRestore(); }
  expect(await history.status("owner", "bot", (await store.db.get<{ source_conversation_id: string }>("SELECT source_conversation_id FROM history_operations WHERE request_id='lost'"))!.source_conversation_id, "lost"))
    .toMatchObject({ state: "rejected", reason: "cancelled" });
  expect(await store.db.get("SELECT COUNT(*) AS count FROM history_operations WHERE bot_id='away' AND state='unknown'")).toEqual({ count: 25 });
});
