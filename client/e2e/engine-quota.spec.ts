import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { QuotaSnapshot } from "../../src/client-protocol/engine-quota.js";
import { unavailableQuota } from "../../src/codex/account-quota.js";
import { fixtureInvitation } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import en from "../src/locales/en.json" with { type: "json" };

// Settings › Model quotas is part of an ordinary build again (src/engine-quota-feature.ts), so every test here
// uses `dist`. TAROBIRD_QUOTA_TEST_CLIENT_DIR still points the page tests at another client directory.
const quotaUiClient = process.env.TAROBIRD_QUOTA_TEST_CLIENT_DIR;

type RecordState = { revision: string; snapshot: QuotaSnapshot; reads: number; refreshes: number; hold?: Promise<void> };
async function fixture(page: Page, english = false, oldHost = false) {
  const text = (key: string) => english ? (en as Record<string, string>)[key] || key : key;
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-quota-ui-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: quotaUiClient ?? path.resolve("dist") });
  await hub.profile.update({ name: "Quota fixture Host", revision: (await hub.profile.read()).revision });
  const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
  const ready = (used: number): QuotaSnapshot => ({ authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(), pools: [{ id: "native_pool", label: "Native shared pool", sharing: "shared", availability: "allowed", windows: [
    { id: "short", label: "5 hours", metric: "percent", usedPercent: used, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp(120_000), periodSeconds: 18_000 },
    { id: "week", label: "Weekly", metric: "unknown", availability: "unknown", observedAt: stamp(), expiresAt: stamp(60_000) },
  ], balances: [{ id: "credits", kind: "credits", unit: "credits", amount: "12.50", observedAt: stamp(), expiresAt: stamp(60_000) }], constraints: [] }], constraints: [] });
  const records: Record<string, RecordState> = {
    coder: { revision: "coder_one", snapshot: ready(38), reads: 0, refreshes: 0 },
    reviewer: { revision: "reviewer_one", snapshot: ready(125), reads: 0, refreshes: 0 },
    writer: { revision: "writer_one", snapshot: unavailableQuota("claude", "no_passive_event"), reads: 0, refreshes: 0 },
    research: { revision: "research_one", snapshot: unavailableQuota("kimi", "not_adapted"), reads: 0, refreshes: 0 },
  };
  const gateways = []; let turns = 0, quotaRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/engine-quotas")) quotaRequests++; });
  if (oldHost) await page.routeWebSocket("**/ws", socket => {
    const upstream = socket.connectToServer(); upstream.onMessage(message => {
      if (typeof message !== "string") return socket.send(message);
      const frame = JSON.parse(message);
      if (frame.type === "ready") frame.serverCapabilities = frame.serverCapabilities.filter((value: string) => value !== "engines.quota.v1");
      socket.send(JSON.stringify(frame));
    });
  });
  for (const [id, name, engine] of [["coder", "Coding Bot", "codex"], ["reviewer", "Review Bot", "codex"], ["writer", "Writing Bot", "claude"], ["research", "Research Bot", "kimi"]] as const) {
    const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine })); await writeFile(path.join(stateDir, "session.json"), "unchanged-session");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
    gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async () => { turns++; throw new Error("quota_must_not_send_a_turn"); },
      readAccountQuota: async options => { const record = records[id]!; record.reads++; if (options.refresh) { record.refreshes++; await record.hold; } return { revision: record.revision, snapshot: record.snapshot }; },
    } }));
  }
  await page.goto(hub.url); const invitation = await fixtureInvitation(hub);
  await page.getByRole("button", { name: text("粘贴连接信息"), exact: true }).click();
  await page.getByLabel(text("配对信息"), { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
  await page.getByRole("button", { name: text("使用配对信息"), exact: true }).click();
  await page.getByRole("button", { name: text("配对此设备"), exact: true }).click();
  await hub.auth.approve(await page.getByLabel(text("配对码"), { exact: true }).innerText(), "local-owner");
  await page.getByLabel(text("配对码"), { exact: true }).waitFor({ state: "hidden" });
  await expect(page.locator(".host-workspace:not([hidden]) .connection-pill.online")).toBeAttached();
  const openSettings = async () => {
    if (page.viewportSize()!.width <= 760) {
      await page.getByRole("navigation", { name: text("主导航") }).getByRole("button", { name: text("我的"), exact: true }).click();
    }
    await page.getByRole("button", { name: text("设置"), exact: true }).filter({ visible: true }).click();
  };
  return { text, records, hub, requests: () => quotaRequests, openSettings, async open() {
    await openSettings();
    await page.getByRole("navigation", { name: text("设置分类") }).getByRole("button", { name: new RegExp(`^${text("模型额度")}`) }).click();
  }, async close() {
    expect(turns).toBe(0); expect(await hub.store.db.get("SELECT COUNT(*) AS count FROM messages")).toEqual({ count: 0 });
    for (const id of Object.keys(records)) expect(await readFile(path.join(root, id, "session.json"), "utf8")).toBe("unchanged-session");
    await page.close(); for (const gateway of gateways) await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true });
  } };
}

