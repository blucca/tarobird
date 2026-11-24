import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import {
  WORKBENCH_DESIGN_CAPABILITY,
  WORKBENCH_DESIGN_COMMENTS_CAPABILITY,
  WORKBENCH_DESIGN_HISTORY_CAPABILITY,
  WORKBENCH_DESIGN_OPEN_CAPABILITY,
  WORKBENCH_SLIDES_CAPABILITY,
  workbenchDesignError,
} from "../src/client-protocol/workbench-design.js";
import { workbenchDesignGuidance } from "../src/gateway/design-guidance.js";
import { buildDesignSandbox } from "../client/design-assets.js";

describe("Remove Baoyu Design canvas from Workbench (#89)", () => {
  it("rejects format:'canvas' and omitted format on design.create / design.open with design_canvas_removed", () => {
    expect(workbenchDesignError({ operation: "design.create", payload: { format: "canvas" } })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.create", payload: {} })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.open", payload: { format: "canvas" } })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.open", payload: {} })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.create", payload: { format: "slides", title: "Deck" } })).toBeUndefined();
    expect(workbenchDesignError({ operation: "design.open", payload: { format: "slides" } })).toBeUndefined();
  });

  it("no longer declares the canvas capability while keeping PPT/slides capabilities", () => {
    expect(CAPABILITIES).not.toContain(WORKBENCH_DESIGN_CAPABILITY);
    expect(SERVER_CAPABILITIES).not.toContain(WORKBENCH_DESIGN_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_SLIDES_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_OPEN_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_COMMENTS_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_HISTORY_CAPABILITY);
  });

  it("removes baoyu-design vendor and skill while keeping baoyu-slides and baoyu-ppt", () => {
    expect(existsSync(path.resolve("client/vendor/baoyu-design"))).toBe(false);
    expect(existsSync(path.resolve("skills/baoyu-design"))).toBe(false);
    expect(existsSync(path.resolve("client/vendor/baoyu-slides/UPSTREAM.json"))).toBe(true);
    expect(existsSync(path.resolve("skills/baoyu-ppt/SKILL.md"))).toBe(true);
  });

  it("builds only the slides sandbox and refuses canvas", () => {
    expect(() => buildDesignSandbox("canvas" as never)).toThrow(/design_canvas_removed/);
    const html = buildDesignSandbox("slides");
    expect(html).toContain("<title>PPT</title>");
  });

  it("updates Bot guidance to explain canvas removal and guide users to Infinite Canvas while keeping PPT", () => {
    expect(workbenchDesignGuidance).not.toContain("format:'canvas'");
    expect(workbenchDesignGuidance).not.toContain(".dc.html");
    expect(workbenchDesignGuidance).toContain("Infinite Canvas");
    expect(workbenchDesignGuidance).toContain("format:'slides'");
  });
});
