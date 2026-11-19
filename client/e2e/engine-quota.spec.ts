import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../../src/hub/server.js";
import { ENGINE_QUOTA_CAPABILITY } from "../../src/client-protocol/engine-quota.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { isPhone, mobileHome, openWorkspacePage, waitForClientOnline } from "./fixtures/mobile.js";
import { mockQuota, officeQuota, quotaCount, quotaDouble, sealedEngines, studioQuota, type QuotaDouble } from "./fixtures/engine-quota.js";

// The owner's model quota page in the real App against real Hubs. The quota
// routes are answered by a recording double with synthetic readings (example
// Hosts and Bots), except in the last test, which calls the real routes of a
// Hub whose engine environment is sealed: no real engine or login is read.
test.use({ serviceWorkers: "block" });

type Hosts = { studio: HubServer; office?: HubServer; doubles: { studio: QuotaDouble; office: QuotaDouble }; dispose: () => Promise<void> };
async function pair(page: Page, hub: HubServer) {
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
}
/** One or two paired Hosts. `mock: false` leaves the real quota routes in place. */
async function hosts(page: Page, options: { second?: boolean; mock?: boolean; beforePairing?: () => Promise<void> } = {}): Promise<Hosts> {
  const second = options.second !== false, opened: HubServer[] = [], roots: string[] = [];
  const dispose = async () => { await page.close().catch(() => undefined); for (const hub of opened) await hub.close().catch(() => undefined); for (const root of roots) await rm(root, { recursive: true, force: true }); };
  try {
    const start = async (name: string, origins?: string[]) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "engine-quota-ui-")); roots.push(root);
      const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist"), managedBots: sealedEngines(root), ...(origins ? { origins } : {}) }); opened.push(hub);
      await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
      return hub;
    };
    const studio = await start("Studio Mac"), office = second ? await start("Office PC", [studio.url]) : undefined;
    const doubles = { studio: quotaDouble(now => studioQuota(now)), office: quotaDouble(now => officeQuota(now)) };
    if (options.mock !== false) { await mockQuota(page.context(), studio.url, studio.url, doubles.studio); if (office) await mockQuota(page.context(), office.url, studio.url, doubles.office); }
    await options.beforePairing?.();
    await page.goto(studio.url); await pair(page, studio); await waitForClientOnline(page);
    if (office) {
      await clickAppAction(page, "连接另一台主机");
      await page.getByLabel("主机名称", { exact: true }).fill("Office PC"); await page.getByLabel("Hub 地址", { exact: true }).fill(office.url);
      await pair(page, office);
      await page.getByLabel("筛选运行主机").filter({ visible: true }).first().selectOption({ label: "Studio Mac" }); await waitForClientOnline(page);
    }
    return { studio, office, doubles, dispose };
  } catch (error) { await dispose(); throw error; }
}
async function openQuota(page: Page, english = false) {
  if (isPhone(page)) {
    await mobileHome(page).getByRole("navigation").getByRole("button", { name: english ? "Me" : "我的", exact: true }).click();
    await mobileHome(page).getByRole("button", { name: english ? /^Model quota/ : /^模型额度/ }).click();
  } else {
    await openWorkspacePage(page, english ? "Settings" : "设置");
    await page.getByRole("navigation", { name: english ? "Settings categories" : "设置分类" }).getByRole("button", { name: english ? /^Model quota/ : /^模型额度/ }).click();
  }
  return page.locator(".engine-quota:visible");
}
const host = (panel: Locator, name: string, english = false) => panel.getByRole("region", { name: `${english ? "Host: " : "主机："}${name}`, exact: true });
/** Nothing spills sideways, nothing is clipped, and no figure leaves its own row. */
const layout = (page: Page) => page.evaluate(() => ({
  page: document.documentElement.scrollWidth - innerWidth,
  clipped: [...document.querySelectorAll<HTMLElement>(".engine-quota *")].filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "visible").map(node => node.className),
  cutFigures: [...document.querySelectorAll<HTMLElement>(".quota-window-value, .quota-balances dd")].filter(node => { const row = node.closest<HTMLElement>(".quota-window, .quota-balances")!.getBoundingClientRect(), box = node.getBoundingClientRect(); return box.left < row.left - 1 || box.right > row.right + 1; }).map(node => node.textContent),
}));
const tidy = { page: 0, clipped: [], cutFigures: [] };
const windowBoxes = (entry: Locator) => entry.locator(".quota-window").evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: Math.round(box.x), y: Math.round(box.y), bottom: Math.round(box.bottom) }; }));

