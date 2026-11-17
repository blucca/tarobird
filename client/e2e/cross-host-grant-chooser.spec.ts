import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// Component journeys against a controllable receiving-Host double (synthetic
// names only). The real signed write, Hub policy and readback stay covered by
// bot-message-grants.spec.ts; this file owns the chooser's own behaviour.
test.use({ serviceWorkers: "block" });
let server: Awaited<ReturnType<typeof createServer>>, base = "";
test.beforeAll(async () => {
  server = await createServer({ server: { port: 0, host: "127.0.0.1" } }); await server.listen();
  base = `${server.resolvedUrls!.local[0]}e2e/fixtures/cross-host-grants.html`;
});
test.afterAll(async () => { await server.close(); });

type Fixture = {
  server: { revision: number; hosts: { id: string; name: string; available: boolean }[]; bots: { id: string; name: string; online: boolean; deleted?: true }[]; grants: { sourceHost: string; sourceBot: string; targetBot: string }[] };
  commands: { operation: string; sourceHost: string; sourceBot: string; revision: string; changes: { targetBot: string; allowed: boolean }[] }[];
  control: { failGet: number; holdPost: boolean; release: () => void; gets: number };
  sources: Record<string, { status: string; bots: { id: string; name: string; role?: string; deletedAt?: number }[] }>;
  hostId: (seed: string) => string; render: () => void; setOnline: (value: boolean) => void; setActive: (value: boolean) => void;
  remount: () => void; touch: () => void; poll: () => void;
};
declare global { interface Window { grantFixture: Fixture } }

const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
async function openCross(page: Page, query = "") {
  await page.goto(`${base}?${query}`);
  const english = query.includes("lang=en");
  if (!query.includes("mount=section")) {
    await page.getByRole("button", { name: english ? "Bot message permissions" : "Bot 消息授权", exact: true }).click();
    await page.getByRole("button", { name: english ? "Cross-host" : "跨主机", exact: true }).click();
  }
  const panel = page.locator(".cross-host-message-grants");
  await expect(panel.locator(".cross-grants-form")).toBeVisible();
  return panel;
}
const chooser = (page: Page, name: string) => page.getByRole("dialog", { name, exact: true });
const commands = (page: Page) => page.evaluate(() => window.grantFixture.commands);
const pageState = async (page: Page) => JSON.parse(await page.getByTestId("page-state").textContent() ?? "{}") as { dirty: boolean; busy: boolean };
const back = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event("tarocub-native-back", { cancelable: true })));
const names = (list: Locator) => list.locator(".cross-grants-option strong").allTextContents();

