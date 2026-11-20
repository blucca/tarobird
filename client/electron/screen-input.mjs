import { SCREEN_MAC_KEYCODES, SCREEN_MODIFIERS, SCREEN_WINDOWS_SCANCODES, screenIsModifier, screenKeyExtraFlags, screenWheelToMac, screenWheelToWindows } from '../../src/client-protocol/screen-keys.ts';
import { toGlobalPoint, toPhysicalPoint } from './screen-geometry.mjs';

export const SCREEN_LEASE_MAX_MS = 6000;
export const SCREEN_FRAME_FRESH_MS = 2000;
const BUTTONS = { 0: 'left', 1: 'other', 2: 'right' };

/** One controller lease at a time. Every input is re-authorized here against
 * the lease, a target-confirmed fresh frame, current geometry and permissions.
 * Releases (key/button up of something this lease pressed) bypass freshness
 * and geometry: refusing an up would leave a key stuck on the target.
 * Native posting is injected; tests never reach the OS.
 *
 * `target` is the controlled platform. On Windows: keys are scan codes, points
 * are physical pixels, the system keeps modifier state itself (no flags), and
 * the native layer alone decides what is still held when a lease ends.
 * `holding(kind, value)` is called, on Windows only, before a key or button
 * that is not down is pressed; if it throws, nothing is pressed.
 * `settled(kind, value)` is called after the native layer has taken its up.
 * A button's `value` is the PHYSICAL button: `native.physicalButton(name)`
 * says which one Windows takes for a button by meaning (left = the main one)
 * at that moment, and exactly that one is recorded, pressed and released. */