test("desktop Settings shows one section per Host with every state, in Chinese and English", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 900 }); const f = await hosts(page);
  try {
    const panel = await openQuota(page), studio = host(panel, "Studio Mac"), office = host(panel, "Office PC");
    await expect(panel.getByRole("article")).toHaveCount(10);
    // Opening the page reads each Host once and refreshes nothing.
    expect([quotaCount(f.doubles.studio, "GET"), quotaCount(f.doubles.office, "GET"), quotaCount(f.doubles.studio, "POST"), quotaCount(f.doubles.office, "POST")]).toEqual([1, 1, 0, 0]);
    await expect(studio).toContainText("已连接"); await expect(studio.getByRole("article")).toHaveCount(5); await expect(office.getByRole("article")).toHaveCount(5);

    // Remaining share, reset time, the Bots that share the login, and a warning from 80 % used.
    const codex = studio.getByRole("article", { name: "Codex Pro", exact: true });
    await expect(codex.locator(".quota-window-name")).toHaveText(["5 小时额度", "7 天额度"]);
    await expect(codex.locator(".quota-window-value")).toHaveText(["剩余 58%", "剩余 19%"]);
    expect(await codex.locator(".quota-window").evaluateAll(nodes => nodes.map(node => [node.getAttribute("data-tone"), node.querySelector<HTMLElement>(".quota-meter span")?.style.getPropertyValue("--quota-fill")]))).toEqual([["normal", "58%"], ["warning", "19%"]]);
    await expect(codex).toContainText(/2 小时 5\d 分后重置/); await expect(codex.locator(".quota-chip")).toHaveText("快用完"); await expect(codex).toContainText("刚刚更新");
    await expect(codex.locator("time[datetime]").first()).toHaveAttribute("title", /.+/);
    await codex.getByText("2 个 Bot 共用", { exact: true }).click();
    await expect(codex.locator(".quota-bots li")).toHaveText(["写作助手", "代码审查"]);
    // Wide layout: the two windows sit side by side.
    const wide = await windowBoxes(codex); expect(wide[1]!.x).toBeGreaterThan(wide[0]!.x); expect(Math.abs(wide[1]!.y - wide[0]!.y)).toBeLessThanOrEqual(1);

    // Unknown is a sentence, never 0 % or a full bar.
    const claude = studio.getByRole("article", { name: "Claude Code", exact: true });
    await expect(claude.locator(".quota-chip")).toHaveText("暂无数据"); await expect(claude).toContainText("还没有读到额度，下一次对话后更新。"); await expect(claude).toContainText("Bot：规划助手");
    await expect(claude).not.toContainText("%"); await expect(claude.locator(".quota-meter")).toHaveCount(0);

    // Windows that share a pool name sit under it once, shorter first; they are not added up.
    const antigravity = studio.getByRole("article", { name: "Antigravity", exact: true });
    await expect(antigravity.locator(".quota-group-name")).toHaveText(["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"]);
    const gemini = antigravity.getByRole("region", { name: "Gemini Models", exact: true });
    await expect(gemini.locator(".quota-window-name")).toHaveText(["5 小时额度", "7 天额度"]);
    await expect(gemini.locator(".quota-window-value")).toHaveText(["已用完", "剩余 36%"]);
    // A used-up pool has an empty track, not a sliver of bar.
    await expect(gemini.locator(".quota-window").first().locator(".quota-meter span")).toBeHidden();
    await gemini.getByText("适用 5 个模型", { exact: true }).click();
    await expect(gemini.locator(".quota-models li")).toHaveCount(5); await expect(gemini.locator(".quota-models li").first()).toHaveText("gemini-pro-latest");
    await expect(antigravity.getByRole("region", { name: "Gemini 4 Argon", exact: true })).toContainText("适用模型：gemini-4-argon");
    await expect(antigravity.locator(".quota-chip")).toHaveText("已用完");
    // Balances keep the upstream's own unit.
    await expect(antigravity.locator(".quota-balances")).toHaveText("余额120 credits");
    await expect(studio.getByRole("article", { name: "DeepSeek", exact: true }).locator(".quota-balances")).toHaveText("余额¥38.50");
    await expect(studio.getByRole("article", { name: "Kimi", exact: true })).toContainText("尚未适配");

    // Over the limit is said in words; no negative share appears anywhere.
    const officeCodex = office.getByRole("article", { name: "Codex Plus", exact: true });
    await expect(officeCodex.locator(".quota-window-value")).toHaveText(["已超额", "剩余 45%"]); await expect(officeCodex.locator(".quota-chip")).toHaveText("已超额");
    await expect(panel).not.toContainText(/-\d+(\.\d+)?\s*%/);
    expect((await panel.locator(".quota-window-value").allTextContents()).filter(text => /-/.test(text))).toEqual([]);
    const shared = office.getByRole("article", { name: "Claude Code Max", exact: true });
    await expect(shared).toContainText("更新于 25 分钟前"); await shared.getByText("3 个 Bot 共用", { exact: true }).click();
    await expect(shared.locator(".quota-bots li")).toHaveText(["资料研究员", "翻译助手", "客服草稿"]);
    const signIn = office.getByRole("article", { name: "Antigravity", exact: true });
    await expect(signIn.locator(".quota-chip")).toHaveText("需要登录"); await expect(signIn).toContainText("请在主机上重新登录 Antigravity。");
    await expect(signIn.getByRole("link", { name: "去官方页面查看" })).toHaveAttribute("href", "https://example.com/usage");
    await expect(office.getByRole("article", { name: "Kimi", exact: true })).toContainText("当前登录方式不提供账号额度，例如 API Key。");
    // A failed read keeps the earlier figure, marked as earlier.
    const failed = office.getByRole("article", { name: "DeepSeek", exact: true });
    await expect(failed.locator(".quota-chip")).toHaveText("读取失败"); await expect(failed).toContainText("读取超时，可稍后刷新。"); await expect(failed).toContainText("$4.20"); await expect(failed).toHaveAttribute("data-earlier", "true");

    // The entry sits beside engine programs, and nothing overflows the dialog.
    await expect(page.getByRole("navigation", { name: "设置分类" }).getByRole("button").nth(2)).toContainText("模型额度");
    expect(await layout(page)).toEqual(tidy);
    await page.screenshot({ path: info.outputPath("quota-desktop-zh-light.png") });

    // English and dark, with names long enough to wrap.
    f.doubles.studio.view = now => studioQuota(now, "en"); f.doubles.office.view = now => officeQuota(now, "en", true);
    await page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^通用/ }).click();
    await page.locator("#theme").selectOption("dark"); await page.locator("#language").selectOption("en");
    await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: /^Model quota/ }).click();
    const english = host(panel, "Office PC", true);
    await expect(english.getByRole("article", { name: "Claude Code Max 20x (annual team seat)", exact: true })).toContainText("Shared by 3 Bots");
    await expect(host(panel, "Studio Mac", true).getByRole("article", { name: "Codex Pro", exact: true }).locator(".quota-window-value")).toHaveText(["58% left", "19% left"]);
    await expect(panel).toContainText("Running low"); await expect(panel).toContainText("Over limit"); await expect(panel).toContainText("Sign-in needed"); await expect(panel).toContainText("Covers 5 models");
    await expect(panel).toContainText(/Resets in 2h 5\dm/); await expect(panel).not.toContainText(/[一-鿿]/);
    expect(await layout(page)).toEqual(tidy);
    await page.screenshot({ path: info.outputPath("quota-desktop-en-dark.png") });
  } finally { await f.dispose(); }
});

