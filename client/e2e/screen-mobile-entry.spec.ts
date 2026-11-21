import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { mobileHome, openMobileHome, openWorkspacePage, selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", hasTouch: true });
for (const width of [390, 950]) test(`real App mobile entry stays in ordinary menus and outside ADHD (${width})`, async ({ page }, info) => {
  await mkdir(path.resolve("../lab"), { recursive: true });
  const root = await mkdtemp(path.resolve("../lab/screen-mobile-entry-"));
  // Only select the native presentation branch and visible lifecycle. Pairing,
  // connection, App menus and settings use the real synthetic Hub. This test
  // never opens a screen socket; native networking is covered separately.
  const vite = await createServer({ plugins: [{ name: "screen-mobile-entry", enforce: "pre", transform(code, id) {
    if (id.endsWith("/src/mobile-screen-viewer-transport.ts")) return code.replace('() => !isDesktop() && ["ios", "android"].includes(Capacitor.getPlatform())', '() => true');
    if (id.endsWith("/src/use-screen-mobile-lifecycle.ts")) return 'export function useScreenMobileLifecycle(_mobile,visible){return visible;}';
  } }], server: { host: "127.0.0.1", port: 0 } });
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await page.setViewportSize({ width, height: 844 });
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('screen-fixture','示例助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["screen-fixture"], "屏幕入口检查", "direct");
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await expect(page.locator(".screen-trigger")).toHaveCount(0); await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    const entry = page.getByRole("button", { name: "查看屏幕", exact: true }); await expect(entry).toBeVisible(); await expect.poll(async () => (await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath("ordinary-menu.png") }); await entry.click();
    await expect(page.getByRole("complementary", { name: "远程屏幕", exact: true })).toBeVisible(); await page.getByRole("button", { name: "断开并关闭屏幕", exact: true }).click();
    if (width <= 760) await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "打开连接设置", exact: true }).filter({ visible: true }).click();
    // The connection page keeps one row to Screen control, now its own page.
    const settings = page.getByRole("dialog", { name: "连接状态与线路", exact: true }); await expect(settings.locator(".screen-settings")).toHaveCount(0);
    await settings.getByRole("button", { name: /^屏幕控制设置/ }).click();
    const screen = page.getByRole("dialog", { name: "屏幕控制设置", exact: true }); await expect(screen.locator(".screen-settings")).toBeVisible(); await expect(screen.getByRole("button", { name: "查看屏幕", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(screen).toBeHidden(); await page.keyboard.press("Escape"); await expect(settings).toBeHidden();
    // The chat menu also opens it directly, next to "View screen".
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    const direct = page.getByRole("button", { name: "屏幕控制设置", exact: true }).filter({ visible: true }); await expect(direct).toBeVisible(); await expect.poll(async () => (await direct.boundingBox())!.height).toBeGreaterThanOrEqual(44); await direct.click();
    await expect(screen.locator(".screen-settings")).toBeVisible(); await page.keyboard.press("Escape"); await expect(screen).toBeHidden();
    if (width <= 760) {
      // "Me" lists Screen control right after Connection status and routes, for the selected computer.
      await openMobileHome(page); await mobileHome(page).getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
      const cell = mobileHome(page).getByRole("button", { name: "屏幕控制设置", exact: true }); await expect(cell).toBeVisible();
      expect(await cell.evaluate(node => node.closest("li")?.previousElementSibling?.querySelector("button")?.getAttribute("aria-label"))).toBe("连接状态与线路");
      await page.screenshot({ path: info.outputPath("me-screen-control.png") });
      await cell.click(); const own = page.getByRole("dialog", { name: "屏幕控制设置", exact: true }); await expect(own.locator(".screen-settings")).toBeVisible();
      await page.getByRole("button", { name: "关闭屏幕控制设置", exact: true }).click(); await expect(own).toHaveCount(0); await expect(cell).toBeFocused();
      await expect(page.getByRole("button", { name: "打开 ADHD 模式", exact: true })).toHaveCount(0); return;
    }
    await openWorkspacePage(page, "打开 ADHD 模式"); await page.getByRole("checkbox", { name: new RegExp(`^加入面板：.*${chat.title}$`) }).check();
    const card = page.locator(".adhd-card"); await expect(card).toHaveCount(1);
    await expect(card.locator(".screen-trigger,.screen-mobile-entry,.workbench-trigger")).toHaveCount(0);
    const more = card.getByRole("button", { name: "更多聊天操作", exact: true });
    if (await more.isVisible()) { await more.click(); await expect(page.getByRole("button", { name: "查看屏幕", exact: true }).filter({ visible: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "屏幕控制设置", exact: true }).filter({ visible: true })).toHaveCount(0); }
    await page.screenshot({ path: info.outputPath("adhd-menu.png") });
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
