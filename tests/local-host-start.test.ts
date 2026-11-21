// Issue #63: a stopped local host gets an explicit "Start local host" action;
// automatic recovery (resume) keeps never re-enabling it.
import { afterEach, expect, it, vi } from "vitest";
import english from "../client/src/locales/en.json" with { type: "json" };
import { setLocale } from "../client/src/i18n.js";
import { prepareLocalController, startLocalHost, watchLocalHostRecovery } from "../client/src/local-controller.js";
import { localControllerMessage, localHostStartFailureMessage, localHostStartIssueMessage } from "../client/src/local-controller-message.js";
import type { HostRegistry } from "../client/src/host-registry.js";
import type { DesktopStartIssue } from "../src/client-protocol/desktop-runtime.js";

afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); vi.useRealTimers(); });
const registry = () => ({ nativeLocalHost: async () => "local-key", rememberNativeLocalHost: vi.fn(), list: async () => [] }) as unknown as HostRegistry;
const dictionary = english as Record<string, string>;
const issues: DesktopStartIssue[] = [{ code: "schema_incompatible", schema: 27, minHubSchema: 1, maxHubSchema: 26 }];

it("reports a stopped host without ever asking the native side to start it", async () => {
  const request = vi.fn(async () => ({ available: true, running: false, hostEnabled: false }));
  expect(await prepareLocalController(registry(), request)).toEqual({ publicKey: "local-key", pending: true, issue: "stopped" });
  expect(request.mock.calls).toEqual([[{ action: "resume" }]]);
});

it("the recovery watcher only resumes, even repeatedly while the host stays stopped", async () => {
  vi.useFakeTimers();
  const request = vi.fn(async () => ({ available: true, running: false, hostEnabled: false }));
  const target = new EventTarget();
  const stop = watchLocalHostRecovery(request, [target]);
  for (let minute = 0; minute < 3; minute++) { await vi.advanceTimersByTimeAsync(61_000); target.dispatchEvent(new Event("focus")); }
  stop();
  expect(request.mock.calls.length).toBeGreaterThan(0);
  expect(request.mock.calls.every(([args]) => (args as { action: string }).action === "resume")).toBe(true);
});

it("starts through the same native start action as the welcome page", async () => {
  const request = vi.fn(async () => ({ available: true, running: true, publicKey: "local-key" }));
  expect(await startLocalHost(request)).toEqual({ ok: true, publicKey: "local-key" });
  expect(request).toHaveBeenCalledExactlyOnceWith({ action: "start" });
});

it("explains every refusal and keeps it actionable", async () => {
  for (const startIssue of issues) {
    const result = await startLocalHost(async () => ({ available: true, running: false, hostEnabled: false, startIssue }));
    expect(result).toEqual({ ok: false, message: localHostStartIssueMessage(startIssue) });
  }
  expect(localHostStartIssueMessage(issues[0]!)).toContain("请先更新 App");
  expect(localHostStartIssueMessage(issues[0]!)).toContain("数据未改动");
  // A native failure maps directory diagnostics, never raw stderr or paths.
  expect(await startLocalHost(async () => { throw new Error("desktop_host_operation_failed|exit=78|reason=state_conflict"); })).toEqual({ ok: false, message: localControllerMessage("conflict") });
  expect(await startLocalHost(async () => { throw new Error("raw stderr: private-path credential"); })).toEqual({ ok: false, message: localHostStartFailureMessage() });
  expect(await startLocalHost(async () => ({ available: true, running: false }))).toEqual({ ok: false, message: localHostStartFailureMessage() });
  expect(await startLocalHost(async () => ({ available: true, running: true, runtimeIssue: "runtime_waiting" }))).toEqual({ ok: false, message: localControllerMessage("runtime_waiting") });
});

it("says how to re-enable instead of only that resume won't", () => {
  const message = localControllerMessage("stopped");
  expect(message).toContain("启动本机主机");
  expect(message).not.toContain("自动恢复不会替你重新启用");
});

it("has English copy with matching placeholders for every new message", () => {
  const placeholders = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort().join();
  const chinese = [localControllerMessage("stopped"), localHostStartFailureMessage(), ...issues.map(localHostStartIssueMessage)];
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  expect(localControllerMessage("stopped")).toBe(dictionary["本机主机已停用，App 不会自动重新启用。点「启动本机主机」即可恢复，其他主机仍可使用。"]);
  for (const key of ["启动本机主机", "正在启动本机主机…", "本机主机已停用", "本机主机已停用，App 不会自动重新启用。", "协调主机「{0}」就是这台电脑上的主机，目前已停用，所以暂时无法管理网络。启动后会自动重新连接。"]) {
    expect(dictionary[key]?.trim(), key).toBeTruthy();
    expect(placeholders(dictionary[key]!), key).toBe(placeholders(key));
  }
  const translated = [localControllerMessage("stopped"), localHostStartFailureMessage(), ...issues.map(localHostStartIssueMessage)];
  translated.forEach((text, index) => { expect(text, chinese[index]).not.toBe(chinese[index]); expect(text).not.toMatch(/[一-鿿]/); });
});
