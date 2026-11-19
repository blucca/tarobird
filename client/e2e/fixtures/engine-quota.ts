import path from "node:path";
import type { BrowserContext } from "@playwright/test";
import { engineQuotaViewSchema, type EngineQuotaView } from "../../../src/client-protocol/engine-quota.js";

// Synthetic quota readings for the model quota page: example Hosts, example
// Bots and placeholder model names only. Times are relative to "now", so a
// reading never ages into "expired" while a spec runs.
const H = 3_600_000, M = 60_000;
export type QuotaLanguage = "zh" | "en";

/** "Studio Mac": healthy, running low, unknown (passive source), named model
 * groups with one pool used up, not adapted, and a balance. */
export function studioQuota(now: number, language: QuotaLanguage = "zh"): EngineQuotaView {
  const word = (zh: string, en: string) => language === "en" ? en : zh;
  const gemini = ["gemini-pro-latest", "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-image-latest", "gemini-flash-thinking-latest"];
  const others = ["claude-sonnet-latest", "claude-opus-latest", "gpt-latest"];
  return { generatedAt: now, refreshing: false, entries: [
    { id: "codex:default", engine: "codex", status: "ok", source: "query", plan: "Pro",
      windows: [{ id: "primary", windowMinutes: 300, usedPercent: 42, resetsAt: now + 2 * H + 59 * M }, { id: "secondary", windowMinutes: 10080, usedPercent: 81, resetsAt: now + 3 * 24 * H + 4 * H }],
      balances: [], updatedAt: now - 20_000, checkedAt: now - 20_000, bots: [{ id: "bot_a", name: word("写作助手", "Writer") }, { id: "bot_b", name: word("代码审查", "Reviewer") }] },
    { id: "claude:default", engine: "claude", status: "unknown", source: "event", windows: [], balances: [], bots: [{ id: "bot_c", name: word("规划助手", "Planner") }] },
    // The Host lists each group's weekly window first; the page puts the shorter one first.
    { id: "antigravity:default", engine: "antigravity", status: "exhausted", source: "query",
      windows: [
        { id: "gemini:week", label: "Gemini Models", windowMinutes: 10080, usedPercent: 64, resetsAt: now + 4 * 24 * H + 6 * H, models: gemini },
        { id: "gemini:5h", label: "Gemini Models", windowMinutes: 300, usedPercent: 100, resetsAt: now + 4 * H + 12 * M, models: gemini },
        { id: "other:week", label: "Claude and GPT models", windowMinutes: 10080, usedPercent: 22, resetsAt: now + 4 * 24 * H + 6 * H, models: others },
        { id: "other:5h", label: "Claude and GPT models", windowMinutes: 300, usedPercent: 35, resetsAt: now + 3 * H + 40 * M, models: others },
        { id: "argon:week", label: "Gemini 4 Argon", windowMinutes: 10080, usedPercent: 8, resetsAt: now + 6 * 24 * H + 2 * H, models: ["gemini-4-argon"] },
      ],
      balances: [{ id: "credits", amount: "120", unit: "credits" }], updatedAt: now - 100_000, checkedAt: now - 100_000, bots: [] },
    { id: "kimi:default", engine: "kimi", status: "not_adapted", windows: [], balances: [], bots: [{ id: "bot_d", name: word("数据分析", "Analyst") }] },
    { id: "deepseek:default", engine: "deepseek", status: "ok", source: "query", windows: [], balances: [{ id: "total", amount: "38.50", unit: "CNY" }], updatedAt: now - 50_000, checkedAt: now - 50_000, bots: [] },
  ] };
}

/** "Office PC": over the limit, a passive reading shared by three Bots, sign-in
 * needed with an official page, unsupported sign-in, and a failed read that
 * keeps an earlier balance. `long` adds names that must wrap, not overflow. */
