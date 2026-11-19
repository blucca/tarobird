import { afterEach, describe, expect, it } from "vitest";
import type { EngineQuotaEntry, EngineQuotaView, EngineQuotaWindow } from "../../src/client-protocol/engine-quota.js";
import { engineQuotaViewSchema } from "../../src/client-protocol/engine-quota.js";
import { setLocale } from "./i18n.js";
import { QUOTA_STALE_AFTER_MS, quotaWindowGroups, quotaBalanceText, quotaDueResets, quotaEntryChip, quotaEntryDetail, quotaEntryHasData, quotaEntryStale, quotaNextReset, quotaReading, quotaReset, quotaResetKey, quotaSince, quotaUpdatedText, quotaWindowTitle } from "./engine-quota.js";

// Synthetic readings only. Times are built in the runner's own time zone so the
// "today / tomorrow / weekday" labels do not depend on where the suite runs.
const H = 3_600_000, M = 60_000;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const now = at(19, 14);
const window = (value: Partial<EngineQuotaWindow> = {}): EngineQuotaWindow => ({ id: "primary", ...value });
const entry = (value: Partial<EngineQuotaEntry> = {}): EngineQuotaEntry => ({ id: "codex:default", engine: "codex", status: "ok", windows: [], balances: [], bots: [], ...value });
const english = () => { Object.assign(globalThis, { document: { documentElement: {} } }); setLocale("en"); };
afterEach(() => { if ("document" in globalThis) { setLocale("zh"); Reflect.deleteProperty(globalThis, "document"); } });

describe("remaining share of one pool", () => {
  it("shows what is left and never a negative figure", () => {
    expect(quotaReading(window({ usedPercent: 42 }))).toEqual({ known: true, remaining: 58, text: "58%", over: false, empty: false, tone: "normal" });
    expect(quotaReading(window({ usedPercent: 0 }))).toMatchObject({ remaining: 100, text: "100%", tone: "normal" });
    expect(quotaReading(window({ usedPercent: 100 }))).toMatchObject({ remaining: 0, text: "0%", over: false, empty: true, tone: "danger" });
    expect(quotaReading(window({ usedPercent: 104 }))).toMatchObject({ remaining: 0, text: "0%", over: true, empty: true, tone: "danger" });
    expect(quotaReading(window({ usedPercent: 10_000 }))).toMatchObject({ remaining: 0, over: true });
  });
  it("warns from 80 % used and rounds in the cautious direction", () => {
    expect(quotaReading(window({ usedPercent: 79.9 }))).toMatchObject({ text: "20%", tone: "normal" });
    expect(quotaReading(window({ usedPercent: 80 }))).toMatchObject({ text: "20%", tone: "warning" });
    expect(quotaReading(window({ usedPercent: 57.4 }))).toMatchObject({ text: "42%" });
    // A sliver is neither "0%" nor "used up".
    expect(quotaReading(window({ usedPercent: 99.6 }))).toMatchObject({ text: "<1%", empty: false, tone: "warning" });
  });
  it("keeps a missing figure missing: unknown is not 0 % and not unlimited", () => {
    expect(quotaReading(window())).toEqual({ known: false });
    expect(quotaReading(window({ usedPercent: Number.NaN }))).toEqual({ known: false });
  });
});

describe("window names", () => {
  it("names a window by its length, or by the upstream's own label", () => {
    expect(quotaWindowTitle(window({ windowMinutes: 300 }))).toEqual({ title: "5 小时额度" });
    expect(quotaWindowTitle(window({ windowMinutes: 10_080 }))).toEqual({ title: "7 天额度" });
    expect(quotaWindowTitle(window({ windowMinutes: 90 }))).toEqual({ title: "90 分钟额度" });
    expect(quotaWindowTitle(window({ label: "Gemini Pro models", windowMinutes: 300 }))).toEqual({ title: "Gemini Pro models", detail: "5 小时额度" });
    expect(quotaWindowTitle(window({ label: "Gemini Pro models" }))).toEqual({ title: "Gemini Pro models", detail: undefined });
    expect(quotaWindowTitle(window())).toEqual({ title: "额度" });
  });
  it("has short English names", () => {
    english();
    expect(quotaWindowTitle(window({ windowMinutes: 300 }))).toEqual({ title: "5-hour limit" });
    expect(quotaWindowTitle(window({ windowMinutes: 10_080 }))).toEqual({ title: "7-day limit" });
  });
});