test("the phone opens its own page from Me with one card per engine, down to 320px", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 900 }); const f = await hosts(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await waitForClientOnline(page);
    const panel = await openQuota(page);
    await expect(page.getByRole("heading", { name: "模型额度", level: 2 })).toBeVisible();
    await expect(panel.getByRole("article")).toHaveCount(10);
    expect([quotaCount(f.doubles.studio, "GET"), quotaCount(f.doubles.office, "GET")]).toEqual([1, 1]);
    // Narrow layout: windows are stacked and every engine is its own raised card.
    const codex = host(panel, "Studio Mac").getByRole("article", { name: "Codex Pro", exact: true }), stacked = await windowBoxes(codex);
    expect(stacked[1]!.x).toBe(stacked[0]!.x); expect(stacked[1]!.y).toBeGreaterThanOrEqual(stacked[0]!.bottom);
    await expect(codex).toHaveCSS("box-shadow", /rgb/); await expect(codex.locator(".quota-window-value")).toHaveText(["剩余 58%", "剩余 19%"]);
    await expect(host(panel, "Studio Mac").getByRole("region", { name: "Gemini Models", exact: true }).locator(".quota-window-name")).toHaveText(["5 小时额度", "7 天额度"]);
    expect(await layout(page)).toEqual(tidy);
    await page.screenshot({ path: info.outputPath("quota-phone-390-zh.png"), fullPage: false });
    await panel.getByRole("button", { name: "刷新", exact: true }).scrollIntoViewIfNeeded();
    expect((await panel.getByRole("button", { name: "刷新", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // English with long Host, plan, model and Bot names on the narrowest phone.
    await page.setViewportSize({ width: 1360, height: 900 }); await page.reload(); await waitForClientOnline(page);
    await openWorkspacePage(page, "设置"); await page.locator("#language").selectOption("en"); await page.getByRole("button", { name: "Close settings", exact: true }).click();
    f.doubles.studio.view = now => studioQuota(now, "en"); f.doubles.office.view = now => officeQuota(now, "en", true);
    await f.office!.profile.update({ name: "Office PC · Shared build machine, 3rd floor", revision: (await f.office!.profile.read()).revision });
    await page.setViewportSize({ width: 320, height: 568 }); await page.reload(); await waitForClientOnline(page);
    const english = await openQuota(page, true);
    await expect(english.getByRole("article")).toHaveCount(10);
    await expect(english.getByRole("region", { name: /^Host: Office PC/ })).toContainText("Max 20x (annual team seat)");
    await expect(english).toContainText("claude-opus-latest-long-context-preview"); await expect(english).toContainText("58% left"); await expect(english).toContainText("Over limit");
    expect(await layout(page)).toEqual(tidy);
    await page.screenshot({ path: info.outputPath("quota-phone-320-en.png") });
  } finally { await f.dispose(); }
});

test("it reads on open and on Refresh only, re-reads a passed reset once without refilling, and keeps an offline Host's last reading", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 900 }); const f = await hosts(page), { studio, office } = f.doubles;
  try {
    const panel = await openQuota(page); await expect(panel.getByRole("article")).toHaveCount(10);
    // Refresh is one request per Host with an empty JSON body; the page stays readable while it runs.
    studio.refreshDelay = office.refreshDelay = 600;
    await panel.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(panel.getByRole("button", { name: "正在刷新…", exact: true })).toBeVisible(); await expect(panel.getByRole("article")).toHaveCount(10);
    await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
    expect([quotaCount(studio, "POST"), quotaCount(office, "POST")]).toEqual([1, 1]);
    expect(studio.requests.find(request => request.method === "POST")!.body).toBe("{}");

    // A closed page asks nothing, whatever happens to the quota meanwhile.
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    const passed = Date.now() - 20_000;
    office.view = now => { const view = officeQuota(now); view.entries[0]!.windows[0]!.resetsAt = passed; view.entries[0]!.updatedAt = passed - 70_000; return view; };
    const closed = [studio.requests.length, office.requests.length];
    await page.waitForTimeout(2500); expect([studio.requests.length, office.requests.length]).toEqual(closed);

    // Opening it again reads once; the passed reset then asks that Host once more.
    await openQuota(page);
    const due = host(panel, "Office PC").getByRole("article", { name: "Codex Plus", exact: true }).locator(".quota-window").first();
    await expect(due).toContainText("已到重置时间，等待新数据。", { timeout: 20_000 });
    expect([quotaCount(studio, "GET"), quotaCount(office, "GET"), quotaCount(studio, "POST"), quotaCount(office, "POST")]).toEqual([2, 2, 1, 2]);
    // The bar is neither kept at the old figure nor refilled; no share is shown for that window.
    await expect(due).toHaveAttribute("data-due", "true"); await expect(due.locator(".quota-meter span")).toHaveCount(0); await expect(due).not.toContainText("%"); await expect(due).not.toContainText("已超额");
    // The entry is no longer marked over the limit because of a window that has reset.
    await expect(host(panel, "Office PC").getByRole("article", { name: "Codex Plus", exact: true }).locator(".quota-chip")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("quota-reset-waiting.png") });
    // It does not keep asking about the same boundary.
    await page.waitForTimeout(3000); expect(quotaCount(office, "POST")).toBe(2);

    // A hidden page (App in the background) does not read either.
    office.view = now => officeQuota(now); studio.refreshDelay = office.refreshDelay = 0;
    await panel.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(due).toContainText(/分钟后重置/); expect(quotaCount(office, "POST")).toBe(3);
    await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
    const hidden = [studio.requests.length, office.requests.length];
    await page.waitForTimeout(1500); expect([studio.requests.length, office.requests.length]).toEqual(hidden);
    await page.evaluate(() => { Reflect.deleteProperty(document, "visibilityState"); document.dispatchEvent(new Event("visibilitychange")); });
    // Coming straight back does not re-read: the last attempt is recent.
    await page.waitForTimeout(800); expect([studio.requests.length, office.requests.length]).toEqual(hidden);

    // Office PC goes offline: its last reading stays, labelled; Studio Mac is unaffected.
    await f.office!.close();
    const offline = host(panel, "Office PC");
    await expect(offline).toHaveAttribute("data-offline", "true", { timeout: 40_000 });
    await expect(offline).toContainText("离线"); await expect(offline).toContainText("主机离线。下面是上次读到的结果（"); await expect(offline.getByRole("article")).toHaveCount(5);
    await expect(offline.getByRole("article", { name: "Claude Code Max", exact: true })).toHaveAttribute("data-earlier", "true");
    await expect(host(panel, "Studio Mac").getByRole("article")).toHaveCount(5); await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await offline.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-host-offline.png") });

    // After a restart with that Host still offline, the reading kept on this device is shown the same way.
    await page.reload(); await waitForClientOnline(page);
    const restarted = host(await openQuota(page), "Office PC");
    await expect(restarted).toContainText("主机离线。下面是上次读到的结果（"); await expect(restarted.getByRole("article")).toHaveCount(5);
    await expect(restarted.getByRole("article", { name: "Codex Plus", exact: true }).locator(".quota-window-value")).toHaveText(["已超额", "剩余 45%"]);
    expect(await layout(page)).toEqual(tidy);
  } finally { await f.dispose(); }
});

