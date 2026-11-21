/**
 * Settings › Model quotas is hidden until it is useful (owner request,
 * 2026-11-21): no navigation entry, no mounted page and no quota list read.
 * Build with `VITE_TAROBIRD_ENGINE_QUOTA_UI=1` to show it again. The Host API
 * and `tarobird engines quota` are unaffected by this switch.
 */
export const ENGINE_QUOTA_UI: boolean = import.meta.env.VITE_TAROBIRD_ENGINE_QUOTA_UI === "1";

/** Whether this user may see the quota page in this build. */
export const engineQuotaPageVisible = (role: string | undefined, enabled = ENGINE_QUOTA_UI) => enabled && role === "owner";

/** The category settings open on: a request for the hidden quota page lands on the default one. */
export const startingSettingsSection = <T extends string>(section: T, enabled = ENGINE_QUOTA_UI): T | "general" => section === "quota" && !enabled ? "general" : section;