test.describe("phone", () => {
  test.use(phone);

  // The Android report: tapping a Bot field handed the choice to an OS list
  // with no title, no host, no search and none of the product's theme.
  test("Bot fields open a product chooser that names its host and can be searched, not an OS list", async ({ page }, info) => {
    const p = await openCross(page, "theme=dark");
    await expect(p.locator(".cross-grants-form select")).toHaveCount(0);
    const field = p.getByLabel("来源 Bot", { exact: true });
    await expect(field).toHaveAccessibleDescription("选择来源 Bot");
    await field.tap();
    const dialog = chooser(page, "选择来源 Bot");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("来源主机：演示来源主机", { exact: true })).toBeVisible();
    const search = dialog.getByRole("combobox", { name: "搜索名称或 ID", exact: true });
    await expect(search).toBeVisible();
    // Opening must not raise the keyboard over the list it was opened to show.
    await expect(search).not.toBeFocused();
    await expect(dialog.getByRole("option")).toHaveCount(8);
    // Follows the App theme: dark surface, light ink, and the palette's accent
    // tokens for the current choice (none yet).
    const paint = await dialog.evaluate(node => {
      const channels = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const light = (value: string) => { const [r, g, b] = channels(value); return (r! * 299 + g! * 587 + b! * 114) / 255000; };
      return { surface: light(getComputedStyle(node).backgroundColor), ink: light(getComputedStyle(node.querySelector(".cross-grants-option strong")!).color) };
    });
    expect(paint.surface).toBeLessThan(0.2); expect(paint.ink).toBeGreaterThan(0.8);
    for (const option of await dialog.getByRole("option").all()) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: info.outputPath("source-bot-chooser-dark-390.png"), animations: "disabled" });
    await search.fill("演示助手 003");
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await dialog.getByRole("option", { name: "演示助手 003", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(field).toHaveAccessibleDescription("演示助手 003");
    await expect(p.locator(".cross-grants-direction")).toHaveText("演示来源主机 · 演示助手 003 → 演示接收主机 · 研究助手");
    // Choosing fills the draft; only the explicit action writes.
    expect(await commands(page)).toEqual([]);
    const receiving = p.getByLabel("本机接收 Bot", { exact: true });
    await receiving.tap();
    const target = chooser(page, "选择本机接收 Bot");
    await expect(target.getByText("接收主机：演示接收主机", { exact: true })).toBeVisible();
    await expect(target.getByRole("option", { name: "研究助手", exact: true })).toHaveAttribute("aria-selected", "true");
    await target.getByRole("option", { name: "复核助手", exact: true }).tap();
    await p.getByRole("button", { name: "允许发送", exact: true }).tap();
    await expect(p.getByRole("status")).toHaveText("已允许发送，并从接收主机核对生效。");
    const sent = await commands(page);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: "cross-host-message-grants", sourceHost: await page.evaluate(() => window.grantFixture.hostId("studio")), sourceBot: "demo_003", changes: [{ targetBot: "beta", allowed: true }] });
  });

  test("search covers names and IDs across a large directory; same names stay distinct and long names wrap", async ({ page }) => {
    const p = await openCross(page, "bots=300");
    await p.getByLabel("来源 Bot", { exact: true }).tap();
    const dialog = chooser(page, "选择来源 Bot"), search = dialog.getByRole("combobox"), options = dialog.getByRole("option");
    await expect(options).toHaveCount(100);
    await expect(dialog.getByText("仅显示前 100 个，请搜索缩小范围。", { exact: true })).toBeVisible();
    // Internal workers and deleted Bots are never offered, by name or by ID.
    for (const hidden of ["内部执行者", "worker_internal", "已删除来源助手", "removed_bot"]) { await search.fill(hidden); await expect(options).toHaveCount(0); }
    await expect(dialog.getByRole("status")).toHaveText("没有找到匹配的 Bot。");
    // With nothing listed, the keyboard's search key must not pick a hidden row.
    await search.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(p.getByLabel("来源 Bot", { exact: true })).toHaveAccessibleDescription("选择来源 Bot");
    // Two Bots share a name: each row has its own accessible name and ID.
    await search.fill("资料助手");
    await expect(options).toHaveCount(2);
    await expect(dialog.getByRole("option", { name: "资料助手 · …1f2e93", exact: true })).toHaveAccessibleDescription("ID …1f2e93");
    await expect(dialog.getByRole("option", { name: "资料助手 · …7a4b20", exact: true })).toHaveAccessibleDescription("ID …7a4b20");
    await search.fill("7A4B20");
    await expect(options).toHaveCount(1);
    await search.fill("DEMO_250");
    expect(await names(dialog)).toEqual(["演示助手 250"]);
    await search.fill("长名称");
    const long = options.first();
    await expect(long).toBeVisible();
    // The whole name is readable: it wraps instead of being cut off.
    expect(await long.evaluate(node => { const name = node.querySelector("strong")!; return { clipped: name.scrollWidth > name.clientWidth + 1, lines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)), overflow: node.scrollWidth > node.clientWidth + 1 }; }))
      .toEqual({ clipped: false, lines: 2, overflow: false });
    await search.fill("");
    await dialog.locator(".cross-grants-picker-list").evaluate(node => { node.scrollTop = node.scrollHeight; });
    // Only the list scrolls: title, close, host and search stay on screen.
    for (const fixed of [dialog.getByRole("heading", { name: "选择来源 Bot", exact: true }), dialog.getByRole("button", { name: "关闭选择", exact: true }), dialog.getByText("来源主机：演示来源主机", { exact: true }), search]) await expect(fixed).toBeInViewport({ ratio: 1 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await dialog.getByRole("option", { name: "演示助手 096", exact: true }).tap();
    await expect(p.getByLabel("来源 Bot", { exact: true })).toHaveAccessibleDescription("演示助手 096");
    expect(await commands(page)).toEqual([]);
  });

  test("Android Back, the close button and the backdrop close only the chooser and never touch the draft", async ({ page }) => {
    const p = await openCross(page);
    const field = p.getByLabel("本机接收 Bot", { exact: true }), page_ = chooser(page, "Bot 消息授权"), local = page.getByRole("button", { name: "本机", exact: true });
    for (const leave of ["back", "close", "backdrop"] as const) {
      await field.tap();
      const dialog = chooser(page, "选择本机接收 Bot");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("combobox").fill("复核");
      if (leave === "back") expect(await back(page)).toBe(true);
      else if (leave === "close") await dialog.getByRole("button", { name: "关闭选择", exact: true }).tap();
      else await page.touchscreen.tap(195, 40);
      await expect(dialog).toHaveCount(0);
      // The permissions page underneath is still open, on the same field.
      await expect(page_).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveAccessibleDescription("研究助手");
      // Not a draft: the other scope stays reachable and nothing was sent.
      await expect(local).toBeEnabled();
    }
    expect(await commands(page)).toEqual([]);
    // The next Back belongs to the page itself.
    expect(await back(page)).toBe(true);
    await expect(page_).toHaveCount(0);
  });
});

