import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { clickAppAction } from "./fixtures/desktop-actions.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });
const clientDir = () => path.resolve(process.env.TAROBOT_E2E_CLIENT_DIR ?? "dist");

test("New Bot describes Antigravity normal approval for the runtime the Bot will get, ordinary or dispatcher", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-new-bot-permission-")), missing = path.join(root, "missing-cli");
  // A stand-in for an agy new enough for ACP: answers --version and models, starts nothing.
  const agy = path.join(root, "agy.mjs");
  await writeFile(agy, `#!/usr/bin/env node
if (process.argv[2] === "--version") { process.stdout.write("1.5.14\\n"); process.exit(0); }
if (process.argv[2] !== "models") process.exit(2);
process.stdout.write("gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n");
`);
  await chmod(agy, 0o755);
  const hub = await HubServer.start({ stateDir: root, clientDir: clientDir(), managedBots: { entrypoint: path.resolve("../tests/fixtures/managed-bot-worker.mjs"), env: { ...process.env, CODEX_EXECUTABLE: process.execPath, CLAUDE_EXECUTABLE: process.execPath, KIMI_EXECUTABLE: missing, DSH_EXECUTABLE: missing, ANTIGRAVITY_EXECUTABLE: agy } } });
  try {
    await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await clickAppAction(page, "新建 Bot");
    const dialog = page.getByRole("dialog", { name: "新建 Bot", exact: true });
    const engine = dialog.getByLabel("引擎", { exact: true });
    await expect(engine.locator('option[value="antigravity"]')).toBeEnabled({ timeout: 30_000 });
    await engine.selectOption("antigravity");
    const normal = dialog.locator('select option[value="normal"]');
    await expect(normal).toHaveText("普通审批 · 逐项确认");
    await dialog.getByRole("checkbox", { name: "作为幕僚长", exact: true }).check();
    await expect(normal).toHaveText("每轮批准 · 终端沙箱");
    await dialog.getByRole("checkbox", { name: "作为幕僚长", exact: true }).uncheck();
    await expect(normal).toHaveText("普通审批 · 逐项确认");
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