test.use({ serviceWorkers: "block", actionTimeout: 10_000 });
for (const [width, english] of [[1360, false], [1360, true], [390, false], [390, true]] as const) test(`the owner finds Model quotas in Settings, and nothing is read before it is opened, at ${width}px ${english ? "en" : "zh"}`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, english);
  try {
    await f.openSettings(); const navigation = page.getByRole("navigation", { name: f.text("设置分类") });
    const entry = navigation.getByRole("button", { name: new RegExp(`^${f.text("模型额度")}`) });
    await expect(entry).toBeVisible();
    // Opening Settings alone asks the Host nothing about quotas.
    expect(f.requests()).toBe(0);
    await entry.click();
    const panel = page.locator(".engine-quota:visible");
    await expect(panel.getByRole("region", { name: "Coding Bot · Codex", exact: true })).toBeVisible();
    // An engine this Host cannot read is listed and says so; it is not left out.
    await expect(panel.getByRole("region", { name: "Research Bot · Kimi", exact: true })).toContainText(f.text("此引擎尚未接入原生额度。"));
    expect(f.requests()).toBeGreaterThan(0);
  } finally { await f.close(); await context.close(); }
});

test("quota page reads actual Host cache and explicit refresh never sends a model turn", async ({ page }, info) => {
  const f = await fixture(page);
  try {
    await f.open(); const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%"); await expect(coder).toContainText("12.50 credits");
    await expect(coder).toContainText("尚无数据"); expect(f.records.coder!.refreshes).toBe(0);
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => f.records.coder!.refreshes).toBe(1);
    const writer = panel.getByRole("region", { name: "Writing Bot · Claude Code", exact: true });
    await writer.getByRole("button", { name: "读取已知状态", exact: true }).click(); await expect.poll(() => f.records.writer!.reads).toBeGreaterThan(1);
    expect(f.records.writer!.refreshes).toBe(0);
    await expect(panel.getByRole("region", { name: "Review Bot · Codex", exact: true })).toContainText("超出 25%");
    await expect(panel.getByRole("region", { name: "Research Bot · Kimi", exact: true })).toContainText("尚未接入");
    await expect(panel.getByRole("region", { name: "Research Bot · Kimi", exact: true }).locator(".quota-help")).toHaveText("官方查看：在 Kimi Code CLI 交互界面输入 /usage 查看套餐额度；ACP 会话里的 /usage 只显示本会话 token。");
    await expect(writer.locator(".quota-help")).toContainText("claude.ai/settings/usage");
    await expect(coder.locator(".quota-help")).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("quota-desktop.png"), fullPage: true });
  } finally { await f.close(); }
});

for (const width of [1360, 390, 320]) for (const english of [false, true]) test(`quota values and independent restrictions fit ${width}px ${english ? "en" : "zh"}`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), f = await fixture(page, english), errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    f.records.reviewer!.snapshot.availability = "blocked";
    f.records.reviewer!.snapshot.constraints = [{ code: "spend_control", availability: "blocked" }];
    f.records.reviewer!.snapshot.pools[0]!.balances[0]!.amount = null;
    await f.open(); const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true }), reviewer = panel.getByRole("region", { name: "Review Bot · Codex", exact: true });
    await expect(coder).toContainText(english ? "62% remaining" : "剩余 62%"); await expect(coder.getByRole("meter")).toHaveCount(1);
    await expect(reviewer).toContainText(f.text("已触发原生消费限制")); await expect(reviewer).toContainText(english ? "25% over limit" : "超出 25%");
    await expect(reviewer.locator(".quota-balance")).toContainText(f.text("尚无数据")); await expect(reviewer.locator(".quota-balance")).not.toContainText("0 credits");
    const research = panel.getByRole("region", { name: "Research Bot · Kimi", exact: true });
    await expect(research.locator(".quota-help")).toHaveText(f.text("官方查看：在 Kimi Code CLI 交互界面输入 /usage 查看套餐额度；ACP 会话里的 /usage 只显示本会话 token。"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.locator(".quota-card").evaluateAll(cards => cards.every(card => card.scrollWidth <= card.clientWidth + 1))).toBe(true);
    await coder.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-values.png") });
    await reviewer.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-restrictions.png") });
    await research.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath("quota-guidance.png") });
    for (const record of Object.values(f.records)) expect(record.refreshes).toBe(0);
    expect(errors).toEqual([]);
  } finally { await f.close(); await context.close(); }
});

