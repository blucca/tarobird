// A Windows computer as the controlled (target) platform (#48): its key table,
// shortcut buttons, modifier mapping and wheel amounts. Pure; nothing is posted.
import { expect, it } from "vitest";
import { SCREEN_CONTROL_WINDOWS_CAPABILITY, screenDesktopSchema, screenKeyCodeSchema } from "../src/client-protocol/remote-screen.js";
import {
  SCREEN_MAC_KEYCODES, SCREEN_SHORTCUTS, SCREEN_WINDOWS_EXTENDED, SCREEN_WINDOWS_SCANCODES, SCREEN_WINDOWS_SHORTCUTS, SCREEN_WINDOWS_WHEEL_MAX,
  screenControllerCode, screenIsModifier, screenModifierModeApplies, screenShortcutEvents, screenShortcuts, screenWheelToWindows,
} from "../src/client-protocol/screen-keys.js";

it("every key the protocol accepts has one Windows scan code, and no two keys share one", () => {
  expect(Object.keys(SCREEN_WINDOWS_SCANCODES).sort()).toEqual(Object.keys(SCREEN_MAC_KEYCODES).sort());
  const values = Object.values(SCREEN_WINDOWS_SCANCODES);
  expect(new Set(values).size).toBe(values.length);
  for (const [code, value] of Object.entries(SCREEN_WINDOWS_SCANCODES)) {
    expect(screenKeyCodeSchema.safeParse(code).success, code).toBe(true);
    // A descriptor is a Set 1 make code (1..0x7f) and at most the extended bit.
    expect(Number.isInteger(value) && (value & ~(SCREEN_WINDOWS_EXTENDED | 0x7f)) === 0 && (value & 0x7f) !== 0, code).toBe(true);
  }
});

it("keys that differ only by the E0 prefix are told apart, and Num Lock is the extended 0x45", () => {
  const E0 = SCREEN_WINDOWS_EXTENDED;
  expect(SCREEN_WINDOWS_SCANCODES).toMatchObject({
    KeyA: 0x1e, KeyQ: 0x10, KeyW: 0x11, KeyZ: 0x2c, Digit1: 0x02, Digit0: 0x0b, Enter: 0x1c, Escape: 0x01, Tab: 0x0f, Space: 0x39, Backspace: 0x0e,
    ControlLeft: 0x1d, ControlRight: E0 | 0x1d, AltLeft: 0x38, AltRight: E0 | 0x38, ShiftLeft: 0x2a, ShiftRight: 0x36, MetaLeft: E0 | 0x5b, MetaRight: E0 | 0x5c,
    ArrowLeft: E0 | 0x4b, Numpad4: 0x4b, Home: E0 | 0x47, Numpad7: 0x47, Delete: E0 | 0x53, NumpadDecimal: 0x53, Insert: E0 | 0x52, Numpad0: 0x52,
    NumpadEnter: E0 | 0x1c, NumpadDivide: E0 | 0x35, Slash: 0x35, F4: 0x3e, F11: 0x57, F12: 0x58, F13: 0x64, F19: 0x6a, IntlBackslash: 0x56,
    // Plain 0x45 is Pause; Chromium's public table and Chrome Remote Desktop inject Num Lock as E0 45.
    NumLock: E0 | 0x45,
  });
  expect(Object.values(SCREEN_WINDOWS_SCANCODES)).not.toContain(0x45);
});

it("the same eight keys are modifiers on both targets", () => {
  for (const code of Object.keys(SCREEN_WINDOWS_SCANCODES)) expect(screenIsModifier(code), code).toBe(/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code));
});

it("a Mac keyboard keeps its main shortcut modifier on a Windows target, a Windows keyboard is not remapped", () => {
  const codes = [...Object.keys(SCREEN_WINDOWS_SCANCODES), "Unidentified"];
  const swap: Record<string, string> = { ControlLeft: "MetaLeft", ControlRight: "MetaRight", MetaLeft: "ControlLeft", MetaRight: "ControlRight" };
  for (const code of codes) {
    expect(screenControllerCode(code, "mac", "command", "windows")).toBe(swap[code] ?? code);
    expect(screenControllerCode(code, "mac", "physical", "windows")).toBe(code);
    for (const mode of ["command", "physical"] as const) expect(screenControllerCode(code, "windows", mode, "windows")).toBe(code);
  }
  // ⌘C on the Mac keyboard is Ctrl+C on Windows; ⌃ is the Windows key.
  expect([screenControllerCode("MetaLeft", "mac", "command", "windows"), screenControllerCode("ControlLeft", "mac", "command", "windows")]).toEqual(["ControlLeft", "MetaLeft"]);
  expect([["mac", "macos"], ["windows", "windows"], ["mac", "windows"], ["windows", "macos"]].map(([controller, target]) => screenModifierModeApplies(controller as "mac", target as "macos")))
    .toEqual([false, false, true, true]);
  expect(screenModifierModeApplies("windows")).toBe(true);
  expect(() => screenModifierModeApplies("mac", "linux" as never)).toThrow("screen_target_platform_unknown");
});

