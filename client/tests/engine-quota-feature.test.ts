import { describe, expect, it } from "vitest";
import { ENGINE_QUOTA_UI, engineQuotaPageVisible, startingSettingsSection } from "../src/engine-quota-feature.js";

describe("model quota settings", () => {
  it("is part of an ordinary build, for the owner only", () => {
    expect(import.meta.env.VITE_TAROBIRD_ENGINE_QUOTA_UI).toBeUndefined();
    expect(ENGINE_QUOTA_UI).toBe(true);
    expect(engineQuotaPageVisible("owner")).toBe(true);
    expect(engineQuotaPageVisible("member")).toBe(false);
    expect(engineQuotaPageVisible(undefined)).toBe(false);
    expect(startingSettingsSection("quota")).toBe("quota");
  });

  it("a build without it sends a request for the quota category to the default one", () => {
    expect(engineQuotaPageVisible("owner", false)).toBe(false);
    expect(startingSettingsSection("quota", false)).toBe("general");
    expect(startingSettingsSection("devices", false)).toBe("devices");
    expect(startingSettingsSection("general", false)).toBe("general");
  });
});