test("quota expiry never invents a refill or issues a refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    const value = f.records.coder!.snapshot.pools[0]!.windows[0]!; value.resetsAt = new Date(Date.now() + 1800).toISOString();
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%"); const requests = f.requests();
    await expect(coder).toContainText("已到重置时间，等待更新");
    await expect(coder).toContainText("上次读数：剩余 62%"); await expect(coder).not.toContainText("剩余 100%");
    expect(f.requests()).toBe(requests); expect(f.records.coder!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("constraints-only quota readings expire locally without any network refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    const snapshot = f.records.coder!.snapshot;
    snapshot.pools = []; snapshot.availability = "blocked";
    snapshot.constraints = [{ code: "ordinary_usage_blocked", availability: "blocked" }];
    snapshot.observedAt = new Date(Date.now() - 57_000).toISOString();
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(coder.locator(".quota-state")).toHaveText("已读取");
    await expect(coder).toContainText("常规使用受限"); await expect(coder.getByRole("meter")).toHaveCount(0);
    const requests = f.requests();
    await expect(coder.locator(".quota-state")).toHaveText("待更新", { timeout: 6_000 });
    await expect(coder).toContainText("常规使用受限"); await expect(coder).not.toContainText("剩余 100%");
    expect(f.requests()).toBe(requests); expect(f.records.coder!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("constraint reset times expire the reading like the Gateway, without a refill or refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    const snapshot = f.records.coder!.snapshot;
    // Mirrors parseCodexQuota: native Codex readings carry their official viewing guidance.
    snapshot.pools = []; snapshot.availability = "blocked"; snapshot.observedAt = new Date().toISOString(); snapshot.help = "codex_usage";
    snapshot.constraints = [{ code: "ordinary_usage_blocked", availability: "blocked", resetsAt: new Date(Date.now() + 4_000).toISOString() }];
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }), constraints = coder.locator(".quota-constraints");
    await expect(coder.locator(".quota-state")).toHaveText("已读取"); await expect(constraints).toContainText("重置："); await expect(coder.locator(".quota-help")).toHaveCount(0);
    await expect(coder.locator(".quota-notice")).toHaveText("原生服务报告使用受限；窗口剩余量不代表可以继续请求。");
    const requests = f.requests();
    await expect(coder.locator(".quota-state")).toHaveText("待更新", { timeout: 8_000 });
    await expect(constraints).toContainText("常规使用受限 · 已到重置时间，等待更新"); await expect(constraints).not.toContainText("重置：");
    await expect(coder.locator(".quota-notice")).toHaveText("上次读数：原生服务报告使用受限；窗口剩余量不代表可以继续请求。");
    await expect(coder.locator(".quota-help")).toContainText("/usage");
    await expect(coder).not.toContainText("剩余 100%");
    expect(f.requests()).toBe(requests); expect(f.records.coder!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("quota authentication changes clear old values and require another explicit refresh", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }); await expect(coder).toContainText("剩余 62%");
    f.records.coder!.revision = "coder_new_authorization";
    await coder.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(coder).toContainText("授权信息已变化"); await expect(coder).not.toContainText("剩余 62%"); expect(f.records.coder!.refreshes).toBe(0);
    await coder.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => f.records.coder!.refreshes).toBe(1); await expect(coder).toContainText("剩余 62%");
  } finally { await f.close(); }
});

