import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";
import { setLocale } from "../src/i18n.js";
import {
  approvalPlainSummary,
  fileKindInfo,
  findApprovalAllowAction,
  formatModelDisplayName,
  signalStrength,
} from "../src/workspace-visuals.js";

const origDocument = globalThis.document;
afterEach(() => {
  if (origDocument === undefined) {
    // @ts-expect-error restore node test global
    delete globalThis.document;
  } else {
    globalThis.document = origDocument;
  }
});

function useTestLocale(locale: "zh" | "en") {
  // @ts-expect-error minimal document stub for i18n.setLocale in node vitest
  globalThis.document = { documentElement: { lang: "" } };
  setLocale(locale);
}

describe("workspace-visuals", () => {
  it("formats raw model IDs into readable names", () => {
    expect(formatModelDisplayName("claude-sonnet-4-6", "claude")).toBe("Claude Sonnet 4.6");
    expect(formatModelDisplayName("claude-opus-4-1-20250805", "claude")).toBe("Claude Opus 4.1");
    expect(formatModelDisplayName("gpt-5.4", "codex")).toBe("GPT-5.4");
    expect(formatModelDisplayName("gpt-5.3-codex", "codex")).toBe("GPT-5.3 Codex");
    expect(formatModelDisplayName("gemini-2.5-pro", "pi")).toBe("Gemini 2.5 Pro");
    expect(formatModelDisplayName("deepseek-reasoner", "deepseek")).toBe("DeepSeek Reasoner");
    expect(formatModelDisplayName("", "claude")).toBe("Claude Code");
    expect(formatModelDisplayName("default", "codex")).toBe("Codex");
  });

  it("maps connection status and latency to plain-language signal strength", () => {
    useTestLocale("zh");
    expect(signalStrength("online", 20)).toEqual({ bars: 4, tone: "ok", label: "很好 · 20ms" });
    expect(signalStrength("online", 150)).toEqual({ bars: 3, tone: "ok", label: "不错 · 150ms" });
    expect(signalStrength("online", 350)).toEqual({ bars: 2, tone: "warn", label: "有点慢 · 350ms" });
    expect(signalStrength("online", 800)).toEqual({ bars: 1, tone: "bad", label: "较卡顿 · 800ms" });
    expect(signalStrength("connecting")).toEqual({ bars: 1, tone: "warn", label: "正在连接…" });
    expect(signalStrength("offline")).toEqual({ bars: 0, tone: "bad", label: "未连上" });

    useTestLocale("en");
    expect(signalStrength("online", 20)).toEqual({ bars: 4, tone: "ok", label: "Great · 20ms" });
  });

  it("turns approval card titles and details into plain everyday summaries", () => {
    useTestLocale("zh");
    expect(approvalPlainSummary("Reviewer", "请求执行命令审批", "npm run test:regression")).toBe(
      "Reviewer 想运行一条命令，需要你同意",
    );
    expect(approvalPlainSummary("Architect", "Allow file edit", "src/App.tsx")).toBe(
      "Architect 想修改或写入文件，需要你同意",
    );
    expect(approvalPlainSummary("Researcher", "Web fetch", "https://example.com")).toBe(
      "Researcher 想访问网络或网页，需要你同意",
    );
    expect(approvalPlainSummary("Reviewer", "部署确认", "")).toBe(
      "Reviewer 想「部署确认」，需要你同意",
    );

    useTestLocale("en");
    expect(approvalPlainSummary("Reviewer", "Approve shell command", "npm test")).toBe(
      "Reviewer wants to run a command — needs your OK",
    );
  });

  it("classifies file types cleanly for varied SVG artwork", () => {
    useTestLocale("zh");
    expect(fileKindInfo("workspace-rail-spec.md", "text/markdown")).toMatchObject({ kind: "doc", ext: "MD", label: "文档" });
    expect(fileKindInfo("budget.xlsx")).toMatchObject({ kind: "sheet", ext: "XLSX", label: "表格" });
    expect(fileKindInfo("layout-benchmark.json", "application/json")).toMatchObject({ kind: "sheet", ext: "JSON", label: "数据文件" });
    expect(fileKindInfo("diagram.png", "image/png")).toMatchObject({ kind: "image", ext: "PNG", label: "图片" });
    expect(fileKindInfo("ConversationWorkspace.tsx")).toMatchObject({ kind: "code", ext: "TSX", label: "代码" });
    expect(fileKindInfo("report.pdf", "application/pdf")).toMatchObject({ kind: "pdf", ext: "PDF", label: "PDF 文档" });
  });

  it("extracts allow_once approval actionId from card messages", () => {
    const msg: Message = {
      id: "m1",
      conversationId: "c1",
      authorId: "bot_rev",
      authorType: "bot",
      status: "streaming",
      createdAt: Date.now(),
      version: 1,
      blocks: [
        {
          type: "card",
          title: "Approve shell command",
          elements: [
            { type: "markdown", text: "npm test" },
            { type: "button", text: "Deny", actionId: "act_deny", value: { cctb_lark: "approval", requestId: "r1", decision: "deny" } },
            { type: "button", text: "Allow once", actionId: "act_allow", value: { cctb_lark: "approval", requestId: "r1", decision: "allow_once" } },
          ],
        },
      ],
    };
    expect(findApprovalAllowAction(msg)).toBe("act_allow");
    expect(findApprovalAllowAction({ ...msg, status: "deleted" })).toBeUndefined();
  });
});
