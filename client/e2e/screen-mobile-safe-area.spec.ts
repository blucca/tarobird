import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", hasTouch: true, isMobile: true });
type Insets = { top: number; right: number; bottom: number; left: number };
// The iPhone WKWebView reports only env(): Capacitor injects no
// --safe-area-inset-* there (measured on device: env top 59px, bottom 34px).
// The CDP override sets exactly env(); no CSS variable is written by this test.
async function systemInsets(page: Page, insets: Insets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: insets.top, topMax: insets.top, right: insets.right, rightMax: insets.right,
    bottom: insets.bottom, bottomMax: insets.bottom, left: insets.left, leftMax: insets.left } });
  await cdp.detach();
}
const controls = ["键盘与快捷键", "屏幕更多操作", "断开并关闭屏幕", "连接屏幕"];
/** Real button rectangles and a hit test at each centre, against the safe rectangle. */
async function layout(page: Page, insets: Insets) {
  return page.evaluate(({ insets, controls }) => {
    const panel = document.querySelector<HTMLElement>(".remote-screen-panel.screen-mobile")!;
    const safe = { top: insets.top, left: insets.left, right: innerWidth - insets.right, bottom: innerHeight - insets.bottom };
    const inside = (r: DOMRect) => r.top >= safe.top - .5 && r.left >= safe.left - .5 && r.bottom <= safe.bottom + .5 && r.right <= safe.right + .5;
    const named = controls.map(name => [name, [...panel.querySelectorAll<HTMLElement>("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name)] as const);
    // A landscape phone names the Host in the status label over the picture,
    // which deliberately lets touches through to the picture beneath it.
    const parts = [...named, ["title", panel.querySelector<HTMLElement>(".screen-title") ?? panel.querySelector<HTMLElement>(".screen-status-label")], ["picture", panel.querySelector<HTMLElement>(".screen-viewport")]] as const;
    const result: Record<string, string> = {};
    for (const [name, node] of parts) {
      if (!node) { result[name] = "missing"; continue; }
      const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      result[name] = `${inside(r) ? "inside" : `outside(${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)})`}${name === "picture" || node.matches(".screen-status-label") || (hit && node.contains(hit)) ? "" : " covered"}`;
    }
    const style = getComputedStyle(panel);
    result.padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
    result.overflow = panel.scrollWidth > panel.clientWidth ? "horizontal" : "none";
    return result;
  }, { insets, controls });
}
const everythingInside = (padding: string) => ({ ...Object.fromEntries([...controls, "title", "picture"].map(name => [name, "inside"])), padding, overflow: "none" });

test("mobile screen viewer keeps its title and controls inside the system safe area", async ({ page }, info) => {
  await mkdir(path.resolve("../lab"), { recursive: true });
  const root = await mkdtemp(path.resolve("../lab/screen-mobile-safe-area-"));
  // Only the native presentation branch is selected; pairing, menus and the
  // panel are the real App against a real Hub. No screen socket is opened.
  const vite = await createServer({ plugins: [{ name: "screen-mobile-safe-area", enforce: "pre", transform(code, id) {
    if (id.endsWith("/src/mobile-screen-viewer-transport.ts")) return code.replace('() => !isDesktop() && ["ios", "android"].includes(Capacitor.getPlatform())', '() => true');
    if (id.endsWith("/src/use-screen-mobile-lifecycle.ts")) return 'export function useScreenMobileLifecycle(_mobile,visible){return visible;}';
  } }], server: { host: "127.0.0.1", port: 0 } });
  await vite.listen(); const url = vite.resolvedUrls!.local[0]!;
  const hub = await HubServer.start({ stateDir: root, origins: [new URL(url).origin] });
  try {
    await page.setViewportSize({ width: 430, height: 932 });
    await hub.profile.update({ name: "示例主机", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('screen-fixture','示例助手','fixture')");
    const chat = await hub.store.createConversation("owner", ["screen-fixture"], "屏幕安全区检查", "direct");
    await page.goto(url); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url); await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click(); await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page); await showDisconnectedBots(page); await selectConversation(page, chat.title);
    await page.evaluate(() => { document.documentElement.dataset.platform = "ios"; });
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    await page.getByRole("button", { name: "查看屏幕", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "远程屏幕", exact: true }); await expect(panel).toBeVisible();
    const cases: [string, number, number, Insets, string][] = [
      ["iphone-portrait", 430, 932, { top: 59, right: 0, bottom: 34, left: 0 }, "59px 0px 34px 0px"],
      ["iphone-landscape", 932, 430, { top: 0, right: 59, bottom: 21, left: 59 }, "0px 59px 21px 59px"],
      ["narrow-iphone", 320, 568, { top: 20, right: 0, bottom: 0, left: 0 }, "20px 0px 0px 0px"],
      ["iphone-portrait-again", 430, 932, { top: 59, right: 0, bottom: 34, left: 0 }, "59px 0px 34px 0px"],
    ];
    for (const [name, width, height, insets, padding] of cases) {
      await page.setViewportSize({ width, height }); await systemInsets(page, insets);
      await expect.poll(() => layout(page, insets), { message: name }).toEqual(everythingInside(padding));
      await page.screenshot({ path: info.outputPath(`${name}.png`) });
    }
    // The tools popover opens below the safe header and ends above the home indicator.
    const portrait = cases[0]![3];
    await page.getByRole("button", { name: "屏幕更多操作", exact: true }).click();
    const popover = page.getByRole("region", { name: "屏幕更多操作", exact: true }); await expect(popover).toBeVisible();
    const box = (await popover.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(portrait.top); expect(box.y + box.height).toBeLessThanOrEqual(932 - portrait.bottom);
    await page.screenshot({ path: info.outputPath("iphone-portrait-tools.png") });
    await page.getByRole("button", { name: "屏幕更多操作", exact: true }).click(); await expect(popover).toBeHidden();
    // The keyboard already shrinks the shell; the home-indicator inset is not reserved twice.
    await page.evaluate(() => { document.documentElement.dataset.keyboardOpen = "true"; });
    await expect.poll(() => panel.evaluate(node => getComputedStyle(node).padding)).toBe("59px 0px 0px");
    await page.evaluate(() => { delete document.documentElement.dataset.keyboardOpen; });
    // Android's native container already insets the WebView (NativeInsets.java):
    // the panel adds nothing, even if env() were non-zero, exactly as before.
    await page.evaluate(() => { document.documentElement.dataset.platform = "android"; document.documentElement.dataset.nativeInsets = "android"; });
    await expect.poll(() => panel.evaluate(node => getComputedStyle(node).padding)).toBe("0px");
    await expect.poll(() => layout(page, { top: 0, right: 0, bottom: 0, left: 0 })).toEqual(everythingInside("0px 0px 0px 0px"));
  } finally { await page.close(); await hub.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
