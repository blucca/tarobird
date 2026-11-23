// What a person saw wrong in the workspace rail on 2026-11-22, one test per thing. The states the real Host
// cannot be driven into quickly are given as a replaced /bot-comms, /tasks or /queue answer.
import { test, expect, type Page } from "@playwright/test";
import { closeHub, comms, item, LONG_BOT, makeHub, mockComms, newPage, openConv, pair, setTheme, tr, type Fixture, type Locale } from "./fixtures/workspace-rail.js";

test.use({ serviceWorkers: "block", actionTimeout: 15_000 });

const rail = (page: Page) => page.locator("aside.conversation-workspace-rail");
async function ready(browser: Parameters<typeof newPage>[0], locale: Locale, width: number, before?: (page: Page, f: Fixture) => Promise<void>) {
  const f = await makeHub(locale), L = tr(locale);
  const { context, page, errors } = await newPage(browser, locale, { width, height: 900 });
  await before?.(page, f);
  await pair(page, f, locale);
  await openConv(page, f.mainTitle);
  const trigger = page.getByRole("button", { name: L("会话工作区"), exact: true });
  const open = async () => { if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click(); await expect(rail(page)).toBeVisible(); };
  const done = async () => { expect(errors).toEqual([]); await context.close(); await closeHub(f); };
  return { f, L, page, trigger, open, done };
}
/** WCAG contrast of an element's text against its own background. */
const contrast = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (color: string) => { const [r, g, b] = color.match(/[\d.]+/g)!.map(Number); return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!); };
  const style = getComputedStyle(node), a = luminance(style.color), b = luminance(style.backgroundColor);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

