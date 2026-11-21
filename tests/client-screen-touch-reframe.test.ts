import { describe, expect, it } from "vitest";
import { ScreenTouch, type ScreenTransform, type ScreenViewport } from "../client/src/screen-touch.js";

// A landscape phone's system keyboard only shortens the picture area. reframe()
// keeps what the person sees (scale and place) and what a tap there hits.
const image = { imageWidth: 1280, imageHeight: 720 };
const area = (width: number, height: number): ScreenViewport => ({ width, height, ...image });
function touch(viewport: ScreenViewport) {
  const changes: ScreenTransform[] = [], value = new ScreenTouch(viewport, () => {}, transform => changes.push(transform));
  value.resize(viewport); return { value, changes };
}
/** The picture's on-screen rectangle inside the area. */
function shown(touch: ScreenTouch, viewport: ScreenViewport) {
  const { width, height } = touch.dimensions, { zoom, x, y } = touch.transform;
  return { left: (viewport.width - width * zoom) / 2 + x, top: (viewport.height - height * zoom) / 2 + y, width: width * zoom, height: height * zoom };
}

describe("ScreenTouch.reframe", () => {
  it("keeps the picture's size, place and tap targets when the keyboard shortens the area, then fits again", () => {
    const full = area(678, 328), short = area(678, 169), { value } = touch(full);
    const before = shown(value, full), tap = { x: 300, y: 120 }, target = value.point(tap);
    value.reframe(short);
    const during = shown(value, short);
    for (const key of ["left", "top", "width", "height"] as const) expect(during[key]).toBeCloseTo(before[key], 6);
    expect(value.transform.zoom).toBeGreaterThan(1);
    expect(value.point(tap)).toEqual(target);
    value.reframe(full);
    expect(value.transform).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it("keeps a zoomed and panned view within the zoom limit", () => {
    const full = area(678, 328), short = area(678, 169), { value } = touch(full);
    // Pinch to 3× around the upper-left quarter (the public gesture path).
    value.down(1, { x: 150, y: 100 }, 0); value.down(2, { x: 250, y: 100 }, 0);
    value.move(1, { x: 50, y: 100 }); value.move(2, { x: 350, y: 100 }); value.flush(); value.up(1); value.up(2);
    expect(value.transform.zoom).toBeCloseTo(3, 6);
    value.reframe(short);
    // 3 × (328 / 169) exceeds the 4× limit: the scale stops there and the
    // picture still covers the whole area (pan stays within its limits).
    expect(value.transform.zoom).toBe(4);
    const pan = shown(value, short);
    expect(pan.left).toBeLessThanOrEqual(0); expect(pan.top).toBeLessThanOrEqual(0);
    expect(pan.left + pan.width).toBeGreaterThanOrEqual(short.width); expect(pan.top + pan.height).toBeGreaterThanOrEqual(short.height);
  });

  it("refits like resize() for any other change", () => {
    for (const next of [area(500, 328), { ...area(678, 169), imageWidth: 1280, imageHeight: 800 }]) {
      const { value } = touch(area(678, 328));
      value.down(1, { x: 150, y: 100 }, 0); value.down(2, { x: 250, y: 100 }, 0); value.move(1, { x: 50, y: 100 }); value.move(2, { x: 350, y: 100 }); value.flush(); value.up(1); value.up(2);
      value.reframe(next);
      expect(value.transform).toEqual({ zoom: 1, x: 0, y: 0 });
      expect(value.dimensions.width).toBeCloseTo(Math.min(next.width / next.imageWidth, next.height / next.imageHeight) * next.imageWidth, 6);
    }
  });

  it("falls back to a fit for an empty area", () => {
    const { value } = touch(area(678, 328));
    value.reframe(area(678, 0)); value.reframe(area(678, 328));
    expect(value.transform).toEqual({ zoom: 1, x: 0, y: 0 });
  });
});