describe("windows that share a pool name", () => {
  const models = ["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest"];
  it("sit under that name once, shorter window first, and are never merged into one figure", () => {
    const groups = quotaWindowGroups([
      window({ id: "gemini:week", label: "Gemini Models", windowMinutes: 10_080, usedPercent: 64, models }),
      window({ id: "gemini:5h", label: "Gemini Models", windowMinutes: 300, usedPercent: 100, models }),
      window({ id: "other:week", label: "Claude and GPT models", windowMinutes: 10_080, usedPercent: 22, models: ["claude-sonnet-latest"] }),
      window({ id: "other:5h", label: "Claude and GPT models", windowMinutes: 300, usedPercent: 35, models: ["claude-sonnet-latest"] }),
      window({ id: "argon:week", label: "Gemini 4 Argon", windowMinutes: 10_080, usedPercent: 8 }),
    ]);
    expect(groups.map(group => [group.heading, group.windows.map(item => item.id)])).toEqual([
      ["Gemini Models", ["gemini:5h", "gemini:week"]], ["Claude and GPT models", ["other:5h", "other:week"]], ["Gemini 4 Argon", ["argon:week"]]]);
    expect(groups[0]!.models).toEqual(models);
    expect(groups[0]!.windows.map(item => item.usedPercent)).toEqual([100, 64]);
    expect(groups[2]!.models).toBeUndefined();
  });
  it("leaves unnamed windows as they are and keeps the Host's order without stated lengths", () => {
    expect(quotaWindowGroups([window({ id: "primary", windowMinutes: 300 }), window({ id: "secondary", windowMinutes: 10_080 })]))
      .toEqual([{ key: "", windows: [window({ id: "primary", windowMinutes: 300 }), window({ id: "secondary", windowMinutes: 10_080 })] }]);
    expect(quotaWindowGroups([window({ id: "b", label: "Pool" }), window({ id: "a", label: "Pool", windowMinutes: 300 })])[0]!.windows.map(item => item.id)).toEqual(["b", "a"]);
    expect(quotaWindowGroups([])).toEqual([]);
  });
  it("states models per window when the group's windows differ, and keeps a lone unnamed-length pool's own title", () => {
    const mixed = quotaWindowGroups([window({ id: "a", label: "Pool", windowMinutes: 300, models: ["one"] }), window({ id: "b", label: "Pool", windowMinutes: 10_080, models: ["two"] })]);
    expect(mixed[0]).toMatchObject({ heading: "Pool" }); expect(mixed[0]!.models).toBeUndefined();
    const lone = quotaWindowGroups([window({ id: "pro", label: "Gemini Pro models", models: ["gemini-pro-latest"] })]);
    expect(lone[0]!.heading).toBeUndefined(); expect(lone[0]!.models).toBeUndefined();
    expect(quotaWindowTitle(lone[0]!.windows[0]!)).toEqual({ title: "Gemini Pro models", detail: undefined });
  });
});

describe("reset time", () => {
  it("counts down against the given clock and shows the same instant as a local time", () => {
    expect(quotaReset(undefined, now, "zh")).toEqual({ state: "none" });
    expect(quotaReset(now + 30_000, now, "zh")).toMatchObject({ state: "future", relative: "不到 1 分钟后重置" });
    expect(quotaReset(now + 12 * M, now, "zh")).toMatchObject({ relative: "12 分钟后重置", exact: "今天 14:12" });
    expect(quotaReset(now + 3 * H, now, "zh")).toMatchObject({ relative: "3 小时后重置", exact: "今天 17:00" });
    expect(quotaReset(now + 2 * H + 59 * M, now, "zh")).toMatchObject({ relative: "2 小时 59 分后重置", exact: "今天 16:59" });
    expect(quotaReset(at(20, 9), now, "zh")).toMatchObject({ relative: "19 小时后重置", exact: "明天 09:00" });
    expect(quotaReset(at(23, 9), now, "zh")).toMatchObject({ relative: "3 天 19 小时后重置", exact: "周一 09:00" });
    expect(quotaReset(at(22, 14), now, "zh")).toMatchObject({ relative: "3 天后重置" });
    const far = quotaReset(at(30, 9), now, "zh");
    expect(far).toMatchObject({ state: "future", exact: "11月30日 09:00" });
    expect(far.state === "future" && far.iso).toBe(new Date(at(30, 9)).toISOString());
  });
  it("a passed reset is due: it never reads as a countdown or a refill", () => {
    expect(quotaReset(now, now, "zh")).toEqual({ state: "due" });
    expect(quotaReset(now - 1, now, "zh")).toEqual({ state: "due" });
  });
  it("stays short in English", () => {
    english();
    expect(quotaReset(now + 2 * H + 59 * M, now, "en")).toMatchObject({ relative: "Resets in 2h 59m", exact: "Today 16:59" });
    expect(quotaReset(at(23, 9), now, "en")).toMatchObject({ relative: "Resets in 3d 19h", exact: "Mon 09:00" });
  });
});

