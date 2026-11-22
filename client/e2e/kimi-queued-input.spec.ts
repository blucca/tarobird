import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import { test, expect, type Browser } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { attachGateway } from "../../src/gateway/service.js";
import type { GatewayChannel } from "../../src/gateway/channel.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { initializeHost } from "../../src/host-cli/setup.js";
import { enterMobileChat, mobileHome } from "./fixtures/mobile.js";

// Isolated fixture: real Hub, Gateway, Core and built App; the Kimi engine is a
// scripted bridge emitting the adapter's wait events. Screenshots record App
// behavior, not a live Kimi run.
const copy = {
  zh: { hold: "等待后台结果处理", holdNotice: "Kimi 正在处理上一项后台结果，本条消息尚未交给模型。", queued: "等待 Kimi 处理这条消息", queueNotice: "停止等待只结束这里的等待：Kimi 仍会执行这条消息，它的回复不会显示在这里。", stopQueued: "停止等待", cancel: "取消等待", pair: "配对此设备", code: "配对码" },
  en: { hold: "Waiting for background result review", holdNotice: "Kimi is reviewing an earlier background result. This message has not reached the model.", queued: "Waiting for Kimi to handle this message", queueNotice: "Stopping only ends the wait here: Kimi will still run this message, and its reply will not appear here.", stopQueued: "Stop waiting", cancel: "Cancel wait", pair: "Pair this device", code: "Pairing code" },
};

async function openChat(browser: Browser, hub: HubServer, phone: boolean, english: boolean, title: string) {
  const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 }, locale: english ? "en-US" : "zh-CN", serviceWorkers: "block" });
  const page = await context.newPage(), text = copy[english ? "en" : "zh"];
  await page.goto(hub.url);
  if (english) {
    const invitation = await fixtureInvitation(hub);
    await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
    await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
    await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
  } else await preparePairing(page, hub);
  await page.getByRole("button", { name: text.pair, exact: true }).click();
  await hub.auth.approve(await page.getByLabel(text.code, { exact: true }).innerText(), "local-owner");
  await page.getByLabel(text.code, { exact: true }).waitFor({ state: "hidden" });
  await expect(phone ? mobileHome(page) : page.locator(".connection-pill.online")).toBeVisible();
  if (phone) await enterMobileChat(page, title); else await page.locator(".conversation-row").filter({ hasText: title }).click();
  return { context, page };
}

for (const phone of [false, true]) for (const english of [false, true]) test(`${phone ? "phone" : "desktop"} ${english ? "en" : "zh"}: a Kimi turn held behind Kimi's own review, then queued natively, shows waiting, never completed`, async ({ browser }, info) => {
  test.setTimeout(90_000);
  const text = copy[english ? "en" : "zh"], label = `${phone ? "phone390" : "desktop1360"}-${english ? "en" : "zh"}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-queued-app-")), stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "kimi", locale: english ? "en" : "zh" }));
  await initializeHost(root, "Demo Host");
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Kimi',?,'kimi')", [hashSecret(secret)]);
  const gates: Array<() => void> = [];
  const gate = () => new Promise<void>(resolve => { gates.push(resolve); });
  let gateway: GatewayChannel | undefined;
  let context: Awaited<ReturnType<typeof openChat>>["context"] | undefined;
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: "bot", engine: "kimi", runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async input => {
        // Kimi runs its own task-origin review: the adapter holds the prompt.
        await input.onEngineEvent?.({ type: "background_review_wait", status: "started", engine: "kimi" });
        await gate();
        await input.onEngineEvent?.({ type: "background_review_wait", status: "finished", engine: "kimi" });
        // Kimi queued the prompt (UserPromptQueued) behind another turn of its own.
        await input.onEngineEvent?.({ type: "native_input_wait", status: "started", engine: "kimi" });
        await gate();
        await input.onEngineEvent?.({ type: "native_input_wait", status: "finished", engine: "kimi" });
        const reply = english ? "The queued question was answered." : "排队的问题已回答。";
        await input.onEngineEvent?.({ type: "assistant_text", text: reply, delta: true });
        return { text: reply };
      },
    } });
    const chat = await hub.store.createConversation("owner", ["bot"], english ? "Kimi queue" : "Kimi 排队", "direct");
    const opened = await openChat(browser, hub, phone, english, chat.title); context = opened.context;
    const page = opened.page, main = page.getByRole("main");
    const composer = page.getByRole("textbox", { name: english ? "Message" : "消息", exact: true });
    await composer.fill(english ? "What changed in the review?" : "复查改了什么？");
    await page.getByRole("button", { name: english ? "Send message" : "发送消息", exact: true }).click();
    await expect(composer).toHaveValue("");

    const run = main.locator(".native-run").last();
    await expect(run.locator(".native-run-status")).toContainText(text.hold);
    await expect(main.getByText(text.holdNotice, { exact: true })).toBeVisible();
    await expect(run.getByRole("button", { name: text.cancel, exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`kimi-held-${label}.png`) });

    await expect.poll(() => gates.length).toBe(1); gates.shift()!();
    await expect(run.locator(".native-run-status")).toContainText(text.queued);
    await expect(main.getByText(text.holdNotice, { exact: true })).toHaveCount(0);
    // ACP cannot withdraw a prompt from Kimi's queue; the control says so.
    await expect(main.getByText(text.queueNotice, { exact: true })).toBeVisible();
    await expect(run.getByRole("button", { name: text.stopQueued, exact: true })).toBeVisible();
    await expect(run.getByRole("button", { name: text.cancel, exact: true })).toHaveCount(0);
    await expect(main.getByText(/Kimi completed the request/)).toHaveCount(0);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: info.outputPath(`kimi-queued-${label}.png`) });

    await expect.poll(() => gates.length).toBe(1); gates.shift()!();
    await expect(main.getByText(english ? "The queued question was answered." : "排队的问题已回答。", { exact: true })).toBeVisible();
    await expect(run.locator(".native-run-status")).not.toContainText(text.queued);
  } finally {
    for (const release of gates) release();
    await context?.close().catch(() => undefined);
    await gateway?.disconnect().catch(() => undefined); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