test("a member has no entry and causes no quota request, on desktop and phone", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 }); const f = await hosts(page, { second: false });
  try {
    await f.studio.store.db.run("UPDATE users SET role='member' WHERE id='owner'");
    await page.reload(); await waitForClientOnline(page);
    await openWorkspacePage(page, "设置");
    const navigation = page.getByRole("navigation", { name: "设置分类" });
    await expect(navigation.getByRole("button", { name: /^引擎程序/ })).toBeVisible(); await expect(navigation.getByRole("button", { name: /^模型额度/ })).toHaveCount(0);
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await waitForClientOnline(page);
    await mobileHome(page).getByRole("navigation").getByRole("button", { name: "我的", exact: true }).click();
    await expect(mobileHome(page).getByRole("button", { name: /^设备与安全/ })).toBeVisible(); await expect(mobileHome(page).getByRole("button", { name: /^模型额度/ })).toHaveCount(0);
    expect(f.doubles.studio.requests).toEqual([]);
  } finally { await f.dispose(); }
});

test("an older Host asks for an update instead of showing an empty or zero quota", async ({ page }, info) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  // The Hub as released before this capability: its `ready` frame does not advertise it.
  const f = await hosts(page, { second: false, beforePairing: () => page.routeWebSocket("**/ws", socket => {
    const server = socket.connectToServer(); socket.onMessage(message => server.send(message));
    server.onMessage(message => { const frame = JSON.parse(String(message)); if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((value: string) => value !== ENGINE_QUOTA_CAPABILITY); socket.send(JSON.stringify(frame)); });
  }) });
  try {
    const panel = await openQuota(page);
    await expect(host(panel, "Studio Mac")).toContainText("请更新这台主机后查看模型额度。");
    await expect(panel.getByRole("article")).toHaveCount(0); await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeDisabled(); await expect(panel).not.toContainText("%");
    expect(f.doubles.studio.requests).toEqual([]);
    await page.screenshot({ path: info.outputPath("quota-older-host.png") });
  } finally { await f.dispose(); }
});

test("the real Host routes answer the owner's page, with a sealed engine environment", async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  const answers: string[] = []; page.on("response", response => { if (response.url().includes("/api/engines/quota")) answers.push(`${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`); });
  const f = await hosts(page, { second: false, mock: false });
  try {
    const panel = await openQuota(page);
    // No engine is installed in the sealed environment and no Bot uses one, so the Host lists none.
    await expect(host(panel, "Studio Mac")).toContainText("这台主机还没有可显示的引擎。");
    await panel.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => answers).toEqual(["GET /api/engines/quota 200", "POST /api/engines/quota/refresh 200"]);
    await expect(host(panel, "Studio Mac")).toContainText("这台主机还没有可显示的引擎。"); await expect(panel).not.toContainText("%");
  } finally { await f.dispose(); }
});