describe("reading age", () => {
  it("labels how old a reading is without claiming the future", () => {
    expect(quotaSince(now + 5_000, now, "zh")).toBe("刚才");
    expect(quotaSince(now - 59_000, now, "zh")).toBe("刚才");
    expect(quotaSince(now - 25 * M, now, "zh")).toBe("25 分钟前");
    expect(quotaSince(now - 2 * H, now, "zh")).toBe("2 小时前");
    expect(quotaSince(now - 3 * 24 * H, now, "zh")).toBe("3 天前");
    expect(quotaUpdatedText(now - 20_000, now, "zh")).toBe("刚刚更新");
    expect(quotaUpdatedText(now - 25 * M, now, "zh")).toBe("更新于 25 分钟前");
  });
  it("marks a reading as expired only by its own age", () => {
    expect(quotaEntryStale(entry(), now)).toBe(false);
    expect(quotaEntryStale(entry({ updatedAt: now - QUOTA_STALE_AFTER_MS }), now)).toBe(false);
    expect(quotaEntryStale(entry({ updatedAt: now - QUOTA_STALE_AFTER_MS - 1 }), now)).toBe(true);
  });
});

describe("balances", () => {
  it("keeps the upstream's figure and unit verbatim", () => {
    expect(quotaBalanceText({ id: "total", amount: "38.50", unit: "CNY" })).toBe("¥38.50");
    expect(quotaBalanceText({ id: "total", amount: "4.20", unit: "USD" })).toBe("$4.20");
    expect(quotaBalanceText({ id: "credits", amount: "120", unit: "credits" })).toBe("120 credits");
    expect(quotaBalanceText({ id: "total", amount: "12.00000001", unit: "EUR" })).toBe("12.00000001 EUR");
    expect(quotaBalanceText({ id: "total", amount: "-3.20", unit: "CNY" })).toBe("-¥3.20");
    expect(quotaBalanceText({ id: "total", amount: "1000000", unit: "USD" })).toBe("$1000000");
  });
});

describe("reset boundaries across a Host's view", () => {
  const view: EngineQuotaView = { generatedAt: now, refreshing: false, entries: [
    entry({ windows: [window({ id: "primary", resetsAt: now - 1_000 }), window({ id: "secondary", resetsAt: now + 3 * H })] }),
    entry({ id: "claude:default", engine: "claude", windows: [window({ id: "five_hour", resetsAt: now + H }), window({ id: "none" })] }),
  ] };
  it("finds the passed boundaries and the next one ahead", () => {
    expect(quotaDueResets(view, now)).toEqual([quotaResetKey(view.entries[0]!, view.entries[0]!.windows[0]!)]);
    expect(quotaNextReset(view, now)).toBe(now + H);
    expect(quotaDueResets(undefined, now)).toEqual([]);
    expect(quotaNextReset({ ...view, entries: [] }, now)).toBeUndefined();
  });
  it("identifies a boundary by entry, window and time, so a new reset time is a new boundary", () => {
    const first = view.entries[0]!, same = quotaResetKey(first, first.windows[0]!);
    expect(quotaResetKey(first, { ...first.windows[0]!, resetsAt: now + 5 * H })).not.toBe(same);
    expect(quotaResetKey({ ...first, id: "codex:work" }, first.windows[0]!)).not.toBe(same);
  });
});

