import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { openMobileHome, openWorkspacePage } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

async function pairClient(page: import("@playwright/test").Page, hub: HubServer) {
  await hub.store.db.run(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [HOST_PROFILE_KEY, JSON.stringify({ name: "macmini", revision: 1 })],
  );
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("macmini");
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".host-workspace:not([hidden])").waitFor({ state: "visible" });
}

test("Settings -> About -> Acknowledgements searches items and displays full license text on desktop and phone (zh and en)", async ({ page }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "acknowledgements-e2e-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  try {
    await pairClient(page, hub);

    // Desktop (Chinese)
    await openWorkspacePage(page, "设置");
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings).toBeVisible();
    await settings.locator("button[data-section='about']").click();
    await expect(settings.getByText("AGPL-3.0-only")).toBeVisible();
    await settings.locator("button[data-about-action='acknowledgements']").click();

    const searchInput = settings.getByRole("searchbox", { name: "搜索致谢项目", exact: true });
    await expect(searchInput).toBeVisible();
    await expect(settings.locator(".about-ack-row").first()).toBeVisible();

    // Filter to LobeHub model brand icons and open full license text.
    await searchInput.fill("LobeHub");
    const lobeRow = settings.locator("button[data-ack-id='lobehub-model-brand-icons']");
    await expect(lobeRow).toBeVisible();
    await lobeRow.click();
    await expect(settings.locator("[data-license-text]")).toContainText("MIT License");
    await expect(settings.locator("[data-license-text]")).toContainText("Brand trademarks belong to their respective owners");

    // Back to list and verify npm + Android + iOS coverage.
    await settings.getByRole("button", { name: "返回致谢列表", exact: true }).click();
    await settings.getByRole("button", { name: "清空搜索", exact: true }).click();
    await searchInput.fill("OkHttp");
    await expect(settings.locator("button[data-ack-id='android-okhttp']")).toBeVisible();
    await searchInput.fill("Capacitor Swift");
    await expect(settings.locator("button[data-ack-id='ios-capacitor-swift-pm']")).toBeVisible();
    await searchInput.fill("react");
    await expect(settings.locator("button[data-ack-id='npm:react']")).toBeVisible();

    // Switch to English inside Settings -> General and verify About -> Acknowledgements in English.
    await settings.locator("button[data-section='general']").click();
    await settings.getByLabel("语言", { exact: true }).selectOption("en");
    const settingsEn = page.getByRole("dialog", { name: "Settings", exact: true });
    await settingsEn.locator("button[data-section='about']").click();
    await settingsEn.locator("button[data-about-action='acknowledgements']").click();
    await expect(settingsEn.getByRole("searchbox", { name: "Search acknowledgements", exact: true })).toBeVisible();
    await settingsEn.locator("button[data-ack-id='pi-mark']").click();
    await expect(settingsEn.locator("[data-license-text]")).toContainText("https://pi.dev");
    await settingsEn.getByRole("button", { name: "Close settings", exact: true }).click();

    // Phone viewport (390x844): Settings -> About -> Acknowledgements (in English)
    await page.setViewportSize({ width: 390, height: 844 });
    const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
    if (!(await home.isVisible().catch(() => false))) {
      await page.locator(".host-workspace:not([hidden]) button[aria-label='Open conversation list']").click();
    }
    await expect(home).toBeVisible();
    await home.getByRole("button", { name: "Me", exact: true }).click();
    await home.locator("button[data-settings-entry='settings']").click();
    await expect(settingsEn).toBeVisible();
    await settingsEn.locator("button[data-section='about']").click();
    await settingsEn.locator("button[data-about-action='acknowledgements']").click();
    await expect(settingsEn.locator("button[data-ack-id='jetbrains-mono']")).toBeVisible();
    await settingsEn.locator("button[data-ack-id='jetbrains-mono']").click();
    await expect(settingsEn.locator("[data-license-text]")).toContainText("SIL OPEN FONT LICENSE");
  } finally {
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
