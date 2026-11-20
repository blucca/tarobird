import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubServer } from "../../src/hub/server.js";
import { hashSecret } from "../../src/hub/auth.js";
import { HOST_PROFILE_KEY } from "../../src/hub/host-profile.js";
import type { HistoryTimings } from "../../src/hub/history.js";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import type { CoreBridgeLike } from "../../src/core/types.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../../src/core/message-normalizer.js";
import { appendHistoryLedgerLine } from "../../src/runtime/history-ledger.js";
import { SessionStore } from "../../src/state/session-store.js";
import { HISTORY_CAPABILITY } from "../../src/client-protocol/history.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { showDisconnectedBots, selectConversation, waitForClientOnline } from "./fixtures/mobile.js";
import { holdMessage } from "./fixtures/message-actions.js";

const CLIENT_DIST = path.resolve(import.meta.dirname, "../dist");
const SCREENSHOT_DIR = process.env.ISSUE53_SCREENSHOT_DIR;

type FakeHistoryBotOptions = {
  id: string;
  name: string;
  engine: "codex" | "claude" | "kimi" | "deepseek" | "antigravity";
  rewind: "turn" | "none";
  fork: "turn" | "head" | "none";
  supported?: boolean;
  onRewind?: (input: { sessionId: string; anchor: unknown }) => Promise<void>;
  onFork?: (input: { sessionId: string; through?: unknown }) => Promise<{ sessionId: string }>;
  onMessage?: (text: string) => Promise<string>;
};

async function attachFakeHistoryBot(hub: HubServer, root: string, options: FakeHistoryBotOptions) {
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run(
    "INSERT INTO bots(id,name,secret_hash,engine) VALUES(?,?,?,?)",
    [options.id, options.name, hashSecret(secret), options.engine],
  );
  const stateDir = path.join(root, `bot-${options.id}`);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: options.engine, locale: "zh" }));
  const store = new SessionStore(path.join(stateDir, "session.json"));
  const runtime = createCoreServiceRuntime();
  let forkSeq = 0;

  const supported = options.supported ?? (options.rewind !== "none" || options.fork !== "none");
  const bridge: CoreBridgeLike = {
    handleAuthorizedMessage: async (message) => ({ text: await (options.onMessage?.(message.text) ?? Promise.resolve("示例回复")) }),
    ...(supported ? {
      historySupport: () => ({ rewind: options.rewind !== "none", fork: options.fork !== "none" }),
      historySession: async (scope) => {
        const record = await store.findByConversationKey(scope.conversationKey);
        return record?.codexSessionId && !record.codexSessionId.startsWith("tarobot-") ? { sessionId: record.codexSessionId } : null;
      },
      withHistoryLocks: async (scope, work) => {
        const record = await store.findByConversationKey(scope.conversationKey);
        const session = record?.codexSessionId && !record.codexSessionId.startsWith("tarobot-") ? { sessionId: record.codexSessionId } : null;
        return await work(session);
      },
      historyCapability: async () => ({ rewind: options.rewind, fork: options.fork }),
      rewindHistory: async (input) => {
        if (options.onRewind) await options.onRewind(input);
        return { sessionId: input.sessionId };
      },
      forkHistory: async (input) => {
        if (options.onFork) return await options.onFork(input);
        return { sessionId: `thr-fork-${++forkSeq}` };
      },
      bindForkedHistorySession: async (target, sessionId) => {
        await store.upsert({
          telegramChatId: stableCoreNumericId(target.conversationKey),
          conversationKey: target.conversationKey,
          codexSessionId: sessionId,
          status: "idle",
          updatedAt: new Date().toISOString(),
        });
      },
    } : {}),
  };

  const gateway = await attachGateway({
    stateDir,
    url: hub.instanceUrl.replace("http", "ws") + "/instance",
    botId: options.id,
    engine: options.engine,
    secret,
    runtime,
    bridge,
  });

  const bindConversation = async (conversationId: string, sessionId: string) => {
    const conversationKey = buildCoreConversationKey(conversationId);
    await store.upsert({
      telegramChatId: stableCoreNumericId(conversationKey),
      conversationKey,
      codexSessionId: sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
  };

  const recordTurn = async (conversationId: string, sessionId: string, sourceMessageId: string, turnNumber: number) => {
    const conversationKey = buildCoreConversationKey(conversationId);
    await appendHistoryLedgerLine(stateDir, conversationKey, {
      v: 1,
      sourceMessageId,
      runId: `run_${sourceMessageId}`,
      engine: options.engine,
      sessionId,
      anchor: options.engine === "deepseek"
        ? { endSeq: turnNumber * 10 }
        : { firstTurnId: `turn_${turnNumber}`, lastTurnId: `turn_${turnNumber}` },
      startedAt: turnNumber * 1000,
      endedAt: turnNumber * 1000 + 500,
      outcome: "ok",
    });
  };

  return { gateway, runtime, store, stateDir, bindConversation, recordTurn };
}

async function seedTurn(hub: HubServer, conversationId: string, botId: string, userText: string, botText: string, index: number) {
  await new Promise(resolve => setTimeout(resolve, 4));
  const { message: userMsg } = await hub.store.sendMessage("owner", {
    clientMsgId: `seed_u_${conversationId}_${index}`,
    conversationId,
    text: userText,
    attachments: [],
  });
  await hub.store.db.run("UPDATE deliveries SET status='accepted', dispatched=1 WHERE message_id=? AND bot_id=?", [userMsg.id, botId]);
  await new Promise(resolve => setTimeout(resolve, 4));
  const botMsg = await hub.store.publishBotMessage(botId, {
    conversationId,
    replyTo: userMsg.id,
    blocks: [{ type: "text", text: botText }],
  });
  return { userMsg, botMsg };
}

async function seedSyntheticHostProfile(hub: HubServer, name = "示例主机") {
  await hub.store.db.run(
    "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [HOST_PROFILE_KEY, JSON.stringify({ name, revision: 0 })],
  );
}

async function pairPage(page: Page, hub: HubServer, conversationTitle: string) {
  await page.goto(hub.url);
  await preparePairing(page, hub);
  await page.getByRole("button", { name: "配对此设备", exact: true }).click();
  await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
  await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
  await showDisconnectedBots(page);
  await waitForClientOnline(page);
  await selectConversation(page, conversationTitle);
}

async function switchLocale(page: Page, locale: "zh" | "en") {
  await page.evaluate(async (next) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tarocub-hosts-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        const store = tx.objectStore("meta");
        const getReq = store.get("preferences");
        getReq.onsuccess = () => {
          const parsed = typeof getReq.result === "string"
            ? JSON.parse(getReq.result) as Record<string, unknown>
            : (getReq.result && typeof getReq.result === "object" ? getReq.result as Record<string, unknown> : {});
          store.put(JSON.stringify({ ...parsed, locale: next }), "preferences");
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, locale);
  await page.reload();
  await waitForClientOnline(page);
}

async function selectConversationAnyLocale(page: Page, title: string) {
  if ((page.viewportSize()?.width ?? 1360) <= 760) {
    const back = page.locator(".host-workspace:not([hidden]) .conversation-header .mobile-menu");
    if (await back.isVisible()) await back.click();
    const home = page.locator(".host-workspace:not([hidden]) .mobile-home");
    await expect(home).toBeVisible();
    await home.locator(".mh-row").filter({ has: page.getByText(title, { exact: true }) }).click();
  } else {
    await page.locator(".conversation-row").filter({ has: page.getByText(title, { exact: true }) }).click();
  }
  await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
}

async function saveShot(page: Page, filename: string) {
  if (!SCREENSHOT_DIR) return;
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(SCREENSHOT_DIR, filename) });
}

