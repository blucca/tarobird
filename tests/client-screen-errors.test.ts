// The shared remote screen reason table (#48/#49 P1). `check-translations`
// only sees literal t("…") calls, so this keeps every table entry translated.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import english from "../client/src/locales/en.json" with { type: "json" };
import { setLocale } from "../client/src/i18n.js";
import { SCREEN_ERROR_MESSAGES, SCREEN_ERROR_MESSAGES_UNKNOWN_TARGET, SCREEN_ERROR_MESSAGES_WINDOWS, isScreenReasonCode, screenError } from "../client/src/screen-errors.js";

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

it("client or platform error text is never shown; an ordinary disconnect is only the localized sentence", () => {
  // The iPhone showed "… (The request was aborted.)" when the Host dropped (F-49-4).
  for (const raw of ["The request was aborted.", "连接恢复后即可操作", "Failed to fetch", "Load failed", "请求失败", "screen locked", "Screen_locked", ""]) {
    expect(isScreenReasonCode(raw), raw).toBe(false);
    expect(screenError(raw), raw).toBe("屏幕连接已结束，请检查主机状态后重试。");
  }
  for (const code of ["screen_new_reason", "session_expired", "x".repeat(200)]) expect(isScreenReasonCode(code), code).toBe(true);
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  expect(screenError("The request was aborted.")).toBe((english as Record<string, string>)["屏幕连接已结束，请检查主机状态后重试。"]);
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
  // iOS native's malformed-command codes read as a protocol mismatch, never as the target's Accessibility refusal.
  for (const code of ["screen_command_invalid", "screen_scope_invalid"]) { expect(screenError(code)).toBe(screenError("screen_protocol_invalid")); expect(screenError(code)).not.toBe(screenError("screen_input_denied")); }
  // Refused input is explained without claiming which of the possible causes it was.
  expect(screenError("screen_input_denied", "windows")).toBe("目标电脑没有接受远程输入，控制已停止。以管理员身份运行的窗口和安全提示不能被远程控制。");
  // A reason that names no target reads the same for both.
  expect(screenError("screen_geometry_changed", "windows")).toBe(screenError("screen_geometry_changed"));
  expect(screenError("screen_new_reason", "windows")).toBe(screenError("screen_new_reason"));
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  expect(screenError("screen_input_denied", "windows")).toBe((english as Record<string, string>)[SCREEN_ERROR_MESSAGES_WINDOWS.screen_input_denied!]);
});

it("every terminal reason a Host, mobile native session or viewer can end a connection with has its own sentence", () => {
  // Mobile sessions keep the Host's validated close reason (#49), so a reason
  // without an entry would show the generic sentence with a raw code.
  const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const sources: Array<[string, RegExp]> = [
    ["src/hub/remote-screen.ts", /(?:closeSession|serviceLost)\([^,()]+,\s*"([a-z_]+)"/g],
    // A lease release shows its reason in the viewer state, except the two the Host hides.
    ["src/hub/remote-screen.ts", /release\(live,\s*"((?!screen_control_stopped"|screen_stream_changed")screen_[a-z_]+)"/g],
    ["src/hub/remote-screen-sockets.ts", /stop\((?:reason = )?"(screen_[a-z_]+)"/g],
    ["client/android/app/src/main/java/com/tarobot/client/HubScreenSession.java", /close\("(screen_[a-z_]+)"\)/g],
    ["client/ios/App/App/HubScreenSession.swift", /(?:fail|HubNetworkError)\("(screen_[a-z_]+)"\)/g],
    ["client/src/remote-screen-viewer.ts", /(?:new Error|this\.fail)\("(screen_[a-z_]+)"\)/g],
  ];
  // The target service's stop and lease-denied events are enumerated, not literal calls.
  const protocol = read("src/client-protocol/remote-screen.ts");
  for (const type of ["stop", "lease-denied"]) {
    const line = protocol.split("\n").find(value => value.includes(`type: z.literal("${type}")`) && value.includes("reason: z.enum("));
    expect(line, type).toBeTruthy();
    const listed = [...line!.matchAll(/"(screen_[a-z_]+)"/g)].map(match => match[1]!);
    expect(listed.length, type).toBeGreaterThan(0);
    for (const reason of listed) expect(SCREEN_ERROR_MESSAGES[reason], `${type}: ${reason}`).toBeTruthy();
  }
  const missing: string[] = [];
  for (const [file, pattern] of sources) {
    const reasons = [...read(file).matchAll(pattern)].map(match => match[1]!);
    expect(reasons.length, file).toBeGreaterThan(0);
    for (const reason of reasons) if (!SCREEN_ERROR_MESSAGES[reason]) missing.push(`${file}: ${reason}`);
  }
  expect([...new Set(missing)]).toEqual([]);
  // The Android close path accepts only the bounded Host form; its fallback is covered too.
  expect(SCREEN_ERROR_MESSAGES.screen_network_closed).toBeTruthy();
  expect(screenError("screen_permission_revoked", "windows")).toBe(screenError("screen_permission_revoked"));
  expect(screenError("screen_attach_timeout", "windows")).toBe(screenError("screen_connect_timeout", "windows"));
  expect(screenError("screen_socket_timeout")).toBe(screenError("screen_network_timeout"));
});

it("when the target's platform is unknown, no sentence assumes a Mac or a Windows-only cause", () => {
  // The Host withholds desktop metadata, or none was ever read for this Host.
  const dictionary = english as Record<string, string>;
  for (const [reason, message] of Object.entries(SCREEN_ERROR_MESSAGES_UNKNOWN_TARGET)) { expect(SCREEN_ERROR_MESSAGES[reason], reason).toBeTruthy(); expect(dictionary[message]?.trim(), reason).toBeTruthy(); }
  const mac = /Mac|辅助功能|输入监控|录制屏幕/, macEnglish = /Mac|Accessibility|Input Monitoring|Screen Recording/;
  const windowsOnly = /管理员|安全提示|Windows/, windowsEnglish = /administrator|security prompt|Windows/i;
  for (const reason of Object.keys(SCREEN_ERROR_MESSAGES)) {
    const text = screenError(reason, "unknown");
    expect(mac.test(text) || windowsOnly.test(text), `${reason}: ${text}`).toBe(false);
  }
  vi.stubGlobal("document", { documentElement: { lang: "zh-CN" } });
  setLocale("en");
  for (const reason of Object.keys(SCREEN_ERROR_MESSAGES)) {
    const text = screenError(reason, "unknown");
    expect(text.startsWith(dictionary["屏幕连接已结束，请检查主机状态后重试。"]!), reason).toBe(false);
    expect(macEnglish.test(text) || windowsEnglish.test(text), `${reason}: ${text}`).toBe(false);
  }
  // A known platform keeps its own sentences.
  setLocale("zh");
  expect(screenError("screen_locked", "macos")).toBe(SCREEN_ERROR_MESSAGES.screen_locked);
  expect(screenError("screen_input_denied", "windows")).toBe(SCREEN_ERROR_MESSAGES_WINDOWS.screen_input_denied);
});
