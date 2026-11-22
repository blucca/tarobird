import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { unavailableQuota } from "../../src/codex/account-quota.js";
import type { QuotaSnapshot } from "../../src/client-protocol/engine-quota.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { createServer } from "./fixtures/vite.js";

test.use({ serviceWorkers: "block" });
type Readings = { context?: { used: number; window: number; compact?: number }; limits: Array<{ id: "primary" | "secondary"; used: number; period: number; resetHours: number }> };
const plenty = (): Readings => ({ context: { used: 76_000, window: 200_000, compact: 168_000 }, limits: [{ id: "primary", used: 20, period: 18_000, resetHours: 2 }, { id: "secondary", used: 10, period: 604_800, resetHours: 120 }] });
const nearlyGone = (): Readings => ({ context: { used: 176_000, window: 200_000, compact: 168_000 }, limits: [{ id: "primary", used: 66, period: 18_000, resetHours: 2 }, { id: "secondary", used: 99, period: 604_800, resetHours: 120 }] });
function quota(limits: Readings["limits"]): QuotaSnapshot {
  const now = Date.now(), at = new Date(now).toISOString(), expiresAt = new Date(now + 60_000).toISOString();
  return { authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "unknown", observedAt: at, lastAttemptAt: at, constraints: [], help: "codex_usage",
    pools: [{ id: "codex", label: "Codex", sharing: "unspecified", availability: "unknown", balances: [], constraints: [], windows: limits.map(item => ({ id: item.id, label: item.id === "primary" ? "Primary" : "Secondary", metric: "percent" as const, usedPercent: item.used,
      availability: "unknown" as const, observedAt: at, expiresAt, periodSeconds: item.period, resetsAt: new Date(now + item.resetHours * 3_600_000).toISOString() })) }] };
}
/** A Bot whose engine reports the given readings. Like a real engine it has no quota reading until it is asked once. */
async function bot(hub: HubServer, root: string, id: string, engine: "codex" | "claude", readings?: { value: Readings; quota: boolean; asked: boolean[] }) {
  const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, model: engine === "codex" ? "gpt-6.1-sol" : "opus", effort: "high", locale: "zh" }));
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
  let loaded = false;
  const bridge: CoreBridgeLike = { handleAuthorizedMessage: async () => ({ text: "好的" }),
    ...(readings ? { getContextUsage: async () => readings.value.context ? { pressureTokens: readings.value.context.used, contextWindow: readings.value.context.window, autoCompactTokens: readings.value.context.compact } : null } : {}),
    ...(readings?.quota ? { readAccountQuota: async (options: { refresh: boolean }) => { readings.asked.push(options.refresh); if (options.refresh) loaded = true; return { revision: "revision_one", snapshot: loaded ? quota(readings.value.limits) : unavailableQuota("codex", "not_loaded") }; } } : {}) };
  return attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, model: engine === "codex" ? "gpt-6.1-sol" : "opus", effort: "high", runtime: createCoreServiceRuntime(), bridge });
}
const workspace = (page: Page) => page.locator(".host-workspace:not([hidden])");
function requests(page: Page) {
  const seen: string[] = [];
  page.on("request", request => { const url = new URL(request.url()); if (/\/context-usage$|\/api\/engine-quotas\//.test(url.pathname)) seen.push(url.pathname + url.search); });
  return seen;
}
async function fixture(page: Page) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-indicators-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
  await hub.profile.update({ name: "测试主机", revision: (await hub.profile.read()).revision });
  const readings = { value: plenty(), quota: true, asked: [] as boolean[] };
  const gateways = [await bot(hub, root, "alpha", "codex", readings), await bot(hub, root, "beta", "claude"), await bot(hub, root, "gamma", "codex", { value: plenty(), quota: false, asked: [] })];
  const both = await hub.store.createConversation("owner", ["alpha"], "有读数", "both");
  await hub.store.createConversation("owner", ["beta"], "读不到", "none");
  await hub.store.createConversation("owner", ["gamma"], "只有上下文", "context");
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" }); await waitForClientOnline(page);
  return { hub, readings, both, dispose: async () => { await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}

test("desktop: ring and battery sit left of the model controls, each only when readable, with every window in the details", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const ws = workspace(page), indicators = ws.locator(".usage-indicators"), ring = indicators.locator("[data-usage=context]"), battery = indicators.locator("[data-usage=quota]");
    await selectConversation(page, "有读数");
    await expect(ring).toHaveText("62%"); await expect(battery).toHaveText("80%");
    await expect(ring).toHaveAttribute("data-tone", "ok"); await expect(battery).toHaveAttribute("data-tone", "ok");
    await expect(indicators).toHaveAccessibleName("上下文可用 62%，额度可用 80%");
    const layout = await ws.locator(".composer-toolbar").evaluate(toolbar => {
      const box = (selector: string) => toolbar.querySelector(selector)!.getBoundingClientRect(), usage = box(".usage-indicators"), model = box(".composer-model-controls"), send = box(".send-button");
      return { usageRight: usage.right, modelLeft: model.left, usageMiddle: usage.top + usage.height / 2, modelMiddle: model.top + model.height / 2, sendRight: send.right, toolbarRight: toolbar.getBoundingClientRect().right, overflow: toolbar.scrollWidth - toolbar.clientWidth };
    });
    expect(layout.usageRight).toBeLessThanOrEqual(layout.modelLeft + 1);
    expect(Math.abs(layout.usageMiddle - layout.modelMiddle)).toBeLessThan(3);
    expect(layout.sendRight).toBeLessThanOrEqual(layout.toolbarRight + 1); expect(layout.overflow).toBeLessThanOrEqual(1);
    await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-plenty.png"), animations: "disabled" });
    // The symbol's text is that of the model control beside it, not the toolbar's larger pill buttons.
    const type = await ws.locator(".composer-toolbar").evaluate(toolbar => { const style = (selector: string) => { const value = getComputedStyle(toolbar.querySelector(selector)!); return [value.fontSize, value.fontWeight, value.color].join(); }; return [style(".usage-indicators"), style(".composer-model-trigger")]; });
    expect(type[0]).toBe(type[1]);
    // Narrow desktop windows: nothing is pushed out of the composer and both numbers stay whole.
    for (const width of [900, 780, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      const narrow = await ws.locator(".composer-toolbar").evaluate(toolbar => { const usage = toolbar.querySelector(".usage-indicators")!, send = toolbar.querySelector(".send-button")!.getBoundingClientRect(), box = toolbar.getBoundingClientRect();
        return { overflow: toolbar.scrollWidth - toolbar.clientWidth, clipped: usage.scrollWidth - usage.clientWidth, sendRight: send.right, right: box.right, usageLeft: usage.getBoundingClientRect().left, left: box.left, page: document.documentElement.scrollWidth - innerWidth }; });
      expect(narrow.overflow, `${width}: ${JSON.stringify(narrow)}`).toBeLessThanOrEqual(1); expect(narrow.clipped).toBeLessThanOrEqual(0);
      expect(narrow.sendRight).toBeLessThanOrEqual(narrow.right + 1); expect(narrow.usageLeft).toBeGreaterThanOrEqual(narrow.left); expect(narrow.page).toBeLessThanOrEqual(0);
      if (width === 780) await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-780.png"), animations: "disabled" });
    }

    await indicators.click();
    const panel = page.getByRole("group", { name: "上下文与额度", exact: true });
    await expect(panel).toBeVisible(); await expect(indicators).toHaveAttribute("aria-expanded", "true");
    const context = panel.getByRole("region", { name: "上下文", exact: true }), limits = panel.getByRole("region", { name: "额度 · Codex", exact: true });
    await expect(context).toContainText("62%"); await expect(context).toContainText("已用 76k / 200k"); await expect(context).toContainText("用到约 84% 时自动压缩");
    await expect(limits.locator(".usage-window")).toHaveCount(2);
    await expect(limits.locator(".usage-window").nth(0)).toContainText("5 小时"); await expect(limits.locator(".usage-window").nth(0)).toContainText("80%");
    await expect(limits.locator(".usage-window").nth(1)).toContainText("7 天"); await expect(limits.locator(".usage-window").nth(1)).toContainText("90%");
    await expect(limits.locator(".usage-window").nth(0)).toContainText(/\d{2}:\d{2} 重置/); await expect(limits.locator(".usage-window").nth(1)).toContainText(/\d+月\d+日 \d{2}:\d{2} 重置/);
    await expect(panel.getByRole("meter", { name: "上下文可用", exact: true })).toHaveAttribute("aria-valuenow", "62");
    await expect(panel).toContainText(/\d{2}:\d{2} 读取/);
    expect(`${await indicators.innerText()}${await panel.innerText()}`).not.toContain("剩");
    const placed = await panel.evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight }; });
    expect(placed.left).toBeGreaterThanOrEqual(0); expect(placed.right).toBeLessThanOrEqual(placed.width); expect(placed.top).toBeGreaterThanOrEqual(0);
    expect(placed.bottom).toBeLessThanOrEqual((await indicators.boundingBox())!.y);
    await page.screenshot({ path: info.outputPath("desktop-details.png"), animations: "disabled" });
    await page.keyboard.press("Escape"); await expect(panel).toBeHidden(); await expect(indicators).toBeFocused();

    // Neither reading: no symbol at all, the model controls stay.
    await selectConversation(page, "读不到");
    await expect(ws.locator(".composer-model-controls")).toBeVisible(); await expect(indicators).toHaveCount(0);
    // Only the context can be read: only the ring.
    await selectConversation(page, "只有上下文");
    await expect(ring).toHaveText("62%"); await expect(battery).toHaveCount(0);
    await expect(indicators).toHaveAccessibleName("上下文可用 62%");

    // Amber at a fifth left, red at a twentieth; the battery shows the tighter window.
    f.readings.value = nearlyGone();
    await selectConversation(page, "有读数");
    await expect(ring).toHaveText("12%"); await expect(battery).toHaveText("1%");
    await expect(ring).toHaveAttribute("data-tone", "low"); await expect(battery).toHaveAttribute("data-tone", "empty");
    await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-low.png"), animations: "disabled" });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const colours = await indicators.evaluate(node => ({ ring: getComputedStyle(node.querySelector(".usage-ring-left")!).stroke, battery: getComputedStyle(node.querySelector(".usage-battery-left")!).fill, text: getComputedStyle(node).color }));
      expect(new Set([colours.ring, colours.battery, colours.text]).size, JSON.stringify(colours)).toBe(3);
      if (theme === "dark") await ws.locator(".composer").screenshot({ path: info.outputPath("desktop-low-dark.png"), animations: "disabled" });
    }

    // A reply ends: both are read again, without a timer.
    f.readings.value = { context: { used: 100_000, window: 200_000 }, limits: plenty().limits };
    await page.getByLabel("消息", { exact: true }).fill("你好"); await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(ws.locator(".message.bot").filter({ hasText: "好的" })).toHaveCount(1);
    await expect(ring).toHaveText("50%"); await expect(battery).toHaveText("80%");
    // The engine itself was asked once; every later number came from what the Host already held.
    expect(f.readings.asked.filter(Boolean)).toHaveLength(1);
  } finally { await f.dispose(); }
});

