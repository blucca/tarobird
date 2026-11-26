import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { messageAction } from "./fixtures/message-actions.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";

test.use({ serviceWorkers: "block" });

type SampleReport = {
  queuedCountMax: number;
  maxBubbleCopies: number;
  lefts: number[];
  widths: number[];
  bgs: string[];
  prevBottomDelta: number;
  sawFinalBubble: boolean;
};

async function installSendFrameSampler(page: Page, text: string) {
  await page.evaluate((targetText) => {
    const state = {
      active: true,
      queuedCountMax: 0,
      maxBubbleCopies: 0,
      lefts: [] as number[],
      widths: [] as number[],
      bgs: [] as string[],
      initialPrevBottom: undefined as number | undefined,
      prevBottomDelta: 0,
      sawFinalBubble: false,
    };
    const prevRow = [...document.querySelectorAll<HTMLElement>("[data-message-id]")].at(-1);
    if (prevRow) state.initialPrevBottom = prevRow.getBoundingClientRect().bottom;

    const record = () => {
      const queued = document.querySelectorAll(".queued-message").length;
      if (queued > state.queuedCountMax) state.queuedCountMax = queued;
      const matches = [...document.querySelectorAll<HTMLElement>(".message.user")].filter(
        (node) => node.innerText.includes(targetText),
      );
      if (matches.length > state.maxBubbleCopies) state.maxBubbleCopies = matches.length;
      const row = matches[0];
      if (row) {
        const bubble = row.querySelector<HTMLElement>(".message-blocks");
        if (bubble) {
          const rect = bubble.getBoundingClientRect();
          const bg = getComputedStyle(bubble).backgroundColor;
          if (!state.lefts.length || Math.abs(state.lefts.at(-1)! - rect.left) > 0.5) state.lefts.push(Math.round(rect.left));
          if (!state.widths.length || Math.abs(state.widths.at(-1)! - rect.width) > 0.5) state.widths.push(Math.round(rect.width));
          if (!state.bgs.length || state.bgs.at(-1) !== bg) state.bgs.push(bg);
        }
        if (!row.classList.contains("is-pending-outbox")) state.sawFinalBubble = true;
      }
      if (prevRow && prevRow.isConnected && state.initialPrevBottom !== undefined) {
        const delta = Math.abs(prevRow.getBoundingClientRect().bottom - state.initialPrevBottom);
        if (delta > state.prevBottomDelta) state.prevBottomDelta = delta;
      }
    };

    const observer = new MutationObserver(() => { if (state.active) record(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const tick = () => {
      if (!state.active) return;
      record();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    Object.assign(window, {
      __sendSampleStop: (): SampleReport => {
        state.active = false;
        observer.disconnect();
        record();
        return {
          queuedCountMax: state.queuedCountMax,
          maxBubbleCopies: state.maxBubbleCopies,
          lefts: state.lefts,
          widths: state.widths,
          bgs: state.bgs,
          prevBottomDelta: state.prevBottomDelta,
          sawFinalBubble: state.sawFinalBubble,
        };
      },
    });
  }, text);
}

async function stopSendFrameSampler(page: Page): Promise<SampleReport> {
  return page.evaluate(() => (window as any).__sendSampleStop());
}

for (const formFactor of [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
]) {
  for (const length of ["short", "long"] as const) {
    test(`normal online send shows zero dashed box and zero bubble jump (${formFactor.name}, ${length})`, async ({ page }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "no-flash-"));
      const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
      try {
        await page.setViewportSize(formFactor.viewport);
        await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_codex','Codex Bot','codex','fixture',1)");
        const chat = await hub.store.createConversation("owner", ["bot_codex"], "No Flash Chat", "chat_1");
        const seedCount = length === "long" ? 40 : 2;
        for (let i = 0; i < seedCount; i++) {
          await hub.store.publishBotMessage("bot_codex", { conversationId: chat.id, blocks: [{ type: "text", text: `Seed message ${i}` }] });
        }
        await page.goto(hub.url);
        await preparePairing(page, hub);
        await page.getByRole("button", { name: "配对此设备", exact: true }).click();
        await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
        await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
        await waitForClientOnline(page);
        await selectConversation(page, "No Flash Chat");
        await expect(page.locator(".message-blocks").filter({ hasText: `Seed message ${seedCount - 1}` })).toBeInViewport();

        const targetText = `Direct online message ${formFactor.name} ${length}`;
        const input = page.getByRole("textbox", { name: "消息", exact: true });
        await input.fill(targetText);
        await installSendFrameSampler(page, targetText);
        await page.getByRole("button", { name: "发送消息", exact: true }).click();
        await expect(page.locator(".message.user").filter({ hasText: targetText })).toBeInViewport();
        await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: targetText })).toHaveCount(0);
        const report = await stopSendFrameSampler(page);

        expect(report.queuedCountMax).toBe(0);
        expect(report.maxBubbleCopies).toBe(1);
        expect(report.sawFinalBubble).toBe(true);
        expect(report.lefts).toHaveLength(1);
        expect(report.widths).toHaveLength(1);
        expect(report.bgs).toHaveLength(1);
        if (length === "short") {
          expect(report.prevBottomDelta).toBeLessThanOrEqual(1);
        }
      } finally {
        await page.close();
        await hub.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("all engines, groups, forwards, and card actions emit no dashed box on normal online send", async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "no-flash-engines-"));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve("dist") });
  const engines = [
    { id: "bot_claude", name: "Claude Bot", engine: "claude" },
    { id: "bot_codex", name: "Codex Bot", engine: "codex" },
    { id: "bot_kimi", name: "Kimi Bot", engine: "kimi" },
    { id: "bot_agy", name: "Antigravity Bot", engine: "antigravity" },
    { id: "bot_deepseek", name: "DeepSeek Bot", engine: "deepseek" },
    { id: "bot_pi", name: "Pi Bot", engine: "pi" },
  ];
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const bot of engines) {
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES(?,?,?,'fixture',1)", [bot.id, bot.name, bot.engine]);
      const conv = await hub.store.createConversation("owner", [bot.id], bot.name, `conv_${bot.id}`);
      await hub.store.publishBotMessage(bot.id, {
        conversationId: conv.id,
        blocks: [
          { type: "text", text: `Ready ${bot.engine}` },
          ...(bot.engine === "kimi"
            ? [{ type: "card" as const, title: "Quick Action", elements: [{ type: "button" as const, text: "Confirm Kimi", actionId: "confirm_kimi", value: {} }] }]
            : []),
        ],
      });
    }
    const group = await hub.store.createConversation("owner", ["bot_kimi", "bot_deepseek"], "Engine Group", "conv_group", { type: "group" });
    await hub.store.publishBotMessage("bot_kimi", { conversationId: group.id, blocks: [{ type: "text", text: "Group Ready" }] });

    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await waitForClientOnline(page);
    await showDisconnectedBots(page);

    for (const bot of engines) {
      await selectConversation(page, bot.name);
      const text = `Normal send ${bot.engine}`;
      await page.getByRole("textbox", { name: "消息", exact: true }).fill(text);
      await installSendFrameSampler(page, text);
      await page.keyboard.press("Enter");
      await expect(page.locator(".message.user").filter({ hasText: text })).toBeVisible();
      await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: text })).toHaveCount(0);
      const report = await stopSendFrameSampler(page);
      expect(report.queuedCountMax, `${bot.engine} flashed .queued-message`).toBe(0);
      expect(report.maxBubbleCopies).toBe(1);
    }

    // Card action (online) must not flash .queued-message either.
    await selectConversation(page, "Kimi Bot");
    await installSendFrameSampler(page, "卡片操作");
    await page.getByRole("button", { name: "Confirm Kimi", exact: true }).click();
    await page.waitForTimeout(150);
    const cardReport = await stopSendFrameSampler(page);
    expect(cardReport.queuedCountMax).toBe(0);

    // Group send (ordinary mentions) must not flash .queued-message.
    await selectConversation(page, "Engine Group");
    const groupText = "Group online send";
    await page.getByRole("textbox", { name: "消息", exact: true }).fill(groupText);
    await installSendFrameSampler(page, groupText);
    await page.keyboard.press("Enter");
    await expect(page.locator(".message.user").filter({ hasText: groupText })).toBeVisible();
    await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: groupText })).toHaveCount(0);
    const groupReport = await stopSendFrameSampler(page);
    expect(groupReport.queuedCountMax).toBe(0);
    expect(groupReport.maxBubbleCopies).toBe(1);

    // Forwarded message must not flash .queued-message.
    await selectConversation(page, "DeepSeek Bot");
    await installSendFrameSampler(page, "Ready deepseek");
    await messageAction(page, page.locator(".message.bot").filter({ hasText: "Ready deepseek" }), "转发消息");
    const dialog = page.getByRole("dialog", { name: "转发消息", exact: true });
    await dialog.getByRole("button", { name: "Engine Group", exact: true }).click();
    await dialog.getByRole("button", { name: "确认转发", exact: true }).click();
    await expect(page.locator(".message.user").filter({ hasText: "Ready deepseek" })).toBeVisible();
    await expect(page.locator(".message.user.is-pending-outbox").filter({ hasText: "Ready deepseek" })).toHaveCount(0);
    const forwardReport = await stopSendFrameSampler(page);
    expect(forwardReport.queuedCountMax).toBe(0);
    expect(forwardReport.maxBubbleCopies).toBe(1);
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
