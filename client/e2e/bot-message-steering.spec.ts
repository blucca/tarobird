import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { steerFallbackNotice } from "../../src/hub/bot-message-steering.js";
import { showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const english = JSON.parse(await readFile(path.resolve("src/locales/en.json"), "utf8")) as Record<string, string>;
const source = { hostId: "hub_fixturesource", hostName: "Mac", botId: "coordinator", botName: "Coordinator", requestId: "req_fixture", hops: 1 };

async function useEnglish(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("tarocub-hosts-v1");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, tx = db.transaction("meta", "readwrite"), store = tx.objectStore("meta"), get = store.get("preferences");
      get.onsuccess = () => { const value = get.result ? JSON.parse(get.result) : {}; store.put(JSON.stringify({ ...value, locale: "en" }), "preferences"); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
  }));
  await page.reload(); await waitForClientOnline(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

for (const locale of ["zh", "en"] as const) for (const width of [1360, 390]) {
  test(`owner steering switch and Bot steer receipts — ${locale} ${width}px`, async ({ browser }, info) => {
    const L = (key: string) => locale === "en" ? english[key] ?? key : key;
    const phone = width < 760;
    const root = await mkdtemp(path.join(os.tmpdir(), "bot-steering-ui-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const [id, name, engine] of [["alpha", "Codex 助手", "codex"], ["beta", "Pi 助手", "pi"]] as const) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,?)", [id, name, hashSecret(randomBytes(16).toString("hex")), engine]);
      await hub.profile.update({ name: "引导验收主机", revision: 0 });
      const codexChat = await hub.store.createConversation("owner", ["alpha"], "引导验收", "codex-chat");
      await hub.store.createConversation("owner", ["beta"], "Pi 验收", "pi-chat");
      // A steered Bot message and one that fell back to the queue.
      const steered = await hub.store.beginBotSteer("owner", { conversationId: codexChat.id, botId: "alpha", clientMsgId: "bm_fixture_steered", text: "Use the staging database", botSource: source, targetId: "run_fixture" }, async () => undefined);
      await hub.store.settleBotSteer(steered.message.id, "alpha", { outcome: "accepted" });
      await hub.store.sendMessageWithNotice("owner", { conversationId: codexChat.id, clientMsgId: "bm_fixture_queued", text: "Second note", attachments: [], mentions: ["alpha"], botSource: { ...source, requestId: "req_fixture_2" }, previewUrl: null }, steerFallbackNotice("alpha", "no_active_turn"));
      await page.goto(hub.url); await page.getByLabel("主机名称", { exact: true }).fill("引导验收主机"); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
      await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
      await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page);
      // The fixture Bots have no worker attached; list them as the owner would after opting in.
      await showDisconnectedBots(page);
      if (locale === "en") await useEnglish(page);
      const open = async (title: string) => {
        if (phone) {
          // Same steps as fixtures/mobile.ts openMobileHome, with this locale's labels.
          const details = page.getByRole("button", { name: L("返回聊天"), exact: true }); if (await details.isVisible()) await details.click();
          const list = page.getByRole("button", { name: L("打开会话列表"), exact: true }); if (await list.isVisible()) await list.click();
          const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
          await expect(home).toHaveAttribute("data-tab", /^(messages|bots|me)$/);
          await home.getByRole("navigation", { name: L("主导航") }).getByRole("button", { name: new RegExp(`^${L("消息")}`) }).click();
          await home.locator(".mh-row").filter({ has: page.getByText(title, { exact: true }) }).click();
        } else await page.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) }).click();
        await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
      };
      const openBotSettings = async () => {
        const settings = page.getByRole("button", { name: L("Bot 设置"), exact: true });
        if (!await settings.isVisible()) await page.getByRole("button", { name: L("查看对话详情"), exact: true }).click();
        await settings.click();
      };
      const closeBotSettings = async () => {
        await page.getByRole("button", { name: L("关闭 Bot 设置"), exact: true }).click();
        await page.getByRole("button", { name: new RegExp(`^(${L("返回聊天")}|${L("关闭对话详情")})$`) }).click();
      };
      await open("引导验收");
      // The receipt states the outcome and offers no owner action on a Bot's record.
      // The queued one keeps its Host notice unfolded; expand the merged one to read its receipt.
      const folded = page.getByRole("button", { name: L("展开协作消息"), exact: true });
      await expect(folded).toHaveCount(1);
      await folded.click();
      await expect(page.getByText(L("已并入正在进行的回复"), { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: L("核对引导回执") })).toHaveCount(0);
      await expect(page.getByText(L("未能并入正在进行的回复（{0}），已改为排队。").replace("{0}", L("对方这个对话里没有进行中的回复")), { exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`receipts-${locale}-${width}.png`) });
      await openBotSettings();
      const label = L("允许其他 Bot 引导这个 Bot");
      const toggle = page.getByRole("switch", { name: label, exact: true });
      await expect(toggle).toBeVisible(); await expect(toggle).toBeChecked(); await expect(toggle).toBeEnabled();
      await expect(page.getByText(L("其他 Bot 发来的补充可以并入正在进行的回复；关闭后一律排队。"), { exact: true })).toBeVisible();
      // The row stays inside the dialog at this width.
      const row = await page.locator(".bot-steering-toggle").boundingBox(), dialog = await page.locator(".bot-settings-panel").boundingBox();
      expect(row && dialog && row.x >= dialog.x - 1 && row.x + row.width <= dialog.x + dialog.width + 1).toBe(true);
      // Capture after the dialog's opening animation has settled.
      await page.locator(".bot-settings-panel").evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
      await page.mouse.move(0, 0);
      await page.screenshot({ path: info.outputPath(`switch-${locale}-${width}.png`) });
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await expect.poll(async () => (await hub.botMessages.readSteering("owner", "alpha", async () => undefined)).allowed).toBe(false);
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect.poll(async () => (await hub.botMessages.readSteering("owner", "alpha", async () => undefined)).allowed).toBe(true);
      await closeBotSettings();
      // Engines that never steer show no such option.
      await open("Pi 验收"); await openBotSettings();
      await expect(page.getByRole("button", { name: L("Bot 消息授权") })).toBeVisible();
      await expect(page.getByRole("switch", { name: label })).toHaveCount(0);
      expect(errors).toEqual([]);
      const audit = await hub.store.db.all<{ detail_json: string }>("SELECT detail_json FROM audit_log WHERE kind='bot-message.steering-updated' ORDER BY id");
      expect(audit.map(row => JSON.parse(row.detail_json).allowed)).toEqual([false, true]);
    } finally { await context.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
  });
}