test("quota cards refresh independently and owner revocation clears all data", async ({ page }) => {
  const f = await fixture(page); let release = () => {};
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }), reviewer = page.getByRole("region", { name: "Review Bot · Codex", exact: true });
    f.records.coder!.hold = new Promise<void>(resolve => { release = resolve; });
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => f.records.coder!.refreshes).toBe(1);
    await reviewer.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => f.records.reviewer!.refreshes).toBe(1);
    await expect(reviewer).toContainText("后可再刷新"); await expect(coder).toHaveAttribute("aria-busy", "true");
    await f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"); release();
    await expect(page.locator(".engine-quota").getByRole("alert")).toContainText("额度查看权限已变化"); await expect(page.locator(".quota-card")).toHaveCount(0);
    const before = f.requests(); await page.reload(); await expect(page.locator(".connection-pill.online")).toBeAttached(); await f.openSettings();
    await expect(page.getByRole("navigation", { name: "设置分类" }).getByRole("button", { name: /^模型额度/ })).toHaveCount(0); expect(f.requests()).toBe(before);
  } finally { release(); await f.close(); }
});

test("old Hosts show an upgrade explanation without probing quota endpoints", async ({ page }) => {
  const f = await fixture(page, false, true);
  try { await f.open(); await expect(page.locator(".engine-quota")).toContainText("请更新主机以查看模型额度"); expect(f.requests()).toBe(0); }
  finally { await f.close(); }
});

test("closing and locking quota settings discard late responses and never replay native refresh", async ({ page }) => {
  const f = await fixture(page); let release = () => {}; let held = false;
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }); await expect(coder).toContainText("剩余 62%");
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/engine-quotas/coder?*", async route => { const response = await route.fetch(); held = true; await gate; await route.fulfill({ response }).catch(() => undefined); });
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    const window = f.records.coder!.snapshot.pools[0]!.windows[0]!; if (window.metric === "percent") window.usedPercent = 91;
    await f.open(); await expect(coder).toContainText("剩余 9%"); release(); await expect(coder).not.toContainText("剩余 62%");
    expect(f.records.coder!.refreshes).toBe(1);
    await page.evaluate(() => { document.documentElement.dataset.mobileLocked = "true"; });
    await expect(page.locator(".quota-card")).toHaveCount(0); const before = f.requests();
    await page.evaluate(() => { document.dispatchEvent(new Event("visibilitychange")); }); expect(f.requests()).toBe(before);
    await page.evaluate(() => { document.documentElement.dataset.mobileLocked = "false"; }); await expect(coder).toContainText("剩余 9%"); expect(f.records.coder!.refreshes).toBe(1);
  } finally { release(); await f.close(); }
});

test("quota discovery keeps not-loaded, unsupported, offline and partial directories distinct and auto-reads readable cards on open", async ({ page }) => {
  const f = await fixture(page);
  try {
    f.records.coder!.snapshot = unavailableQuota("codex", "not_loaded");
    f.records.reviewer!.snapshot = unavailableQuota("codex", "offline");
    await page.route("**/api/engine-quotas", async route => {
      const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), truncated: true } });
    });
    await f.open(); const panel = page.locator(".engine-quota:visible"), coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    await expect(panel).toContainText("只返回了部分 Bot");
    // Readable active cards without data auto-refresh once on page open without manual clicking.
    await expect.poll(() => f.records.coder!.refreshes).toBe(1);
    await expect(coder).toContainText("尚未读取原生额度");
    await expect(coder.getByRole("meter")).toHaveCount(0);
    await expect(panel.getByRole("region", { name: "Review Bot · Codex", exact: true })).toContainText("当前离线");
    for (const name of ["Review Bot · Codex", "Research Bot · Kimi"]) await expect(panel.getByRole("region", { name, exact: true }).getByRole("button")).toHaveCount(0);
    expect(f.records.reviewer!.refreshes).toBe(0);
    expect(f.records.research!.refreshes).toBe(0);
  } finally { await f.close(); }
});

