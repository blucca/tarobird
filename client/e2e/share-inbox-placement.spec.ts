import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { mobileHome, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

// The native share inbox entry is an in-flow notice row: on every phone page,
// orientation and iPad layout it must not cover any reachable control, must stay
// inside the safe areas, and must sit below dialogs. Browsers cannot be native:
// the plugin header is injected before load (Capacitor reads it at
// registration) and the platform flips to iOS/Android once the App is online.
// Safe areas use Capacitor's --safe-area-inset-* tokens; the keyboard uses the
// iOS overlay attributes the viewport controller writes.
// SHARE_SHOTS_DIR=<dir> also saves a screenshot + geometry JSON per page.
const shots = process.env.SHARE_SHOTS_DIR;
const title = "分享位置";
type Platform = "ios" | "android";
type Insets = { top: number; right: number; bottom: number; left: number };
const IPHONE_PORTRAIT: Insets = { top: 59, right: 0, bottom: 34, left: 0 };
const IPHONE_LANDSCAPE: Insets = { top: 0, right: 59, bottom: 21, left: 59 };
const IPAD: Insets = { top: 24, right: 0, bottom: 20, left: 0 };
const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

async function bootstrap(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const item = { id: "884b9026-9029-4a6b-ad36-cd40b6f9a241", createdAt: Date.now(), text: "来自系统分享的草稿", files: [] };
    w.__share = { mode: "one", calls: [] as string[] };
    // Capacitor reads plugin headers when the plugin registers (module load).
    w.Capacitor = {
      PluginHeaders: [{ name: "TaroCubShareInbox", methods: ["setMaxFileBytes", "list", "prepare", "readChunk", "remove", "clear", "pushTokenSnapshot"].map(name => ({ name, rtype: "promise" })) }],
      nativePromise: async (plugin: string, method: string) => {
        w.__share.calls.push(`${plugin}.${method}`);
        if (plugin !== "TaroCubShareInbox") throw new Error(`unexpected_native:${plugin}.${method}`);
        if (method === "list") {
          if (w.__share.mode === "error") throw new Error("share_app_group_unavailable");
          return { items: w.__share.mode === "one" ? [structuredClone(item)] : [] };
        }
        if (method === "pushTokenSnapshot") return { revision: 0 };
        return {};
      },
    };
  });
}

async function goNative(page: Page, platform: Platform, insets: Insets) {
  await page.evaluate(({ platform, insets }) => {
    const w = window as any, root = document.documentElement;
    if (platform === "android") { w.androidBridge = {}; root.dataset.nativeInsets = "android"; }
    else w.webkit = { messageHandlers: { bridge: { postMessage() {} } } };
    root.dataset.platform = platform;
    for (const [side, value] of Object.entries(insets)) root.style.setProperty(`--safe-area-inset-${side}`, `${value}px`);
  }, { platform, insets });
}

/** Every visible interactive control, clipped by scrollers and the viewport. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const share = document.querySelector<HTMLElement>(".share-inbox-button");
    const box = share?.getBoundingClientRect();
    const hit = box ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
    const selfHit = !!share && !!hit && share.contains(hit);
    if (share) share.style.visibility = "hidden";
    const selector = "button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=link],[role=checkbox],[role=switch],[role=menuitem],[role=option],[role=searchbox],[tabindex]:not([tabindex='-1']),[contenteditable=true],[contenteditable='']";
    const controls: { name: string; rect: number[] }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (share?.contains(el) || el.closest("[hidden],[inert]")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      let [l, t, rr, b] = [r.left, r.top, r.right, r.bottom];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (ps.overflowX !== "visible" || ps.overflowY !== "visible") { const pr = p.getBoundingClientRect(); l = Math.max(l, pr.left); t = Math.max(t, pr.top); rr = Math.min(rr, pr.right); b = Math.min(b, pr.bottom); }
      }
      l = Math.max(l, 0); t = Math.max(t, 0); rr = Math.min(rr, innerWidth); b = Math.min(b, innerHeight);
      if (rr - l < 1 || b - t < 1) continue;
      // Covered by something else (sheet, dialog): not reachable, not our concern.
      const top = document.elementFromPoint((l + rr) / 2, (t + b) / 2);
      if (!top || !(el.contains(top) || top.contains(el))) continue;
      const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.textContent ?? "").trim().slice(0, 24) || el.tagName;
      controls.push({ name, rect: [l, t, rr, b].map(v => Math.round(v * 10) / 10) });
    }
    if (share) share.style.visibility = "";
    const rect = box ? [box.left, box.top, box.right, box.bottom].map(v => Math.round(v * 10) / 10) : undefined;
    const overlaps = rect ? controls.filter(c => c.rect[0] < rect[2] && c.rect[2] > rect[0] && c.rect[1] < rect[3] && c.rect[3] > rect[1]) : [];
    const css = (name: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
    const position = share ? getComputedStyle(share).position : undefined;
    return { position, viewport: [innerWidth, innerHeight], safe: ["--app-safe-top", "--app-safe-right", "--app-safe-bottom", "--app-safe-left"].map(css), share: rect, selfHit, overlaps, controls };
  });
}

/** Scene transitions slide the page in; measure once nothing moves between frames. */
async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every(a => a.effect?.getComputedTiming().iterations === Infinity || a.playState !== "running"));
  await page.waitForFunction(() => new Promise<boolean>(resolve => {
    const shape = () => [...document.querySelectorAll(".share-inbox-button,.mobile-home,.conversation-main,.conversation-header")].map(el => { const r = el.getBoundingClientRect(); return `${r.x},${r.y},${r.width},${r.height}`; }).join(";");
    const before = shape(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(shape() === before)));
  }));
}
async function record(page: Page, name: string) {
  await settle(page);
  const data = await measure(page);
  if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); await writeFile(path.join(shots, `${name}.json`), JSON.stringify(data, null, 1)); }
  return data;
}

