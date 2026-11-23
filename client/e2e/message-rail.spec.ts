import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { preparePairing } from "./fixtures/pairing-invite.js";

test.use({ serviceWorkers: "block" });

async function pairClient(page: import("@playwright/test").Page, hub: HubServer) {
  await page.goto(hub.url);
  await page.getByLabel("主机名称", { exact: true }).fill("macmini");
  await page.getByLabel("Hub 地址", { exact: true }).fill(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await page.locator(".host-workspace:not([hidden])").waitFor({ state: "visible" });
}

test("desktop message rail jumps to unrendered earlier messages in a long conversation, shows hover preview, and tracks scrolling", async ({ page }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "message-rail-long-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_codex','Codex','fixture',1)");
    const chat = await hub.store.createConversation("owner", ["bot_codex"], "Long History Check", "chat_long");

    const turnCount = 55;
    const userMessageIds: string[] = [];
    for (let i = 1; i <= turnCount; i++) {
      const sent = await hub.store.sendMessage("owner", {
        conversationId: chat.id,
        clientMsgId: `c_u_${i}`,
        text: `Turn ${i}: Check milestone ${i} architecture and rollout checklist.`,
        attachments: [],
      });
      userMessageIds.push(sent.message.id);
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: chat.id,
        replyTo: sent.message.id,
        status: "complete",
        blocks: [{
          type: "text",
          text: `Reply ${i}: Verified step ${i}.\n\n` + Array.from({ length: 6 }, (_, j) => `- Detail line ${j + 1} for turn ${i} covering implementation and verification.`).join("\n"),
        }],
      });
    }

    await pairClient(page, hub);
    await page.locator(".sidebar").getByRole("button", { name: "按对话", exact: true }).click();
    await page.locator(`[data-conversation-id="${chat.id}"]`).click();

    const rail = page.getByRole("navigation", { name: "消息刻度条", exact: true });
    await expect(rail).toBeVisible();

    // Long conversation samples ticks cleanly (<= 44) while keeping first and last turns.
    const ticks = rail.locator(".message-rail-tick");
    const count = await ticks.count();
    expect(count).toBeGreaterThanOrEqual(20);
    expect(count).toBeLessThanOrEqual(44);
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[0]}"]`)).toBeVisible();
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[turnCount - 1]}"]`)).toBeVisible();

    // Initially at bottom -> last turn tick is active, and Turn 1 is NOT mounted in the DOM yet (virtualized).
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[turnCount - 1]}"]`)).toHaveClass(/is-active/);
    await expect(page.locator(`[data-message-id="${userMessageIds[0]}"]`)).toHaveCount(0);

    // Hovering first tick displays the preview card with both prompt and reply preview.
    const firstTick = rail.locator(`[data-rail-message-id="${userMessageIds[0]}"]`);
    await firstTick.hover();
    const preview = rail.locator(".message-rail-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Turn 1: Check milestone 1");
    await expect(preview).toContainText("Reply 1: Verified step 1.");

    // Clicking the first tick jumps straight to the previously unrendered message and lands it in the viewport.
    await firstTick.click();
    const firstMessage = page.locator(`[data-message-id="${userMessageIds[0]}"]`);
    await expect(firstMessage).toBeVisible();
    await expect(firstMessage).toHaveClass(/focused-message/);
    await expect(firstTick).toHaveClass(/is-active/);
    const inViewport = await page.evaluate((id) => {
      const vp = document.querySelector(".message-scroll")?.getBoundingClientRect();
      const row = document.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect();
      return !!vp && !!row && row.bottom > vp.top && row.top < vp.bottom;
    }, userMessageIds[0]!);
    expect(inViewport).toBe(true);

    // Scrolling back down updates the active tick to follow the scroll position.
    await page.evaluate(() => {
      const vp = document.querySelector<HTMLElement>(".message-scroll");
      if (vp) vp.scrollTop = vp.scrollHeight;
    });
    await expect(rail.locator(`[data-rail-message-id="${userMessageIds[turnCount - 1]}"]`)).toHaveClass(/is-active/);
  } finally {
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("desktop message rail works in group conversations and stays hidden on phone viewports", async ({ page }) => {
  test.setTimeout(90_000);
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "message-rail-group-"));
  const hub = await HubServer.start({ stateDir, clientDir: path.resolve("dist") });
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,online) VALUES('bot_a','Architect','fixture',1),('bot_b','Reviewer','fixture',1)");
    const group = await hub.store.createConversation("owner", ["bot_a", "bot_b"], "Design Sync", "group_sync", "group");
    const u1 = await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "g_u1", text: "Kickoff: compare storage options", attachments: [] });
    await hub.store.publishBotMessage("bot_a", { conversationId: group.id, replyTo: u1.message.id, status: "complete", blocks: [{ type: "text", text: "Option A uses local cache plus sync." }] });
    const u2 = await hub.store.sendMessage("owner", { conversationId: group.id, clientMsgId: "g_u2", text: "Follow-up: check latency budget", attachments: [] });
    await hub.store.publishBotMessage("bot_b", { conversationId: group.id, replyTo: u2.message.id, status: "complete", blocks: [{ type: "text", text: "P95 stays under 20 ms." }] });

    await pairClient(page, hub);
    await page.locator(".sidebar").getByRole("button", { name: "按对话", exact: true }).click();
    await page.locator(`[data-conversation-id="${group.id}"]`).click();

    const rail = page.getByRole("navigation", { name: "消息刻度条", exact: true });
    await expect(rail).toBeVisible();
    await expect(rail.locator(".message-rail-tick")).toHaveCount(2);

    await rail.locator(`[data-rail-message-id="${u1.message.id}"]`).hover();
    await expect(rail.locator(".message-rail-preview")).toContainText("Architect:");
    await expect(rail.locator(".message-rail-preview")).toContainText("Option A uses local cache");

    // Phone viewport hides the rail cleanly.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rail).toHaveCount(0);
  } finally {
    await hub.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
