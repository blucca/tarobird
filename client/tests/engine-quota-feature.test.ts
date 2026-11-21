import { describe, expect, it } from "vitest";
import { ENGINE_QUOTA_UI, engineQuotaPageVisible, startingSettingsSection } from "../src/engine-quota-feature.js";

describe("hidden model quota settings", () => {
  it("is off unless the build opts in", () => {
    expect(import.meta.env.VITE_TAROBIRD_ENGINE_QUOTA_UI).toBeUndefined();
    expect(ENGINE_QUOTA_UI).toBe(false);
    expect(engineQuotaPageVisible("owner")).toBe(false);
  });

  it("a request for the quota category opens the default category instead", () => {
    expect(startingSettingsSection("quota")).toBe("general");
    expect(startingSettingsSection("devices")).toBe("devices");
    expect(startingSettingsSection("general")).toBe("general");
  });

  it("an opted-in build still shows it to the owner only", () => {
    expect(engineQuotaPageVisible("owner", true)).toBe(true);
    expect(engineQuotaPageVisible("member", true)).toBe(false);
    expect(engineQuotaPageVisible(undefined, true)).toBe(false);
    expect(startingSettingsSection("quota", true)).toBe("quota");
  });
});