test.describe("desktop", () => {
  test("arrows skip unavailable rows, Enter chooses only a highlighted row, IME Enter and Escape choose nothing", async ({ page }) => {
    const p = await openCross(page);
    const field = p.getByLabel("来源主机", { exact: true });
    await field.focus(); await page.keyboard.press("Enter");
    const dialog = chooser(page, "选择来源主机"), search = dialog.getByRole("combobox"), list = dialog.getByRole("listbox");
    await expect(search).toBeFocused();
    await expect(dialog.getByText("接收主机：演示接收主机", { exact: true })).toBeVisible();
    // Nothing is highlighted until asked: Enter is not a hidden confirmation.
    await expect(search).not.toHaveAttribute("aria-activedescendant", /.+/);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    const active = () => list.locator("[data-active]");
    await page.keyboard.press("ArrowDown");
    await expect(active()).toHaveAccessibleName("演示来源主机"); // starts at the current choice
    await expect(search).toHaveAttribute("aria-activedescendant", await active().getAttribute("id") ?? "missing");
    await page.keyboard.press("ArrowDown"); await expect(active()).toHaveAccessibleName("实验室主机");
    for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowDown");
    // The departed host is listed for context, never reachable.
    await expect(active()).toHaveAccessibleName(/^同名主机 · …/);
    const departed = dialog.getByRole("option", { name: "已离网主机", exact: true });
    await expect(departed).toHaveAttribute("aria-disabled", "true");
    await expect(departed).toHaveAccessibleDescription(/来源主机当前不可用，仅可撤销/);
    await departed.click({ force: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp");
    await expect(active()).toHaveAccessibleName("实验室主机");
    // A composing Enter belongs to the input method.
    await search.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    await search.dispatchEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true });
    await expect(dialog).toBeVisible();
    // The highlight is that host, not "row two": filtering it away clears it.
    await search.fill("演示");
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(active()).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveAccessibleDescription("演示来源主机");
    await expect(page.getByRole("button", { name: "本机", exact: true })).toBeEnabled();
    // Enter on a highlighted row chooses it and returns to the field.
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(field).toHaveAccessibleDescription("实验室主机");
    await expect(page.getByRole("button", { name: "本机", exact: true })).toBeDisabled();
    expect(await commands(page)).toEqual([]);
  });

  test("re-choosing the current host only closes; another host clears the source Bot; same-name hosts stay distinct", async ({ page }) => {
    const p = await openCross(page);
    const host = p.getByLabel("来源主机", { exact: true }), bot = p.getByLabel("来源 Bot", { exact: true }), local = page.getByRole("button", { name: "本机", exact: true });
    await host.click();
    await chooser(page, "选择来源主机").getByRole("option", { name: "演示来源主机", exact: true }).click();
    await expect(chooser(page, "选择来源主机")).toHaveCount(0);
    await expect(local).toBeEnabled(); // same host: not a change
    await bot.click();
    await chooser(page, "选择来源 Bot").getByRole("option", { name: "演示助手 002", exact: true }).click();
    await expect(bot).toHaveAccessibleDescription("演示助手 002");
    await host.click();
    await chooser(page, "选择来源主机").getByRole("option", { name: "演示来源主机", exact: true }).click();
    await expect(bot).toHaveAccessibleDescription("演示助手 002"); // still the same host: the Bot stays
    // A host this device has no connection to: exact Bot ID, as before.
    await host.click();
    await chooser(page, "选择来源主机").getByRole("option", { name: "实验室主机", exact: true }).click();
    const manual = p.getByLabel("来源 Bot ID", { exact: true });
    await expect(manual).toHaveValue("");
    await expect(p.getByText("此设备尚未连接来源主机，或来源主机暂时离线。连接后可按名称选择；也可填写准确的 Bot ID。", { exact: true })).toBeVisible();
    await manual.fill("remote_exact_id");
    await expect(p.locator(".cross-grants-direction")).toHaveText("实验室主机 · remote_exact_id → 演示接收主机 · 研究助手");
    await expect(p.getByText("请核对来源 Bot ID；这里不会自动验证它的名称或创建新 Bot。", { exact: true })).toBeVisible();
    // Back to the first host: the typed ID does not become its Bot.
    await host.click();
    const hosts = chooser(page, "选择来源主机");
    const twins = hosts.getByRole("option", { name: /^同名主机 · …[a-f0-9]{6}$/ });
    await expect(twins).toHaveCount(2);
    const [first, second] = await Promise.all([twins.nth(0).getAttribute("aria-label"), twins.nth(1).getAttribute("aria-label")]);
    expect(first).not.toBe(second);
    const connected = await page.evaluate(() => window.grantFixture.hostId("twin_a"));
    await hosts.locator(`[data-choice-id="${connected}"]`).click();
    await expect(host).toHaveAccessibleDescription(`同名主机 · …${connected.slice(-6)}`);
    await expect(bot).toHaveAccessibleDescription("选择来源 Bot");
    await bot.click();
    const bots = chooser(page, "选择来源 Bot");
    await expect(bots.getByText(`来源主机：同名主机 · …${connected.slice(-6)}`, { exact: true })).toBeVisible();
    expect(await names(bots)).toEqual(["同名主机助手"]);
    await bots.getByRole("option", { name: "同名主机助手", exact: true }).click();
    await p.getByRole("button", { name: "允许发送", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已允许发送，并从接收主机核对生效。");
    expect(await commands(page)).toEqual([expect.objectContaining({ sourceHost: connected, sourceBot: "twin_bot", changes: [{ targetBot: "alpha", allowed: true }] })]);
  });

  test("the same Bot ID on two hosts stays two endpoints: no borrowed avatar or presence, exact tuple", async ({ page }) => {
    const p = await openCross(page);
    await p.getByLabel("来源 Bot", { exact: true }).click();
    const source = chooser(page, "选择来源 Bot"), remote = source.getByRole("option", { name: "来源研究员", exact: true });
    await expect(remote).toHaveAccessibleDescription("ID alpha");
    // A source Bot is a name from another host: neutral mark, no presence.
    await expect(source.locator(".profile-avatar, img")).toHaveCount(0);
    await expect(source.getByText(/当前在线|当前离线/)).toHaveCount(0);
    await remote.click();
    await p.getByLabel("本机接收 Bot", { exact: true }).click();
    const target = chooser(page, "选择本机接收 Bot"), own = target.getByRole("option", { name: "研究助手", exact: true });
    await expect(own).toHaveAccessibleDescription("当前在线 ID alpha");
    // Only this host's own Bots are drawn with its avatars.
    await expect(target.locator(".cross-grants-option .profile-avatar")).toHaveCount(3);
    await expect(target.getByRole("option", { name: "复核助手", exact: true })).toHaveAccessibleDescription("当前离线 ID beta");
    // Deleted recipients are revoke-only records, not choices.
    await expect(target.getByRole("option", { name: "已删除助手", exact: true })).toHaveCount(0);
    await own.click();
    await expect(p.locator(".cross-grants-direction")).toHaveText("演示来源主机 · 来源研究员 → 演示接收主机 · 研究助手");
    await p.getByRole("button", { name: "允许发送", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已允许发送，并从接收主机核对生效。");
    expect(await commands(page)).toEqual([{ operation: "cross-host-message-grants", sourceHost: await page.evaluate(() => window.grantFixture.hostId("studio")), sourceBot: "alpha", revision: "1".padStart(64, "0"), changes: [{ targetBot: "alpha", allowed: true }] }]);
    await expect(p.getByRole("button", { name: "撤销 演示来源主机 · 来源研究员 → 演示接收主机 · 研究助手", exact: true })).toBeVisible();
    await expect(p.getByRole("button", { name: "已授权", exact: true })).toBeDisabled();
  });

  test("departed hosts and deleted recipients are listed for revocation only", async ({ page }) => {
    const p = await openCross(page);
    const edge = p.locator(".cross-grants-edge").filter({ hasText: "已离网主机" });
    await expect(edge).toContainText("来源主机当前不可用，仅可撤销");
    await expect(edge).toContainText("接收 Bot 已不可用，仅可撤销");
    await edge.getByRole("button", { name: "撤销 已离网主机 · legacy_bot → 演示接收主机 · 已删除助手", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已撤销授权，并从接收主机核对生效。");
    expect(await commands(page)).toEqual([expect.objectContaining({ sourceHost: await page.evaluate(() => window.grantFixture.hostId("departed")), sourceBot: "legacy_bot", changes: [{ targetBot: "retired", allowed: false }] })]);
    // With its last record gone the departed host is no longer offered at all.
    await p.getByLabel("来源主机", { exact: true }).click();
    await expect(chooser(page, "选择来源主机").getByRole("option")).toHaveCount(4);
  });

  test("manual Bot IDs keep their rules beside the chooser: known workers are refused, exact IDs still work", async ({ page }) => {
    const p = await openCross(page);
    await p.getByRole("button", { name: "使用 Bot ID", exact: true }).click();
    const manual = p.getByLabel("来源 Bot ID", { exact: true });
    await manual.fill("worker_internal");
    await expect(p.getByRole("alert")).toHaveText("内部执行者不参与手动消息授权，请选择普通 Bot。");
    await expect(p.getByRole("button", { name: "允许发送", exact: true })).toBeDisabled();
    await manual.fill("offline_exact_bot");
    await p.getByRole("button", { name: "允许发送", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已允许发送，并从接收主机核对生效。");
    expect(await commands(page)).toEqual([expect.objectContaining({ sourceBot: "offline_exact_bot", changes: [{ targetBot: "alpha", allowed: true }] })]);
    await p.getByRole("button", { name: "按名称选择 Bot", exact: true }).click();
    await expect(p.getByLabel("来源 Bot", { exact: true })).toHaveAccessibleDescription("选择来源 Bot");
  });
});

test.describe("live lists and locks", () => {
  test("a row that left the live directory, or became internal, cannot be chosen even before the list redraws", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    const field = p.getByLabel("来源 Bot", { exact: true });
    await field.click();
    const dialog = chooser(page, "选择来源 Bot");
    // The source host deleted one Bot and demoted another; this page has not drawn that yet.
    await page.evaluate(() => {
      const directory = window.grantFixture.sources.studio!;
      directory.bots = directory.bots.filter(bot => bot.id !== "demo_002").map(bot => bot.id === "demo_003" ? { ...bot, role: "worker" } : bot);
    });
    for (const stale of ["演示助手 002", "演示助手 003"]) {
      await dialog.getByRole("option", { name: stale, exact: true }).click();
      await expect(dialog).toBeVisible();
      await expect(field).toHaveAccessibleDescription("选择来源 Bot");
    }
    expect((await pageState(page)).dirty).toBe(false);
    // Highlight a row, then let the list catch up: the highlight must not slide onto a neighbour.
    await dialog.getByRole("combobox").focus();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
    await expect(dialog.locator("[data-active]")).toHaveAccessibleName("资料助手 · …1f2e93");
    await page.evaluate(() => {
      const fixture = window.grantFixture, directory = fixture.sources.studio!;
      directory.bots = directory.bots.filter(bot => bot.id !== "client_7f3a9c21d4e8b6a05c1f2e93"); fixture.render();
    });
    await expect.poll(() => names(dialog)).toEqual(["来源研究员", "资料助手", "负责跨地区项目资料整理与每周进展汇总的长名称来源助手", "演示助手 001", "演示助手 004"]);
    await expect(dialog.locator("[data-active]")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(field).toHaveAccessibleDescription("选择来源 Bot");
    await dialog.getByRole("option", { name: "演示助手 004", exact: true }).click();
    await expect(field).toHaveAccessibleDescription("演示助手 004");
    // A chosen Bot that later disappears is named as a problem, never silently swapped.
    await page.evaluate(() => {
      const fixture = window.grantFixture, directory = fixture.sources.studio!;
      directory.bots = directory.bots.filter(bot => bot.id !== "demo_004"); fixture.render();
    });
    await expect(field).toHaveAccessibleDescription("所选 Bot 已不可用，请重新选择");
    await expect(p.getByRole("button", { name: "允许发送", exact: true })).toBeDisabled();
    expect(await commands(page)).toEqual([]);
  });

  test("re-choosing a saved exact-ID source after its directory returns is not a new edit", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    // No source directory: the owner types the exact ID, with stray spaces.
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.sources.studio!.status = "offline"; fixture.render(); });
    await p.getByLabel("来源 Bot ID", { exact: true }).fill("  alpha  ");
    await p.getByRole("button", { name: "允许发送", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已允许发送，并从接收主机核对生效。");
    expect(await commands(page)).toEqual([expect.objectContaining({ sourceBot: "alpha", changes: [{ targetBot: "alpha", allowed: true }] })]);
    expect((await pageState(page)).dirty).toBe(false);
    // The directory returns: field and chooser show that Bot by its trimmed ID.
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.sources.studio!.status = "online"; fixture.render(); });
    const field = p.getByLabel("来源 Bot", { exact: true });
    await expect(field).toHaveAccessibleDescription("来源研究员");
    await field.click();
    const dialog = chooser(page, "选择来源 Bot"), current = dialog.getByRole("option", { name: "来源研究员", exact: true });
    await expect(current).toHaveAttribute("aria-selected", "true");
    await current.click();
    await expect(dialog).toHaveCount(0);
    // The same Bot again: nothing to save or discard, and nothing more is sent.
    await expect(page.getByTestId("page-state")).toHaveText('{"dirty":false,"busy":false}');
    await expect(p.getByRole("button", { name: "已授权", exact: true })).toBeDisabled();
    expect(await commands(page)).toHaveLength(1);
  });

  test("losing the source directory closes its chooser and leaves the exact-ID path; a deleted recipient leaves the list", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    await p.getByLabel("来源 Bot", { exact: true }).click();
    await expect(chooser(page, "选择来源 Bot")).toBeVisible();
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.sources.studio!.status = "offline"; fixture.render(); });
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const manual = p.getByLabel("来源 Bot ID", { exact: true });
    await expect(manual).toBeEnabled();
    // Keyboard focus stays in the panel instead of falling to the document.
    expect(await p.evaluate(node => node.contains(document.activeElement))).toBe(true);
    // The directory returning must not reopen a chooser nobody asked for.
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.sources.studio!.status = "online"; fixture.render(); });
    await expect(p.getByLabel("来源 Bot", { exact: true })).toBeVisible();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const target = p.getByLabel("本机接收 Bot", { exact: true });
    await target.click();
    const dialog = chooser(page, "选择本机接收 Bot");
    await expect(dialog.getByRole("option")).toHaveCount(3);
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.server.bots.find(bot => bot.id === "beta")!.deleted = true; fixture.touch(); fixture.poll(); });
    await expect(dialog.getByRole("option")).toHaveCount(2);
    await expect(dialog.getByRole("option", { name: "复核助手", exact: true })).toHaveCount(0);
    expect(await commands(page)).toEqual([]);
  });

  test("going offline locks an open chooser in place; nothing can be chosen until the connection returns", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    const field = p.getByLabel("本机接收 Bot", { exact: true });
    await field.click();
    const dialog = chooser(page, "选择本机接收 Bot");
    await page.evaluate(() => window.grantFixture.setOnline(false));
    await expect(dialog.getByRole("status")).toHaveText("连接恢复后即可操作");
    await expect(dialog).toBeVisible(); // stays put: a tap in flight cannot reach the page below
    for (const option of await dialog.getByRole("option").all()) await expect(option).toHaveAttribute("aria-disabled", "true");
    await dialog.getByRole("option", { name: "复核助手", exact: true }).click({ force: true });
    await dialog.getByRole("combobox").focus();
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-active]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(field).toBeDisabled();
    await expect(field).toHaveAccessibleDescription("研究助手");
    expect(await p.evaluate(node => node.contains(document.activeElement))).toBe(true);
    for (const name of ["来源主机", "来源 Bot"]) await expect(p.getByLabel(name, { exact: true })).toBeDisabled();
    expect((await pageState(page)).dirty).toBe(false);
    await page.evaluate(() => window.grantFixture.setOnline(true));
    await expect(field).toBeEnabled();
    expect(await commands(page)).toEqual([]);
  });

  test("a permission change elsewhere locks an open chooser and the draft; reload is explicit and nothing is resent", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    await p.getByLabel("本机接收 Bot", { exact: true }).click();
    await chooser(page, "选择本机接收 Bot").getByRole("option", { name: "复核助手", exact: true }).click();
    expect((await pageState(page)).dirty).toBe(true);
    const field = p.getByLabel("来源 Bot", { exact: true });
    await field.click();
    const dialog = chooser(page, "选择来源 Bot");
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.touch(); fixture.poll(); });
    await expect(dialog.getByRole("status")).toHaveText("授权、Bot 或网络状态已变化，请重新载入后核对。");
    await dialog.getByRole("option", { name: "演示助手 001", exact: true }).click({ force: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "关闭选择", exact: true }).click();
    await expect(field).toBeDisabled();
    await expect(field).toHaveAccessibleDescription("选择来源 Bot");
    await expect(p.getByRole("alert")).toHaveText("授权、Bot 或网络状态已变化，请重新载入后核对。");
    await expect(p.getByRole("button", { name: "允许发送", exact: true })).toBeDisabled();
    expect(await commands(page)).toEqual([]);
    await p.getByRole("button", { name: "重新载入并核对", exact: true }).click();
    await expect(p.getByRole("status")).toHaveText("已重新载入主机当前权限。");
    await expect(field).toBeEnabled();
    expect((await pageState(page)).dirty).toBe(false);
    expect(await commands(page)).toEqual([]);
  });

  test("fields stay locked while a save is in flight and a failed read locks an open chooser", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    await p.getByLabel("来源 Bot", { exact: true }).click();
    await chooser(page, "选择来源 Bot").getByRole("option", { name: "演示助手 001", exact: true }).click();
    await page.evaluate(() => { window.grantFixture.control.holdPost = true; });
    await p.getByRole("button", { name: "允许发送", exact: true }).click();
    await expect(p.getByRole("button", { name: "正在保存并核对…", exact: true })).toBeDisabled();
    for (const name of ["来源主机", "来源 Bot", "本机接收 Bot"]) await expect(p.getByLabel(name, { exact: true })).toBeDisabled();
    expect((await pageState(page)).busy).toBe(true);
    await page.evaluate(() => { const { control } = window.grantFixture; control.holdPost = false; control.release(); });
    await expect(p.getByRole("status")).toHaveText("已允许发送，并从接收主机核对生效。");
    expect(await commands(page)).toHaveLength(1);
    const field = p.getByLabel("本机接收 Bot", { exact: true });
    await field.click();
    const dialog = chooser(page, "选择本机接收 Bot");
    await page.evaluate(() => { const fixture = window.grantFixture; fixture.control.failGet = 1; fixture.poll(); });
    await expect(dialog.getByRole("status")).toHaveText("无法核对主机权限，请恢复连接后重试。");
    await dialog.getByRole("option", { name: "复核助手", exact: true }).click({ force: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(field).toHaveAccessibleDescription("研究助手");
    expect(await commands(page)).toHaveLength(1);
  });

  test("hiding the page or changing the receiving host removes the chooser and never brings it back", async ({ page }) => {
    const p = await openCross(page, "mount=section");
    await p.getByLabel("来源主机", { exact: true }).click();
    await expect(chooser(page, "选择来源主机")).toBeVisible();
    await page.evaluate(() => window.grantFixture.setActive(false));
    await expect(page.locator("dialog")).toHaveCount(0);
    await page.evaluate(() => window.grantFixture.setActive(true));
    await expect(p.locator(".cross-grants-form")).toBeVisible();
    await expect(page.locator("dialog")).toHaveCount(0);
    await p.getByLabel("本机接收 Bot", { exact: true }).click();
    await expect(chooser(page, "选择本机接收 Bot")).toBeVisible();
    await page.evaluate(() => window.grantFixture.remount());
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(p.locator(".cross-grants-form")).toBeVisible();
    expect(await commands(page)).toEqual([]);
  });
});

