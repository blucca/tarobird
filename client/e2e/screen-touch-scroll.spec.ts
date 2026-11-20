import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { ScreenTouch } from "../src/screen-touch.js";
import type { ScreenInputEvent } from "../../src/client-protocol/remote-screen.js";

// A controlled QA page stands in for the remote desktop (1280 × 720, two
// independently scrollable areas). The phone gesture is the production
// ScreenTouch; its events are replayed onto the page as browser mouse input
// (no desktop injection). The cursor follows only moves and buttons, as on a
// Mac where an injected scroll does not move the pointer, and the takeover
// rule mirrors client/electron/screen-service.mjs #watchTakeover.
test.use({ viewport: { width: 1280, height: 720 } });
const PHONE = { width: 400, height: 225, imageWidth: 1280, imageHeight: 720 };
const TAKEOVER_POINTS = 12;
const qaPage = `<!doctype html><style>body{margin:0}section{position:absolute;left:0;width:1280px;height:360px;overflow:auto}#a{top:0;background:#eef}#b{top:360px;background:#efe}div{height:3000px}</style>
<section id=a><div>A</div></section><section id=b><div>B</div></section>`;

class Remote {
  cursor = { x: 0, y: 0 }; expected?: { x: number; y: number }; events: string[] = [];
  constructor(private cdp: CDPSession) {}
  static async open(page: Page) { await page.setContent(qaPage); return new Remote(await page.context().newCDPSession(page)); }
  async apply(event: ScreenInputEvent) {
    if (event.kind !== "move" && event.kind !== "wheel" && event.kind !== "button") return;
    const x = event.x * 1280, y = event.y * 720; this.expected = { x, y };
    this.events.push(`${event.kind}@${Math.round(x)},${Math.round(y)}`);
    if (event.kind === "wheel") { await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: event.dx * 3.2, deltaY: event.dy * 3.2 }); return; }
    this.cursor = { x, y };
    await this.cdp.send("Input.dispatchMouseEvent", event.kind === "move" ? { type: "mouseMoved", x, y }
      : { type: event.down ? "mousePressed" : "mouseReleased", x, y, button: event.button === 2 ? "right" : "left", clickCount: event.clicks });
  }
  /** After ≥300 ms without input: would the controlled side call this a local takeover? */
  takeover() { return !!this.expected && Math.hypot(this.cursor.x - this.expected.x, this.cursor.y - this.expected.y) > TAKEOVER_POINTS; }
}
async function scrolls(page: Page) { await page.waitForTimeout(400); return page.evaluate(() => ({ a: document.getElementById("a")!.scrollTop, b: document.getElementById("b")!.scrollTop })); }
function phone(control = true) {
  const events: ScreenInputEvent[] = [];
  const touch = new ScreenTouch(PHONE, event => events.push(event), () => {}); touch.setControl(control);
  return { touch, events };
}
/** Two parallel fingers from `start` (viewer CSS px), moved by `step` per frame. */
function twoFingers(touch: ScreenTouch, start: { x: number; y: number }, step: { x: number; y: number }, frames: number) {
  touch.down(1, { x: start.x - 20, y: start.y }, 0); touch.down(2, { x: start.x + 20, y: start.y }, 0);
  for (let n = 1; n <= frames; n++) { touch.move(1, { x: start.x - 20 + step.x * n, y: start.y + step.y * n }); touch.move(2, { x: start.x + 20 + step.x * n, y: start.y + step.y * n }); touch.flush(); }
}
async function replay(remote: Remote, events: ScreenInputEvent[]) { for (const event of events.splice(0)) await remote.apply(event); }

test("a two-finger scroll scrolls the area where it began and leaves the cursor where it scrolls", async ({ page }) => {
  const remote = await Remote.open(page), { touch, events } = phone();
  // Tap first, as on the iPhone: the remote cursor rests at the picture centre.
  touch.down(1, { x: 200, y: 112.5 }, 0); touch.up(1); await replay(remote, events);
  expect(remote.takeover()).toBe(false);
  // Fingers land low in area B (y≈455 remote) and travel 150 CSS px up over area A.
  twoFingers(touch, { x: 200, y: 160 }, { x: 0, y: -10 }, 15); touch.up(1); touch.up(2);
  const wheels = events.filter(event => event.kind === "wheel");
  expect.soft(new Set(wheels.map(event => `${event.x},${event.y}`)).size, "one fixed scroll position").toBe(1);
  await replay(remote, events);
  const after = await scrolls(page);
  expect.soft(after.a, "the area the fingers crossed is untouched").toBe(0);
  expect.soft(after.b, "the area where the gesture began scrolls").toBeGreaterThan(300);
  expect.soft(remote.takeover(), "the phone's own scroll is not a local takeover").toBe(false);
  // The person at the computer moving the mouse is still a takeover.
  remote.cursor = { x: remote.cursor.x + 40, y: remote.cursor.y }; expect(remote.takeover()).toBe(true);
});