test("the conversation title keeps its room just above 1100px while the rail is open", async ({ browser }) => {
  const { page, trigger, open, done } = await ready(browser, "en", 1101);
  try {
    await open();
    const title = page.locator(".host-workspace:not([hidden]) .conversation-header .chat-identity>span[title]");
    // "Wo…" was 39px here; the whole title is 239px.
    expect((await title.boundingBox())!.width).toBeGreaterThan(100);
    await expect(trigger.locator(".workspace-rail-trigger-label")).toBeHidden();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(trigger.locator(".workspace-rail-trigger-label")).toBeVisible();
    expect(await title.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  } finally { await done(); }
});

test("Bot messages: both ends of a long route, whole cards to a page, plain status words, readable approval in the dark theme", async ({ browser }) => {
  const { page, L, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.main, comms(f.ids.main, [
      item(1, { status: "needs_approval", sourceBotName: LONG_BOT, targetBotName: "Reviewer-Security-Auditor-与合规审查-Bot", canJumpToTarget: true, targetConversationId: f.ids.revConv,
        pendingApproval: { messageId: "msg_pending_1", title: "请求执行命令审批", detail: "psql -h db.example -f migrate.sql" } }),
      item(2, { status: "running", delivery: "queued" }), item(3, { status: "steered", delivery: "steered", replyExcerpt: undefined }),
      item(4, { status: "queued", delivery: "fell_back_to_queue", replyExcerpt: undefined }), item(5, { status: "failed", delivery: "not_delivered", replyExcerpt: "错误：目标 Bot 离线。" }),
      item(6, { status: "cancelled", replyExcerpt: undefined }), item(7, { status: "uncertain", delivery: "steer_uncertain", replyExcerpt: undefined }),
      item(8), item(9), item(10),
    ]));
  });
  try {
    await open();
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    const cards = rail(page).locator(".workspace-comm-card");
    // As many whole cards as the rail is tall: nothing is cut at the bottom edge, and the pager is in view.
    const fits = () => rail(page).locator(".workspace-body").evaluate(node => {
      const edge = node.getBoundingClientRect().bottom, last = [...node.querySelectorAll(".workspace-comm-card")].at(-1)!.getBoundingClientRect().bottom;
      return { cut: last > edge, pager: node.querySelector(".workspace-pager")!.getBoundingClientRect().bottom <= edge, scrolls: node.scrollHeight > node.clientHeight };
    });
    await expect(cards).toHaveCount(5);
    await expect(rail(page).locator(".workspace-pager")).toContainText("1 / 2");
    // Polled: a page that gave a card back settles one layout later than the count.
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    // A taller rail holds more, still whole. (Four was the fixed number before; it left this rail half empty.)
    await page.setViewportSize({ width: 1440, height: 1300 });
    // The count first: the page of five also fits the taller rail until the rail's new height is applied.
    await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(8);
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    await page.setViewportSize({ width: 1440, height: 640 });
    await expect(cards).toHaveCount(4);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(cards).toHaveCount(5);
    await expect.poll(fits).toEqual({ cut: false, pager: true, scrolls: false });
    // The sender, the arrow and the receiver are all on screen, each name shortened rather than one end lost.
    const route = await cards.first().locator(".workspace-comm-route").evaluate(node => {
      const box = node.getBoundingClientRect(), parts = [...node.children].map(child => child.getBoundingClientRect());
      // The names share the row; the arrow between them keeps its own width.
      return { inside: parts.every(part => part.right <= box.right + 0.5), names: [parts[0]!.width > 40, parts[2]!.width > 40], arrow: parts[1]!.width > 8 };
    });
    expect(route).toEqual({ inside: true, names: [true, true], arrow: true });
    if (process.env.WORKSPACE_RAIL_UI_SHOTS) await rail(page).screenshot({ path: `${process.env.WORKSPACE_RAIL_UI_SHOTS}/comms-fixed.png` });
    await expect(cards.first().locator(".workspace-comm-route > span").last()).toHaveAttribute("title", "Reviewer-Security-Auditor-与合规审查-Bot");
    await expect(rail(page).locator(".workspace-comm-status")).toContainText(["待审批", "运行中", "已并入回复", "排队中", "失败"]);
    await expect(cards.nth(1).locator(".workspace-comm-sub")).toContainText("经排队投递");
    await expect(cards.nth(3).locator(".workspace-comm-sub")).toContainText("未能并入，已改为排队");
    // A failed item's text is not a reply.
    await cards.nth(4).getByRole("button", { name: "展开详情" }).click();
    await expect(cards.nth(4).locator(".workspace-comm-expanded-label")).toContainText(["失败信息"]);
    await cards.nth(4).getByRole("button", { name: "收起" }).click();
    await rail(page).getByRole("button", { name: "下一页" }).click();
    await expect(rail(page).locator(".workspace-comm-status")).toContainText(["已取消", "结果未确认", "已回传"]);
    await rail(page).getByRole("button", { name: "上一页" }).click();
    expect(await contrast(page, "aside.conversation-workspace-rail .workspace-jump-btn.is-alert")).toBeGreaterThan(4.5);
    await setTheme(page, "dark");
    // White on the dark theme's light orange was about 2:1.
    expect(await contrast(page, "aside.conversation-workspace-rail .workspace-jump-btn.is-alert")).toBeGreaterThan(4.5);
    expect(await contrast(page, ".host-workspace:not([hidden]) .workspace-rail-trigger-badge")).toBeGreaterThan(4.5);
    if (process.env.WORKSPACE_RAIL_UI_SHOTS) await rail(page).screenshot({ path: `${process.env.WORKSPACE_RAIL_UI_SHOTS}/comms-fixed-dark.png` });
  } finally { await done(); }
});

test("a slow read says it is reading, and a failed one says so", async ({ browser }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let fail = false;
  const { page, L, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await page.route(`**/api/conversations/${f.ids.main}/bot-comms`, async route => {
      if (fail) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
      await held; await route.fallback();
    });
  });
  try {
    await open();
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-empty")).toHaveText("正在读取…");
    release();
    await expect(rail(page).locator(".workspace-comm-card")).toHaveCount(2);
    // Another conversation whose first read fails.
    fail = true;
    await page.route(`**/api/conversations/${f.ids.empty}/bot-comms`, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
    await openConv(page, "空白对话");
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-empty")).toHaveText("暂时读不到 Bot 之间的往来，请稍后再刷新。");
  } finally { await done(); }
});