async function withHub(page: Page, run: (page: Page) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "share-placement-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','产品搭档','fixture')");
    const conversation = await hub.store.createConversation("owner", ["alpha"], title, "share-placement");
    for (let i = 0; i < 30; i++) await hub.store.publishBotMessage("alpha", { conversationId: conversation.id, blocks: [{ type: "text", text: `第 ${i + 1} 条回复：用于把聊天滚动起来，检查回到底部按钮。` }], status: "complete" });
    await bootstrap(page);
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page); await showDisconnectedBots(page);
    await run(page);
  } finally { await page.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}

const nav = (page: Page) => mobileHome(page).getByRole("navigation", { name: "主导航" });

async function keyboard(page: Page, height: number) {
  await page.evaluate(height => {
    const root = document.documentElement;
    root.dataset.keyboardResize = "overlay"; root.dataset.keyboardOpen = height ? "true" : "false";
    if (height) root.style.setProperty("--app-height", `${innerHeight - height}px`); else root.style.removeProperty("--app-height");
  }, height);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}
async function chatScenarios(page: Page, label: string, keyboardHeight: number, phone: boolean) {
  const out: Record<string, Awaited<ReturnType<typeof measure>>> = {};
  if (phone) {
    await nav(page).getByRole("button", { name: /^消息/ }).click();
    await mobileHome(page).getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).click();
  } else await page.locator(".host-workspace:not([hidden])").getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first().click();
  await expect(page.locator(".message-scroll")).toContainText("第 30 条回复");
  out.chat = await record(page, `${label}-chat`);
  await page.locator(".message-scroll").evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
  const list = await page.locator(".message-scroll").boundingBox();
  await page.mouse.move(list!.x + list!.width / 2, list!.y + list!.height / 2); await page.mouse.wheel(0, -2000);
  await expect(page.locator(".jump-latest").filter({ visible: true })).toBeVisible();
  out["chat-scrolled"] = await record(page, `${label}-chat-scrolled`);
  await page.locator(".jump-latest").filter({ visible: true }).click();
  const composer = page.locator(".composer textarea").filter({ visible: true }).first();
  await composer.focus(); await keyboard(page, keyboardHeight);
  out["chat-keyboard"] = await record(page, `${label}-chat-keyboard`);
  await composer.blur(); await keyboard(page, 0);
  return out;
}

type Geometry = Awaited<ReturnType<typeof measure>>;
function expectClear(name: string, data: Geometry) {
  expect(data.share, `${name}: entry shown`).toBeDefined();
  const [left, top, right, bottom] = data.share!, [width, height] = data.viewport, [safeTop, safeRight, safeBottom, safeLeft] = data.safe;
  expect(data.overlaps, `${name}: covers no control`).toEqual([]);
  expect(data.selfHit, `${name}: hit-tests as itself`).toBe(true);
  expect(data.position, `${name}: in flow, below every layer`).toBe("static");
  expect(right - left, `${name}: target width`).toBeGreaterThanOrEqual(44);
  expect(bottom - top, `${name}: target height`).toBeGreaterThanOrEqual(44);
  expect(left, `${name}: left safe area`).toBeGreaterThanOrEqual(safeLeft);
  expect(right, `${name}: right safe area`).toBeLessThanOrEqual(width - safeRight);
  expect(top, `${name}: top safe area`).toBeGreaterThanOrEqual(safeTop);
  expect(bottom, `${name}: bottom safe area`).toBeLessThanOrEqual(height - safeBottom);
}
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
async function openChat(page: Page, phone: boolean) {
  if (phone) {
    await nav(page).getByRole("button", { name: /^消息/ }).click();
    await mobileHome(page).getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).click();
  } else await workspace(page).getByRole("button").filter({ has: page.getByText(title, { exact: true }) }).first().click();
  await expect(page.locator(".message-scroll")).toContainText("第 30 条回复");
}
const entry = (page: Page) => page.getByRole("button", { name: "待发送分享 (1)", exact: true });