test("ADHD panes show no symbols and ask for no readings", async ({ page }) => {
  const f = await fixture(page);
  try {
    const seen = requests(page);
    await selectConversation(page, "有读数");
    await expect(workspace(page).locator(".usage-indicators")).toBeVisible();
    const before = seen.length;
    await page.getByRole("button", { name: "打开 ADHD 模式", exact: true }).click();
    for (const title of ["有读数", "只有上下文"]) await page.getByRole("checkbox", { name: `加入面板：测试主机 · ${title}`, exact: true }).check();
    await expect(page.locator(".adhd-card")).toHaveCount(2);
    await expect(page.locator(".adhd-card .composer")).toHaveCount(2);
    await expect(page.locator(".usage-indicators")).toHaveCount(0);
    const card = page.locator(`.adhd-card[data-pane-conversation="${f.both.id}"]`);
    await card.locator(".composer textarea").fill("窗口里发一条"); await card.locator(".send-button").click();
    await expect(card.locator(".message-blocks").filter({ hasText: "好的" })).toHaveCount(1);
    await expect(page.locator(".usage-indicators")).toHaveCount(0);
    expect(seen.slice(before)).toEqual([]);
    await page.getByRole("button", { name: "返回聊天", exact: true }).click();
    await selectConversation(page, "有读数");
    await expect(workspace(page).locator(".usage-indicators")).toBeVisible();
  } finally { await f.dispose(); }
});

