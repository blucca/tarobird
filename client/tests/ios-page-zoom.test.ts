import { describe, expect, it } from "vitest";
import { lockIosAppPageZoom, withoutPageZoom } from "../src/ios-page-zoom.js";

// index.html ships this viewport; only the iOS App caps it.
const shipped = "width=device-width,initial-scale=1,viewport-fit=cover";
function page(content: string) {
  const meta = { content };
  const root = { querySelector: (selector: string) => selector === 'meta[name="viewport"]' ? meta : null } as unknown as Pick<Document, "querySelector">;
  return { meta, root };
}

describe("iOS App page zoom", () => {
  it("caps the iOS App viewport at scale 1 and keeps every shipped setting", () => {
    const { meta, root } = page(shipped);
    lockIosAppPageZoom("ios", root);
    expect(meta.content).toBe(`${shipped},maximum-scale=1`);
    lockIosAppPageZoom("ios", root);
    expect(meta.content).toBe(`${shipped},maximum-scale=1`);
  });

  it("replaces an earlier scale limit instead of adding a second one", () => {
    expect(withoutPageZoom("width=device-width, maximum-scale=5, user-scalable=yes, initial-scale=1")).toBe("width=device-width,initial-scale=1,maximum-scale=1");
  });

  it("leaves Android, desktop and browser viewports unchanged", () => {
    for (const platform of ["android", "web"]) {
      const { meta, root } = page(shipped);
      lockIosAppPageZoom(platform, root);
      expect(meta.content).toBe(shipped);
    }
  });
});