test("each area scrolls in both directions from its own start and the letterbox scrolls nothing", async ({ page }) => {
  const remote = await Remote.open(page), { touch, events } = phone();
  twoFingers(touch, { x: 200, y: 40 }, { x: 0, y: -8 }, 10); touch.up(1); touch.up(2); await replay(remote, events);
  const down = await scrolls(page); expect(down.a).toBeGreaterThan(200); expect(down.b).toBe(0);
  twoFingers(touch, { x: 200, y: 40 }, { x: 0, y: 8 }, 5); touch.up(1); touch.up(2); await replay(remote, events);
  const back = await scrolls(page); expect(back.a).toBeLessThan(down.a); expect(back.b).toBe(0);
  // A 16:9 picture in a square viewer leaves margins; a gesture starting there sends nothing.
  const square = new ScreenTouch({ width: 400, height: 400, imageWidth: 1280, imageHeight: 720 }, event => events.push(event), () => {}); square.setControl(true);
  twoFingers(square, { x: 200, y: 30 }, { x: 0, y: 10 }, 10); square.up(1); square.up(2);
  expect(events).toEqual([]);
});

test("pinch zoom stays local and a later scroll maps its start through the zoom", async ({ page }) => {
  const remote = await Remote.open(page), { touch, events } = phone();
  touch.down(1, { x: 150, y: 112.5 }, 0); touch.down(2, { x: 250, y: 112.5 }, 0);
  touch.move(1, { x: 50, y: 112.5 }); touch.move(2, { x: 350, y: 112.5 }); touch.flush(); touch.up(1); touch.up(2);
  expect(events, "pinch sends nothing").toEqual([]); expect(touch.transform.zoom).toBeGreaterThan(2);
  const start = { x: 200, y: 150 }, origin = touch.point(start)!;
  twoFingers(touch, start, { x: 0, y: -10 }, 6); touch.up(1); touch.up(2);
  expect(events[0]).toEqual({ kind: "move", ...origin });
  expect(events.slice(1).every(event => event.kind === "wheel" && event.x === origin.x && event.y === origin.y)).toBe(true);
  await replay(remote, events); const after = await scrolls(page);
  expect(origin.y * 720 > 360 ? after.b : after.a).toBeGreaterThan(0); expect(origin.y * 720 > 360 ? after.a : after.b).toBe(0);
  expect(remote.takeover()).toBe(false);
});

test("pan, cancel, control loss and a third finger end the gesture without stray input", async ({ page }) => {
  const remote = await Remote.open(page);
  // Viewing: one-finger pan and two-finger pinch only move the local picture.
  const view = phone(false);
  view.touch.down(1, { x: 200, y: 100 }, 0); view.touch.move(1, { x: 260, y: 100 }); view.touch.up(1);
  twoFingers(view.touch, { x: 200, y: 160 }, { x: 0, y: -10 }, 5); view.touch.up(1); view.touch.up(2);
  expect(view.events).toEqual([]);
  // Controlling: cancel mid-scroll stops the wheel; later finger movement sends nothing.
  for (const end of ["cancel", "control loss", "third finger"] as const) {
    const { touch, events } = phone();
    twoFingers(touch, { x: 200, y: 160 }, { x: 0, y: -10 }, 4); const sent = events.length;
    expect(events.filter(event => event.kind === "move")).toHaveLength(1);
    if (end === "cancel") touch.cancel(); else if (end === "control loss") touch.setControl(false); else touch.down(3, { x: 100, y: 100 }, 0);
    touch.move(1, { x: 180, y: 50 }); touch.move(2, { x: 220, y: 50 }); touch.flush(); touch.up(1); touch.up(2); touch.up(3);
    expect(events.length, end).toBe(sent);
    await replay(remote, events);
  }
  expect(remote.takeover()).toBe(false);
});
