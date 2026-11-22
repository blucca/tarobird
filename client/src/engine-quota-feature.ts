/**
 * Settings › Model quotas. Hidden on 2026-11-21 until it was useful; shown again on the owner's word on
 * 2026-11-22, when Claude Code, Codex and Antigravity could be read (Kimi, DeepSeek and Pi are listed as not
 * supported yet). Build with `VITE_TAROBIRD_ENGINE_QUOTA_UI=0` for a client without the entry, the page and
 * its quota list read. The Host API and `tarobird engines quota` are unaffected by this switch.
 */
export const ENGINE_QUOTA_UI: boolean = import.meta.env.VITE_TAROBIRD_ENGINE_QUOTA_UI !== "0";

/** Whether this user may see the quota page in this build. */
export const engineQuotaPageVisible = (role: string | undefined, enabled = ENGINE_QUOTA_UI) => enabled && role === "owner";

/** The category settings open on: a request for the hidden quota page lands on the default one. */
export const startingSettingsSection = <T extends string>(section: T, enabled = ENGINE_QUOTA_UI): T | "general" => section === "quota" && !enabled ? "general" : section;
