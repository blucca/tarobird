import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { mobileHome, openMobileHome, waitForClientOnline } from "./fixtures/mobile.js";

// An unanswered request to one host must not take over "Connect to another
// host" (iPhone, 11-21: an expired request left only "scan a new code").
// Temporary Hubs only; every approval is the Hub's own explicit approve().
test.use({ serviceWorkers: "block" });
const others = (hub: HubServer) => hub.store.devices("owner").then(devices => devices.filter(device => device.id !== "pairing_fixture_owner"));
const code = (page: Page) => page.getByLabel("配对码", { exact: true });
async function named(hub: HubServer, name: string) { await hub.store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 1 })]); }
/** Fill the visible add-host form and request pairing; the host name is the
 * saved local alias (left at the default for a host that is never approved). */
async function request(page: Page, hub: HubServer, hostName?: string) {
  if (hostName) await page.getByLabel("主机名称", { exact: true }).fill(hostName);
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await expect(code(page)).toBeVisible(); return code(page).innerText();
}
async function approve(page: Page, hub: HubServer, value: string) {
  await hub.auth.approve(value, "local-owner"); await expect(code(page)).toHaveCount(0, { timeout: 15_000 }); await waitForClientOnline(page);
}
async function hostStates(page: Page) {
  await clickAppAction(page, "设备与网络"); await page.getByRole("dialog", { name: "设备与网络", exact: true }).getByRole("button", { name: "此设备的连接", exact: true }).click();
  const rows = page.locator(".saved-host-manager .host-manager-row");
  await expect(rows.first()).toBeVisible();
  const states = await rows.evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.getAttribute("aria-label"), node.querySelector(".saved-host-state")?.textContent])));
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  return states;
}

async function hubs() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pair-another-"));
  const a = await HubServer.start({ stateDir: path.join(root, "a"), clientDir: path.resolve("dist") });
  const b = await HubServer.start({ stateDir: path.join(root, "b"), origins: [a.url] }), c = await HubServer.start({ stateDir: path.join(root, "c"), origins: [a.url] });
  await named(a, "主机甲"); await named(b, "主机乙"); await named(c, "主机丙");
  return { a, b, c, close: async () => { await a.close(); await b.close(); await c.close(); await rm(root, { recursive: true, force: true }); } };
}

test("an expired request offers paste and the normal add flow, stays renewable, and is labelled as expired", async ({ page }) => {
  const { a, b, c, close } = await hubs();
  try {
    // The client counts down from the code's own expiry; let B's first code lapse quickly.
    let pairs = 0;
    await page.route(`${b.url}/api/pair`, async route => {
      const response = await route.fetch(); const body = await response.json(); pairs++;
      await route.fulfill({ response, json: { ...body, expiresAt: pairs === 1 ? Date.now() + 1500 : body.expiresAt } });
    });
    await page.goto(a.url); await approve(page, a, await request(page, a, "主机甲"));
    await clickAppAction(page, "连接另一台主机"); const expired = await request(page, b);
    await expect(page.getByRole("status").filter({ hasText: "配对码已过期，请扫描新的限时连接码。" })).toBeVisible({ timeout: 10_000 });
    await b.store.db.run("UPDATE pairing_requests SET expires_at=?", [Date.now() - 1]);
    // Host approval is never relaxed: the expired code cannot be approved.
    await expect(b.auth.approve(expired, "local-owner")).rejects.toThrow();
    const device = await b.store.db.get<{ device_id: string }>("SELECT device_id FROM pairing_requests");
    // Both ways to renew are offered, and so is the ordinary add flow.
    for (const name of ["扫描新的连接码", "粘贴连接信息", "连接其他主机"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回会话", exact: true }).click();
    // "Connect to another host" still shows the unanswered request first...
    await clickAppAction(page, "连接另一台主机"); await expect(page.getByRole("heading", { name: "用已配对设备确认" })).toBeVisible();
    // ...and one explicit choice returns to the normal add flow with scan and paste.
    await page.getByRole("button", { name: "连接其他主机", exact: true }).click();
    await expect(page.getByRole("heading", { name: "连接你的 TaroBird" })).toBeVisible();
    for (const name of ["粘贴连接信息", "导入二维码图片", "扫描连接二维码", "返回配对申请"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await approve(page, c, await request(page, c, "主机丙"));
    expect(await others(b)).toHaveLength(0);
    expect(await hostStates(page)).toEqual({ "主机甲": "已连接", "主机丙": "已连接", "我的主机": "配对已过期" });
    // Phone list: an unapproved host is not called a paired computer.
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    await mobileHome(page).getByRole("button", { name: "我的", exact: true }).click();
    const list = mobileHome(page).locator(".mh-group").filter({ has: page.locator(".mh-status") }).first();
    await expect(list).toContainText("配对已过期"); await expect(list).not.toContainText("已配对电脑");
    await page.setViewportSize({ width: 1360, height: 900 });
    // The expired request is still recoverable with the same device key.
    await clickAppAction(page, "连接另一台主机"); await expect(page.getByRole("heading", { name: "用已配对设备确认" })).toBeVisible();
    await preparePairing(page, b); await expect(code(page)).not.toHaveText(expired);
    expect(await b.store.db.get("SELECT device_id FROM pairing_requests WHERE status='pending'")).toEqual(device);
    await approve(page, b, await code(page).innerText());
    expect((await others(b)).map(entry => entry.id)).toEqual([device!.device_id]);
    expect(Object.values(await hostStates(page))).toEqual(["已连接", "已连接", "已连接"]);
  } finally { await page.close(); await close(); }
});

test("a still-valid request survives adding another host and is approved with its original code", async ({ page }) => {
  const { a, b, c, close } = await hubs();
  try {
    await page.goto(a.url); await approve(page, a, await request(page, a, "主机甲"));
    await clickAppAction(page, "连接另一台主机"); const waiting = await request(page, b, "主机乙");
    await page.getByRole("button", { name: "连接其他主机", exact: true }).click();
    // A different host starts from an empty form, never with this request's details.
    await expect(page.getByText("已读取主机信息", { exact: true })).toHaveCount(0); await expect(page.getByLabel("主机名称", { exact: true })).toHaveValue("我的主机");
    // Changing one's mind keeps the request.
    await page.getByRole("button", { name: "返回配对申请", exact: true }).click(); await expect(code(page)).toHaveText(waiting);
    await page.getByRole("button", { name: "连接其他主机", exact: true }).click();
    await approve(page, c, await request(page, c, "主机丙"));
    expect(await hostStates(page)).toEqual({ "主机甲": "已连接", "主机丙": "已连接", "主机乙": "待批准" });
    await clickAppAction(page, "连接另一台主机"); await expect(code(page)).toHaveText(waiting);
    await approve(page, b, waiting);
    expect(await others(b)).toHaveLength(1);
    expect(await hostStates(page)).toEqual({ "主机甲": "已连接", "主机丙": "已连接", "主机乙": "已连接" });
  } finally { await page.close(); await close(); }
});