test("phone: nothing beside the composer and no context; quota in the more sheet; a red battery in the header only when nearly gone", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    const seen = requests(page);
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await waitForClientOnline(page);
    const ws = workspace(page), header = ws.locator(".conversation-header");
    await selectConversation(page, "有读数");
    await expect.poll(() => seen.filter(url => url.includes("/api/engine-quotas/alpha")).length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "更多聊天操作", exact: true }).filter({ visible: true }).click();
    const row = page.getByRole("button", { name: "额度", exact: true });
    await expect(row).toBeVisible(); await expect(row.locator(".action-value")).toHaveText("80%");
    await expect(page.locator(".usage-indicators")).toHaveCount(0); await expect(header.locator(".quota-low-mark")).toHaveCount(0);
    const rows = await page.locator(".mobile-chat-action-list").filter({ has: row }).locator("button").evaluateAll(nodes => nodes.map(node => ({ text: node.querySelector(".action-label")?.textContent, height: node.getBoundingClientRect().height, overflow: node.scrollWidth - node.clientWidth })));
    expect(rows[0]!.text).toBe("额度"); expect(rows[1]!.text).toBe("连接状态与线路"); expect(rows[0]!.height).toBeCloseTo(rows[1]!.height, 0); expect(rows[0]!.overflow).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("phone-more.png"), animations: "disabled" });
    await row.click();
    const details = page.getByRole("dialog", { name: "额度", exact: true });
    await expect(details.getByRole("region", { name: "额度 · Codex", exact: true }).locator(".usage-window")).toHaveCount(2);
    await expect(details).toContainText("5 小时"); await expect(details).toContainText("7 天"); await expect(details).not.toContainText("上下文");
    expect(await details.innerText()).not.toContain("剩");
    await page.screenshot({ path: info.outputPath("phone-details.png"), animations: "disabled" });
    await details.getByRole("button", { name: "关闭额度", exact: true }).click(); await expect(details).toBeHidden();

    // Nearly gone: the battery appears alone where the computer's name would be.
    f.readings.value = nearlyGone();
    await selectConversation(page, "读不到"); await expect(header.locator(".quota-low-mark")).toHaveCount(0);
    await selectConversation(page, "有读数");
    const mark = header.getByRole("button", { name: "额度快用完了，查看额度", exact: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(mark).toBeVisible();
      const layout = await header.evaluate(node => { const box = node.getBoundingClientRect(), title = node.querySelector(".header-title")!.getBoundingClientRect(), item = node.querySelector(".quota-low-mark")!.getBoundingClientRect(), battery = node.querySelector(".quota-low-mark .usage-battery-left")!;
        return { titleRight: title.right, markLeft: item.left, markRight: item.right, markWidth: item.width, right: box.right, overflow: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - innerWidth, fill: getComputedStyle(battery).fill, red: getComputedStyle(node).getPropertyValue("--red") }; });
      expect(layout.markLeft).toBeGreaterThanOrEqual(layout.titleRight - 1); expect(layout.markRight).toBeLessThanOrEqual(layout.right + 1);
      expect(layout.markWidth).toBeGreaterThanOrEqual(32); expect(layout.overflow).toBeLessThanOrEqual(1); expect(layout.page).toBeLessThanOrEqual(0);
      await header.screenshot({ path: info.outputPath(`phone-header-low-${width}.png`), animations: "disabled" });
    }
    await mark.click();
    await expect(details).toContainText("1%"); await expect(details.locator("[data-tone=empty]").first()).toBeVisible();
    await details.getByRole("button", { name: "关闭额度", exact: true }).click();
    // The phone never asked for context.
    expect(seen.filter(url => url.includes("/context-usage"))).toEqual([]);
  } finally { await f.dispose(); }
});

