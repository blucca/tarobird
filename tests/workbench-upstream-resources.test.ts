import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Workbench editor and authoring resource provenance", () => {
  it("baoyu-design carries the exact references for its bundled canvas editor", () => {
    const vendor = join("client/vendor", "baoyu-design"), adapted = join("skills", "baoyu-design");
    const editorPin = JSON.parse(readFileSync(join(vendor, "UPSTREAM.json"), "utf8"));
    const skillPin = JSON.parse(readFileSync(join(adapted, "UPSTREAM.json"), "utf8"));
    for (const key of ["repository", "commit", "version", "component"]) expect(skillPin[key]).toBe(editorPin[key]);
    const references = readdirSync(join(adapted, "references")).sort();
    expect(references).toEqual(readdirSync(join(vendor, "reference")).sort());
    for (const name of references) {
      const bytes = readFileSync(join(adapted, "references", name));
      expect(bytes).toEqual(readFileSync(join(vendor, "reference", name)));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(skillPin.upstreamFiles[`artifact-type/reference/${name}`]);
      expect(digest).toBe(editorPin.files[`reference/${name}`]);
    }
    for (const name of ["LICENSE", "NOTICE.md"]) expect(readFileSync(join(adapted, name))).toEqual(readFileSync(join(vendor, name)));
    expect(skillPin.upstreamFiles["scripts/artifact.mjs"]).toMatch(/^[a-f0-9]{64}$/);
    expect(skillPin.upstreamFiles["scripts/server.mjs"]).toMatch(/^[a-f0-9]{64}$/);
    expect(readdirSync(adapted)).not.toContain("scripts");
  });

  it("workbench-slides pins Apache-2.0 Open Artifact slides editor with intact LICENSE, NOTICE and file hashes", () => {
    expect(existsSync("client/vendor/baoyu-slides")).toBe(false);
    expect(existsSync("skills/baoyu-ppt")).toBe(false);
    const vendor = join("client/vendor", "workbench-slides");
    const pin = JSON.parse(readFileSync(join(vendor, "UPSTREAM.json"), "utf8"));
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.repository).toBe("https://github.com/JimLiu/open-artifact");
    expect(pin.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(readFileSync(join(vendor, "LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(vendor, "NOTICE"), "utf8")).toContain("Apache License, Version 2.0");
    for (const [name, expected] of Object.entries<string>(pin.files)) {
      const digest = createHash("sha256").update(readFileSync(join(vendor, name))).digest("hex");
      expect(digest).toBe(expected);
    }
  });
});