export function officeQuota(now: number, language: QuotaLanguage = "zh", long = false): EngineQuotaView {
  const word = (zh: string, en: string) => language === "en" ? en : zh;
  return { generatedAt: now, refreshing: false, entries: [
    { id: "codex:default", engine: "codex", status: "exhausted", source: "query", plan: "Plus",
      windows: [{ id: "primary", windowMinutes: 300, usedPercent: 104, resetsAt: now + 48 * M }, { id: "secondary", windowMinutes: 10080, usedPercent: 55, resetsAt: now + 5 * 24 * H + 2 * H }],
      balances: [], updatedAt: now - 30_000, checkedAt: now - 30_000, bots: [{ id: "bot_e", name: word("日报助手", "Daily digest") }] },
    { id: "claude:default", engine: "claude", status: "ok", source: "event", plan: long ? "Max 20x (annual team seat)" : "Max",
      windows: [{ id: "five_hour", windowMinutes: 300, usedPercent: 12, resetsAt: now + 4 * H + 5 * M },
        { id: "seven_day", windowMinutes: 10080, usedPercent: 63, resetsAt: now + 2 * 24 * H + 6 * H, ...(long ? { models: ["claude-opus-latest-long-context-preview", "claude-sonnet-latest"] } : {}) }],
      balances: [], updatedAt: now - 25 * M, checkedAt: now - 25 * M,
      bots: [{ id: "bot_f", name: word("资料研究员", long ? "Weekly research digest assistant" : "Researcher") }, { id: "bot_g", name: word("翻译助手", "Translator") }, { id: "bot_h", name: word("客服草稿", "Support drafts") }] },
    { id: "antigravity:default", engine: "antigravity", status: "login_required", windows: [], balances: [], checkedAt: now - 30_000, bots: [{ id: "bot_i", name: word("绘图助手", "Illustrator") }], guideUrl: "https://example.com/usage" },
    { id: "kimi:default", engine: "kimi", status: "unsupported", windows: [], balances: [], bots: [] },
    { id: "deepseek:default", engine: "deepseek", status: "error", reason: "timeout", source: "query", windows: [], balances: [{ id: "total", amount: "4.20", unit: "USD" }], updatedAt: now - 2 * H, checkedAt: now - 40_000, bots: [] },
  ] };
}

/** Engine environment with no CLI and an empty home: even a request that is not
 * mocked could not reach a real engine or login. */
export const sealedEngines = (root: string) => ({ entrypoint: path.join(root, "no-entrypoint.js"), env: { HOME: root, PATH: root, TAROBOT_MODEL_DISCOVERY: "0" } });

/** A controllable stand-in for one Host's quota routes. It records what the
 * page asked for, so a spec can assert "one read" as well as what is shown. */
export type QuotaDouble = { view: (now: number) => EngineQuotaView; refreshDelay: number; requests: { method: string; body: string | null }[] };
export const quotaDouble = (view: QuotaDouble["view"]): QuotaDouble => ({ view, refreshDelay: 0, requests: [] });
export const quotaCount = (double: QuotaDouble, method: "GET" | "POST") => double.requests.filter(request => request.method === method).length;
/** `hubUrl` and `pageOrigin` are read up front: a closed Hub no longer has a URL.
 * The second Host is another origin for the page, so its answers carry CORS headers. */
export async function mockQuota(context: BrowserContext, hubUrl: string, pageOrigin: string, double: QuotaDouble) {
  const cors = { "access-control-allow-origin": pageOrigin, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
  await context.route(url => url.href.startsWith(`${hubUrl}/api/engines/quota`), async route => {
    const request = route.request(), method = request.method();
    if (method === "OPTIONS") { await route.fulfill({ status: 204, headers: cors }); return; }
    double.requests.push({ method, body: request.postData() });
    if (method === "POST" && double.refreshDelay) await new Promise(resolve => setTimeout(resolve, double.refreshDelay));
    // The fixture itself must stay a valid protocol view.
    await route.fulfill({ contentType: "application/json", headers: cors, body: JSON.stringify(engineQuotaViewSchema.parse(double.view(Date.now()))) });
  });
}