test("overview: a message being handled is not in line, hidden tasks are counted, sizes match the conversation, a group names the rest", async ({ browser }) => {
  const { page, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await page.route(`**/api/conversations/${f.ids.main}/tasks*`, route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ supported: true, tasks: [1, 2, 3].map(n => (
      { id: `t${n}`, label: `后台任务 ${n}`, kind: "shell", mode: "background", status: "running", canStop: false, updatedAt: Date.now() })) }) }));
  });
  try {
    await open();
    const live = rail(page).locator(".workspace-section").nth(1);
    // The Host says this message is "dispatched": the Bot has it. It used to read "队列第 1 位".
    await expect(live.locator(".workspace-item-meta").last()).toHaveText("处理中");
    await expect(live).not.toContainText("队列第");
    await expect(live.locator(".workspace-more-hint")).toHaveText("还有 1 个后台任务");
    const chatSize = await page.locator(".file-card-meta small").first().innerText();
    expect(chatSize).toBe("17.99 KiB");
    await expect(rail(page).locator(".workspace-section").last()).toContainText(chatSize);
    await openConv(page, "发布群");
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).locator(".workspace-env-bot")).toContainText("5 位 Bot");
    await expect(rail(page).locator(".workspace-chip", { hasText: "+2" })).toHaveCount(1);
    expect(f.ids.group).toBeTruthy();
  } finally { await done(); }
});

test("jumping to a conversation that is gone stays here and says why", async ({ browser }) => {
  const { page, L, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.main, comms(f.ids.main, [item(1, { canJumpToTarget: true, targetConversationId: "gw_gone_0000", targetConversationTitle: "已删除的协作" })]));
  });
  try {
    await open();
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await rail(page).getByRole("button", { name: "去协作对话" }).click();
    await expect(page.getByText("协作对话已不存在，或当前不可访问。")).toBeVisible();
    await expect(page.getByRole("heading", { name: f.mainTitle, exact: true, level: 1 })).toBeVisible();
    await expect(rail(page)).toBeVisible();
    await expect(page.getByText("conversation_forbidden")).toHaveCount(0);
  } finally { await done(); }
});

test("a jump leaves the keyboard in the conversation that opened, and a full list says it is not everything", async ({ browser }) => {
  const { page, L, f, open, done } = await ready(browser, "zh", 1440, async (page, f) => {
    await mockComms(page, f.ids.empty, comms(f.ids.empty, Array.from({ length: 60 }, (_, index) => item(index + 1))));
  });
  try {
    await open();
    // The real item of this fixture: Architect asked Researcher, who has replied.
    await rail(page).getByRole("button", { name: "去协作对话" }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText(f.mainTitle);
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".composer"))).toBe(true);
    // Sixty is all the Host returns: the list says so, and a shorter one does not.
    await openConv(page, "空白对话");
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-more-hint")).toHaveText("这里最多显示最近 60 条，更早的往来不在其中。");
    await openConv(page, f.mainTitle);
    await rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) }).click();
    await expect(rail(page).locator(".workspace-comm-card")).toHaveCount(2);
    await expect(rail(page).locator(".workspace-more-hint")).toHaveCount(0);
  } finally { await done(); }
});

