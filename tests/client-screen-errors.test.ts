// The shared remote screen reason table (#48/#49 P1). `check-translations`
// only sees literal t("…") calls, so this keeps every table entry translated.
import { afterEach, expect, it, vi } from "vitest";
import english from "../client/src/locales/en.json" with { type: "json" };
import { setLocale } from "../client/src/i18n.js";
import { SCREEN_ERROR_MESSAGES, SCREEN_ERROR_MESSAGES_WINDOWS, screenError } from "../client/src/screen-errors.js";

afterEach(() => { setLocale("zh"); vi.unstubAllGlobals(); });
const placeholders = (value: string) => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort().join();

it("every reason message has an English translation with the same placeholders", () => {
  const dictionary = english as Record<string, string>;
  expect(Object.keys(SCREEN_ERROR_MESSAGES).length).toBeGreaterThan(0);
  for (const [reason, message] of Object.entries(SCREEN_ERROR_MESSAGES)) {
    expect(dictionary[message]?.trim(), reason).toBeTruthy();
    expect(placeholders(dictionary[message]!), reason).toBe(placeholders(message));
  }
  expect(dictionary["屏幕连接已结束，请检查主机状态后重试。"]?.trim()).toBeTruthy();
});

it("known reasons show their sentence in the UI locale; unknown ones keep the generic sentence and a bounded code", () => {
  expect(screenError("screen_locked")).toBe("目标 Mac 已锁定，请在本机解锁后重新连接。");
  expect(screenError("x".repeat(200))).toBe(`屏幕连接已结束，请检查主机状态后重试。 (${"x".repeat(120)})`);
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  expect(screenError("screen_locked")).toBe((english as Record<string, string>)["目标 Mac 已锁定，请在本机解锁后重新连接。"]);
  expect(screenError("screen_new_reason")).toBe(`${(english as Record<string, string>)["屏幕连接已结束，请检查主机状态后重试。"]} (screen_new_reason)`);
});

it("a Windows target has its own sentence wherever the usual one names a Mac or a Mac permission", () => {
  const dictionary = english as Record<string, string>;
  const names = /Mac|辅助功能|输入监控|录制屏幕/;
  for (const [reason, message] of Object.entries(SCREEN_ERROR_MESSAGES)) {
    // Host-side and local-service reasons are shown on the computer itself and name no target.
    if (names.test(message)) expect(SCREEN_ERROR_MESSAGES_WINDOWS[reason], reason).toBeTruthy();
  }
  for (const [reason, message] of Object.entries(SCREEN_ERROR_MESSAGES_WINDOWS)) {
    expect(SCREEN_ERROR_MESSAGES[reason], reason).toBeTruthy();
    expect(names.test(message), reason).toBe(false);
    expect(dictionary[message]?.trim(), reason).toBeTruthy();
    expect(names.test(dictionary[message]!) || /Accessibility|Input Monitoring|Screen Recording/.test(dictionary[message]!), reason).toBe(false);
    expect(placeholders(dictionary[message]!), reason).toBe(placeholders(message));
  }
});

it("the target decides the sentence; an unknown reason is the same bounded code for both", () => {
  expect(screenError("screen_locked", "windows")).toBe("目标电脑已锁定或正在显示安全提示，请在那台电脑上处理后重新连接。");
  expect(screenError("screen_locked", "macos")).toBe(screenError("screen_locked"));
  // Refused input is explained without claiming which of the possible causes it was.
  expect(screenError("screen_input_denied", "windows")).toBe("目标电脑没有接受远程输入，控制已停止。以管理员身份运行的窗口和安全提示不能被远程控制。");
  // A reason that names no target reads the same for both.
  expect(screenError("screen_geometry_changed", "windows")).toBe(screenError("screen_geometry_changed"));
  expect(screenError("screen_new_reason", "windows")).toBe(screenError("screen_new_reason"));
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  expect(screenError("screen_input_denied", "windows")).toBe((english as Record<string, string>)[SCREEN_ERROR_MESSAGES_WINDOWS.screen_input_denied!]);
});