export class ScreenInput {
  #lease; #timer; #keys = new Map(); #buttons = new Map(); #physical = new Map(); #point; #pointAt = 0; #pointScale = 1; #sequence = 0; #wheel;
  constructor({ native, geometry, frames, ready, monotonic = () => performance.now(), wall = Date.now, onReleased = () => {}, target = 'macos', holding = () => {}, settled = () => {} }) {
    Object.assign(this, { native, geometry, frames, ready, monotonic, wall, onReleased, target, holding, settled });
    this.windows = target === 'windows';
  }
  get lease() { return this.#lease && { ...this.#lease }; }
  /** Last remote pointer position and when it was posted (local-takeover check).
   * `scale`: units of that position per display point (1 on macOS). */
  get pointer() { return this.#lease && this.#point ? { ...this.#point, at: this.#pointAt, scale: this.#pointScale } : undefined; }

  /** Host-issued lease (or renewal of the same id). On refusal returns a
   * `lease-denied` reason: screen_frame_stale | screen_lease_invalid |
   * screen_input_denied | screen_geometry_changed | screen_locked. */
  grant(lease) {
    const blocked = this.ready();
    if (blocked) return { ok: false, reason: blocked };
    const frame = this.frames(lease.sessionId, lease.frameSequence, lease.streamGeneration);
    if (!frame || !this.#fresh(frame)) return { ok: false, reason: 'screen_frame_stale' };
    const display = this.geometry.find(frame.displayId);
    if (!display || display.revision !== frame.geometryRevision) return { ok: false, reason: 'screen_geometry_changed' };
    const remaining = Math.min(SCREEN_LEASE_MAX_MS, lease.expiresAt - this.wall());
    if (!(remaining > 0)) return { ok: false, reason: 'screen_lease_invalid' };
    const current = this.#lease;
    if (current && (current.sessionId !== lease.sessionId || current.leaseId !== lease.leaseId || current.generation !== lease.generation)) this.release('screen_lease_invalid');
    const renewal = this.#lease?.leaseId === lease.leaseId;
    // Renewal keeps the dedup sequence and pressed state; a new lease starts clean.
    if (!renewal) { this.#sequence = 0; this.#keys.clear(); this.#buttons.clear(); this.#physical.clear(); this.#wheel = undefined; }
    this.#lease = { sessionId: lease.sessionId, generation: lease.generation, leaseId: lease.leaseId, expiresAt: lease.expiresAt, deadline: this.monotonic() + remaining };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.release('screen_lease_invalid'), remaining + 5);
    this.#timer.unref?.();
    return { ok: true };
  }

  /** Validates and posts one input. Returns a bounded reason code on refusal. */
  apply(input) {
    const lease = this.#lease;
    if (!lease || input.sessionId !== lease.sessionId || input.generation !== lease.generation || input.leaseId !== lease.leaseId) return 'screen_lease_mismatch';
    if (this.monotonic() > lease.deadline || this.wall() > lease.expiresAt) { this.release('screen_lease_invalid'); return 'screen_lease_invalid'; }
    if (input.sequence <= this.#sequence) return 'screen_input_replayed';
    this.#sequence = input.sequence;
    const { event } = input;
    if (this.#releasing(event)) return this.#post(() => this.#release(event)) ?? null;
    const blocked = this.ready();
    if (blocked) { this.release(blocked); return blocked; }
    const frame = this.frames(input.sessionId, input.frameSequence);
    if (!frame || input.expiresAt !== frame.captureMs + SCREEN_FRAME_FRESH_MS || !this.#fresh(frame)) return 'screen_frame_stale';
    if (input.displayId !== frame.displayId || input.displayRevision !== frame.geometryRevision) return 'screen_geometry_changed';
    const display = this.geometry.find(input.displayId);
    if (!display || display.revision !== input.displayRevision) { this.release('screen_geometry_changed'); return 'screen_geometry_changed'; }
    return this.#post(() => this.#press(event, display)) ?? null;
  }

  #fresh(frame) { return this.wall() <= frame.captureMs + SCREEN_FRAME_FRESH_MS && this.monotonic() <= frame.receivedMono + SCREEN_FRAME_FRESH_MS; }
  #releasing(event) {
    return event.kind === 'key' && !event.down && this.#keys.has(event.code)
      || event.kind === 'button' && !event.down && this.#buttons.has(event.button);
  }
  #post(action) {
    try { action(); return undefined; }
    catch { this.release('screen_input_denied'); return 'screen_input_denied'; }
  }
  #flags() {
    if (this.windows) return 0;
    let flags = 0;
    for (const code of this.#keys.keys()) if (screenIsModifier(code)) flags |= SCREEN_MODIFIERS[code].flag | SCREEN_MODIFIERS[code].device;
    return flags;
  }
  /** Where a normalized position on `display` is for the native layer. */
  #locate(display, x, y) {
    if (!this.windows) return toGlobalPoint(display, x, y);
    const rect = this.geometry.physical(display.id);
    if (!rect) throw new Error('screen_geometry_changed');
    this.#pointScale = display.scale;
    return toPhysicalPoint(rect, x, y);
  }
  #press(event, display) {
    if (['move', 'button', 'wheel'].includes(event.kind)) this.#pointAt = this.monotonic();
    switch (event.kind) {
      case 'move': {
        this.#point = this.#locate(display, event.x, event.y);
        const held = [...this.#buttons.keys()][0];
        this.native.mouse(held === undefined ? 'move' : 'drag', BUTTONS[held] ?? 'left', this.#point.x, this.#point.y, 1, this.#flags());
        return;
      }
      case 'button': {
        this.#point = this.#locate(display, event.x, event.y);
        if (!event.down) return; // an up for a button this lease never pressed
        let name = BUTTONS[event.button];
        if (this.windows) {
          // Decide which physical button, record it, then press that very one.
          name = this.#physical.get(event.button) ?? this.native.physicalButton(name);
          if (!this.#buttons.has(event.button)) this.holding('button', name);
          this.#physical.set(event.button, name);
        }
        this.#buttons.set(event.button, event.clicks);
        this.native.mouse('down', name, this.#point.x, this.#point.y, event.clicks, this.#flags());
        return;
      }
      case 'wheel': {
        this.#point = this.#locate(display, event.x, event.y);
        if (this.windows) {
          const { vertical, horizontal, carry } = screenWheelToWindows(event.dx, event.dy, this.#wheel);
          this.#wheel = carry;
          if (vertical || horizontal) this.native.scroll(this.#point.x, this.#point.y, vertical, horizontal, 0);
          return;
        }
        const { wheel1, wheel2 } = screenWheelToMac(event.dx, event.dy);
        if (wheel1 || wheel2) this.native.scroll(this.#point.x, this.#point.y, wheel1, wheel2, this.#flags());
        return;
      }
      case 'key': {
        const keycode = (this.windows ? SCREEN_WINDOWS_SCANCODES : SCREEN_MAC_KEYCODES)[event.code];
        if (keycode === undefined || !event.down) return;
        const repeat = this.#keys.has(event.code);
        if (this.windows && !repeat) this.holding('key', keycode);
        this.#keys.set(event.code, keycode);
        if (screenIsModifier(event.code)) { if (!repeat) this.native.key(keycode, true, this.#flags(), { modifier: true, repeat: false }); return; }
        this.native.key(keycode, true, this.#extra(event.code), { modifier: false, repeat });
        return;
      }
      case 'text': {
        // Committed IME/explicit text is typed as Unicode, never via the clipboard,
        // and never combined with held shortcut modifiers.
        if ([...this.#keys.keys()].some(code => screenIsModifier(code) && !code.startsWith('Shift'))) throw new Error('screen_text_with_modifiers');
        if (!this.windows) { this.native.text(event.text); return; }
        // On Windows a line break and a tab are typed as the real Enter and Tab
        // keys. They are recorded like any other key for as long as the text is
        // being typed, unless this lease already holds them.
        const typed = [['Enter', /[\n\r]/], ['Tab', /\t/]].filter(([code, pattern]) => pattern.test(event.text) && !this.#keys.has(code)).map(([code]) => SCREEN_WINDOWS_SCANCODES[code]);
        for (const scan of typed) this.holding('key', scan);
        this.native.text(event.text);
        for (const scan of typed) this.settled('key', scan);
        return;
      }
      default: throw new Error('screen_input_unknown');
    }
  }
  #extra(code) { return this.windows ? 0 : this.#flags() | screenKeyExtraFlags(code); }
  #release(event) {
    if (event.kind === 'button') {
      const clicks = this.#buttons.get(event.button); this.#buttons.delete(event.button);
      const point = this.#point ?? this.native.location();
      const name = this.#physical.get(event.button) ?? BUTTONS[event.button]; this.#physical.delete(event.button);
      this.native.mouse('up', name, point.x, point.y, clicks, this.#flags());
      if (this.windows) this.settled('button', name);
      return;
    }
    const keycode = this.#keys.get(event.code); this.#keys.delete(event.code);
    if (screenIsModifier(event.code)) this.native.key(keycode, false, this.#flags(), { modifier: true, repeat: false });
    else this.native.key(keycode, false, this.#extra(event.code), { modifier: false, repeat: false });
    // Only an up the native layer did not refuse: a refused one threw above.
    if (this.windows) this.settled('key', keycode);
  }

  /** Releases everything this lease pressed, then forgets the lease. Never
   * waits for the controller: called on expiry, stop, lock, takeover, failure. */
  release(reason = 'screen_released') {
    clearTimeout(this.#timer); this.#timer = undefined;
    const lease = this.#lease; this.#lease = undefined;
    const keys = [...this.#keys.entries()].reverse(), buttons = [...this.#buttons.entries()];
    this.#keys.clear(); this.#buttons.clear(); this.#physical.clear();
    const errors = [];
    const attempt = fn => { try { fn(); } catch (error) { errors.push(error); } };
    // On Windows only the native layer knows what the system actually took, and
    // it lifts buttons where the pointer is now instead of moving it back.
    if (!this.windows) {
      for (const [code, keycode] of keys.filter(([code]) => !screenIsModifier(code))) attempt(() => this.native.key(keycode, false, 0, { modifier: false, repeat: false }));
      for (const [, keycode] of keys.filter(([code]) => screenIsModifier(code))) attempt(() => this.native.key(keycode, false, 0, { modifier: true, repeat: false }));
      if (buttons.length) {
        let point = this.#point; if (!point) attempt(() => { point = this.native.location(); });
        for (const [button, clicks] of buttons) if (point) attempt(() => this.native.mouse('up', BUTTONS[button], point.x, point.y, clicks, 0));
      }
    }
    // The native layer also tracks what it posted and clears it independently.
    attempt(() => this.native.releaseAll());
    this.#point = undefined; this.#wheel = undefined;
    if (lease) this.onReleased(lease, reason);
    return errors.length === 0;
  }
}
