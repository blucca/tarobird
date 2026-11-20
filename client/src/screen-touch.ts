import type { ScreenInputEvent } from "../../src/client-protocol/remote-screen.js";

export const SCREEN_TOUCH_SLOP = 8, SCREEN_TOUCH_HOLD_MS = 550, SCREEN_TOUCH_MAX_ZOOM = 4;
export type ScreenPoint = { x: number; y: number };
export type ScreenTransform = { zoom: number; x: number; y: number };
export type ScreenViewport = { width: number; height: number; imageWidth: number; imageHeight: number };
type Finger = { start: ScreenPoint; point: ScreenPoint; at: number };
const distance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: ScreenPoint, b: ScreenPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

/** Pure touch arbitration. Pointer positions are viewport-local CSS pixels.
 * Pair movement is flushed once per animation frame so two parallel fingers
 * are considered together, rather than mistaking their first event for pinch. */
export class ScreenTouch {
  transform: ScreenTransform = { zoom: 1, x: 0, y: 0 };
  private fingers = new Map<number, Finger>();
  private mode: "idle" | "candidate" | "drag" | "pan" | "pair" | "pinch" | "scroll" | "consumed" = "idle";
  private control = false;
  private pair?: { center: ScreenPoint; distance: number; previous: ScreenPoint; transform: ScreenTransform };
  private dragPoint?: ScreenPoint;
  private lastTap?: { point: ScreenPoint; at: number; clicks: 1 | 2 | 3 };
  private initial: ScreenTransform = this.transform;
  constructor(private viewport: ScreenViewport, private emit: (event: ScreenInputEvent) => void, private changed: (transform: ScreenTransform) => void) {}
  get dimensions() {
    const factor = Math.min(this.viewport.width / this.viewport.imageWidth, this.viewport.height / this.viewport.imageHeight);
    return { width: this.viewport.imageWidth * factor, height: this.viewport.imageHeight * factor };
  }
  hasPointer(id: number) { return this.fingers.has(id); }
  setControl(value: boolean) { if (value !== this.control) this.cancel(); this.control = value; }
  resize(viewport: ScreenViewport) { this.cancel(); this.viewport = viewport; this.fit(); }
  fit() { this.cancel(); this.update({ zoom: 1, x: 0, y: 0 }); }
  private update(transform: ScreenTransform) {
    const { width, height } = this.dimensions, zoom = clamp(transform.zoom, 1, SCREEN_TOUCH_MAX_ZOOM);
    const x = Math.max(0, (width * zoom - this.viewport.width) / 2), y = Math.max(0, (height * zoom - this.viewport.height) / 2);
    this.transform = { zoom, x: clamp(transform.x, -x, x), y: clamp(transform.y, -y, y) }; this.changed(this.transform);
  }
  point(value: ScreenPoint, edge = false): ScreenPoint | undefined {
    const { width, height } = this.dimensions, { zoom, x, y } = this.transform;
    const px = (value.x - (this.viewport.width - width * zoom) / 2 - x) / (width * zoom), py = (value.y - (this.viewport.height - height * zoom) / 2 - y) / (height * zoom);
    if (!Number.isFinite(px + py) || !edge && (px < 0 || py < 0 || px > 1 || py > 1)) return;
    return { x: clamp(px, 0, 1), y: clamp(py, 0, 1) };
  }
  private button(point: ScreenPoint, button: 0 | 2, down: boolean, clicks: 1 | 2 | 3 = 1) { this.emit({ kind: "button", ...point, button, down, clicks }); }
  private releaseDrag() { if (this.mode === "drag" && this.dragPoint) this.button(this.dragPoint, 0, false); this.dragPoint = undefined; }
  down(id: number, point: ScreenPoint, at: number) {
    if (this.fingers.has(id)) return;
    this.fingers.set(id, { start: point, point, at });
    if (this.fingers.size === 1) { this.mode = "candidate"; this.initial = this.transform; }
    else if (this.fingers.size === 2) {
      this.lastTap = undefined; this.releaseDrag(); const [a, b] = [...this.fingers.values()].map(value => value.point);
      this.pair = { center: middle(a!, b!), previous: middle(a!, b!), distance: Math.max(1, distance(a!, b!)), transform: this.transform }; this.mode = "pair";
    } else { this.releaseDrag(); this.mode = "consumed"; }
  }
  move(id: number, point: ScreenPoint) {
    const finger = this.fingers.get(id); if (!finger) return; finger.point = point;
    if (this.fingers.size !== 1 || ["consumed", "pair", "pinch", "scroll"].includes(this.mode)) return;
    if (this.mode === "candidate" && distance(point, finger.start) > SCREEN_TOUCH_SLOP) {
      this.lastTap = undefined;
      if (this.control) {
        const origin = this.point(finger.start); if (!origin) { this.mode = "consumed"; return; }
        this.mode = "drag"; this.dragPoint = origin; this.button(origin, 0, true);
      } else this.mode = "pan";
    }
    if (this.mode === "drag") { const mapped = this.point(point, true); if (mapped) { this.dragPoint = mapped; this.emit({ kind: "move", ...mapped }); } }
    if (this.mode === "pan") this.update({ ...this.initial, x: this.initial.x + point.x - finger.start.x, y: this.initial.y + point.y - finger.start.y });
  }
  flush() {
    if (this.fingers.size !== 2 || !this.pair || !["pair", "pinch", "scroll"].includes(this.mode)) return;
    const [a, b] = [...this.fingers.values()].map(value => value.point), center = middle(a!, b!), span = distance(a!, b!), pair = this.pair;
    if (this.mode === "pair") {
      if (!this.control || Math.abs(span - pair.distance) > SCREEN_TOUCH_SLOP && Math.abs(span / pair.distance - 1) > .04) this.mode = "pinch";
      else if (distance(center, pair.center) > SCREEN_TOUCH_SLOP) this.mode = "scroll";
      else return;
    }
    if (this.mode === "pinch") {
      const zoom = clamp(pair.transform.zoom * span / pair.distance, 1, SCREEN_TOUCH_MAX_ZOOM), ratio = zoom / pair.transform.zoom;
      this.update({ zoom, x: center.x - this.viewport.width / 2 - (pair.center.x - this.viewport.width / 2 - pair.transform.x) * ratio,
        y: center.y - this.viewport.height / 2 - (pair.center.y - this.viewport.height / 2 - pair.transform.y) * ratio });
    } else {
      const point = this.point(center); if (point) this.emit({ kind: "wheel", ...point, dx: clamp(pair.previous.x - center.x, -2000, 2000), dy: clamp(pair.previous.y - center.y, -2000, 2000) });
    }
    pair.previous = center;
  }
  hold(at: number) {
    if (!this.control || this.mode !== "candidate" || this.fingers.size !== 1) return;
    const finger = [...this.fingers.values()][0]!;
    if (at - finger.at < SCREEN_TOUCH_HOLD_MS || distance(finger.point, finger.start) > SCREEN_TOUCH_SLOP) return;
    this.lastTap = undefined;
    const point = this.point(finger.point); if (point) { this.button(point, 2, true); this.button(point, 2, false); }
    this.mode = "consumed";
  }
  up(id: number) {
    const finger = this.fingers.get(id); if (!finger) return;
    this.flush();
    if (this.fingers.size === 1 && this.mode === "candidate" && this.control) {
      const point = this.point(finger.point), last = this.lastTap;
      if (point) {
        // Like mouse clicks, compare touch-down times and CSS pixel positions.
        // Commit both edges with the same count only after a completed tap.
        const clicks = last && finger.at >= last.at && finger.at - last.at <= 450 && distance(finger.point, last.point) <= 4 && last.clicks < 3 ? (last.clicks + 1) as 2 | 3 : 1;
        this.lastTap = { point: { ...finger.point }, at: finger.at, clicks };
        this.button(point, 0, true, clicks); this.button(point, 0, false, clicks);
      } else this.lastTap = undefined;
    }
    this.releaseDrag(); this.fingers.delete(id); this.mode = this.fingers.size ? "consumed" : "idle"; this.pair = undefined;
  }
  cancel() { this.releaseDrag(); this.fingers.clear(); this.pair = undefined; this.lastTap = undefined; this.mode = "idle"; }
}
