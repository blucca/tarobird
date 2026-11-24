import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appCapabilityInstructions, appTurnInstructions } from "../src/gateway/agent-instructions.js";
import { executeCronAddTool } from "../src/tools/cron-add-tool.js";
import { CronStore } from "../src/state/cron-store.js";
import { CronScheduler } from "../src/runtime/cron-scheduler.js";
import { resolveTimelineLogPath } from "../src/state/timeline-log.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("Scheduled task deliveryMode clarity (#114)", () => {
  it("explains both delivery modes, their defaults, and an agent-mode one-shot example in schedules guidance", () => {
    const cap = appCapabilityInstructions("schedules", { timezone: "Asia/Shanghai" });
    expect(cap).toContain("deliveryMode");
    expect(cap).toContain("notify");
    expect(cap).toContain("agent");
    expect(cap).toMatch(/one-shot|in\/at/i);
    expect(cap).toMatch(/"deliveryMode"\s*:\s*"agent"/);

    const turn = appTurnInstructions("20分钟后提醒另一个 Bot 继续工作", { engine: "claude", nativeDelivery: true }) ?? "";
    expect(turn).toContain("deliveryMode");
    expect(turn).toContain("notify");
    expect(turn).toContain("agent");
  });

  it("clearly states in cron.add receipt whether the Bot will run or only send a reminder (zh & en)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-mode-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn().mockResolvedValue(undefined), runJobNow: vi.fn().mockResolvedValue(undefined) };
    const baseCtx = {
      channel: "lark" as const,
      chatId: 1,
      userId: 2,
      chatType: "private" as const,
      larkChatId: "gw_conv1",
      conversationKey: "lark:gw_conv1",
      stateDir,
      instanceName: "bot1",
      cronRuntime: { store, scheduler },
    };
    try {
      // 1. One-shot default -> notify (zh)
      const notifyZh = await executeCronAddTool({ in: "10m", prompt: "喝水" }, { ...baseCtx, locale: "zh" });
      expect(notifyZh.ok).toBe(true);
      expect(notifyZh.message).toContain("仅发送提醒");
      expect(notifyZh.message).toContain("不会运行 Bot");

      // 2. One-shot default -> notify (en)
      const notifyEn = await executeCronAddTool({ in: "10m", prompt: "Drink water" }, { ...baseCtx, locale: "en" });
      expect(notifyEn.ok).toBe(true);
      expect(notifyEn.message).toMatch(/only reminds you|reminder only/i);
      expect(notifyEn.message).toMatch(/Bot will not run/i);

      // 3. One-shot explicit deliveryMode: "agent" -> agent (zh)
      const agentZh = await executeCronAddTool({ in: "10m", prompt: "检查额度并通知另一个 Bot", deliveryMode: "agent" }, { ...baseCtx, locale: "zh" });
      expect(agentZh.ok).toBe(true);
      expect(agentZh.message).toContain("自动运行 Bot");

      // 4. Recurring default -> agent (en)
      const agentEn = await executeCronAddTool({ cron: "0 9 * * *", prompt: "Send morning digest" }, { ...baseCtx, locale: "en" });
      expect(agentEn.ok).toBe(true);
      expect(agentEn.message).toMatch(/Bot will run/i);
    } finally {
      await removeTempRoot(stateDir);
    }
  });

  it("records deliveryMode on cron.completed timeline events so reminder-only runs are distinguishable", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "tarobird-cron-log-"));
    const store = new CronStore(stateDir);
    try {
      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "Standup reminder",
        larkChatId: "gw_conv1",
        conversationKey: "lark:gw_conv1",
        deliveryMode: "notify",
        runOnce: true,
        targetAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const scheduler = new CronScheduler({ store, executor: async () => {}, stateDir });
      try {
        await scheduler.runJobNow(job.id);
      } finally {
        await scheduler.stop();
      }
      const raw = await readFile(resolveTimelineLogPath(stateDir), "utf8");
      const events = raw.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const completed = events.find(e => e.type === "cron.completed" && e.metadata?.cronJobId === job.id);
      expect(completed).toBeDefined();
      expect(completed?.metadata?.deliveryMode).toBe("notify");
      expect(completed?.detail).toMatch(/reminder/i);
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});