// Layout: ordinary phones, a folding phone's cover and inner displays, a
// tablet and the desktop dialog, in both languages. Browser geometry only.
const layouts = [
  { name: "phone-320", width: 320, height: 568, touch: true }, { name: "phone-390", width: 390, height: 844, touch: true },
  { name: "phone-430", width: 430, height: 932, touch: true }, { name: "fold-cover-466", width: 466, height: 678, touch: true },
  { name: "fold-inner-951", width: 951, height: 669, touch: true }, { name: "tablet-820", width: 820, height: 1180, touch: true },
  { name: "desktop-1360", width: 1360, height: 900, touch: false },
];
const copy = {
  zh: { host: "来源主机", bot: "来源 Bot", target: "本机接收 Bot", hosts: "选择来源主机", bots: "选择来源 Bot", targets: "选择本机接收 Bot", close: "关闭选择", allow: "允许发送", long: "负责跨地区项目资料整理与每周进展汇总的长名称来源助手", longTarget: "负责合同条款逐项核对与风险提示的长名称接收助手" },
  en: { host: "Source host", bot: "Source Bot", target: "Receiving Bot on this host", hosts: "Choose a source host", bots: "Choose a source Bot", targets: "Choose a receiving Bot", close: "Close chooser", allow: "Allow sending", long: "Source assistant for cross-region project archives and weekly progress summaries", longTarget: "Receiving assistant for clause-by-clause contract checks and risk notes" },
};
/** Text that is cut off, wider than its box, or outside the panel. */
const overflowing = (root: Locator, selectors: string) => root.evaluate((node, query) => {
  const frame = node.getBoundingClientRect(), found: string[] = [];
  for (const element of node.querySelectorAll<HTMLElement>(query)) {
    if (!element.getClientRects().length) continue;
    const box = element.getBoundingClientRect();
    if (element.scrollWidth > element.clientWidth + 1 || box.left < frame.left - 1 || box.right > frame.right + 1) found.push(`${element.className || element.tagName}: ${element.textContent?.slice(0, 40)}`);
  }
  return found;
}, selectors);
const page_text = ".cross-grants-form-title,.cross-grants-field>span,.cross-grants-select,.cross-grants-select-value,.cross-grants-form .text-button,.cross-grants-confirm>span,.cross-grants-direction,.cross-grants-direction>span,.cross-grants-edge strong,.cross-grants-edge strong>span,.cross-grants-edge small,.cross-grants-edge>button,.message-grants-actions>button,.message-grants-hint,.cross-grants-receiver";
const chooser_text = "h2,.cross-grants-picker-context,.cross-grants-picker-search,.cross-grants-option,.cross-grants-option-copy>strong,.cross-grants-option-copy>small,.cross-grants-picker-more";
/** Settled position: the phone sheet slides in, so wait out its entrance. */
async function inViewport(page: Page, dialog: Locator) {
  const size = page.viewportSize()!;
  await expect.poll(async () => {
    const box = (await dialog.boundingBox())!;
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height + 0.5 ? "inside" : JSON.stringify(box);
  }).toBe("inside");
}
for (const layout of layouts) for (const language of ["zh", "en"] as const) test(`layout ${layout.name} ${language}: fields, direction, records and all three choosers fit without clipped text`, async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: layout.width, height: layout.height }, isMobile: layout.touch, hasTouch: layout.touch, serviceWorkers: "block" });
  const page = await context.newPage(), words = copy[language];
  try {
    const p = await openCross(page, `lang=${language}&bots=40&targets=12`);
    const fields = [p.getByLabel(words.host, { exact: true }), p.getByLabel(words.bot, { exact: true }), p.getByLabel(words.target, { exact: true })];
    const pick = async (field: Locator, title: string, option: string, shot: string) => {
      await field.click();
      const dialog = chooser(page, title);
      await expect(dialog).toBeVisible();
      await inViewport(page, dialog);
      for (const fixed of [dialog.getByRole("heading", { name: title, exact: true }), dialog.getByRole("button", { name: words.close, exact: true }), dialog.getByRole("combobox")]) await expect(fixed).toBeInViewport({ ratio: 1 });
      expect(await overflowing(dialog, chooser_text)).toEqual([]);
      const rows = dialog.getByRole("option");
      expect((await rows.first().boundingBox())!.height).toBeGreaterThanOrEqual(layout.touch ? 44 : 40);
      // The close control is a full touch target on touch layouts.
      const close = (await dialog.getByRole("button", { name: words.close, exact: true }).boundingBox())!;
      if (layout.width <= 760) { expect(close.width).toBeGreaterThanOrEqual(44); expect(close.height).toBeGreaterThanOrEqual(44); }
      await page.screenshot({ path: info.outputPath(`${layout.name}-${language}-${shot}.png`), animations: "disabled" });
      await dialog.getByRole("combobox").fill(option.slice(0, 12));
      await rows.filter({ hasText: option }).first().click();
      await expect(dialog).toHaveCount(0);
    };
    await pick(fields[0]!, words.hosts, language === "zh" ? "演示来源主机" : "Demo source host", "hosts");
    await pick(fields[1]!, words.bots, words.long, "source-bots");
    await pick(fields[2]!, words.targets, words.longTarget, "receiving-bots");
    await expect(p.locator(".cross-grants-direction")).toContainText(words.long);
    expect(await overflowing(p, page_text)).toEqual([]);
    await expect.poll(() => p.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    if (layout.touch) for (const control of [...fields, p.getByRole("button", { name: words.allow, exact: true }), ...await p.locator(".cross-grants-edge>button").all()]) {
      await control.scrollIntoViewIfNeeded();
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
    }
    // The long names are shown whole: both fields grew instead of truncating.
    await expect(fields[1]!).toHaveAccessibleDescription(words.long);
    await fields[0]!.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${layout.name}-${language}-page.png`), animations: "disabled" });
    await p.locator(".cross-grants-existing").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`${layout.name}-${language}-records.png`), animations: "disabled" });
  } finally { await context.close(); }
});

for (const scale of [130, 160]) test(`phone text at ${scale}% keeps every label, value and row whole`, async ({ browser }, info) => {
  const context = await browser.newContext({ ...phone, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const p = await openCross(page, "lang=en&bots=12");
    const before = (await p.locator(".cross-grants-form-title").boundingBox())!.height;
    // Chromium honours text-size-adjust under mobile emulation; this stands in
    // for the OS text-size setting, which no browser run can set.
    await page.addStyleTag({ content: `html{-webkit-text-size-adjust:${scale}%;text-size-adjust:${scale}%}` });
    await expect.poll(async () => (await p.locator(".cross-grants-form-title").boundingBox())!.height).toBeGreaterThan(before * 1.15);
    await p.getByLabel("Source Bot", { exact: true }).tap();
    const dialog = chooser(page, "Choose a source Bot");
    await inViewport(page, dialog);
    expect(await overflowing(dialog, chooser_text)).toEqual([]);
    for (const fixed of [dialog.getByRole("button", { name: "Close chooser", exact: true }), dialog.getByRole("combobox")]) await expect(fixed).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath(`text-${scale}-chooser.png`), animations: "disabled" });
    await dialog.getByRole("option", { name: copy.en.long, exact: true }).tap();
    await p.getByLabel("Receiving Bot on this host", { exact: true }).tap();
    await chooser(page, "Choose a receiving Bot").getByRole("option", { name: copy.en.longTarget, exact: true }).tap();
    expect(await overflowing(p, page_text)).toEqual([]);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await p.locator(".cross-grants-confirm").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`text-${scale}-page.png`), animations: "disabled" });
  } finally { await context.close(); }
});

test("a short viewport, as left by an on-screen keyboard, keeps the search field and a whole row", async ({ browser }) => {
  const context = await browser.newContext({ ...phone, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const p = await openCross(page, "bots=40&safe=24");
    await p.getByLabel("来源 Bot", { exact: true }).tap();
    const dialog = chooser(page, "选择来源 Bot"), search = dialog.getByRole("combobox");
    await search.tap();
    await expect(search).toBeFocused();
    for (const height of [520, 400, 300]) {
      await page.setViewportSize({ width: 390, height });
      await inViewport(page, dialog);
      for (const fixed of [dialog.getByRole("button", { name: "关闭选择", exact: true }), search, dialog.getByRole("option").first()]) await expect(fixed).toBeInViewport({ ratio: 1 });
    }
    await search.fill("演示助手 03");
    await expect(dialog.getByRole("option")).toHaveCount(7);
    await dialog.getByRole("option", { name: "演示助手 033", exact: true }).tap();
    await expect(p.getByLabel("来源 Bot", { exact: true })).toHaveAccessibleDescription("演示助手 033");
    // Reopening far down the list shows the current choice by scrolling the
    // list only; the sheet's own title, close and search stay reachable.
    await p.getByLabel("来源 Bot", { exact: true }).tap();
    await inViewport(page, dialog);
    for (const fixed of [dialog.getByRole("heading", { name: "选择来源 Bot", exact: true }), dialog.getByRole("button", { name: "关闭选择", exact: true }), search, dialog.getByRole("option", { name: "演示助手 033", exact: true })]) await expect(fixed).toBeInViewport({ ratio: 1 });
    expect(await dialog.evaluate(node => node.scrollTop)).toBe(0);
    await expect(dialog.getByRole("option", { name: "演示助手 033", exact: true })).toHaveAttribute("aria-selected", "true");
    // Shorter still (a landscape keyboard): not even one row fits. Showing the
    // current choice must not push the title and search out of a sheet that
    // could not be scrolled back; the sheet itself becomes scrollable instead.
    for (const height of [240, 200]) {
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await page.setViewportSize({ width: 390, height });
      await p.getByLabel("来源 Bot", { exact: true }).tap();
      await inViewport(page, dialog);
      expect(await dialog.evaluate(node => ({ sheet: node.scrollTop, list: node.querySelector("[role=listbox]")!.scrollTop > 0 }))).toEqual({ sheet: 0, list: true });
      for (const fixed of [dialog.getByRole("heading", { name: "选择来源 Bot", exact: true }), dialog.getByRole("button", { name: "关闭选择", exact: true }), search]) await expect(fixed).toBeInViewport({ ratio: 1 });
      await dialog.evaluate(node => { node.scrollTop = node.scrollHeight; });
      await expect(dialog.getByRole("option", { name: "演示助手 033", exact: true })).toBeInViewport({ ratio: 1 });
    }
  } finally { await context.close(); }
});