test("keyboard: opening moves into the rail, arrows change tab, Escape closes and returns to the entry", async ({ browser }) => {
  const { page, L, trigger, done } = await ready(browser, "zh", 1440);
  try {
    if (await trigger.getAttribute("aria-expanded") === "true") await trigger.click();
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(rail(page)).toBeVisible();
    await expect(rail(page).getByRole("tab", { name: L("总览") })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const commsTab = rail(page).getByRole("tab", { name: new RegExp(L("Bot 通信")) });
    await expect(commsTab).toBeFocused();
    await expect(commsTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(rail(page).getByRole("tab", { name: new RegExp(L("文件")) })).toHaveAttribute("aria-selected", "true");
    // One Tab leaves the tab row for the tab's own content, not for the next tab.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).not.toBe("tab");
    await page.keyboard.press("Escape");
    await expect(rail(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // A rail that comes back with the page does not take the focus from where the person was.
    await trigger.click();
    await page.reload();
    await expect(rail(page)).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.conversation-workspace-rail"))).toBe(false);
  } finally { await done(); }
});

test("the entry rests without a frame, like the header buttons beside it, and shows its edge only while the rail is open", async ({ browser }) => {
  const { trigger, open, done } = await ready(browser, "zh", 1400);
  try {
    const edge = () => trigger.evaluate(node => getComputedStyle(node).borderTopColor);
    expect(await edge()).toBe("rgba(0, 0, 0, 0)");
    await open();
    await expect.poll(edge).not.toBe("rgba(0, 0, 0, 0)");
  } finally { await done(); }
});

/** The colour a theme token resolves to, as a computed colour string. */
const token = (page: Page, name: string) => page.evaluate(value => {
  const probe = document.body.appendChild(document.createElement("span")); probe.style.color = `var(${value})`;
  const colour = getComputedStyle(probe).color; probe.remove(); return colour;
}, name);

test("a turn's changes are listed by file name with green and red counts; the reply's own entry stays 本轮改动", async ({ browser }) => {
  const { page, open, done } = await ready(browser, "zh", 1400);
  try {
    await open();
    const row = rail(page).locator(".workspace-diff-row");
    // The names are the Hub's record of that run (two edits in the fixture's journal), not the totals on the card.
    await expect(row.locator(".workspace-diff-name")).toHaveText(["ConversationWorkspace.tsx", "bot-messages.ts"]);
    await expect(row.locator(".workspace-diff-name").first()).toHaveAttribute("title", "client/src/ConversationWorkspace.tsx");
    await expect(row.locator(".workspace-diff-counts").first().locator("span")).toHaveText(["+2", "-1"]);
    await expect(row.locator(".workspace-diff-counts").last().locator("span")).toHaveText(["+1", "-1"]);
    const countsMetrics = await row.locator(".workspace-diff-counts").first().evaluate(node => {
      const style = getComputedStyle(node);
      const spans = [...node.querySelectorAll("span")].map(span => {
        const box = span.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(span);
        const textBox = range.getBoundingClientRect();
        return { color: getComputedStyle(span).color, top: box.top, bottom: box.bottom, height: box.height, textTop: textBox.top, textBottom: textBox.bottom };
      });
      return { alignItems: style.alignItems, fontVariantNumeric: style.fontVariantNumeric, spans };
    });
    expect(countsMetrics.alignItems).toBe("baseline");
    expect(countsMetrics.fontVariantNumeric).toBe("tabular-nums");
    expect(countsMetrics.spans.map(s => s.color)).toEqual([await token(page, "--green"), await token(page, "--red")]);
    expect(countsMetrics.spans[0]!.color).not.toBe(countsMetrics.spans[1]!.color);
    expect(Math.abs(countsMetrics.spans[0]!.top - countsMetrics.spans[1]!.top)).toBeLessThan(0.5);
    expect(Math.abs(countsMetrics.spans[0]!.height - countsMetrics.spans[1]!.height)).toBeLessThan(0.5);
    expect(Math.abs(countsMetrics.spans[0]!.textBottom - countsMetrics.spans[1]!.textBottom)).toBeLessThan(0.5);
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    // On the reply itself the entry carries no counts and no names.
    const reply = page.locator(".host-workspace:not([hidden])").getByRole("region", { name: "运行回复", exact: true });
    await expect(reply.getByRole("button", { name: "本轮改动", exact: true })).toBeVisible();
    await expect(reply.getByRole("button", { name: /改动 \d+ 个文件|\+\d+/ })).toHaveCount(0);
    await row.getByRole("button").click();
    await expect(page.getByRole("dialog", { name: "本轮改动", exact: true })).toBeVisible();
  } finally { await done(); }
});

test("when the names cannot be read, the saved totals stand in, still green and red", async ({ browser }) => {
  const { page, open, done } = await ready(browser, "zh", 1400, async page => {
    await page.route("**/api/messages/*/changes?*", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  });
  try {
    await open();
    const row = rail(page).locator(".workspace-diff-row");
    await expect(row.locator(".workspace-diff-name")).toHaveText(["改动 2 个文件"]);
    await expect(row.locator(".workspace-diff-counts span")).toHaveText(["+14", "-3"]);
    expect(await row.locator(".workspace-diff-counts span").evaluateAll(spans => spans.map(span => getComputedStyle(span).color))).toEqual([await token(page, "--green"), await token(page, "--red")]);
  } finally { await done(); }
});
