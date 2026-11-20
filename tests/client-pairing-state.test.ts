import { expect, it } from "vitest";
import { hostCleanupError, pairingState, pairingStateLabel } from "../client/src/pairing-state.js";

it("an unanswered pairing is waiting, expired or unconfirmed, never paired", () => {
  const now = 1_000_000;
  expect(pairingState(undefined, now)).toBeUndefined();
  expect(pairingState({}, now)).toBeUndefined();
  expect(pairingState({ pendingPairing: { code: "", expiresAt: 0 } }, now)).toBe("unconfirmed");
  expect(pairingState({ pendingPairing: { code: "12345678", expiresAt: now + 60_000 } }, now)).toBe("waiting");
  expect(pairingState({ pendingPairing: { code: "12345678", expiresAt: now } }, now)).toBe("expired");
  // The Host's clock decides, as on the waiting page.
  expect(pairingState({ pendingPairing: { code: "12345678", expiresAt: now + 30_000, serverTimeOffset: 60_000 } }, now)).toBe("expired");
  expect([pairingStateLabel("waiting"), pairingStateLabel("expired"), pairingStateLabel("unconfirmed")]).toEqual(["待批准", "配对已过期", "待确认"]);
});

it("a failed host cleanup names the step and never shows a raw native code", () => {
  expect(hostCleanupError("shared")).toBe("未能清理共享文件。旧连接已停止，请重试清理。");
  for (const step of ["shared", "push", "browser", "key", "cache"] as const) expect(hostCleanupError(step)).not.toMatch(/[a-z]+_[a-z_]+/);
});
