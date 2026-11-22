import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { BOT_AVATAR_DEFAULT_PREFIX } from "../../src/hub/bot-avatar-default.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

// A streamed reply adds a little DOM several times a second. Each addition may restyle what it touches,
// never the whole message or page: with some selectors (`:has()` on an ancestor followed by a bare tag, a
// structural pseudo-class or `*`) the browser restyled about 2,500 elements per update of a long reply.
// The count comes from the browser's own trace, so the budget does not depend on how fast the machine is.
test.use({ serviceWorkers: "block" });
const BUDGET = 400;
for (const [name, viewport, phone] of [["desktop", { width: 1360, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) test(`a streamed update of a long reply restyles a bounded number of elements (${name})`, async ({ browser }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "restyle-budget-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const context = await browser.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','狐狸','fixture'),('beta','章鱼','fixture')");
    for (const [bot, avatar] of [["alpha", "pastel-fox"], ["beta", "mini-octopus"]]) await hub.store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + bot, avatar]);
    const chat = await hub.store.createConversation("owner", ["alpha"], "发布计划", "fox");
    // An unread conversation and earlier replies with lists, bold text and code: the content the selectors react to.
    const other = await hub.store.createConversation("owner", ["beta"], "每周研究", "octopus");
    await hub.store.publishBotMessage("beta", { conversationId: other.id, blocks: [{ type: "text", text: "未读的一条" }], status: "complete" });
    for (let i = 0; i < 12; i++) await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text: `第 ${i} 条历史消息。\n\n- 要点一\n- **要点二**\n\n1. 先做这件事\n\n   再补充一句\n2. 然后那件事` }], status: "complete" });
    await page.goto(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await showDisconnectedBots(page); await waitForClientOnline(page);
    if (phone) await selectConversation(page, "发布计划"); else await page.locator(`.conversation-row[data-conversation-id="${chat.id}"]`).filter({ visible: true }).click();
    await expect(page.getByRole("heading", { name: "发布计划", exact: true })).toBeVisible();
    let text = "正在整理。\n\n" + "这是一段已经写好的内容，包含一些**加粗**、`代码`和[链接](https://example.com)。\n\n- 一项\n- 另一项\n\n".repeat(260);
    const reply = await hub.store.publishBotMessage("alpha", { conversationId: chat.id, blocks: [{ type: "text", text }], status: "streaming" });
    await expect(page.locator("article.message.bot").last().locator(".markdown-chunk").last()).toBeVisible();
    await page.waitForTimeout(1500);
    const size = await page.locator("article.message.bot").last().evaluate(node => node.querySelectorAll("*").length);
    expect(size, "the streamed reply is long enough for the budget to mean something").toBeGreaterThan(BUDGET * 4);
    const cdp = await context.newCDPSession(page);
    const counts: number[] = [];
    cdp.on("Tracing.dataCollected", event => { for (const entry of event.value as Array<{ name?: string; ph?: string; args?: { elementCount?: number } }>) if (entry.name === "UpdateLayoutTree" && entry.ph === "X") counts.push(entry.args?.elementCount ?? 0); });
    await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] }, transferMode: "ReportEvents" });
    for (let i = 0; i < 12; i++) {
      text += `第 ${i} 句新增内容，带**加粗**和一个[链接](https://example.com/${i})。`; if (i % 4 === 3) text += "\n\n- 新的一项\n\n";
      await hub.store.publishBotMessage("alpha", { id: reply.id, conversationId: chat.id, blocks: [{ type: "text", text }], status: "streaming" });
      await page.waitForTimeout(150);
    }
    await expect(page.locator("article.message.bot").last()).toContainText("第 11 句新增内容");
    const done = new Promise<void>(resolve => cdp.once("Tracing.tracingComplete", () => resolve()));
    await cdp.send("Tracing.end"); await done;
    expect(counts.length, "the trace recorded style recalculations").toBeGreaterThan(5);
    console.log(`restyle-budget ${name}: message elements ${size}, recalculations ${counts.length}, largest ${Math.max(...counts)}`);
    expect(Math.max(...counts)).toBeLessThanOrEqual(BUDGET);
  } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