test.describe("Conversation history rewind & fork (#53)", () => {
  test("entries, blocked reasons, rewind collapse/expand, multi-device sync and reload persistence", async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "history-ui-entries-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: CLIENT_DIST });
    await seedSyntheticHostProfile(hub);
    const desktopCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
    const desktop = await desktopCtx.newPage();
    const phone = await phoneCtx.newPage();
    const errors: string[] = [];
    for (const p of [desktop, phone]) p.on("pageerror", e => errors.push(e.message));

    const codex = await attachFakeHistoryBot(hub, root, { id: "bot_codex", name: "示例助手 A", engine: "codex", rewind: "turn", fork: "turn" });
    const claude = await attachFakeHistoryBot(hub, root, { id: "bot_claude", name: "示例助手 B", engine: "claude", rewind: "none", fork: "head" });
    const agy = await attachFakeHistoryBot(hub, root, { id: "bot_agy", name: "示例助手 C", engine: "antigravity", rewind: "none", fork: "none", supported: false });

    try {
      const codexChat = await hub.store.createConversation("owner", ["bot_codex"], "代码重构讨论", "chat_codex");
      const claudeChat = await hub.store.createConversation("owner", ["bot_claude"], "方案梳理", "chat_claude");
      const agyChat = await hub.store.createConversation("owner", ["bot_agy"], "日常备忘", "chat_agy");

      await codex.bindConversation(codexChat.id, "thr_codex_1");
      await claude.bindConversation(claudeChat.id, "ses_claude_1");
      await agy.bindConversation(agyChat.id, "ses_agy_1");

      const t1 = await seedTurn(hub, codexChat.id, "bot_codex", "第一轮：分析现有目录结构", "已完成目录结构梳理。", 1);
      const t2 = await seedTurn(hub, codexChat.id, "bot_codex", "第二轮：把配置改成 YAML 格式", "已给出 YAML 方案。", 2);
      const t3 = await seedTurn(hub, codexChat.id, "bot_codex", "第三轮：顺便生成迁移脚本", "迁移脚本如下。", 3);
      await codex.recordTurn(codexChat.id, "thr_codex_1", t1.userMsg.id, 1);
      await codex.recordTurn(codexChat.id, "thr_codex_1", t2.userMsg.id, 2);
      await codex.recordTurn(codexChat.id, "thr_codex_1", t3.userMsg.id, 3);

      const claudeT1 = await seedTurn(hub, claudeChat.id, "bot_claude", "整理发布清单", "好的，这是发布清单。", 1);
      const agyT1 = await seedTurn(hub, agyChat.id, "bot_agy", "记录一条待办", "已记录。", 1);

      await pairPage(desktop, hub, codexChat.title);
      await pairPage(phone, hub, codexChat.title);

      // 1a. Codex (rewind: turn, fork: turn) — Desktop right-click & Shift+F10, plus chat-menu & ConversationPanel
      const row2Desktop = desktop.locator(`article[data-message-id="${t2.userMsg.id}"]`);
      await row2Desktop.click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "从这一轮分叉", exact: true })).toBeVisible();
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true })).toBeVisible();
      await saveShot(desktop, "01-desktop-message-menu-codex.png");
      await desktop.keyboard.press("Escape");

      // Shift+F10 keyboard context menu on user message; Bot reply hides both
      await row2Desktop.focus();
      await desktop.keyboard.press("Shift+F10");
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true })).toBeVisible();
      await desktop.keyboard.press("Escape");

      await desktop.locator(`article[data-message-id="${t2.botMsg.id}"]`).click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "从这一轮分叉" })).toHaveCount(0);
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前" })).toHaveCount(0);
      await desktop.keyboard.press("Escape");

      // Desktop chat-menu has "分叉当前对话"
      await desktop.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await expect(desktop.getByRole("menuitem", { name: "分叉当前对话" }).or(desktop.locator(".chat-menu button", { hasText: "分叉当前对话" }))).toBeVisible();
      await desktop.keyboard.press("Escape");

      // Phone long-press message sheet has both entries; phone "聊天操作" has "分叉当前对话"
      const row2Phone = phone.locator(`article[data-message-id="${t2.userMsg.id}"]`);
      await holdMessage(phone, row2Phone);
      const sheet = phone.getByRole("dialog", { name: "消息操作", exact: true });
      await expect(sheet.getByRole("button", { name: "从这一轮分叉", exact: true })).toBeVisible();
      await expect(sheet.getByRole("button", { name: "回退到这条之前", exact: true })).toBeVisible();
      await saveShot(phone, "02-phone-message-sheet-codex.png");
      await sheet.getByRole("button", { name: "关闭消息操作", exact: true }).click();

      await phone.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      const phoneChatSheet = phone.getByRole("dialog", { name: "聊天操作", exact: true });
      await expect(phoneChatSheet.getByRole("button", { name: "分叉当前对话", exact: true })).toBeVisible();
      await phoneChatSheet.getByRole("button", { name: "关闭聊天操作", exact: true }).click();

      // Desktop ConversationPanel ("对话详情" -> "对话设置") shows "分叉当前对话" right after "新建独立对话"
      await desktop.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await desktop.locator(".chat-menu button", { hasText: "对话详情" }).click();
      await desktop.getByRole("button", { name: "对话设置", exact: true }).click();
      const panel = desktop.getByRole("dialog", { name: "对话设置", exact: true });
      await expect(panel.getByRole("button", { name: "分叉当前对话" })).toBeVisible();
      await panel.getByRole("button", { name: "关闭对话设置", exact: true }).click();
      await desktop.getByRole("button", { name: "关闭对话详情", exact: true }).click();

      // 1b. Claude (fork: head only) — No message entries, YES conversation menu entry
      await selectConversation(desktop, claudeChat.title);
      await desktop.locator(`article[data-message-id="${claudeT1.userMsg.id}"]`).click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "从这一轮分叉" })).toHaveCount(0);
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前" })).toHaveCount(0);
      await desktop.keyboard.press("Escape");
      await desktop.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await expect(desktop.locator(".chat-menu button", { hasText: "分叉当前对话" })).toBeVisible();
      await desktop.keyboard.press("Escape");

      // 1c. Antigravity (unsupported) — Neither message nor conversation entries
      await selectConversation(desktop, agyChat.title);
      await desktop.locator(`article[data-message-id="${agyT1.userMsg.id}"]`).click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "从这一轮分叉" })).toHaveCount(0);
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前" })).toHaveCount(0);
      await desktop.keyboard.press("Escape");
      await desktop.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await expect(desktop.locator(".chat-menu button", { hasText: "分叉当前对话" })).toHaveCount(0);
      await desktop.keyboard.press("Escape");

      // 2. Blocked reasons: running & queued (desktop + phone)
      await selectConversation(desktop, codexChat.title);
      const codexKey = buildCoreConversationKey(codexChat.id);
      codex.runtime.activeRuns.set(codexKey, { abortController: new AbortController() });
      await hub.store.appendBotEvent("bot_codex", codexChat.id, "turn.state", { running: true });
      await row2Desktop.click({ button: "right" });
      const rewindItem = desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true });
      await expect(rewindItem).toBeDisabled();
      await expect(desktop.locator(".desktop-menu-note")).toContainText("当前轮结束或停止后可用");
      await desktop.keyboard.press("Escape");

      await holdMessage(phone, row2Phone);
      const blockedSheet = phone.getByRole("dialog", { name: "消息操作", exact: true });
      await expect(blockedSheet.getByRole("button", { name: "回退到这条之前", exact: true })).toBeDisabled();
      await expect(blockedSheet).toContainText("当前轮结束或停止后可用");
      await blockedSheet.getByRole("button", { name: "关闭消息操作", exact: true }).click();
      codex.runtime.activeRuns.delete(codexKey);

      // Queued delivery also blocks with the queued reason
      await hub.store.db.run("UPDATE deliveries SET status='pending', dispatched=0 WHERE message_id=? AND bot_id=?", [t3.userMsg.id, "bot_codex"]);
      await hub.store.appendBotEvent("bot_codex", codexChat.id, "turn.state", { promptQueue: { botId: "bot_codex", changed: true } });
      await row2Desktop.click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true })).toBeDisabled();
      await expect(desktop.locator(".desktop-menu-note")).toContainText("排队消息发完或取消后可用");
      await desktop.keyboard.press("Escape");

      await hub.store.db.run("UPDATE deliveries SET status='accepted', dispatched=1 WHERE message_id=? AND bot_id=?", [t3.userMsg.id, "bot_codex"]);
      await hub.store.appendBotEvent("bot_codex", codexChat.id, "turn.state", { running: false });

      // 3. Rewind dialog check ("文件改动" first) -> cancel -> confirm -> collapse -> multi-device -> expand -> reload
      await row2Desktop.click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true })).toBeEnabled();
      await desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true }).click();

      const dialog = desktop.getByRole("dialog", { name: "回退到这条消息之前", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator(".explanation-list dt")).toHaveText(["文件改动", "聊天记录", "无法撤销"]);
      await expect(dialog).toContainText("这条消息和它之后的 3 条消息将离开 Bot 的上下文");
      await saveShot(desktop, "03-desktop-rewind-confirm.png");

      // Cancel first
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(row2Desktop).toBeVisible();

      // Reopen & confirm
      await row2Desktop.click({ button: "right" });
      await desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true }).click();
      await desktop.getByRole("dialog", { name: "回退到这条消息之前", exact: true }).getByRole("button", { name: "回退", exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // Collapsed row appears on BOTH desktop and phone (without phone reload!)
      for (const page of [desktop, phone]) {
        const notice = page.locator(".rewind-notice summary");
        await expect(notice).toBeVisible();
        await expect(notice).toContainText("已回退的 4 条消息");
        await expect(notice).toContainText("不再进入上下文");
        await expect(page.locator(`article[data-message-id="${t2.userMsg.id}"]`)).toHaveCount(0);
        await expect(page.locator(`article[data-message-id="${t1.userMsg.id}"]`)).toBeVisible();
      }
      await saveShot(desktop, "04-desktop-rewound-collapsed.png");
      await saveShot(phone, "05-phone-rewound-collapsed.png");

      // Expand locally on desktop -> dimmed with left border; phone remains collapsed
      await desktop.locator(".rewind-notice summary").click();
      const expandedRow = desktop.locator(`article[data-message-id="${t2.userMsg.id}"]`);
      await expect(expandedRow).toBeVisible();
      await expect(expandedRow).toHaveClass(/is-rewound/);
      await saveShot(desktop, "06-desktop-rewound-expanded.png");
      await expect(phone.locator(`article[data-message-id="${t2.userMsg.id}"]`)).toHaveCount(0);

      // Expanded rewound message hides rewind/fork entries while keeping copy/quote/forward
      await expandedRow.click({ button: "right" });
      await expect(desktop.getByRole("menuitem", { name: "复制消息", exact: true })).toBeVisible();
      await expect(desktop.getByRole("menuitem", { name: "回复", exact: true })).toBeVisible();
      await expect(desktop.getByRole("menuitem", { name: "转发", exact: true })).toBeVisible();
      await expect(desktop.getByRole("menuitem", { name: "从这一轮分叉" })).toHaveCount(0);
      await expect(desktop.getByRole("menuitem", { name: "回退到这条之前" })).toHaveCount(0);
      await desktop.keyboard.press("Escape");

      // Reload desktop -> collapsed row persists
      await desktop.reload();
      await waitForClientOnline(desktop);
      await selectConversation(desktop, codexChat.title);
      await expect(desktop.locator(".rewind-notice summary")).toContainText("已回退的 4 条消息");
      expect(errors).toEqual([]);
    } finally {
      await codex.gateway.disconnect();
      await claude.gateway.disconnect();
      await agy.gateway.disconnect();
      await desktopCtx.close();
      await phoneCtx.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fork marks (list, header, top banner), jump to original, other device stays put, and message sent during delayed rewind", async ({ browser }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "history-ui-fork-"));
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: CLIENT_DIST });
    await seedSyntheticHostProfile(hub);
    const desktopCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
    const desktop = await desktopCtx.newPage();
    const phone = await phoneCtx.newPage();
    const errors: string[] = [];
    for (const p of [desktop, phone]) p.on("pageerror", e => errors.push(e.message));

    let releaseRewind: (() => void) | undefined;
    let rewindEntered: (() => void) | undefined;
    const rewindWaiting = new Promise<void>(resolve => { rewindEntered = resolve; });
    const dispatchedTexts: string[] = [];

    const codex = await attachFakeHistoryBot(hub, root, {
      id: "bot_codex",
      name: "示例助手",
      engine: "codex",
      rewind: "turn",
      fork: "turn",
      onRewind: async () => {
        rewindEntered?.();
        await new Promise<void>(resolve => { releaseRewind = resolve; });
      },
      onMessage: async (text) => {
        dispatchedTexts.push(text);
        return `已处理：${text}`;
      },
    });

    try {
      const chat = await hub.store.createConversation("owner", ["bot_codex"], "架构讨论", "chat_arch");
      await codex.bindConversation(chat.id, "thr_arch_1");
      const t1 = await seedTurn(hub, chat.id, "bot_codex", "第一轮：确定接口边界", "接口边界已确认。", 1);
      const t2 = await seedTurn(hub, chat.id, "bot_codex", "第二轮：补充缓存策略", "缓存策略如下。", 2);
      await codex.recordTurn(chat.id, "thr_arch_1", t1.userMsg.id, 1);
      await codex.recordTurn(chat.id, "thr_arch_1", t2.userMsg.id, 2);

      await pairPage(desktop, hub, chat.title);
      await pairPage(phone, hub, chat.title);

      // 1. Fork from turn 1 on desktop
      await desktop.locator(`article[data-message-id="${t1.userMsg.id}"]`).click({ button: "right" });
      await desktop.getByRole("menuitem", { name: "从这一轮分叉", exact: true }).click();
      const forkDialog = desktop.getByRole("dialog", { name: "从这一轮分叉", exact: true });
      await expect(forkDialog).toBeVisible();
      await expect(forkDialog.locator(".explanation-list dt")).toHaveText(["文件", "聊天记录", "不带过去"]);
      await saveShot(desktop, "07-desktop-fork-confirm.png");
      await forkDialog.getByRole("button", { name: "分叉", exact: true }).click();
      await expect(forkDialog).toHaveCount(0);

      // Initiating device jumps to the forked conversation and shows all 3 marks + forked empty copy
      await expect(desktop.locator(".chat-identity")).toContainText("架构讨论 · 分叉");
      await expect(desktop.locator(".fork-origin-badge")).toContainText("分叉自 架构讨论");
      await expect(desktop.locator(".fork-origin-banner")).toContainText("分叉自「架构讨论」");
      await expect(desktop.locator(".fork-origin-banner")).toContainText("第一轮：确定接口边界");
      await expect(desktop.locator(".direct-empty")).toContainText("已带入原对话的上下文，可以直接接着聊。原对话不受影响。");
      await expect(desktop.locator(".conversation-list [aria-label='分叉对话']").first()).toBeVisible();
      await saveShot(desktop, "08-desktop-forked-chat.png");

      // Second device (phone) stays on original chat (does NOT jump!)
      await expect(phone.locator(".chat-identity")).toHaveText("架构讨论");
      // Phone home list shows the fork icon on the new conversation
      await phone.getByRole("button", { name: "打开会话列表", exact: true }).click();
      await expect(phone.locator(".mobile-home [aria-label='分叉对话']").first()).toBeVisible();
      await saveShot(phone, "09-phone-fork-list-mark.png");
      await selectConversation(phone, chat.title);

      // Click "查看原对话" on desktop -> returns to original conversation & focuses turn 1
      await desktop.getByRole("button", { name: "查看原对话", exact: true }).click();
      await expect(desktop.locator(".chat-identity")).toHaveText("架构讨论");
      await expect(desktop.locator(`article[data-message-id="${t1.userMsg.id}"]`)).toHaveClass(/focused-message/);

      // 2. Sending a message while rewind is delayed stays outside the rewound range and dispatches afterwards
      await desktop.locator(`article[data-message-id="${t2.userMsg.id}"]`).click({ button: "right" });
      await desktop.getByRole("menuitem", { name: "回退到这条之前", exact: true }).click();
      await desktop.getByRole("dialog", { name: "回退到这条消息之前", exact: true }).getByRole("button", { name: "回退", exact: true }).click();

      await rewindWaiting;
      await expect(desktop.getByRole("dialog", { name: "回退到这条消息之前", exact: true }).getByRole("button", { name: "正在回退…" })).toBeDisabled();

      // Phone sends a new message during the in-flight rewind
      await phone.getByRole("textbox", { name: "消息", exact: true }).fill("回退期间发送的新消息");
      await phone.getByRole("button", { name: "发送消息", exact: true }).click();
      await expect(desktop.locator("article", { hasText: "回退期间发送的新消息" })).toBeVisible();
      // Must NOT have been dispatched while rewind is active!
      expect(dispatchedTexts).toEqual([]);

      // Complete rewind -> collapsed row covers only turn 2 (2 messages); the new message stays outside and dispatches!
      releaseRewind?.();
      await expect(desktop.getByRole("dialog", { name: "回退到这条消息之前", exact: true })).toHaveCount(0);
      await expect(desktop.locator(".rewind-notice summary")).toContainText("已回退的 2 条消息");
      await expect(desktop.locator("article", { hasText: "回退期间发送的新消息" })).toBeVisible();
      await expect.poll(() => dispatchedTexts).toContain("回退期间发送的新消息");
      expect(errors).toEqual([]);
    } finally {
      releaseRewind?.();
      await codex.gateway.disconnect();
      await desktopCtx.close();
      await phoneCtx.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("errors, history_changed, started polling, same-requestId retry, upstreamRejection fallback, old Hub & narrow EN/ZH viewports", async ({ browser }) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "history-ui-edges-"));
    const timings: HistoryTimings = { rewindMs: 450, forkMs: 450 };
    const hub = await HubServer.start({ stateDir: path.join(root, "hub"), clientDir: CLIENT_DIST, historyTimings: timings });
    await seedSyntheticHostProfile(hub);
    const desktopCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
    const desktop = await desktopCtx.newPage();
    const errors: string[] = [];
    desktop.on("pageerror", e => errors.push(e.message));

    let rewindBehavior: "fail" | "delay" | "ok" = "fail";
    let releaseDelayedRewind: (() => void) | undefined;
    const codex = await attachFakeHistoryBot(hub, root, {
      id: "bot_codex",
      name: "示例助手",
      engine: "codex",
      rewind: "turn",
      fork: "turn",
      onRewind: async () => {
        if (rewindBehavior === "fail") throw new Error("turn_unresolved");
        if (rewindBehavior === "delay") {
          await new Promise<void>(resolve => { releaseDelayedRewind = resolve; });
        }
      },
    });
    const deepseek = await attachFakeHistoryBot(hub, root, { id: "bot_dsh", name: "示例分叉助手", engine: "deepseek", rewind: "none", fork: "turn" });
    const agy = await attachFakeHistoryBot(hub, root, { id: "bot_agy", name: "示例兜底助手", engine: "antigravity", rewind: "none", fork: "none", supported: false });

    try {
      const chat = await hub.store.createConversation("owner", ["bot_codex"], "边界验证", "chat_edge");
      await codex.bindConversation(chat.id, "thr_edge_1");
      const t1 = await seedTurn(hub, chat.id, "bot_codex", "第一轮正常问答", "第一轮回复正常。", 1);
      const t2 = await seedTurn(hub, chat.id, "bot_codex", "第二轮触发异常", "临时回复。", 2);
      // Seed TWO upstreamRejection failure cards — buttons must appear ONLY on the LAST one!
      const rej1 = await hub.store.publishBotMessage("bot_codex", {
        conversationId: chat.id,
        replyTo: t2.userMsg.id,
        blocks: [{
          type: "card",
          title: "上游拒收了这段对话",
          template: "orange",
          elements: [{ type: "markdown", text: "模型服务连续 2 次以「请求无效」拒绝了这段对话。可以回退到出问题的消息之前，或新开对话。" }],
          extra: { upstreamRejection: { v: 1, streak: 2, firstMessageId: t2.userMsg.id } },
        }],
      });
      const t3 = await seedTurn(hub, chat.id, "bot_codex", "第三轮再次触发", "临时回复。", 3);
      const rej2 = await hub.store.publishBotMessage("bot_codex", {
        conversationId: chat.id,
        replyTo: t3.userMsg.id,
        blocks: [{
          type: "card",
          title: "上游拒收了这段对话",
          template: "orange",
          elements: [{ type: "markdown", text: "模型服务连续 3 次以「请求无效」拒绝了这段对话。可以回退到出问题的消息之前，或新开对话。" }],
          extra: { upstreamRejection: { v: 1, streak: 3, firstMessageId: t2.userMsg.id } },
        }],
      });
      await codex.recordTurn(chat.id, "thr_edge_1", t1.userMsg.id, 1);
      await codex.recordTurn(chat.id, "thr_edge_1", t2.userMsg.id, 2);
      await codex.recordTurn(chat.id, "thr_edge_1", t3.userMsg.id, 3);

      // DeepSeek chat with upstreamRejection (rewind: none, fork: turn -> fork from t1, the previous run!)
      const dshChat = await hub.store.createConversation("owner", ["bot_dsh"], "按轮分叉兜底", "chat_dsh");
      await deepseek.bindConversation(dshChat.id, "dsh_1");
      const d1 = await seedTurn(hub, dshChat.id, "bot_dsh", "第一轮正常内容", "正常回答。", 1);
      const d2 = await seedTurn(hub, dshChat.id, "bot_dsh", "第二轮坏图片", "失败前。", 2);
      await hub.store.publishBotMessage("bot_dsh", {
        conversationId: dshChat.id,
        replyTo: d2.userMsg.id,
        blocks: [{
          type: "card",
          title: "上游拒收了这段对话",
          template: "orange",
          elements: [{ type: "markdown", text: "模型服务连续 2 次以「请求无效」拒绝了这段对话。" }],
          extra: { upstreamRejection: { v: 1, streak: 2, firstMessageId: d2.userMsg.id } },
        }],
      });

      // Antigravity chat with upstreamRejection -> ONLY "新开对话"
      const agyChat = await hub.store.createConversation("owner", ["bot_agy"], "无回退兜底", "chat_agy_rej");
      const a1 = await seedTurn(hub, agyChat.id, "bot_agy", "第一轮消息", "正常。", 1);
      await hub.store.publishBotMessage("bot_agy", {
        conversationId: agyChat.id,
        replyTo: a1.userMsg.id,
        blocks: [{
          type: "card",
          title: "上游拒收了这段对话",
          template: "orange",
          elements: [{ type: "markdown", text: "模型服务连续 2 次以「请求无效」拒绝了这段对话。请新开对话继续。" }],
          extra: { upstreamRejection: { v: 1, streak: 2, firstMessageId: a1.userMsg.id } },
        }],
      });

      await pairPage(desktop, hub, chat.title);

      // 1. Upstream rejection buttons appear ONLY on the LAST marked message (rej2, NOT rej1)
      await expect(desktop.locator(`article[data-message-id="${rej1.id}"] .upstream-rejection-actions`)).toHaveCount(0);
      const lastBar = desktop.locator(`article[data-message-id="${rej2.id}"] .upstream-rejection-actions`);
      await expect(lastBar).toBeVisible();
      await expect(lastBar.getByRole("button", { name: "回退到出问题之前", exact: true })).toBeVisible();
      await expect(lastBar.getByRole("button", { name: "新开对话", exact: true })).toBeVisible();
      await saveShot(desktop, "10-desktop-upstream-rejection-codex.png");

      // Check DeepSeek fallback card (fork before issue -> anchors to d1)
      await selectConversation(desktop, dshChat.title);
      await expect(desktop.locator(".upstream-rejection-actions").getByRole("button", { name: "从出问题之前分叉", exact: true })).toBeVisible();
      await desktop.locator(".upstream-rejection-actions").getByRole("button", { name: "从出问题之前分叉", exact: true }).click();
      const dshForkDialog = desktop.getByRole("dialog", { name: "从这一轮分叉", exact: true });
      await expect(dshForkDialog).toContainText(d1.userMsg.blocks[0]!.type === "text" ? d1.userMsg.blocks[0]!.text : "");
      await dshForkDialog.getByRole("button", { name: "取消", exact: true }).click();

      // Check Antigravity fallback card (only "新开对话")
      await selectConversation(desktop, agyChat.title);
      const agyBar = desktop.locator(".upstream-rejection-actions");
      await expect(agyBar.getByRole("button", { name: "新开对话", exact: true })).toBeVisible();
      await expect(agyBar.getByRole("button", { name: "回退到出问题之前" })).toHaveCount(0);
      await expect(agyBar.getByRole("button", { name: "从出问题之前分叉" })).toHaveCount(0);

      // 2. Back to Codex chat: click "回退到出问题之前" -> opens dialog anchored to t2 -> engine error keeps dialog open
      await selectConversation(desktop, chat.title);
      await desktop.locator(`article[data-message-id="${rej2.id}"] .upstream-rejection-actions`).getByRole("button", { name: "回退到出问题之前", exact: true }).click();
      const dialog = desktop.getByRole("dialog", { name: "回退到这条消息之前", exact: true });
      await expect(dialog).toContainText("第二轮触发异常");
      await dialog.getByRole("button", { name: "回退", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("无法定位对应的历史轮次");
      await expect(dialog.getByRole("button", { name: "回退", exact: true })).toBeEnabled();

      // 3. history_changed: a new message arrives while confirmation dialog is open
      rewindBehavior = "ok";
      await hub.store.publishBotMessage("bot_codex", { conversationId: chat.id, blocks: [{ type: "text", text: "确认期间到达的新消息" }] });
      await expect(desktop.locator("article", { hasText: "确认期间到达的新消息" })).toBeVisible();
      await dialog.getByRole("button", { name: "回退", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("对话有新消息，请再确认一次");

      // 4. Network abort -> retry with SAME requestId -> started polling -> completes automatically!
      const seenRequestIds: string[] = [];
      let abortFirst = true;
      rewindBehavior = "delay";
      await desktop.route("**/api/conversations/*/history/rewind", async (route) => {
        const body = route.request().postDataJSON() as { requestId: string };
        seenRequestIds.push(body.requestId);
        if (abortFirst) {
          abortFirst = false;
          await route.abort("failed");
          return;
        }
        await route.continue();
      });

      await dialog.getByRole("button", { name: "回退", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("未确认操作结果");
      await expect(dialog.getByRole("button", { name: "重试", exact: true })).toBeVisible();

      // Retry -> sends EXACT SAME requestId -> Hub times out at 450ms and returns `started` -> polling stays busy!
      await dialog.getByRole("button", { name: "重试", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "正在回退…" })).toBeDisabled();
      expect(seenRequestIds.length).toBe(2);
      expect(seenRequestIds[0]).toBe(seenRequestIds[1]);

      // Wait > 600ms so Hub returns `state: "started"` and client enters 2s poll loop, then release bridge
      await desktop.waitForTimeout(700);
      await expect(dialog.getByRole("button", { name: "正在回退…" })).toBeDisabled();
      releaseDelayedRewind?.();
      await expect(dialog).toHaveCount(0, { timeout: 10_000 });
      await expect(desktop.locator(".rewind-notice summary")).toBeVisible();

      // 5. Old Hub without conversations.history.v1 -> zero GET .../history requests, zero entries
      const oldCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
      const oldPage = await oldCtx.newPage();
      let historyGets = 0;
      oldPage.on("request", req => { if (req.url().includes("/history")) historyGets++; });
      await oldPage.routeWebSocket(/\/ws/, ws => {
        const server = ws.connectToServer();
        server.onMessage(raw => {
          if (typeof raw === "string" && raw.includes(HISTORY_CAPABILITY)) {
            try {
              const frame = JSON.parse(raw) as { type?: string; serverCapabilities?: string[] };
              if (frame.type === "ready" && Array.isArray(frame.serverCapabilities)) {
                frame.serverCapabilities = frame.serverCapabilities.filter(c => c !== HISTORY_CAPABILITY);
                ws.send(JSON.stringify(frame));
                return;
              }
            } catch { /* pass through */ }
          }
          ws.send(raw);
        });
        ws.onMessage(raw => server.send(raw));
      });
      await pairPage(oldPage, hub, dshChat.title);
      await oldPage.locator(`article[data-message-id="${d1.userMsg.id}"]`).click({ button: "right" });
      await expect(oldPage.getByRole("menuitem", { name: "从这一轮分叉" })).toHaveCount(0);
      await expect(oldPage.getByRole("menuitem", { name: "回退到这条之前" })).toHaveCount(0);
      await oldPage.keyboard.press("Escape");
      await oldPage.getByRole("button", { name: "更多聊天操作", exact: true }).click();
      await expect(oldPage.locator(".chat-menu button", { hasText: "分叉当前对话" })).toHaveCount(0);
      expect(historyGets).toBe(0);
      await oldCtx.close();

      // 6. Narrow viewports (320×568 & 360×800) in BOTH Chinese and English: zero horizontal overflow, buttons stay on 1 row!
      // Create a fresh chat with an upstreamRejection card, a rewound span, and a forked chat for clean visual & layout checks
      const narrowChat = await hub.store.createConversation("owner", ["bot_codex"], "窄屏排版验证", "chat_narrow");
      await codex.bindConversation(narrowChat.id, "thr_narrow_1");
      const n1 = await seedTurn(hub, narrowChat.id, "bot_codex", "第一条示例消息", "第一条示例回复。", 1);
      const n2 = await seedTurn(hub, narrowChat.id, "bot_codex", "第二条需要回退的消息", "第二条示例回复。", 2);
      const n3 = await seedTurn(hub, narrowChat.id, "bot_codex", "第三条触发拒收的消息", "临时。", 3);
      await hub.store.publishBotMessage("bot_codex", {
        conversationId: narrowChat.id,
        replyTo: n3.userMsg.id,
        blocks: [{
          type: "card",
          title: "上游拒收了这段对话",
          template: "orange",
          elements: [{ type: "markdown", text: "模型服务连续 2 次以「请求无效」拒绝了这段对话。" }],
          extra: { upstreamRejection: { v: 1, streak: 2, firstMessageId: n3.userMsg.id } },
        }],
      });
      await codex.recordTurn(narrowChat.id, "thr_narrow_1", n1.userMsg.id, 1);
      await codex.recordTurn(narrowChat.id, "thr_narrow_1", n2.userMsg.id, 2);
      await codex.recordTurn(narrowChat.id, "thr_narrow_1", n3.userMsg.id, 3);
      // Seed a completed rewind range covering n2 only, leaving n3+rejection visible!
      const now = Date.now();
      await hub.store.db.run(
        `INSERT INTO conversation_history_ops(id,user_id,request_id,payload_hash,conversation_id,bot_id,kind,anchor_message_id,anchor_created_at,through_message_id,through_created_at,target_conversation_id,state,error,result_json,created_at,updated_at)
         VALUES('hop_narrow_1','owner','req_narrow_1','hash1',?,'bot_codex','rewind',?,?,?,?,NULL,'completed',NULL,NULL,?,?)`,
        [narrowChat.id, n2.userMsg.id, n2.userMsg.createdAt, n2.botMsg.id, n2.botMsg.createdAt, now, now],
      );
      const forkedNarrow = await hub.store.db.transaction(() => hub.store.createConversationInTransaction("owner", ["bot_codex"], "窄屏排版验证 · 分叉", "fork_narrow", {
        type: "direct",
        fork: { opId: "hop_fork_n", conversationId: narrowChat.id, title: "窄屏排版验证", mode: "turn", throughMessageId: n1.userMsg.id, excerpt: "第一条示例消息", at: now },
      }));

      for (const [vw, vh] of [[320, 568], [360, 800]] as const) {
        const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, hasTouch: true, serviceWorkers: "block" });
        const page = await ctx.newPage();
        page.on("pageerror", e => errors.push(e.message));
        await pairPage(page, hub, narrowChat.title);

        for (const locale of ["zh", "en"] as const) {
          if (locale === "en") {
            await switchLocale(page, "en");
            await selectConversationAnyLocale(page, narrowChat.title);
          }

          // Check no horizontal overflow on chat view with collapsed rewind row + upstream rejection card
          const checkNoOverflow = async (label: string) => {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow, `${vw}x${vh} ${locale} ${label} horizontal overflow`).toBeLessThanOrEqual(1);
          };

          const rewindSummary = page.locator(".rewind-notice summary");
          await expect(rewindSummary).toBeVisible();
          if (locale === "en") {
            await expect(rewindSummary).toContainText("2 rewound messages");
            await expect(rewindSummary).toContainText("not in context");
          } else {
            await expect(rewindSummary).toContainText("已回退的 2 条消息");
          }
          const summaryBox = await rewindSummary.boundingBox();
          expect(summaryBox!.height, `${vw}x${vh} ${locale} rewind summary single line`).toBeLessThanOrEqual(32);

          const rejBtns = page.locator(".upstream-rejection-actions button");
          await expect(rejBtns).toHaveCount(2);
          if (locale === "en") {
            await expect(rejBtns.nth(0)).toHaveText("Rewind before issue");
            await expect(rejBtns.nth(1)).toHaveText("New chat");
          }
          const b0 = await rejBtns.nth(0).boundingBox();
          const b1 = await rejBtns.nth(1).boundingBox();
          expect(Math.abs(b0!.y - b1!.y), `${vw}x${vh} ${locale} rejection buttons on 1 row`).toBeLessThanOrEqual(2);
          expect(b0!.height, `${vw}x${vh} ${locale} primary button single line`).toBeLessThanOrEqual(46);
          expect(b1!.height, `${vw}x${vh} ${locale} secondary button single line`).toBeLessThanOrEqual(46);
          await checkNoOverflow("chat-rewind-and-rejection");
          await saveShot(page, `11-narrow-${vw}x${vh}-${locale}-chat.png`);

          // Open rewind confirmation dialog from rejection button -> check 1-row actions & no overflow
          await rejBtns.nth(0).click();
          const confirmDlg = page.locator("dialog.history-confirmation-dialog");
          await expect(confirmDlg).toBeVisible();
          if (locale === "en") {
            await expect(confirmDlg).toContainText("Rewind to before this message");
            await expect(confirmDlg).toContainText("File changes");
          }
          const cBtns = confirmDlg.locator(".confirmation-actions button");
          await expect(cBtns).toHaveCount(2);
          // Read both button rects in one frame and poll until the sheet open animation settles.
          await expect.poll(async () => {
            return await cBtns.evaluateAll((els) => {
              if (els.length !== 2) return 999;
              const r0 = els[0]!.getBoundingClientRect();
              const r1 = els[1]!.getBoundingClientRect();
              return Math.abs(r0.top - r1.top);
            });
          }, { message: `${vw}x${vh} ${locale} confirm buttons on 1 row` }).toBeLessThanOrEqual(2);
          await checkNoOverflow("rewind-dialog");
          await saveShot(page, `12-narrow-${vw}x${vh}-${locale}-rewind-dialog.png`);
          await cBtns.nth(0).click();

          // Check forked chat top banner & header icon on narrow viewport
          await selectConversationAnyLocale(page, forkedNarrow.title);
          const banner = page.locator(".fork-origin-banner");
          await expect(banner).toBeVisible();
          if (locale === "en") {
            await expect(banner).toContainText("Forked from");
            await expect(banner.getByRole("button", { name: "Open original", exact: true })).toBeVisible();
          }
          await expect(page.locator(".fork-origin-badge")).toBeVisible();
          await checkNoOverflow("forked-banner");
          await saveShot(page, `13-narrow-${vw}x${vh}-${locale}-forked.png`);
        }
        await ctx.close();
      }

      expect(errors).toEqual([]);
    } finally {
      releaseDelayedRewind?.();
      await codex.gateway.disconnect();
      await deepseek.gateway.disconnect();
      await agy.gateway.disconnect();
      await desktopCtx.close();
      await hub.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