test("model quotas auto-read stale/empty cards on open and update automatically when a slow Claude answer arrives late", async ({ page }) => {
  const f = await fixture(page);
  try {
    const now = Date.now(), stamp = (delta = 0) => new Date(now + delta).toISOString();
    const readyCodex: QuotaSnapshot = {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(),
      pools: [{
        id: "codex_pool", label: "Codex", sharing: "shared", availability: "allowed",
        windows: [{ id: "secondary", label: "Secondary", metric: "percent", usedPercent: 18, availability: "allowed", observedAt: stamp(), expiresAt: stamp(60_000), resetsAt: stamp((3 * 24 + 17) * 3_600_000), periodSeconds: 604_800 }],
        balances: [], constraints: [],
      }], constraints: [],
    };
    const readyClaude: QuotaSnapshot = {
      authMode: "subscription", capability: { mode: "active" }, state: "ready", availability: "allowed", observedAt: stamp(5_000),
      pools: [{
        id: "claude_pool", label: "Claude", sharing: "shared", availability: "allowed",
        windows: [{ id: "seven_day", label: "7 days", metric: "percent", usedPercent: 26, availability: "allowed", observedAt: stamp(5_000), expiresAt: stamp(65_000), resetsAt: stamp((4 * 24 + 5) * 3_600_000), periodSeconds: 604_800 }],
        balances: [], constraints: [],
      }], constraints: [],
    };
    // Start with coder unloaded and writer (Claude) active but timing out on its first refresh.
    f.records.coder!.snapshot = unavailableQuota("codex", "not_loaded");
    f.records.writer!.snapshot = { ...unavailableQuota("claude", "not_loaded"), capability: { mode: "active" }, authMode: "subscription" };

    // Intercept refresh calls on the server side by updating records right after refresh starts.
    const origCoder = f.records.coder!;
    let claudeTimedOut = false;
    await page.route("**/api/engine-quotas/coder?*", async route => {
      origCoder.snapshot = readyCodex;
      return route.continue();
    });
    await page.route("**/api/engine-quotas/writer?*", async route => {
      if (route.request().method() === "POST" || route.request().url().includes("refresh=1")) {
        f.records.writer!.snapshot = { ...unavailableQuota("claude", "timeout"), capability: { mode: "active" }, authMode: "subscription" };
        claudeTimedOut = true;
      }
      return route.continue();
    });

    await f.open();
    const panel = page.locator(".engine-quota:visible");
    const coder = panel.getByRole("region", { name: "Coding Bot · Codex", exact: true });
    const writer = panel.getByRole("region", { name: "Writing Bot · Claude Code", exact: true });

    // Both cards started reading automatically on open without clicking Refresh.
    await expect(coder).toContainText("剩余 82%");
    await expect(coder).toContainText("3 天 17 小时");
    await expect.poll(() => claudeTimedOut).toBe(true);
    // Slow Claude shows "正在读取…" instead of an immediate timeout error.
    await expect(writer.locator(".quota-state")).toHaveText("正在读取…");
    await expect(writer).not.toContainText("读取原生额度超时");

    // Late answer arrives on the Host cache; the Settings card picks it up automatically.
    f.records.writer!.snapshot = readyClaude;
    await expect(writer).toContainText("剩余 74%", { timeout: 10_000 });
    await expect(writer).toContainText("4 天 5 小时");
    await expect(writer.locator(".quota-state")).toHaveText("已读取");
  } finally { await f.close(); }
});

test("a failed quota card preserves marked old values while a retired scope only reloads the cache", async ({ page }) => {
  const f = await fixture(page);
  try {
    await f.open(); const coder = page.getByRole("region", { name: "Coding Bot · Codex", exact: true }), reviewer = page.getByRole("region", { name: "Review Bot · Codex", exact: true });
    await expect(coder).toContainText("剩余 62%");
    await page.route("**/api/engine-quotas/coder?*", route => route.fulfill({ status: 503, json: { error: "unavailable" } }));
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect(coder.getByRole("alert")).toContainText("本次刷新失败");
    await expect(coder).toContainText("上次读数：剩余 62%"); await expect(reviewer.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    await page.unroute("**/api/engine-quotas/coder?*");
    await page.route("**/api/engine-quotas/coder?*", route => route.fulfill({ status: 409, json: { error: "quota_scope_changed" } }));
    const before = f.records.coder!.reads;
    await coder.getByRole("button", { name: "刷新", exact: true }).click(); await expect(page.locator(".engine-quota")).toContainText("已重新读取列表");
    await expect.poll(() => f.records.coder!.reads).toBeGreaterThan(before); expect(f.records.coder!.refreshes).toBe(0);
    await expect(coder).toContainText("剩余 62%"); await expect(coder.getByRole("alert")).toHaveCount(0);
  } finally { await f.close(); }
});