test("phone with two computers: the red battery sits under the computer's name", async ({ page }, info) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-two-hosts-"));
  const vite = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false } }); await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!;
  const a = await HubServer.start({ stateDir: path.join(root, "a"), origins: [new URL(origin).origin] }), b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [new URL(origin).origin] });
  const readings = { value: nearlyGone(), quota: true, asked: [] as boolean[] };
  const gateway = await bot(a, root, "alpha", "codex", readings);
  async function pair(hub: HubServer, name: string, add = false) {
    await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
    if (add) await clickAppAction(page, "连接另一台主机", workspace(page).getByRole("button", { name: "连接另一台主机", exact: true })); else await page.goto(origin);
    await page.getByLabel("主机名称", { exact: true }).fill(name); await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(workspace(page).locator(".connection-pill.online")).toBeVisible();
  }
  try {
    await a.store.createConversation("owner", ["alpha"], "有读数", "both");
    await pair(a, "办公室电脑"); await pair(b, "家里电脑", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await workspace(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    await workspace(page).locator(".mobile-home .mh-row").filter({ hasText: "有读数" }).click();
    const header = workspace(page).locator(".conversation-header"), low = header.getByRole("button", { name: "运行于 办公室电脑，额度快用完了，查看额度", exact: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(low).toBeVisible();
      const layout = await header.evaluate(node => { const item = node.querySelector(".header-host-usage")!, chip = item.querySelector(".host-source-badge")!.getBoundingClientRect(), battery = item.querySelector(".usage-battery")!.getBoundingClientRect(), box = item.getBoundingClientRect(), title = node.querySelector(".header-title")!.getBoundingClientRect();
        return { chipBottom: chip.bottom, batteryTop: battery.top, chipMiddle: chip.left + chip.width / 2, batteryMiddle: battery.left + battery.width / 2, left: box.left, right: box.right, headerRight: node.getBoundingClientRect().right, titleRight: title.right, titleWidth: title.width, top: box.top, bottom: box.bottom, headerTop: node.getBoundingClientRect().top, headerBottom: node.getBoundingClientRect().bottom, overflow: node.scrollWidth - node.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; });
      expect(layout.batteryTop).toBeGreaterThanOrEqual(layout.chipBottom - 1);
      expect(Math.abs(layout.batteryMiddle - layout.chipMiddle)).toBeLessThan(2);
      expect(layout.left).toBeGreaterThanOrEqual(layout.titleRight - 1); expect(layout.right).toBeLessThanOrEqual(layout.headerRight + 1);
      expect(layout.top).toBeGreaterThanOrEqual(layout.headerTop - 1); expect(layout.bottom).toBeLessThanOrEqual(layout.headerBottom + 1);
      expect(layout.titleWidth).toBeGreaterThan(88); expect(layout.overflow).toBeLessThanOrEqual(1); expect(layout.page).toBeLessThanOrEqual(0);
      await header.screenshot({ path: info.outputPath(`phone-two-hosts-low-${width}.png`), animations: "disabled" });
    }
    await low.click();
    await expect(page.getByRole("dialog", { name: "额度", exact: true })).toContainText("1%");
    await page.getByRole("dialog", { name: "额度", exact: true }).getByRole("button", { name: "关闭额度", exact: true }).click();
    // With quota to spare the computer's name is the plain chip it was, and nothing sits under it.
    readings.value = plenty();
    await workspace(page).getByRole("button", { name: "打开会话列表", exact: true }).click();
    await workspace(page).locator(".mobile-home .mh-row").filter({ hasText: "有读数" }).click();
    await expect(header.locator(".header-host-usage")).toHaveCount(0);
    await expect(header.locator(":scope > .host-source-badge.header-host-source")).toHaveAttribute("title", "运行于 办公室电脑");
    await header.screenshot({ path: info.outputPath("phone-two-hosts-plenty.png"), animations: "disabled" });
  } finally { await page.close(); await gateway.disconnect(); await a.close(); await b.close(); await vite.close(); await rm(root, { recursive: true, force: true }); }
});
