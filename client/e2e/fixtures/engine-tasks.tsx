import { useState } from "react";
import { createRoot } from "react-dom/client";
import { EngineTasks } from "../../src/EngineTasks.js";
import { RuntimeHostContext } from "../../src/RuntimeHost.js";
import type { EngineTask } from "../../../src/client-protocol/engine-tasks.js";
import type { HubConnection } from "../../src/connection.js";
import { setLocale } from "../../src/i18n.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/expressive-themes.css";
import "../../src/cli-typography.css";
import "../../src/layout-density.css";
import "../../src/motion.css";
import "../../src/conversation-creation.css";
const fixtureQuery = new URLSearchParams(location.search);
setLocale(fixtureQuery.get("lang") === "en" ? "en" : "zh");
let fail = false, uncertain = false, rejectOnce = false, stopScope: "foreground" | "subagents" = "foreground";
let recovery: { token: string; reason: "stop_unconfirmed" } | undefined;
const unknownReceipts = new Set<string>(); let unknownOnce = false;
const calls: Array<{ route: string; input?: { taskId: string; requestId: string } }> = [];
const tasks: EngineTask[] = [
  { id: "alpha", label: "检查 iPhone 键盘与滚动", kind: "subagent", mode: "background", status: "running", canStop: true, startedAt: Date.now() - 8000, updatedAt: Date.now(), progress: "已检查键盘弹起布局，正在核对列表的滚动位置。" },
  { id: "beta", label: "检查消息队列", kind: "subagent", mode: "background", status: "running", canStop: true, updatedAt: Date.now(), progress: "等待消息接收回执。" },
  { id: "foreground", label: "读取配置", parentId: "alpha", kind: "subagent", mode: "foreground", status: "running", canStop: false, updatedAt: Date.now() },
];
// Kimi's ACP has no per-task stop: detached work is listed for monitoring only.
if (fixtureQuery.get("shape") === "kimi") tasks.splice(0, tasks.length,
  { id: "kt_build", label: "运行全量单元测试", kind: "shell", mode: "background", status: "running", canStop: false, startedAt: Date.now() - 95_000, updatedAt: Date.now(), owner: "bound" },
  { id: "kt_review", label: "Review the release notes", kind: "subagent", mode: "background", status: "running", canStop: false, startedAt: Date.now() - 40_000, updatedAt: Date.now(), owner: "bound" },
  { id: "kt_lint", label: "检查类型与格式", kind: "shell", mode: "background", status: "done", canStop: false, startedAt: Date.now() - 300_000, updatedAt: Date.now() - 120_000, owner: "bound" },
  { id: "kt_e2e", label: "回归测试 · 手机端滚动与键盘", kind: "shell", mode: "background", status: "error", canStop: false, startedAt: Date.now() - 600_000, updatedAt: Date.now() - 200_000, owner: "unattributed" });
const count = fixtureQuery.get("shape") === "kimi" ? tasks.length : Math.min(30, Number(fixtureQuery.get("count")) || 3);
for (let i = tasks.length; i < count; i++) tasks.push({ ...tasks[0]!, id: `extra-${i + 1}`, label: `Kimi film 场景 ${i + 1} · 检查画面与字幕`, startedAt: Date.now() + i, progress: "检查画面、字幕与音频同步。" });
const hub = { identity: { hubPublicKey: "host", deviceId: "device" }, http: async (route: string, init?: RequestInit) => {
  const input = init?.body ? JSON.parse(String(init.body)) : undefined; calls.push({ route, input });
  if (fail) throw new Error("offline");
  if (input?.token) { recovery = undefined; return { outcome: "accepted" }; }
  if (input) { if (unknownOnce) { unknownOnce = false; unknownReceipts.add(input.requestId); } if (unknownReceipts.has(input.requestId)) return { outcome: "unknown", reason: "uncertain" }; if (rejectOnce) { rejectOnce = false; return { outcome: "rejected", reason: "not_ready" }; } if (uncertain) throw new Error("lost_reply"); const task = tasks.find(task => task.id === input.taskId); if (task) task.status = "stopped"; return { outcome: "accepted" }; }
  return { supported: true, tasks: structuredClone(tasks), foregroundStopScope: stopScope, recovery };
} } as unknown as HubConnection;
function Fixture() {
  const [active, setActive] = useState(true), [online, setOnline] = useState(true), [scope, setScope] = useState("chat"), [activity, setActivity] = useState("");
  Object.assign(window, { taskFixture: { calls, tasks, unknownOnce: () => { unknownOnce = true; }, recovery: () => { recovery = { token: "fence", reason: "stop_unconfirmed" }; setActivity(String(Date.now())); }, child: () => { tasks[2]!.canStop = true; setActivity(String(Date.now())); }, idle: () => { for (const task of tasks) task.status = "done"; setActivity(""); }, rejectOnce: () => { rejectOnce = true; }, setActive, setOnline, setScope, setLocale, stopScope: () => { stopScope = "subagents"; setActivity("running"); }, fail: (value: boolean) => { fail = value; setActivity(String(Date.now())); }, uncertain: (value: boolean) => { uncertain = value; }, add: () => tasks.push({ ...tasks[0]!, id: "late", label: "Later task", status: "running" }) } });
  return <main style={{ display: "block", maxWidth: 600, padding: 20 }}><button>其他输入</button><EngineTasks key={scope} connection={hub} conversationId={scope} botId="bot" active={active} online={online} available activity={activity}/></main>;
}
createRoot(document.getElementById("root")!).render(<RuntimeHostContext.Provider value="测试主机"><Fixture/></RuntimeHostContext.Provider>);