for (const [label, platform, width, height, insets, keyboardHeight] of [
  ["iphone-portrait", "ios", 430, 932, IPHONE_PORTRAIT, 346],
  ["iphone-landscape", "ios", 932, 430, IPHONE_LANDSCAPE, 210],
  ["android-portrait", "android", 412, 846, NONE, 320],
  ["android-landscape", "android", 870, 388, NONE, 200],
  ["ipad-portrait", "ios", 820, 1180, IPAD, 400],
  ["ipad-landscape", "ios", 1180, 820, IPAD, 400],
] as const) test(`pending share entry covers no control: ${label}`, async ({ browser }) => {
  const phone = width <= 760;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "zh-CN" });
  await withHub(await context.newPage(), async page => {
    await goNative(page, platform, insets);
    if (phone) {
      // Any App render after the flip picks up the native share bridge.
      await nav(page).getByRole("button", { name: /^Bot/ }).click();
      await expect(entry(page)).toBeVisible();
      for (const tab of ["消息", "Bot", "我的"]) {
        await nav(page).getByRole("button", { name: new RegExp(`^${tab}`) }).click();
        await expect(mobileHome(page)).toHaveAttribute("data-tab", tab === "消息" ? "messages" : tab === "Bot" ? "bots" : "me");
        expectClear(`${label} ${tab}`, await record(page, `${label}-${tab}`));
      }
    }
    await openChat(page, phone);
    await expect(entry(page)).toBeVisible();
    expectClear(`${label} chat`, await record(page, `${label}-chat`));
    // Away from the latest message the jump button appears above the composer.
    const list = (await page.locator(".message-scroll").boundingBox())!;
    await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2); await page.mouse.wheel(0, -2000);
    await expect(page.locator(".jump-latest").filter({ visible: true })).toBeVisible();
    expectClear(`${label} chat scrolled`, await record(page, `${label}-chat-scrolled`));
    await page.locator(".jump-latest").filter({ visible: true }).click();
    // Typing: the row steps aside instead of shrinking the visible chat further.
    const composer = page.locator(".composer textarea").filter({ visible: true }).first();
    await composer.focus(); await keyboard(page, keyboardHeight);
    const typing = await record(page, `${label}-chat-keyboard`);
    expect(typing.share).toEqual([0, 0, 0, 0]); expect(typing.overlaps).toEqual([]); await expect(entry(page)).toBeHidden();
    await composer.blur(); await keyboard(page, 0);
    await expect(entry(page)).toBeVisible();
    // The review dialog layers above the entry and returns focus to it.
    await entry(page).click();
    const dialog = page.getByRole("dialog", { name: "收到的分享", exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog).toContainText("来自系统分享的草稿");
    await settle(page);
    expect(await entry(page).evaluate(el => { const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && !el.contains(hit); })).toBe(true);
    if (shots) await page.screenshot({ path: path.join(shots, `${label}-dialog.png`) });
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toBeHidden(); await expect(entry(page)).toBeFocused();
  });
  await context.close();
});

test("an empty or unreadable inbox shows no entry; pending shares still show the read error", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "zh-CN" });
  await withHub(await context.newPage(), async page => {
    await page.evaluate(() => { (window as any).__share.mode = "error"; });
    await goNative(page, "ios", IPHONE_PORTRAIT);
    await nav(page).getByRole("button", { name: /^Bot/ }).click(); await nav(page).getByRole("button", { name: /^消息/ }).click();
    // Several 2.5 s polls fail; no "(0)" entry ever appears, at home or in the chat.
    await expect.poll(() => page.evaluate(() => (window as any).__share.calls.filter((c: string) => c.endsWith(".list")).length), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".share-inbox-button")).toHaveCount(0);
    await expect(page.getByText(/待发送分享/)).toHaveCount(0);
    if (shots) { await settle(page); await page.screenshot({ path: path.join(shots, "iphone-portrait-error-empty.png") }); }
    await openChat(page, true);
    await expect(page.locator(".share-inbox-button")).toHaveCount(0);
    await page.evaluate(() => { (window as any).__share.mode = "none"; });
    const before = await page.evaluate(() => (window as any).__share.calls.length);
    await expect.poll(() => page.evaluate(() => (window as any).__share.calls.length), { timeout: 10_000 }).toBeGreaterThan(before);
    await expect(page.locator(".share-inbox-button")).toHaveCount(0);
    // A new share appears on the next poll and opens the review dialog.
    await page.evaluate(() => { (window as any).__share.mode = "one"; });
    await expect(entry(page)).toBeVisible({ timeout: 10_000 });
    // A later read failure keeps the pending item and explains itself in the dialog.
    await page.evaluate(() => { (window as any).__share.mode = "error"; });
    await entry(page).click();
    const dialog = page.getByRole("dialog", { name: "收到的分享", exact: true });
    await expect(dialog.getByRole("alert").filter({ hasText: "share_app_group_unavailable" })).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText("来自系统分享的草稿");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(entry(page)).toBeVisible();
  });
  await context.close();
});
