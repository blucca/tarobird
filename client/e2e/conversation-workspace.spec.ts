import { test, expect, type Page } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { networkId } from "../../src/hub/private-network.js";
import { networkManifestSchema } from "../../src/client-protocol/private-network.js";
import { fixtureInvitation, preparePairing } from "./fixtures/pairing-invite.js";
import { pairingLink } from "../src/pairing-link.js";
import { waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });

const english = JSON.parse(await readFile(path.resolve("src/locales/en.json"), "utf8")) as Record<string, string>;
const reviewDir = process.env.WORKSPACE_RAIL_UI_SHOTS;

async function shot(page: Page, info: { outputPath(name: string): string }, name: string) {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  if (reviewDir) await page.screenshot({ path: path.join(reviewDir, `${name}.png`) });
}

async function noHorizontalOverflow(page: Page, selector?: string) {
  if (selector) {
    expect(await page.locator(selector).first().evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

async function insertBotMessage(hub: HubServer, botId: string, conversationId: string, replyTo: string, blocks: unknown[], status = "complete") {
  const id = `bm_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await hub.store.db.run(
    "INSERT INTO messages(id,conversation_id,author_type,author_id,reply_to,blocks_json,status,version,created_at) VALUES(?,?,'bot',?,?,?,?,1,?)",
    [id, conversationId, botId, replyTo, JSON.stringify(blocks), status, Date.now()],
  );
  return id;
}

for (const locale of ["zh", "en"] as const) for (const phone of [false, true]) {
  test(`conversation workspace rail, bot-to-bot comms and coexistence · ${phone ? "phone" : "desktop"} · ${locale}`, async ({ browser }, info) => {
    const L = (key: string) => locale === "en" ? (english[key] ?? key) : key;
    const root = await mkdtemp(path.join(os.tmpdir(), "workspace-rail-ui-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: path.resolve("dist") });
    const context = await browser.newContext({
      viewport: phone ? { width: 390, height: 844 } : { width: 1360, height: 900 },
      locale: locale === "en" ? "en-US" : "zh-CN",
      serviceWorkers: "block",
      ...(phone ? { isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const tag = `${phone ? "phone" : "desktop"}-${locale}`;

    try {
      await hub.profile.update({ name: "Example Studio Host", revision: 0 });
      for (const [id, name, engine, model] of [
        ["bot_arch", "Architect", "claude", "claude-sonnet-4-6"],
        ["bot_rev", "Reviewer", "codex", "gpt-5.4"],
        ["bot_res", "Researcher", "pi", "gemini-2.5-pro"],
      ] as const) {
        await hub.store.db.run(
          "INSERT INTO bots(id,name,secret_hash,engine,model,online) VALUES(?,?,?,?,?,1)",
          [id, name, hashSecret(randomBytes(16).toString("hex")), engine, model],
        );
      }
      const nonce = randomBytes(32).toString("base64url");
      const manifest = networkManifestSchema.parse({
        v: 2,
        id: networkId(hub.auth.publicKey, nonce),
        name: "ExampleNet",
        authorityKey: hub.auth.publicKey,
        genesisNonce: nonce,
        revision: 1,
        hosts: [{ publicKey: hub.auth.publicKey, name: "Example Studio Host", routes: [], protocol: 2, state: "active", revoked: false }],
        devices: [],
        revokedMembers: [],
        blockedBindings: [],
      });
      const membership = { manifest, signature: hub.auth.signNetworkManifest(manifest) };
      await hub.store.db.run(
        "INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
        [JSON.stringify({ v: 1, routes: [], membership, imported: {}, revokedMembers: [], revokedHosts: [], retiredNetworks: [], admissions: [], peers: [], proofs: [], intents: {}, lastSyncedAt: Date.now(), waiting: false })],
      );
      const guard = async () => undefined;
      await hub.botMessages.grant({ sourceHost: "Example Studio Host", sourceBot: "bot_arch", targetBot: "bot_rev" }, guard);
      await hub.botMessages.grant({ sourceHost: "Example Studio Host", sourceBot: "bot_arch", targetBot: "bot_res" }, guard);

      // Main conversation
      const mainTitle = locale === "en" ? "Workspace Rail Implementation" : "会话工作区开发";
      const mainChat = await hub.store.createConversation("owner", ["bot_arch"], mainTitle, "main-workspace-chat");
      const { message: userMsg } = await hub.store.sendMessage("owner", {
        conversationId: mainChat.id,
        clientMsgId: "cm_main_1",
        text: locale === "en" ? "Coordinate review and benchmark summary." : "请协调评审并汇总基准测试结果。",
        attachments: [],
        mentions: ["bot_arch"],
        previewUrl: null,
      });
      await insertBotMessage(hub, "bot_arch", mainChat.id, userMsg.id, [
        { type: "text", text: locale === "en" ? "I delegated the code audit to Reviewer and the benchmark summary to Researcher." : "我已将代码审计委派给 Reviewer，并将基准测试汇总交给 Researcher。" },
      ]);
      await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [userMsg.id, "bot_arch"]);

      // Bot-to-Bot delegation #1: Architect -> Reviewer (pending approval card!)
      const revTarget = await hub.botMessages.local(
        { operation: "resolve", host: "Example Studio Host", bot: "bot_rev", requestId: randomUUID(), contextMessage: userMsg.id, data: {} },
        "bot_arch",
        guard,
      ) as { conversationId: string };
      const revSent = await hub.botMessages.local(
        { operation: "send", host: "Example Studio Host", bot: "bot_rev", conversation: revTarget.conversationId, requestId: "req-ui-rev", contextMessage: userMsg.id, data: { text: locale === "en" ? "Run the full regression suite and verify auth checks." : "运行完整回归测试并检查鉴权逻辑。" } },
        "bot_arch",
        guard,
      ) as { messageId: string };
      await hub.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id=?", [revSent.messageId, "bot_rev"]);
      await insertBotMessage(hub, "bot_rev", revTarget.conversationId, revSent.messageId, [{
        type: "card",
        title: locale === "en" ? "Approve shell command" : "请求执行命令审批",
        elements: [
          { type: "markdown", text: "npm run test:regression -- --reporter=verbose" },
          { type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId: "perm-ui-1", decision: "allow_once" } },
        ],
      }], "streaming");

      // Bot-to-Bot delegation #2: Architect -> Researcher (completed with reply!)
      const resTarget = await hub.botMessages.local(
        { operation: "resolve", host: "Example Studio Host", bot: "bot_res", requestId: randomUUID(), contextMessage: userMsg.id, data: {} },
        "bot_arch",
        guard,
      ) as { conversationId: string };
      const resSent = await hub.botMessages.local(
        { operation: "send", host: "Example Studio Host", bot: "bot_res", conversation: resTarget.conversationId, requestId: "req-ui-res", contextMessage: userMsg.id, data: { text: locale === "en" ? "Summarize layout benchmark numbers." : "整理布局基准数据。" } },
        "bot_arch",
        guard,
      ) as { messageId: string };
      await insertBotMessage(hub, "bot_res", resTarget.conversationId, resSent.messageId, [
        { type: "text", text: locale === "en" ? "Verified: 320px rail adds 0ms layout shift and fits 1360px cleanly." : "已验证：320px 侧栏无布局抖动，1360px 下三栏比例舒适。" },
      ], "complete");
      await hub.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [resSent.messageId, "bot_res"]);

      // Pair & open app
      await page.goto(hub.url);
      if (locale === "en") {
        const invitation = await fixtureInvitation(hub);
        await page.getByRole("button", { name: "Paste connection details", exact: true }).click();
        await page.getByLabel("Pairing information", { exact: true }).fill(pairingLink({ v: 1, kind: "connect", hubPublicKey: hub.auth.publicKey, invite: invitation.invite, routes: [{ name: "Direct", url: hub.url }] }));
        await page.getByRole("button", { name: "Use pairing information", exact: true }).click();
      } else {
        await page.getByLabel("主机名称", { exact: true }).fill("Example Studio Host");
        await preparePairing(page, hub);
      }
      await page.getByRole("button", { name: L("配对此设备"), exact: true }).click();
      await hub.auth.approve(await page.getByLabel(L("配对码"), { exact: true }).innerText(), "local-owner");
      await page.getByLabel(L("配对码"), { exact: true }).waitFor({ state: "hidden" });
      await waitForClientOnline(page);

      // Select the main conversation
      if (phone) {
        const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
        await home.getByRole("navigation", { name: L("主导航") }).getByRole("button", { name: new RegExp(`^${L("消息")}`) }).click();
        await home.locator(".mh-row").filter({ has: page.getByText(mainTitle, { exact: true }) }).click();
      } else {
        await page.locator(".conversation-row").filter({ has: page.getByText(mainTitle, { exact: true }) }).click();
      }
      await expect(page.getByRole("heading", { name: mainTitle, exact: true, level: 1 })).toBeVisible();

      // Workspace trigger is closed by default and shows the amber approval alert badge ("1").
      const trigger = page.getByRole("button", { name: L("会话工作区"), exact: true });
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger.locator(".workspace-rail-trigger-badge.is-alert")).toHaveText("1");

      // Open Workspace Rail / Sheet
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      const container = phone
        ? page.getByRole("dialog", { name: L("会话工作区"), exact: true })
        : page.locator("aside.conversation-workspace-rail");
      await expect(container).toBeVisible();
      if (!phone) {
        // Light rail does NOT trigger desktop side-panel window expansion.
        await expect(page.locator(".app-shell")).not.toHaveClass(/has-side-panel/);
      }

      // Overview tab: Environment + Bot-to-Bot Comms (needs approval + replied)
      await expect(container).toContainText("Example Studio Host");
      await expect(container).toContainText("Architect");
      await expect(container).toContainText("Reviewer");
      await expect(container).toContainText(L("待审批"));
      await expect(container).toContainText("Researcher");
      await expect(container).toContainText(L("已回传"));
      await noHorizontalOverflow(page, phone ? ".conversation-workspace-sheet" : ".conversation-workspace-rail");
      await shot(page, info, `${tag}-overview`);

      // Expand details inline on the completed comm
      const expandButtons = container.getByRole("button", { name: L("展开详情"), exact: true });
      await expandButtons.last().click();
      await expect(container).toContainText(locale === "en" ? "Verified: 320px rail" : "已验证：320px 侧栏");

      // Switch to Bot Comms tab and filter
      await container.getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
      await expect(container.getByRole("button", { name: new RegExp(L("进行中 / 待审批")) })).toBeVisible();
      await container.getByRole("button", { name: new RegExp(L("进行中 / 待审批")) }).click();
      await expect(container.locator(".workspace-comm-card")).toHaveCount(1);
      await expect(container).toContainText("Reviewer");
      await shot(page, info, `${tag}-comms`);

      // Switch to Files tab
      await container.getByRole("tab", { name: new RegExp(`^${L("文件")}`) }).click();
      await expect(container).toContainText(L("暂无本轮改动、工作台内容或对话文件。"));

      // Desktop mutual exclusion: opening Workbench hides Workspace Rail; closing Workbench restores it!
      if (!phone) {
        const workbenchBtn = page.getByRole("button", { name: L("工作台"), exact: true });
        await workbenchBtn.click();
        await expect(page.locator("aside.conversation-workspace-rail")).toHaveCount(0);
        await workbenchBtn.click();
        await expect(page.locator("aside.conversation-workspace-rail")).toBeVisible();
      }

      // Jump directly to the approval collaboration conversation
      await container.getByRole("tab", { name: new RegExp(L("总览")) }).click();
      await container.getByRole("button", { name: L("去批准"), exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Architect");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
