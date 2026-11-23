import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAcknowledgements, runCli } from "../scripts/acknowledgements.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("third-party acknowledgements manifest and build check", () => {
  it("loads all curated and bundled npm entries with non-empty license texts and passes check mode", () => {
    const built = buildAcknowledgements(REPO_ROOT);
    expect(built.curatedCount).toBeGreaterThanOrEqual(20);
    expect(built.npmCount).toBeGreaterThanOrEqual(40);
    expect(built.entries.length).toBe(built.curatedCount + built.npmCount);

    for (const entry of built.entries) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.license.trim().length).toBeGreaterThan(0);
      expect(entry.licenseText.trim().length).toBeGreaterThan(0);
    }

    // Coverage across all required categories: assets/fonts/icons, vendored, npm, android, ios.
    const categories = new Set(built.entries.map((entry) => entry.category));
    expect(categories).toEqual(new Set(["asset", "vendored", "npm", "android", "ios"]));

    // Trademark notices (model-brand icons & Pi mark) and generated check mode pass cleanly.
    const names = new Set(built.entries.map((entry) => entry.id));
    expect(names.has("lobehub-model-brand-icons")).toBe(true);
    expect(names.has("pi-mark")).toBe(true);
    expect(names.has("android-okhttp")).toBe(true);
    expect(names.has("ios-capacitor-swift-pm")).toBe(true);
    expect(names.has("npm:react")).toBe(true);

    expect(runCli(["check", "--root", REPO_ROOT])).toBe(0);
  });

  it("fails the build check when a referenced license text file is removed or emptied", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "ack-check-fail-"));
    try {
      // Minimal cloned repo structure to verify missing/empty license text failure.
      cpSync(path.join(REPO_ROOT, "third-party"), path.join(tmp, "third-party"), { recursive: true });
      cpSync(path.join(REPO_ROOT, "client", "public", "licenses"), path.join(tmp, "client", "public", "licenses"), { recursive: true });
      cpSync(path.join(REPO_ROOT, "client", "vendor"), path.join(tmp, "client", "vendor"), { recursive: true });
      cpSync(path.join(REPO_ROOT, "assets", "product", "fonts"), path.join(tmp, "assets", "product", "fonts"), { recursive: true });
      cpSync(path.join(REPO_ROOT, "deepseek-harness-plugin", "LICENSE"), path.join(tmp, "deepseek-harness-plugin", "LICENSE"));
      cpSync(path.join(REPO_ROOT, "LICENSING.md"), path.join(tmp, "LICENSING.md"));
      cpSync(path.join(REPO_ROOT, "package.json"), path.join(tmp, "package.json"));
      cpSync(path.join(REPO_ROOT, "client", "package.json"), path.join(tmp, "client", "package.json"));
      symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(tmp, "node_modules"));
      symlinkSync(path.join(REPO_ROOT, "client", "node_modules"), path.join(tmp, "client", "node_modules"));

      // Baseline passes in the isolated copy.
      expect(runCli(["check", "--root", tmp])).toBe(0);

      // Removing a license text file makes the check throw / fail.
      const piLicense = path.join(tmp, "third-party", "licenses", "pi-mark.txt");
      const originalText = readFileSync(piLicense, "utf8");
      unlinkSync(piLicense);
      expect(() => runCli(["check", "--root", tmp])).toThrow(/Missing file for pi-mark\.licenseFile/);

      // Writing an empty license file also makes the check throw / fail.
      writeFileSync(piLicense, "   \n", "utf8");
      expect(() => runCli(["check", "--root", tmp])).toThrow(/Empty license\/notice text for pi-mark\.licenseFile/);

      // Restoring the license text restores a clean check.
      writeFileSync(piLicense, originalText, "utf8");
      expect(runCli(["check", "--root", tmp])).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
