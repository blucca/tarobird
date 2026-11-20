import { t } from "./i18n.js";
import { pairingRemaining } from "./pairing-time.js";
import type { ResetStep } from "./local-reset.js";
import type { Identity } from "./storage.js";

/** A saved connection whose pairing the Host has not approved yet is never a
 * paired host. `unconfirmed`: the request's receipt was lost and is rechecked. */
export type PairingState = "waiting" | "expired" | "unconfirmed";
export function pairingState(identity: Pick<Identity, "pendingPairing"> | undefined, now = Date.now()): PairingState | undefined {
  const pending = identity?.pendingPairing;
  if (!pending) return undefined;
  if (!pending.code) return "unconfirmed";
  return pairingRemaining(pending.expiresAt, now, pending.serverTimeOffset) > 0 ? "waiting" : "expired";
}
export function pairingStateLabel(state: PairingState): string {
  return state === "waiting" ? t("待批准") : state === "expired" ? t("配对已过期") : t("待确认");
}
/** Removing one host stops at the failed local cleanup step; the step names
 * are the device reset's. Raw native codes (e.g. share_app_group_unavailable)
 * are not shown. Unlike a device reset, reopening does not resume it. */
export function hostCleanupError(step: ResetStep): string {
  const name = step === "shared" ? t("共享文件") : step === "push" ? t("推送注册") : step === "browser" ? t("网页登录数据") : step === "key" ? t("设备密钥") : t("本地缓存");
  return t("未能清理{0}。旧连接已停止，请重试清理。", name);
}