it("Windows shortcut buttons use only keys that no keyboard layout moves", () => {
  // A button sends positions. Letters, digits and punctuation are positions whose
  // meaning the target's layout decides (the W position is Z on AZERTY), so a
  // button whose label names such a key would lie on some targets.
  const fixed = /^(Escape|Tab|Space|Enter|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Left|Right|Up|Down)|F\d{1,2}|(Control|Shift|Alt|Meta)(Left|Right))$/;
  expect(screenShortcuts("windows")).toBe(SCREEN_WINDOWS_SHORTCUTS);
  expect(SCREEN_WINDOWS_SHORTCUTS.map(shortcut => [shortcut.id, shortcut.codes.join("+")])).toEqual([
    ["escape", "Escape"], ["app-switcher", "AltLeft+Tab"], ["start-menu", "MetaLeft"], ["task-view", "MetaLeft+Tab"],
    ["input-source", "MetaLeft+Space"], ["close-window", "AltLeft+F4"], ["close-tab", "ControlLeft+F4"],
  ]);
  for (const shortcut of SCREEN_WINDOWS_SHORTCUTS) {
    for (const code of shortcut.codes) expect(fixed.test(code), `${shortcut.id}: ${code}`).toBe(true);
    expect(shortcut.label.zh && shortcut.label.en, shortcut.id).toBeTruthy();
    const events = screenShortcutEvents(shortcut.codes);
    expect(events.map(event => event.code)).toEqual([...shortcut.codes, ...[...shortcut.codes].reverse()]);
  }
  // Never the secure attention sequence, and nothing that only opens an elevated window.
  expect(SCREEN_WINDOWS_SHORTCUTS.some(shortcut => shortcut.codes.includes("Delete") || shortcut.id === "task-manager")).toBe(false);
  // The Mac list is a different list and stays as it was.
  expect(screenShortcuts("macos")).toBe(SCREEN_SHORTCUTS);
});

it("wheel pixels become Windows wheel amounts with the right sign on each axis", () => {
  // One notch is 120 units for the 100 px a Chromium page reports for it.
  expect(screenWheelToWindows(0, 100)).toMatchObject({ vertical: -120, horizontal: 0 });   // content down = wheel towards the user
  expect(screenWheelToWindows(0, -100)).toMatchObject({ vertical: 120, horizontal: 0 });
  expect(screenWheelToWindows(100, 0)).toMatchObject({ vertical: 0, horizontal: 120 });    // right is right
  expect(screenWheelToWindows(-50, 25)).toMatchObject({ vertical: -30, horizontal: -60 });
  expect(Object.is(screenWheelToWindows(0, 0).vertical, 0) && Object.is(screenWheelToWindows(0, 0).horizontal, 0)).toBe(true);
  expect(screenWheelToWindows(2000, -2000)).toMatchObject({ vertical: SCREEN_WINDOWS_WHEEL_MAX, horizontal: SCREEN_WINDOWS_WHEEL_MAX });
  expect(screenWheelToWindows(-2000, 2000)).toMatchObject({ vertical: -SCREEN_WINDOWS_WHEEL_MAX, horizontal: -SCREEN_WINDOWS_WHEEL_MAX });
});

it("slow scrolling is carried, not rounded away, and a turn back does not inherit the other direction", () => {
  // 0.5 px at a time is 0.6 units: alone it would always round to nothing.
  let carry: { vertical: number; horizontal: number } | undefined, total = 0;
  const sent: number[] = [];
  for (let step = 0; step < 10; step++) { const next = screenWheelToWindows(0, 0.5, carry); carry = next.carry; total += next.vertical; sent.push(next.vertical); }
  expect(total).toBe(-6);
  expect(sent.every(Number.isInteger) && sent.some(value => value === 0) && sent.some(value => value === -1)).toBe(true);
  expect(Math.abs(carry!.vertical)).toBeLessThan(1);
  // 0.9 units pending downwards; one small step up must not be cancelled by it.
  const down = screenWheelToWindows(0, 0.75);
  expect(down).toMatchObject({ vertical: 0 });
  expect(down.carry.vertical).toBeCloseTo(-0.9);
  const up = screenWheelToWindows(0, -1, down.carry);
  expect(up.vertical).toBe(1);
  expect(up.carry.vertical).toBeCloseTo(0.2);
  // The two axes carry separately.
  const both = screenWheelToWindows(0.5, 0, { vertical: -0.9, horizontal: 0.5 });
  expect(both).toMatchObject({ vertical: 0, horizontal: 1, carry: { vertical: -0.9, horizontal: 0.1 } });
});

it("the protocol names Windows as a platform and the Host capability a Windows target waits for", () => {
  expect(screenDesktopSchema.shape.platform.safeParse("windows").success).toBe(true);
  expect(SCREEN_CONTROL_WINDOWS_CAPABILITY).toBe("screen-windows-v1");
});
