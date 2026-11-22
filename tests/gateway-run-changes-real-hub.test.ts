import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isRunActive, nativeRun } from "../src/client-protocol/run.js";
import { runChangesSummarySchema } from "../src/client-protocol/run-changes.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { attachGateway } from "../src/gateway/service.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

// The unit tests hand the Gateway a transport that already lists runs.changes.v1. Here a real Hub says what it
// supports, which is what decides whether a reply's card gets its counts at all.
let root: string, stateDir: string, hub: HubServer, gateway: GatewayChannel | undefined, secret: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-run-changes-")); stateDir = path.join(root, "instance"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  hub = await HubServer.start({ stateDir: path.join(root, "hub") }); secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
});
afterEach(async () => { await gateway?.disconnect(); gateway = undefined; await hub.close(); await rm(root, { recursive: true, force: true }); });

it("a reply through a real Hub and Gateway carries the counts of the edits its run recorded", async () => {
  gateway = await attachGateway({ stateDir, botId: "alpha", secret, engine: "codex", url: hub.instanceUrl.replace("http", "ws") + "/instance", runtime: createCoreServiceRuntime(), bridge: {
    handleAuthorizedMessage: async input => {
      await input.onEngineEvent?.({ type: "tool_use", toolName: "Edit", toolUseId: "edit_1", toolInput: { file_path: "/work/notes.txt" } });
      await input.onEngineEvent?.({ type: "tool_result", toolName: "Edit", toolUseId: "edit_1", changes: [{ path: "/work/notes.txt", diff: "@@ -1,2 +1,3 @@\n one\n-two\n+2\n+three\n" }] });
      return { text: "Edited." };
    },
  } });
  const chat = await hub.store.createConversation("owner", ["alpha"], "Recorded changes", "create_changes");
  await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "ask", text: "Edit the notes", attachments: [] });
  const finished = async () => (await hub.store.snapshot("owner", chat.id)).messages.flatMap(message => message.authorType === "bot" ? message.blocks : [])
    .find(block => block.type === "card" && !!nativeRun(block) && !isRunActive(nativeRun(block)!.phase));
  const end = Date.now() + 10_000;
  while (!await finished()) { if (Date.now() > end) throw new Error("run_not_finished"); await new Promise(resolve => setTimeout(resolve, 20)); }
  const card = (await finished())!, run = card.type === "card" ? nativeRun(card)! : undefined;
  expect(run?.detailsUnavailable).toBeFalsy();
  expect(runChangesSummarySchema.parse(card.type === "card" ? card.extra?.runChanges : undefined)).toMatchObject({ runId: run!.id, revision: run!.revision, files: 1, edits: 1, additions: 2, deletions: 1 });
});
