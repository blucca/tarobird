import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HubPromptQueue } from "../../src/hub/prompt-queue.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";

// How often an open conversation asks the Host for its queue of waiting messages. An entry can only appear
// with a new message, and that is announced; so an empty queue needs no timer, and the many updates of a
// streamed reply need no read each. A queue that holds entries is still read on its timer.
test.use({ serviceWorkers: "block" });
test("an empty queue is not polled, a streamed reply is read about once a second, and a queued message still shows at once", async ({ page }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "queue-reads-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,online) VALUES('alpha','alpha','fixture','codex',1)");
    await hub.store.db.run("INSERT INTO managed_bots VALUES('alpha','owner','alpha','{}')");
    await new HubPromptQueue(hub.store).registerWorker("alpha", true);
    const chat = await hub.store.createConversation("owner", ["alpha"], "读取频率", "reads");
    const reads: number[] = [];
    page.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname === `/api/conversations/${chat.id}/queue`) reads.push(Date.now()); });
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await selectConversation(page, "读取频率");
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await page.waitForTimeout(1500);

    // Nothing is waiting and nothing happens: no read at all in six seconds (a two-second timer made three).
    let from = reads.length; await page.waitForTimeout(6000);
    expect(reads.length - from, "reads of an idle, empty queue in 6 s").toBe(0);

    // A reply streams: 24 updates in about 3.6 s. One read when the reply appears, then about one a second.
    from = reads.length;
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: "开始" }], status: "streaming" });
    for (let i = 0; i < 24; i++) { await hub.store.publishBotMessage("alpha", { id: reply.id, conversationId: chat.id, blocks: [{ type: "text", text: "开始" + "，继续".repeat(i + 1) }], status: "streaming" }); await page.waitForTimeout(150); }
    await page.waitForTimeout(1200);
    const streamed = reads.length - from;
    expect(streamed, "reads while a reply streamed").toBeGreaterThanOrEqual(1);
    expect(streamed, "reads while a reply streamed").toBeLessThanOrEqual(7);

    // A message sent while the Bot is busy is in the queue right away, and a queue that holds something is read on its timer again.
    from = reads.length; const sentAt = Date.now();
    await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: "queued-one", text: "排队的一条", attachments: [] });
    await expect(page.getByRole("button", { name: /^管理待执行消息，共 \d+ 条$/ })).toBeVisible({ timeout: 1500 });
    expect(Date.now() - sentAt).toBeLessThan(1500);
    await page.waitForTimeout(5000);
    expect(reads.length - from, "reads in 5 s while a message waits").toBeGreaterThanOrEqual(3);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