describe("entry status", () => {
  const chip = (value: Partial<EngineQuotaEntry>, stale = false) => quotaEntryChip(entry(value), stale, now);
  it("leaves a healthy entry unmarked and marks the ones that need attention", () => {
    expect(chip({ windows: [window({ usedPercent: 42 })] })).toBeUndefined();
    expect(chip({ windows: [window({ usedPercent: 42 }), window({ id: "secondary", usedPercent: 81 })] })).toEqual({ tone: "warning", text: "快用完" });
    expect(chip({ windows: [window({ usedPercent: 100 })] })).toEqual({ tone: "danger", text: "已用完" });
    expect(chip({ status: "exhausted", windows: [window({ usedPercent: 104 })] })).toEqual({ tone: "danger", text: "已超额" });
    // The upstream says a pool is used up without giving a share.
    expect(chip({ status: "exhausted" })).toEqual({ tone: "danger", text: "已用完" });
  });
  it("says why there is nothing to show instead of 0 % or unlimited", () => {
    expect(chip({ status: "unknown" })).toEqual({ tone: "muted", text: "暂无数据" });
    expect(chip({ status: "login_required" })).toEqual({ tone: "warning", text: "需要登录" });
    expect(chip({ status: "unsupported" })).toEqual({ tone: "muted", text: "此登录方式不提供" });
    expect(chip({ status: "not_adapted" })).toEqual({ tone: "muted", text: "尚未适配" });
    expect(chip({ status: "engine_missing" })).toEqual({ tone: "muted", text: "未安装" });
    expect(chip({ status: "error", reason: "timeout" })).toEqual({ tone: "warning", text: "读取失败" });
  });
  it("does not keep an old or passed reading marked as used up", () => {
    expect(chip({ status: "exhausted", windows: [window({ usedPercent: 104 })] }, true)).toEqual({ tone: "muted", text: "数据已过期" });
    expect(chip({ status: "exhausted", windows: [window({ usedPercent: 104, resetsAt: now - 1_000 }), window({ id: "secondary", usedPercent: 55, resetsAt: now + H })] })).toBeUndefined();
    expect(chip({ status: "exhausted", windows: [window({ usedPercent: 104, resetsAt: now - 1_000 }), window({ id: "secondary", usedPercent: 100, resetsAt: now + H })] })).toEqual({ tone: "danger", text: "已用完" });
  });
  it("explains each state in one sentence", () => {
    expect(quotaEntryDetail(entry())).toBeUndefined();
    expect(quotaEntryDetail(entry({ status: "exhausted" }))).toBeUndefined();
    expect(quotaEntryDetail(entry({ engine: "claude", status: "unknown", source: "event" }))).toBe("还没有读到额度，下一次对话后更新。");
    expect(quotaEntryDetail(entry({ status: "unknown", source: "query" }))).toBe("还没有读到额度，可稍后刷新。");
    // While the Host is still reading, an actively queried engine is not "nothing"; a passive one still waits for a chat.
    expect(quotaEntryDetail(entry({ status: "unknown", source: "query" }), true)).toBe("正在读取…");
    expect(quotaEntryDetail(entry({ engine: "claude", status: "unknown", source: "event" }), true)).toBe("还没有读到额度，下一次对话后更新。");
    expect(quotaEntryDetail(entry({ engine: "antigravity", status: "login_required" }))).toBe("请在主机上重新登录 Antigravity。");
    expect(quotaEntryDetail(entry({ engine: "kimi", status: "not_adapted" }))).toBe("TaroBird 还没有接入 Kimi 的额度读取。");
    expect(quotaEntryDetail(entry({ engine: "deepseek", status: "engine_missing" }))).toBe("这台主机上没有找到 DeepSeek。");
    expect(quotaEntryDetail(entry({ status: "unsupported" }))).toBe("当前登录方式不提供账号额度，例如 API Key。");
    expect([undefined, "timeout", "rate_limited", "invalid_response", "upstream_error"].map(reason => quotaEntryDetail(entry({ status: "error", reason: reason as EngineQuotaEntry["reason"] }))))
      .toEqual(["读取失败，可稍后刷新。", "读取超时，可稍后刷新。", "查询太频繁，请稍后再刷新。", "上游返回的内容无法识别。", "上游服务出错，可稍后刷新。"]);
  });
  it("knows whether an entry carries figures", () => {
    expect(quotaEntryHasData(entry())).toBe(false);
    expect(quotaEntryHasData(entry({ windows: [window()] }))).toBe(true);
    expect(quotaEntryHasData(entry({ balances: [{ id: "total", amount: "1", unit: "USD" }] }))).toBe(true);
  });
});

it("the page's sample shapes are valid protocol views", () => {
  expect(() => engineQuotaViewSchema.parse({ generatedAt: now, refreshing: false, entries: [
    entry({ plan: "Pro", source: "query", updatedAt: now, checkedAt: now, windows: [window({ windowMinutes: 300, usedPercent: 42, resetsAt: now + H })], bots: [{ id: "bot_a", name: "Writer" }] }),
    entry({ id: "deepseek:default", engine: "deepseek", balances: [{ id: "total", amount: "38.50", unit: "CNY" }] }),
  ] })).not.toThrow();
});
