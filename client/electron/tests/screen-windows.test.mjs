// A Windows computer as the controlled target (#48). Everything native is a
// scripted fake: no test here posts input, captures a screen or opens a pipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as realFs from 'node:fs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { controlPath } from '../../../src/hub/service.ts';
import { SCREEN_WINDOWS_EXTENDED, SCREEN_WINDOWS_SCANCODES } from '../../../src/client-protocol/screen-keys.ts';
import { ScreenGeometry, toPhysicalPoint } from '../screen-geometry.mjs';
import { HELD_JOURNAL_COMPACT_BYTES, HeldJournal, readHeldJournal } from '../screen-held-journal.mjs';
import { screenControlAddress, screenServiceTicket } from '../screen-host-control.mjs';
import { ScreenInput } from '../screen-input.mjs';
import { ScreenService } from '../screen-service.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check, ms = 600) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 5)); } return check(); };
const E0 = SCREEN_WINDOWS_EXTENDED;

// ---------------- geometry: DIPs for the wire, physical pixels for input ----------------
// A 150 % laptop panel (2560×1600) as primary, a 100 % monitor to its left and
// a 125 % one above. Windows lists them in physical pixels; Electron in DIPs.
const MONITORS = [{ x: 0, y: 0, width: 2560, height: 1600 }, { x: -1920, y: 200, width: 1920, height: 1080 }, { x: 300, y: -1440, width: 2560, height: 1440 }];
const DISPLAYS = [
  { id: 11, bounds: { x: 0, y: 0, width: 1707, height: 1067 }, scaleFactor: 1.5, rotation: 0, label: 'Laptop' },
  { id: 12, bounds: { x: -1920, y: 133, width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0, label: 'Left' },
  { id: 13, bounds: { x: 200, y: -1152, width: 2048, height: 1152 }, scaleFactor: 1.25, rotation: 0, label: 'Above' },
];
/** Electron's `screen` for those displays: an origin converts to its monitor's physical origin. */
function screenOf(displays = DISPLAYS, origins = MONITORS) {
  return { getAllDisplays: () => displays, dipToScreenPoint: point => { const index = displays.findIndex(d => d.bounds.x === point.x && d.bounds.y === point.y); return index < 0 ? { x: NaN, y: NaN } : { x: origins[index].x, y: origins[index].y }; } };
}

test('each Windows display takes the physical rectangle of the monitor Windows lists at its origin', () => {
  const geometry = new ScreenGeometry({ screen: screenOf(), platform: 'windows', monitors: () => MONITORS });
  const displays = geometry.displays();
  assert.deepEqual(displays.map(d => [d.id, d.nativeId, d.x, d.y, d.width, d.height, d.scale]), [
    ['win-11', '11', 0, 0, 1707, 1067, 1.5], ['win-12', '12', -1920, 133, 1920, 1080, 1], ['win-13', '13', 200, -1152, 2048, 1152, 1.25]]);
  // 1707×1067 DIPs at 150 % is 2560.5×1600.5: the monitor's own 2560×1600 is used, not a product.
  assert.deepEqual(displays.map(d => geometry.physical(d.id)), MONITORS);
  // The wire description carries no physical rectangle.
  for (const d of displays) assert.deepEqual(Object.keys(d).sort(), ['height', 'id', 'name', 'nativeId', 'revision', 'rotation', 'scale', 'width', 'x', 'y']);
});

test('a display that cannot be matched to exactly one monitor is not offered', () => {
  const offered = (monitors, screen = screenOf()) => new ScreenGeometry({ screen, platform: 'windows', monitors }).displays().map(d => d.nativeId);
  assert.deepEqual(offered(() => MONITORS), ['11', '12', '13']);
  assert.deepEqual(offered(() => MONITORS.slice(0, 2)), ['11', '12'], 'no monitor at that origin');
  assert.deepEqual(offered(() => [...MONITORS, { ...MONITORS[1], width: 1280 }]), ['11', '13'], 'two monitors claim one origin');
  assert.deepEqual(offered(() => [MONITORS[0], { ...MONITORS[1], width: 2560 }, MONITORS[2]]), ['11', '13'], 'the monitor there has another size');
  assert.deepEqual(offered(() => { throw new Error('screen_input_unavailable'); }), [], 'monitors could not be read');
  assert.deepEqual(offered(() => [{ x: 0.5, y: 0, width: 2560, height: 1600 }, 'junk', null]), []);
  assert.deepEqual(offered(() => MONITORS, { getAllDisplays: () => DISPLAYS }), [], 'no conversion available: nothing is guessed from the scale');
  assert.deepEqual(offered(() => MONITORS, { getAllDisplays: () => DISPLAYS, dipToScreenPoint: () => { throw new Error('gone'); } }), []);
});

test('a monitor that moves in physical pixels is a new revision even when its DIP bounds look the same', () => {
  let monitors = MONITORS, origins = MONITORS;
  const geometry = new ScreenGeometry({ screen: { getAllDisplays: () => DISPLAYS, dipToScreenPoint: point => { const index = DISPLAYS.findIndex(d => d.bounds.x === point.x && d.bounds.y === point.y); return { x: origins[index].x, y: origins[index].y }; } },
    platform: 'windows', monitors: () => monitors });
  const before = geometry.find('win-12').revision;
  assert.equal(geometry.find('win-12').revision, before);
  monitors = origins = [MONITORS[0], { ...MONITORS[1], y: 201 }, MONITORS[2]];
  const after = geometry.find('win-12');
  assert.notEqual(after.revision, before);
  assert.deepEqual(geometry.physical('win-12'), { x: -1920, y: 201, width: 1920, height: 1080 });
  assert.equal(geometry.find('win-11').revision, geometry.find('win-11').revision);
  // A display that is gone leaves no rectangle behind.
  monitors = [MONITORS[0]];
  geometry.displays();
  assert.equal(geometry.physical('win-12'), undefined);
});

test('a normalized position lands on a whole pixel of its own monitor, edges included', () => {
  const [laptop, left, above] = MONITORS;
  assert.deepEqual(toPhysicalPoint(laptop, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(toPhysicalPoint(laptop, 1, 1), { x: 2559, y: 1599 }, 'the last pixel, not the first of the next monitor');
  assert.deepEqual(toPhysicalPoint(laptop, 0.5, 0.5), { x: 1280, y: 800 });
  assert.deepEqual(toPhysicalPoint(left, 0, 0), { x: -1920, y: 200 });
  assert.deepEqual(toPhysicalPoint(left, 1, 1), { x: -1, y: 1279 });
  assert.deepEqual(toPhysicalPoint(above, 0, 1), { x: 300, y: -1 });
  assert.deepEqual(toPhysicalPoint(above, 0.999999, 0), { x: 300 + 2559, y: -1440 });
  for (const [nx, ny] of [[0, 0], [1 / 3, 2 / 3], [0.9999, 0.0001], [1, 1]]) for (const rect of MONITORS) {
    const point = toPhysicalPoint(rect, nx, ny);
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height);
  }
  for (const [nx, ny] of [[-0.01, 0], [0, 1.01], [NaN, 0]]) assert.throws(() => toPhysicalPoint(laptop, nx, ny), /screen_point_out_of_bounds/);
});

test('a Mac keeps its identities and never asks for monitors', () => {
  const geometry = new ScreenGeometry({ screen: { getAllDisplays: () => DISPLAYS }, monitors: () => { throw new Error('not on a Mac'); } });
  assert.deepEqual(geometry.displays().map(d => d.id), ['cg-11', 'cg-12', 'cg-13']);
  assert.equal(geometry.physical('cg-11'), undefined);
});

// ---------------- input: scan codes, physical pixels, wheel amounts ----------------
const LEASE = 'L'.repeat(43);
const SWAP = { left: 'right', right: 'left', other: 'other' };
function inputLab({ holding, settled, physical = MONITORS[1], swapped = { now: false }, display = { id: 'win-12', nativeId: '12', name: 'Left', revision: 1, x: -1920, y: 133, width: 1920, height: 1080, scale: 1.25, rotation: 0 } } = {}) {
  const calls = [], clock = { wall: 1_800_000_000_000, mono: 1000 }, released = [];
  const native = { mouse: (...args) => calls.push(['mouse', ...args]), scroll: (...args) => calls.push(['scroll', ...args]), key: (...args) => calls.push(['key', ...args]),
    text: text => calls.push(['text', text]), location: () => { calls.push(['location']); return { x: 5, y: 6 }; }, releaseAll: () => calls.push(['releaseAll']),
    physicalButton: name => swapped.now ? SWAP[name] : name };
  const frame = { captureMs: clock.wall - 100, receivedMono: clock.mono - 90, displayId: display.id, geometryRevision: 1, streamGeneration: 2 };
  const input = new ScreenInput({ native, geometry: { find: id => id === display.id ? display : undefined, physical: id => id === display.id ? physical : undefined },
    frames: () => frame, ready: () => null, wall: () => clock.wall, monotonic: () => clock.mono, onReleased: (_lease, reason) => released.push(reason), target: 'windows',
    holding: (kind, value) => { calls.push(['holding', kind, value]); holding?.(kind, value); }, settled: (kind, value) => { calls.push(['settled', kind, value]); settled?.(kind, value); } });
  let sequence = 0;
  const send = event => input.apply({ type: 'input', sessionId: 's1', desktopId: 'd', generation: 'g1', displayId: display.id, displayRevision: 1, leaseId: LEASE, sequence: ++sequence, frameSequence: 7, expiresAt: frame.captureMs + 2000, event });
  assert.deepEqual(input.grant({ sessionId: 's1', generation: 'g1', leaseId: LEASE, expiresAt: clock.wall + 6000, frameSequence: 7, streamGeneration: 2 }), { ok: true });
  return { input, calls, send, released, native, swapped };
}

test('Windows keys are posted as scan codes without modifier flags, recorded before the press and taken off the record after the release', () => {
  const { calls, send } = inputLab();
  for (const [code, down] of [['ControlRight', true], ['KeyC', true], ['KeyC', true], ['KeyC', false], ['KeyC', true], ['KeyC', false], ['ControlRight', false]]) assert.equal(send({ kind: 'key', code, down }), null);
  assert.deepEqual(calls, [
    ['holding', 'key', E0 | 0x1d], ['key', E0 | 0x1d, true, 0, { modifier: true, repeat: false }],
    ['holding', 'key', 0x2e], ['key', 0x2e, true, 0, { modifier: false, repeat: false }],
    ['key', 0x2e, true, 0, { modifier: false, repeat: true }],  // a held key repeats; it is not recorded twice
    ['key', 0x2e, false, 0, { modifier: false, repeat: false }], ['settled', 'key', 0x2e],
    ['holding', 'key', 0x2e], ['key', 0x2e, true, 0, { modifier: false, repeat: false }],  // pressed again: recorded again
    ['key', 0x2e, false, 0, { modifier: false, repeat: false }], ['settled', 'key', 0x2e],
    ['key', E0 | 0x1d, false, 0, { modifier: true, repeat: false }], ['settled', 'key', E0 | 0x1d],
  ]);
  for (const [name, value] of Object.entries(SCREEN_WINDOWS_SCANCODES)) {
    const lab = inputLab();
    assert.equal(lab.send({ kind: 'key', code: name, down: true }), null);
    assert.deepEqual(lab.calls.at(-1).slice(0, 4), ['key', value, true, 0], name);
  }
});

test('a press whose record cannot be written is not posted, and ends the lease', () => {
  for (const event of [{ kind: 'key', code: 'ShiftLeft', down: true }, { kind: 'button', x: 0.5, y: 0.5, button: 0, down: true, clicks: 1 }, { kind: 'text', text: 'a\tb' }, { kind: 'text', text: 'a\nb' }]) {
    const { calls, send, released, input } = inputLab({ holding: () => { throw new Error('disk full'); } });
    assert.equal(send(event), 'screen_input_denied');
    assert.deepEqual(calls.filter(call => ['key', 'mouse', 'text'].includes(call[0])), [], 'nothing was pressed or typed');
    assert.deepEqual(released, ['screen_input_denied']);
    assert.equal(input.lease, undefined);
  }
});

test('an up that Windows refused is not taken off the record, and one that could not be taken off ends the lease', () => {
  const refused = inputLab();
  refused.send({ kind: 'key', code: 'AltLeft', down: true });
  refused.native.key = () => { throw new Error('screen_input_blocked'); };
  assert.equal(refused.send({ kind: 'key', code: 'AltLeft', down: false }), 'screen_input_denied');
  assert.deepEqual(refused.calls.filter(call => call[0] === 'settled'), [], 'still a candidate');
  const unrecorded = inputLab({ settled: () => { throw new Error('disk full'); } });
  unrecorded.send({ kind: 'key', code: 'AltLeft', down: true });
  assert.equal(unrecorded.send({ kind: 'key', code: 'AltLeft', down: false }), 'screen_input_denied');
  assert.deepEqual(unrecorded.released, ['screen_input_denied']);
  assert.equal(unrecorded.calls.at(-1)[0], 'releaseAll');
});

test('pointer events use whole physical pixels of the monitor; a button is decided, recorded and pressed as one physical button', () => {
  const { calls, send, input } = inputLab();
  send({ kind: 'move', x: 0, y: 0 });
  send({ kind: 'button', x: 1, y: 1, button: 2, down: true, clicks: 1 });
  send({ kind: 'move', x: 0.5, y: 0.5 });
  send({ kind: 'button', x: 0.5, y: 0.5, button: 2, down: false, clicks: 1 });
  send({ kind: 'button', x: 0.25, y: 0.75, button: 1, down: true, clicks: 2 });
  assert.deepEqual(calls, [
    ['mouse', 'move', 'left', -1920, 200, 1, 0],
    ['holding', 'button', 'right'], ['mouse', 'down', 'right', -1, 1279, 1, 0],
    ['mouse', 'drag', 'right', -960, 740, 1, 0],
    ['mouse', 'up', 'right', -960, 740, 1, 0], ['settled', 'button', 'right'],
    ['holding', 'button', 'other'], ['mouse', 'down', 'other', -1440, 1010, 2, 0],
  ]);
  // The takeover check compares in the same units: physical pixels, 1.25 per point here.
  assert.deepEqual({ x: input.pointer.x, y: input.pointer.y, scale: input.pointer.scale }, { x: -1440, y: 1010, scale: 1.25 });
});

test('on a computer with swapped buttons the main button is the physical right one, from record to release, whatever the setting does meanwhile', () => {
  const { calls, send, swapped } = inputLab({ swapped: { now: true } });
  send({ kind: 'button', x: 0, y: 0, button: 0, down: true, clicks: 1 });
  // The person flips the setting while the button is held: the up still lifts what was pressed.
  swapped.now = false;
  send({ kind: 'button', x: 0, y: 0, button: 0, down: false, clicks: 1 });
  // Pressed again under the new setting: the other physical button, recorded as that.
  send({ kind: 'button', x: 0, y: 0, button: 0, down: true, clicks: 1 });
  assert.deepEqual(calls, [
    ['holding', 'button', 'right'], ['mouse', 'down', 'right', -1920, 200, 1, 0],
    ['mouse', 'up', 'right', -1920, 200, 1, 0], ['settled', 'button', 'right'],
    ['holding', 'button', 'left'], ['mouse', 'down', 'left', -1920, 200, 1, 0],
  ]);
  // The secondary and the middle button likewise.
  const other = inputLab({ swapped: { now: true } });
  other.send({ kind: 'button', x: 0, y: 0, button: 2, down: true, clicks: 1 }); other.send({ kind: 'button', x: 0, y: 0, button: 1, down: true, clicks: 1 });
  assert.deepEqual(other.calls.filter(call => call[0] === 'holding'), [['holding', 'button', 'left'], ['holding', 'button', 'other']]);
});

test('a display without a physical rectangle takes no pointer input', () => {
  const { calls, send, released } = inputLab({ physical: null });
  assert.equal(send({ kind: 'move', x: 0.5, y: 0.5 }), 'screen_input_denied');
  assert.deepEqual(calls.filter(call => call[0] === 'mouse'), []);
  assert.deepEqual(released, ['screen_input_denied']);
});

test('the wheel is sent in Windows amounts and slow scrolling adds up across events', () => {
  const { calls, send } = inputLab();
  send({ kind: 'wheel', x: 0, y: 0, dx: 0, dy: 100 });
  send({ kind: 'wheel', x: 0, y: 0, dx: -50, dy: 0 });
  for (let step = 0; step < 4; step++) send({ kind: 'wheel', x: 0, y: 0, dx: 0, dy: 0.5 });
  const scrolls = calls.filter(call => call[0] === 'scroll');
  assert.deepEqual(scrolls.slice(0, 2), [['scroll', -1920, 200, -120, 0, 0], ['scroll', -1920, 200, 0, -60, 0]]);
  // 4 × 0.6 units: two events carry, two send one unit each.
  assert.deepEqual(scrolls.slice(2), [['scroll', -1920, 200, -1, 0, 0], ['scroll', -1920, 200, -1, 0, 0]]);
});

test('ending a Windows lease leaves the lifting to the native layer: no ups from here, no pointer move', () => {
  const { calls, send, input, released } = inputLab();
  send({ kind: 'key', code: 'ShiftLeft', down: true }); send({ kind: 'key', code: 'KeyA', down: true });
  send({ kind: 'button', x: 0.5, y: 0.5, button: 0, down: true, clicks: 1 });
  calls.length = 0;
  assert.equal(input.release('screen_local_takeover'), true);
  assert.deepEqual(calls, [['releaseAll']], 'and nothing is taken off the record here: the service does that once Windows took the release');
  assert.deepEqual(released, ['screen_local_takeover']);
  // A release the system refused is reported, not swallowed.
  const refused = inputLab();
  refused.send({ kind: 'key', code: 'KeyA', down: true });
  refused.native.releaseAll = () => { throw new Error('screen_release_pending'); };
  assert.equal(refused.input.release(), false);
});

test('text is typed as text; its line breaks and tabs are real keys, on record while they are typed', () => {
  const plain = inputLab();
  assert.equal(plain.send({ kind: 'text', text: '中文 😀' }), null);
  assert.deepEqual(plain.calls, [['text', '中文 😀']], 'Unicode only: nothing to record');
  const keyed = inputLab();
  assert.equal(keyed.send({ kind: 'text', text: 'a\r\nb\tc\n' }), null);
  assert.deepEqual(keyed.calls, [['holding', 'key', 0x1c], ['holding', 'key', 0x0f], ['text', 'a\r\nb\tc\n'], ['settled', 'key', 0x1c], ['settled', 'key', 0x0f]]);
  // Windows took only part of it: Enter may be down, so it stays on record for the general release.
  const half = inputLab();
  half.native.text = () => { throw new Error('screen_input_blocked'); };
  assert.equal(half.send({ kind: 'text', text: 'a\nb' }), 'screen_input_denied');
  assert.deepEqual(half.calls, [['holding', 'key', 0x1c], ['releaseAll']]);
  // An Enter this lease already holds is the lease's: typing does not take it off the record.
  const held = inputLab();
  held.send({ kind: 'key', code: 'Enter', down: true });
  held.calls.length = 0;
  held.send({ kind: 'text', text: 'a\nb\t' });
  assert.deepEqual(held.calls, [['holding', 'key', 0x0f], ['text', 'a\nb\t'], ['settled', 'key', 0x0f]]);
  // Never together with a held shortcut modifier.
  const modified = inputLab();
  modified.send({ kind: 'key', code: 'ControlLeft', down: true });
  assert.equal(modified.send({ kind: 'text', text: 'x' }), 'screen_input_denied');
});

// ---------------- the record of what remote control holds ----------------
async function journalLab(t, fs) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'screen-held-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state', 'screen-control.held.log');
  return { file, journal: new HeldJournal({ file, login: () => 'wts-1-2-3', ...(fs ? { fs } : {}) }), text: () => readFileSync(file, 'utf8') };
}
/** The real file functions, with `writeSync` replaced by `write(fd, bytes, offset, length, real)`. */
const writing = write => ({ closeSync: realFs.closeSync, mkdirSync: realFs.mkdirSync, openSync: realFs.openSync, rmSync: realFs.rmSync,
  writeSync: (fd, bytes, offset, length) => write(fd, bytes, offset, length, (count = length) => realFs.writeSync(fd, bytes, offset, count)) });

test('the record is one appended line per press and per release, and adds up to what is held', async t => {
  const { file, journal, text } = await journalLab(t);
  assert.deepEqual(readHeldJournal(file), { state: 'missing' });
  journal.add('key', 0x1d); journal.add('key', 0x1d); journal.add('button', 'right'); journal.add('key', E0 | 0x4b);
  assert.equal(text(), 'tarobot-screen-held 1 wts-1-2-3\n+key 29\n+button right\n+key 331\n');
  assert.deepEqual(readHeldJournal(file), { state: 'valid', login: 'wts-1-2-3', keys: [0x1d, E0 | 0x4b], buttons: ['right'] });
  journal.remove('key', 0x1d); journal.remove('key', 0x1d); journal.remove('key', 0x2a);
  assert.equal(text(), 'tarobot-screen-held 1 wts-1-2-3\n+key 29\n+button right\n+key 331\n-key 29\n');
  assert.deepEqual(readHeldJournal(file), { state: 'valid', login: 'wts-1-2-3', keys: [E0 | 0x4b], buttons: ['right'] });
  assert.equal(journal.size, 2);
  journal.clear();
  assert.deepEqual([existsSync(file), journal.size, journal.open], [false, 0, false]);
  // The next press starts a new file.
  journal.add('key', 0x1e);
  assert.equal(text(), 'tarobot-screen-held 1 wts-1-2-3\n+key 30\n');
  for (const [kind, value] of [['key', 0], ['key', 0x180], ['key', 1.5], ['key', '30'], ['button', 'fourth'], ['wheel', 1]]) assert.throws(() => journal.add(kind, value), /screen_held_record_failed/);
  assert.equal(text(), 'tarobot-screen-held 1 wts-1-2-3\n+key 30\n', 'nothing invalid is ever written');
});

test('a write that is cut short is continued; one that stops is a failure, after which nothing more is appended', async t => {
  // Twelve bytes at a time, as the reviewers' short-writing file did: the line is on disk whole before add returns.
  const pieces = await journalLab(t, writing((_fd, _bytes, _offset, length, real) => real(Math.min(12, length))));
  pieces.journal.add('key', 0x1e); pieces.journal.add('button', 'left'); pieces.journal.remove('key', 0x1e);
  assert.equal(pieces.text(), 'tarobot-screen-held 1 wts-1-2-3\n+key 30\n+button left\n-key 30\n');
  // Twelve bytes, then nothing: the first press is refused, and what is on disk reads as "nothing was pressed".
  let calls = 0;
  const stopped = await journalLab(t, writing((_fd, _bytes, _offset, _length, real) => calls++ === 0 ? real(12) : 0));
  assert.throws(() => stopped.journal.add('key', 0x1e), /screen_held_record_failed/);
  assert.equal(stopped.text(), 'tarobot-scre');
  assert.deepEqual([stopped.journal.size, readHeldJournal(stopped.file)], [0, { state: 'valid', keys: [], buttons: [] }]);
  assert.throws(() => stopped.journal.add('key', 0x1f), /screen_held_record_failed/);
  assert.equal(stopped.text(), 'tarobot-scre', 'no line is appended behind a piece of one');
  // A key is held, then a second press cannot be recorded: the first stays a candidate, the second is not one.
  let allowed = 1;  // the header and the first line go out in one write
  const later = await journalLab(t, writing((_fd, _bytes, _offset, _length, real) => allowed-- > 0 ? real() : (real(3), 0)));
  later.journal.add('key', 0x2a);
  assert.throws(() => later.journal.add('key', 0x1e), /screen_held_record_failed/);
  assert.equal(later.text(), 'tarobot-screen-held 1 wts-1-2-3\n+key 42\n+ke');
  assert.deepEqual(readHeldJournal(later.file), { state: 'valid', login: 'wts-1-2-3', keys: [0x2a], buttons: [] });
  assert.deepEqual([later.journal.size], [1]);
  // A release that cannot be recorded leaves the key a candidate.
  assert.throws(() => later.journal.remove('key', 0x2a), /screen_held_record_failed/);
  assert.equal(later.journal.size, 1);
  // Writers that lie about their progress are failures too.
  for (const answer of [-1, NaN, undefined, 1e9]) {
    const lying = await journalLab(t, writing(() => answer));
    assert.throws(() => lying.journal.add('key', 0x1e), /screen_held_record_failed/);
  }
  const throwing = await journalLab(t, writing(() => { throw new Error('EIO'); }));
  assert.throws(() => throwing.journal.add('key', 0x1e), /screen_held_record_failed/);
});

test('a record that is already there is never appended to or replaced: it belongs to an unfinished recovery', async t => {
  const { file, journal } = await journalLab(t);
  realFs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'tarobot-screen-held 1 wts-9-9-9\n+key 42\n');
  assert.throws(() => journal.add('key', 0x1e), /screen_held_record_failed/);
  assert.equal(readFileSync(file, 'utf8'), 'tarobot-screen-held 1 wts-9-9-9\n+key 42\n');
});

test('reading a record: an unfinished last piece is dropped, anything else unreadable means nothing is known', async t => {
  const { file } = await journalLab(t);
  realFs.mkdirSync(path.dirname(file), { recursive: true });
  const read = text => { writeFileSync(file, text); return readHeldJournal(file); };
  const head = 'tarobot-screen-held 1 wts-1-2-3\n';
  // Interrupted appends: the press behind the last piece was never made.
  assert.deepEqual(read(''), { state: 'valid', keys: [], buttons: [] });
  assert.deepEqual(read('tarobot-screen-he'), { state: 'valid', keys: [], buttons: [] });
  assert.deepEqual(read(head), { state: 'valid', login: 'wts-1-2-3', keys: [], buttons: [] });
  assert.deepEqual(read(`${head}+key 42\n+key 3`), { state: 'valid', login: 'wts-1-2-3', keys: [42], buttons: [] });
  // An interrupted release: the input stays a candidate.
  assert.deepEqual(read(`${head}+key 42\n+button left\n-key 4`), { state: 'valid', login: 'wts-1-2-3', keys: [42], buttons: ['left'] });
  assert.deepEqual(read(`${head}+key 42\n-key 42\n+key 42\n`).keys, [42]);
  // Everything else is not a record this code wrote.
  for (const text of ['{"format":1,"keys":[42]}\n', 'tarobot-screen-held 2 wts-1-2-3\n+key 42\n', 'tarobot-screen-held 1 \n', `${head}+key 0\n`, `${head}+key 384\n`, `${head}+key 042\n`, `${head}+key 4.2\n`,
    `${head}+button fourth\n`, `${head}+wheel 3\n`, `${head}key 42\n`, `${head}+key 42 \n`, `${head}\n+key 42\n`, `${head}+key 42\r\n`, `${head}+key 3+key 30\n`, `\n${head}`]) {
    assert.equal(read(text).state, 'corrupt', JSON.stringify(text));
  }
  // A last piece is dropped only if it is the beginning of a line this code writes. Anything else is unknown content.
  for (const piece of ['tarobot-screen-held 1 ', 'tarobot-screen-held 1 wts-1-2', 't', '']) assert.deepEqual(read(piece), { state: 'valid', keys: [], buttons: [] }, JSON.stringify(piece));
  for (const piece of ['corrupt', 'tarobot-screen-held 2', 'tarobot-screen-held 1 wts 1', 'Tarobot', ' tarobot-screen-held 1 ', '{"format":1', '+key 30', '\u0000\u0000\u0000']) assert.deepEqual(read(piece), { state: 'corrupt' }, JSON.stringify(piece));
  for (const piece of ['+', '-', '+k', '+key', '+key ', '+key 3', '+key 30', '-key 383', '+b', '-button', '+button ', '+button l', '-button righ', '+button other']) {
    assert.deepEqual(read(`${head}+key 42\n${piece}`), { state: 'valid', login: 'wts-1-2-3', keys: [42], buttons: [] }, JSON.stringify(piece));
  }
  for (const piece of ['corrupt', 'key 30', '+key 0', '+key 3840', '+key 3x', '+keys', '+button x', '+button leftt', '*key 3', '+ key 3', '+KEY 3', '\u0000', ' ']) {
    assert.deepEqual(read(`${head}+key 42\n${piece}`), { state: 'corrupt', login: 'wts-1-2-3' }, JSON.stringify(piece));
  }
  // The injected reader the service uses in tests behaves the same.
  assert.deepEqual(readHeldJournal('synthetic', () => 'corrupt'), { state: 'corrupt' });
  // What can still be told of an unreadable record: the session it was written in, if its first line is whole.
  assert.deepEqual(read(`${head}garbage\n`), { state: 'corrupt', login: 'wts-1-2-3' });
  assert.deepEqual(read('garbage\n'), { state: 'corrupt' });
  await assert.rejects(async () => readHeldJournal(path.dirname(file)), 'a read error is an error, not an empty record');
});

test('a long session does not grow the record without bound: with nothing held it starts again', async t => {
  const { file, journal } = await journalLab(t);
  journal.add('key', 0x2a);
  for (let press = 0; press * 16 < HELD_JOURNAL_COMPACT_BYTES + 4096; press++) { journal.add('key', 0x1e); journal.remove('key', 0x1e); }
  // Shift is still held: the file must stay whatever its size.
  assert.ok(realFs.statSync(file).size > HELD_JOURNAL_COMPACT_BYTES);
  assert.deepEqual(readHeldJournal(file).keys, [0x2a]);
  journal.remove('key', 0x2a);
  assert.equal(existsSync(file), false, 'nothing held is the same as no record');
  journal.add('key', 0x1e);
  assert.equal(readFileSync(file, 'utf8'), 'tarobot-screen-held 1 wts-1-2-3\n+key 30\n');
});

// ---------------- the Host's control pipe ----------------
test('the control address on Windows is the named pipe the Host derives from its directory', () => {
  for (const directory of ['C:\\Users\\example\\AppData\\Roaming\\com.tarobot.client\\host', 'c:/users/Example/appdata/roaming/COM.TAROBOT.CLIENT/host', 'D:\\isolated root\\host']) {
    const address = screenControlAddress(directory, 'win32');
    assert.equal(address, controlPath(directory, 'win32'));
    assert.match(address, /^\\\\\.\\pipe\\tarobot-hub-[0-9a-f]{64}$/);
  }
  // The same directory spelled in another case is the same pipe; another directory is another pipe.
  assert.equal(screenControlAddress('C:\\A\\Host', 'win32'), screenControlAddress('c:\\a\\host', 'win32'));
  assert.notEqual(screenControlAddress('C:\\a\\host', 'win32'), screenControlAddress('C:\\b\\host', 'win32'));
  assert.equal(screenControlAddress('/tmp/x/host', 'darwin'), '/tmp/x/host/hub-control.sock');
});

/** A control endpoint that answers like the Host: nothing at all without the key when `strict`. */
function pipe({ token, strict, capabilities = ['target-stop', 'screen-service-ticket', 'screen-quality-v1', 'screen-windows-v1'] }) {
  const requests = [], addresses = [], publicKey = `${'A'.repeat(59)}=`;
  const connect = address => {
    addresses.push(address);
    const socket = new EventEmitter();
    Object.assign(socket, { setTimeout() {}, destroy() {}, write(text) {
      const request = JSON.parse(text); requests.push(request);
      if (strict && request.token !== token) { queueMicrotask(() => socket.emit('close')); return; }
      const reply = { running: true, pid: 1, url: 'https://127.0.0.1:1', publicKey, controlCapabilities: capabilities,
        ...(request.command === 'screen-service-ticket' ? { screenServiceTicket: { ticket: 'T'.repeat(43), expiresAt: Date.now() + 30000 }, instancePort: 45678 } : {}) };
      queueMicrotask(() => socket.emit('data', Buffer.from(`${JSON.stringify(reply)}\n`)));
    } });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  return { connect, requests, addresses };
}
async function keyed(t, mode = 0o600) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'screen-pipe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = 'ab'.repeat(32);
  await writeFile(path.join(directory, 'hub-control.key'), token, { mode });
  await chmod(path.join(directory, 'hub-control.key'), mode);
  return { directory, token };
}

test('on Windows the ticket is asked on the pipe, with the key on every request', async t => {
  const { directory, token } = await keyed(t);
  const host = pipe({ token, strict: true });
  const ticket = await screenServiceTicket(directory, 'desktop-1', { platform: 'win32', connect: host.connect });
  assert.equal(ticket.ticket, 'T'.repeat(43));
  assert.equal(ticket.instancePort, 45678);
  assert.ok(ticket.capabilities.includes('screen-windows-v1'));
  assert.deepEqual(host.addresses, [controlPath(directory, 'win32'), controlPath(directory, 'win32')]);
  assert.deepEqual(host.requests.map(request => [request.command, request.token]), [['status', token], ['screen-service-ticket', token]]);
  assert.equal(host.requests[1].desktopId, 'desktop-1');
});

test('the key file rule follows the platform: owner-only by mode where modes exist, not on Windows', async t => {
  const open = await keyed(t, 0o644);
  // Windows has no such mode bits: the Host itself accepts this file there.
  const windows = pipe({ token: open.token, strict: true });
  assert.equal((await screenServiceTicket(open.directory, 'desktop-1', { platform: 'win32', connect: windows.connect })).ticket, 'T'.repeat(43));
  // Elsewhere the same file is refused, as before.
  if (process.platform !== 'win32') {
    const unix = pipe({ token: open.token });
    await assert.rejects(screenServiceTicket(open.directory, 'desktop-1', { platform: process.platform, connect: unix.connect }), /unsafe_hub_control_key/);
    assert.deepEqual(unix.requests.map(request => request.token), [undefined], 'status went without a key, as before');
  }
});

test('no key file on Windows means no Host has started there, and nothing is sent', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'screen-pipe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = pipe({ token: 'x', strict: true });
  await assert.rejects(screenServiceTicket(directory, 'desktop-1', { platform: 'win32', connect: host.connect }), /screen_host_unavailable/);
  assert.deepEqual(host.requests, []);
});

test('a Windows Host that does not answer the key is unavailable, not an error to print', async t => {
  const { directory } = await keyed(t);
  const host = pipe({ token: 'other', strict: true });
  await assert.rejects(screenServiceTicket(directory, 'desktop-1', { platform: 'win32', connect: host.connect }), /^Error: screen_host_unavailable$/);
});

// ---------------- the service on Windows ----------------
function sockets() {
  const all = [];
  class FakeSocket extends EventEmitter {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; all.push(this); }
    send(data, options, callback) { const done = typeof options === 'function' ? options : callback; this.sent.push(typeof data === 'string' ? JSON.parse(data) : data); done?.(); }
    open() { this.readyState = 1; this.emit('open'); }
    receive(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
    close(code = 1005, reason = '') { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code, Buffer.from(reason)); }
    terminate() { this.close(1006); }
  }
  return { FakeSocket, all, find: suffix => all.filter(socket => socket.url.endsWith(suffix)) };
}
const UNIQUE = '2-000000000004c2a1-1db123456789abc';
/** A Windows addon with the real backend's surface. `state` is what the test scripts. */
function windowsAddon(state = {}) {
  Object.assign(state, { session: { available: true, onConsole: true, locked: false, unique: UNIQUE, loginDone: true }, pending: 0, releaseAll: () => { state.pending = 0; return 0; },
    calls: [], poll: () => ({ alive: true, failed: false, foreign: 0, interrupted: 0 }), swapped: false, ...state });
  const note = (name, ...args) => { state.calls.push([name, ...args]); };
  return { screenTargetPlatform: () => 'windows', screenSession: () => state.session, screenMonitors: () => [{ x: 0, y: 0, width: 1920, height: 1080 }], screenDisplayUuid: () => null,
    screenMouse: (...args) => { note('mouse', ...args); state.onPress?.('mouse', args); }, screenScroll: (...args) => note('scroll', ...args),
    screenPhysicalButton: name => state.swapped ? SWAP[name] : name,
    screenKey: (...args) => { note('key', ...args); state.onPress?.('key', args); }, screenText: text => { note('text', text); state.onText?.(text); }, screenCursor: () => ({ x: 0, y: 0 }),
    screenReleaseAll: () => { note('releaseAll'); return state.releaseAll(); }, screenReleasePending: () => state.pending,
    screenReleaseCandidates: (keys, buttons) => { note('releaseCandidates', keys, buttons); return state.candidates?.(keys, buttons) ?? 0; },
    screenReleaseStale: () => { throw new Error('Windows never lifts input it has no record of'); },
    screenMonitorStart: () => note('monitorStart'), screenMonitorStop: () => note('monitorStop'), screenMonitorPoll: () => state.poll(), screenMonitorAccess: () => true, screenCaptureAccess: () => true };
}
/** Any use of a Mac permission API or of System Settings fails the test that caused it. */
const noMac = () => { throw new Error('a Mac permission API was used on Windows'); };
const LOGIN = `wts-${UNIQUE}`;
/** A record as a lease of this login session leaves it. */
const recorded = (lines, login = LOGIN) => `tarobot-screen-held 1 ${login}\n${lines.map(line => `${line}\n`).join('')}`;
const held = file => { const { state, keys, buttons } = readHeldJournal(file); return state === 'valid' ? { keys, buttons } : state; };
async function windowsService(t, { addon, state = {}, capabilities = ['screen-service-ticket', 'screen-quality-v1', 'screen-windows-v1'], files, start = true, directory, heldFs } = {}) {
  const stateDir = directory ?? await mkdtemp(path.join(os.tmpdir(), 'screen-windows-'));
  if (!directory) t.after(() => rm(stateDir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files ?? {})) await writeFile(path.join(stateDir, name), content);
  let hooks; const ws = sockets(), tickets = [], logs = [], capture = { starts: [], stops: [] };
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25, rotation: 0, label: 'Display' };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], dipToScreenPoint: () => ({ x: 0, y: 0 }) }), powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: noMac, isTrustedAccessibilityClient: noMac }, shell: { openExternal: noMac } };
  const service = new ScreenService({ electron, addon: addon ?? windowsAddon(state), stateDir, platform: 'win32', WebSocketClass: ws.FakeSocket, log: line => logs.push(line), ...(heldFs ? { heldFs } : {}),
    hostControl: { ticket: async () => { tickets.push(1); return { ticket: 'T'.repeat(43), instancePort: 1234, capabilities }; } },
    captureHost: callbacks => (hooks = callbacks, { start: async session => { capture.starts.push(session.sessionId); }, stop: id => capture.stops.push(id), reset() {}, pause() {}, credit() {}, keyframe() {}, close() {} }) });
  t.after(() => service.dispose());
  if (start) { await service.start(); await tick(); }
  const register = () => { const [control] = ws.find('/screen/v1/target'); control.open(); control.receive({ type: 'registered', epoch: 'desktop_epoch', serverTime: Date.now() }); return control; };
  return { service, ws, state, stateDir, tickets, logs, capture, electron, register, hooks: () => hooks,
    marker: path.join(stateDir, 'screen-control.active'), record: path.join(stateDir, 'screen-control.held.log') };
}
/** Registered, one session attached, one fresh frame confirmed, lease granted and ready. */
async function controlling(t, options) {
  const f = await windowsService(t, options);
  const control = f.register();
  const session = { id: 'screen_1', desktopId: f.service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation_1',
    display: f.service.status().desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() };
  control.receive({ type: 'start', session, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'] });
  const [media] = f.ws.find('/screen/v1/target-media');
  media.open(); media.receive({ type: 'attached', sessionId: session.id }); await tick();
  const captureMs = Date.now();
  f.hooks().onMessage({ type: 'frame', sessionId: session.id, sequence: 1, streamGeneration: 1, captureMs, geometryRevision: session.display.revision, bytes: new Uint8Array([1]) });
  control.receive({ type: 'ack', sessionId: session.id, frameSequence: 1, streamGeneration: 1 });
  const lease = () => control.receive({ type: 'lease', sessionId: session.id, generation: session.generation, leaseId: LEASE, expiresAt: captureMs + 5000, frameSequence: 1, streamGeneration: 1 });
  let sequence = 0;
  const input = event => control.receive({ type: 'input', sessionId: session.id, desktopId: f.service.desktopId, generation: session.generation, displayId: session.display.id, displayRevision: session.display.revision,
    leaseId: LEASE, sequence: ++sequence, frameSequence: 1, expiresAt: captureMs + 2000, event });
  return { ...f, control, session, media, lease, input, ready: () => until(() => control.sent.some(message => message.type === 'lease-ready')) };
}

test('an older Windows addon, whose screen functions are stubs, is not a target and reaches for nothing', async t => {
  const stub = { screenMouse() { throw new Error('screen_unavailable'); }, screenSession: () => ({ available: false, onConsole: false, locked: false }), screenMonitorPoll: () => ({ alive: false, failed: false, foreign: 0, interrupted: 0 }) };
  const f = await windowsService(t, { addon: stub });
  assert.deepEqual(f.service.status(), { supported: false, reason: 'screen_native_unavailable' });
  assert.deepEqual([f.tickets.length, f.ws.all.length], [0, 0]);
  await assert.rejects(f.service.retry(), /screen_service_unavailable/);
  // A marker function that throws, or names something else, is not Windows support either.
  for (const screenTargetPlatform of [() => { throw new Error('x'); }, () => 'macos', () => undefined]) {
    const other = await windowsService(t, { addon: { ...stub, screenTargetPlatform } });
    assert.deepEqual(other.service.status(), { supported: false, reason: 'screen_native_unavailable' });
  }
});

test('a Windows target sends nothing to a Host that does not know Windows targets', async t => {
  const f = await windowsService(t, { capabilities: ['screen-service-ticket', 'screen-quality-v1'] });
  assert.ok(await until(() => f.service.status().error));
  assert.equal(f.service.status().error, 'screen_host_update_required');
  assert.equal(f.service.status().phase, 'retrying');
  assert.equal(f.ws.all.length, 0, 'no socket, so no hello an older Host would refuse again and again');
  const without = await windowsService(t, { capabilities: null });  // an older Host's ticket reply names no capabilities
  assert.ok(await until(() => without.service.status().error));
  assert.deepEqual([without.service.status().error, without.ws.all.length], ['screen_host_update_required', 0]);
});

test('a Windows desktop registers as windows without touching any Mac permission API', async t => {
  const f = await windowsService(t);
  const control = f.register();
  const [hello] = control.sent;
  assert.equal(hello.type, 'hello');
  assert.deepEqual(hello.features, ['screen.quality.v1']);
  assert.deepEqual({ ...hello.desktop, desktopId: 'id', instanceId: 'id' }, { desktopId: 'id', instanceId: 'id', loginSession: `wts-${UNIQUE}`, platform: 'windows', capture: 'granted', accessibility: true, locked: false,
    displays: [{ id: 'win-1', nativeId: '1', name: 'Display', revision: 1, x: 0, y: 0, width: 1536, height: 864, scale: 1.25, rotation: 0 }] });
  assert.deepEqual(f.service.status().permissions, { capture: 'granted', accessibility: true, inputMonitoring: true });
  await assert.rejects(f.service.permission('capture'), /screen_permission_invalid/);
  await assert.rejects(f.service.permission('accessibility'), /screen_permission_invalid/);
});

test('a locked, disconnected or foreign-desktop Windows session is registered but says it cannot be seen or controlled', async t => {
  for (const session of [{ available: true, onConsole: true, locked: true, unique: UNIQUE }, { available: true, onConsole: false, locked: false, unique: UNIQUE }, { available: false, onConsole: false, locked: true, unique: null }]) {
    const f = await windowsService(t, { state: { session } });
    const control = f.register();
    assert.deepEqual([control.sent[0].desktop.locked, control.sent[0].desktop.capture, control.sent[0].desktop.accessibility], [true, 'unavailable', false]);
    assert.equal(control.sent[0].desktop.loginSession, session.unique ? `wts-${UNIQUE}` : 'unknown');
    assert.deepEqual(f.service.status().permissions, { capture: 'unavailable', accessibility: false, inputMonitoring: true });
    assert.equal(f.service.status().registered, true);
    // A session cannot start there.
    const record = { id: 'screen_1', desktopId: f.service.desktopId, deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation_1', display: control.sent[0].desktop.displays[0], controlAllowed: true, state: 'connecting', createdAt: Date.now() };
    control.receive({ type: 'start', session: record, mediaTicket: 'M'.repeat(43), streamGeneration: 1, codecs: ['h264'] });
    assert.deepEqual(control.sent.at(-1), { type: 'stop', sessionId: 'screen_1', reason: 'screen_locked' });
    assert.equal(f.ws.find('/screen/v1/target-media').length, 0);
  }
});

test('locking Windows ends the sessions here and now, and unlocking resumes nothing', async t => {
  const f = await controlling(t);
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'ShiftLeft', down: true });
  f.electron.powerMonitor.emit('lock-screen');
  assert.equal(f.service.input.lease, undefined);
  assert.deepEqual(f.service.status().sessions, []);
  assert.ok(f.capture.stops.includes('screen_1'));
  assert.ok(f.control.sent.some(message => message.type === 'stop' && message.sessionId === 'screen_1' && message.reason === 'screen_locked'));
  assert.ok(f.state.calls.some(call => call[0] === 'releaseAll'));
  f.electron.powerMonitor.emit('unlock-screen');
  await tick();
  assert.deepEqual(f.service.status().sessions, []);
  assert.equal(f.service.input.lease, undefined);
});

test('a key is on disk before Windows is asked to press it, off it once Windows took its up, and the record goes with the lease', async t => {
  const seen = [];
  const f = await controlling(t, { state: { onPress: (kind, args) => seen.push([kind, args[0], held(f.record)]) } });
  f.lease(); assert.ok(await f.ready());
  assert.equal(readFileSync(f.marker, 'utf8').split(' ')[1], LOGIN, 'the marker names the login session');
  assert.equal(existsSync(f.record), false, 'a lease that has pressed nothing has recorded nothing');
  f.input({ kind: 'key', code: 'ControlLeft', down: true });
  f.input({ kind: 'key', code: 'KeyV', down: true });
  f.input({ kind: 'key', code: 'KeyV', down: false });
  f.input({ kind: 'button', x: 0.5, y: 0.5, button: 0, down: true, clicks: 1 });
  assert.deepEqual(seen, [
    ['key', 0x1d, { keys: [0x1d], buttons: [] }],
    ['key', 0x2f, { keys: [0x1d, 0x2f], buttons: [] }],
    ['key', 0x2f, { keys: [0x1d, 0x2f], buttons: [] }],  // its up is posted while it is still on record
    ['mouse', 'down', { keys: [0x1d], buttons: ['left'] }],  // and it is off the record once Windows took that up
  ]);
  assert.equal(readFileSync(f.record, 'utf8'), recorded(['+key 29', '+key 47', '-key 47', '+button left']));
  f.control.receive({ type: 'release', sessionId: 'screen_1', reason: 'screen_control_stopped' });
  assert.ok(await until(() => !existsSync(f.marker)));
  assert.equal(existsSync(f.record), false);
});

test('a record that could not be written whole refuses the press; what was already held stays a candidate across a restart', async t => {
  // Shift is recorded and pressed. Then the disk takes three bytes of the next line and stops (the reviewers' short write).
  let whole = true;
  const heldFs = writing((_fd, _bytes, _offset, _length, real) => whole ? real() : (real(3), 0));
  const f = await controlling(t, { heldFs });
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'ShiftLeft', down: true });
  whole = false;
  // The general release that follows is refused as well: a consent prompt has the input.
  f.state.pending = 1; f.state.releaseAll = () => { throw new Error('screen_release_pending'); };
  f.input({ kind: 'key', code: 'KeyA', down: true });
  assert.deepEqual(f.state.calls.filter(call => call[0] === 'key').map(call => call.slice(1, 3)), [[0x2a, true]], 'A was never pressed');
  assert.equal(f.service.input.lease, undefined);
  assert.ok(f.control.sent.some(message => message.type === 'lease-denied' && message.reason === 'screen_input_denied'));
  assert.equal(readFileSync(f.record, 'utf8'), `${recorded(['+key 42'])}+ke`, 'a piece of the refused line is all that reached the disk');
  assert.equal(existsSync(f.marker), true);
  // The App dies. The next start offers exactly Shift, and keeps everything until Windows has taken its up.
  let refuse = true;
  const next = await windowsService(t, { directory: f.stateDir, state: { candidates: () => { if (refuse) throw new Error('screen_release_pending'); return 1; } } });
  assert.deepEqual(next.state.calls.filter(call => call[0].startsWith('release')), [['releaseCandidates', [0x2a], []]]);
  assert.deepEqual([existsSync(next.record), existsSync(next.marker), next.service.status().permissions.accessibility], [true, true, false]);
  refuse = false;
  assert.ok(await until(() => !existsSync(next.record) && !existsSync(next.marker), 2500));
  assert.equal(next.service.status().permissions.accessibility, true);
});

test('the very first press cannot be recorded: it is not made, and the piece left on disk says nothing was pressed', async t => {
  const heldFs = writing((_fd, _bytes, _offset, length, real) => real(Math.min(12, length)) && 0);
  const f = await controlling(t, { heldFs });
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'KeyA', down: true });
  assert.deepEqual(f.state.calls.filter(call => call[0] === 'key'), [], 'no native down after a short write');
  assert.equal(f.service.input.lease, undefined);
  // The lease ended with nothing held: record and marker go, and a later start has nothing to settle.
  assert.ok(await until(() => !existsSync(f.record) && !existsSync(f.marker)));
  // Had the App died first, the piece alone reads as an unfinished first press.
  writeFileSync(f.record, 'tarobot-scre'); writeFileSync(f.marker, `1 ${LOGIN}`);
  const next = await windowsService(t, { directory: f.stateDir });
  assert.deepEqual(next.state.calls.filter(call => call[0].startsWith('release')), []);
  assert.deepEqual([existsSync(next.record), existsSync(next.marker), next.service.status().permissions.accessibility, next.logs.includes('screen_stale_record_invalid')], [false, false, true, false]);
});

test('a key that was pressed and released is not a candidate: after a crash a person holding that very key is left alone', async t => {
  const f = await controlling(t);
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'ShiftLeft', down: true });
  f.input({ kind: 'key', code: 'ShiftLeft', down: false });
  f.input({ kind: 'button', x: 0.5, y: 0.5, button: 2, down: true, clicks: 1 });
  f.input({ kind: 'button', x: 0.5, y: 0.5, button: 2, down: false, clicks: 1 });
  f.input({ kind: 'key', code: 'KeyA', down: true });
  // The App dies here, with A held by remote control. What it leaves behind:
  assert.deepEqual(held(f.record), { keys: [0x1e], buttons: [] });
  assert.equal(existsSync(f.marker), true);
  // The next start. The person at the computer happens to hold Shift and the
  // right mouse button: this fake would lift whatever it is asked about.
  const lifted = [];
  const next = await windowsService(t, { directory: f.stateDir, state: { candidates: (keys, buttons) => { lifted.push(...keys, ...buttons); return keys.length + buttons.length; } } });
  assert.deepEqual(next.state.calls.filter(call => call[0].startsWith('release')), [['releaseCandidates', [0x1e], []]]);
  assert.deepEqual(lifted, [0x1e], 'Shift and the mouse button, released long before the crash, were never asked about');
  assert.equal(existsSync(next.record) || existsSync(next.marker), false);
});

test('a crash with nothing held asks Windows about nothing, whatever was pressed earlier in that lease', async t => {
  const f = await controlling(t);
  f.lease(); assert.ok(await f.ready());
  for (const code of ['ControlLeft', 'KeyV', 'MetaLeft']) { f.input({ kind: 'key', code, down: true }); f.input({ kind: 'key', code, down: false }); }
  f.input({ kind: 'text', text: 'line\nnext\tcell' });
  assert.deepEqual(held(f.record), { keys: [], buttons: [] });
  const next = await windowsService(t, { directory: f.stateDir });
  assert.deepEqual(next.state.calls.filter(call => call[0].startsWith('release')), []);
  assert.equal(existsSync(next.record) || existsSync(next.marker), false);
});

test('the physical button that was pressed is the one on record and the only one a later start asks about', async t => {
  const f = await controlling(t, { state: { swapped: true } });
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'button', x: 0.5, y: 0.5, button: 0, down: true, clicks: 1 });
  assert.deepEqual(f.state.calls.filter(call => call[0] === 'mouse').map(call => call.slice(1, 3)), [['down', 'right']], 'the main button of a swapped mouse');
  assert.deepEqual(held(f.record), { keys: [], buttons: ['right'] });
  // The App dies; the setting is put back to normal before the next start. Still exactly the physical right button.
  const next = await windowsService(t, { directory: f.stateDir, state: { swapped: false } });
  assert.deepEqual(next.state.calls.filter(call => call[0].startsWith('release')), [['releaseCandidates', [], ['right']]]);
});

test('a line break typed as text is on record while it is typed, and stays there if Windows took only part of the text', async t => {
  let during;
  const f = await controlling(t, { state: { onText: () => { during = held(f.record); } } });
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'text', text: 'a\nb' });
  assert.deepEqual(during, { keys: [0x1c], buttons: [] });
  assert.deepEqual(held(f.record), { keys: [], buttons: [] });
  // The next text is cut off inside Windows, and the release that follows is refused too. Then the App dies.
  f.state.onText = () => { throw new Error('screen_input_blocked'); };
  f.state.pending = 1; f.state.releaseAll = () => { throw new Error('screen_release_pending'); };
  f.input({ kind: 'text', text: 'c\td' });
  assert.equal(f.service.input.lease, undefined);
  assert.deepEqual(held(f.record), { keys: [0x0f], buttons: [] });
  const next = await windowsService(t, { directory: f.stateDir });
  assert.deepEqual(next.state.calls.filter(call => call[0].startsWith('release')), [['releaseCandidates', [0x0f], []]], 'the real Tab key is a candidate; nothing else is');
});

test('an up Windows refused stays on record, ends the lease, and is settled by the general release', async t => {
  const f = await controlling(t);
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'AltLeft', down: true });
  const key = f.service.addon.screenKey;
  f.service.addon.screenKey = (code, down, ...rest) => { if (!down) throw new Error('screen_input_blocked'); return key(code, down, ...rest); };
  let record;
  f.state.releaseAll = () => { record = held(f.record); f.state.pending = 0; return 1; };
  f.input({ kind: 'key', code: 'AltLeft', down: false });
  assert.equal(f.service.input.lease, undefined);
  assert.deepEqual(record, { keys: [0x38], buttons: [] }, 'still a candidate while the general release runs');
  assert.ok(f.control.sent.some(message => message.type === 'lease-denied' && message.reason === 'screen_input_denied'));
  assert.ok(await until(() => !existsSync(f.record) && !existsSync(f.marker)));
});

test('a release Windows refused keeps the record and the marker, denies control, and is finished later', async t => {
  const f = await controlling(t);
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'ShiftLeft', down: true });
  // A consent prompt has the input: Windows takes no release.
  f.state.pending = 1; f.state.releaseAll = () => { throw new Error('screen_release_pending'); };
  f.control.receive({ type: 'release', sessionId: 'screen_1', reason: 'screen_control_stopped' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.service.input.lease, undefined);
  assert.deepEqual(held(f.record), { keys: [0x2a], buttons: [] });
  assert.equal(existsSync(f.marker), true, 'the marker is not removed while a key may still be down');
  assert.equal(f.service.status().permissions.accessibility, false);
  // A new lease is refused while that is so.
  f.control.sent.length = 0;
  await new Promise(resolve => setTimeout(resolve, 260));
  f.lease();
  assert.ok(f.control.sent.some(message => message.type === 'lease-denied' && message.reason === 'screen_input_denied'));
  // The desktop is back: the same release goes through, and only then the files go.
  f.state.releaseAll = () => { f.state.pending = 0; return 1; };
  assert.ok(await until(() => !existsSync(f.record) && !existsSync(f.marker), 2500));
  assert.equal(f.service.status().permissions.accessibility, true);
});

test('a refused release is finished without a Host: a held key does not wait for the connection to come back', async t => {
  const f = await controlling(t);
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'key', code: 'ControlLeft', down: true });
  f.state.pending = 1; f.state.releaseAll = () => { throw new Error('screen_release_pending'); };
  // The Host goes away while a consent prompt has the input.
  f.control.close(1006);
  assert.equal(f.service.input.lease, undefined);
  assert.equal(f.service.status().registered, false);
  assert.deepEqual([held(f.record), existsSync(f.marker)], [{ keys: [0x1d], buttons: [] }, true]);
  f.state.releaseAll = () => { f.state.pending = 0; return 1; };
  assert.ok(await until(() => !existsSync(f.record) && !existsSync(f.marker), 2500));
  assert.equal(f.service.status().registered, false, 'still no Host');
});

test('after a crash exactly the recorded keys and buttons are offered for lifting, and nothing else is looked at', async t => {
  const f = await windowsService(t, { files: { 'screen-control.active': `1 ${LOGIN}`, 'screen-control.held.log': recorded(['+key 42', '+key 285', '+key 30', '+key 31', '-key 31', '+button left']) } });
  assert.deepEqual(f.state.calls.filter(call => call[0].startsWith('release')), [['releaseCandidates', [0x2a, E0 | 0x1d, 0x1e], ['left']]]);
  assert.equal(existsSync(f.record), false);
  assert.equal(existsSync(f.marker), false);
  assert.equal(f.service.status().permissions.accessibility, true);
});

test('a recovery Windows did not take keeps both files, denies control and is tried again', async t => {
  let refuse = true;
  const state = { candidates: () => { if (refuse) throw new Error('screen_release_pending'); return 2; } };
  const f = await windowsService(t, { state, files: { 'screen-control.active': `1 ${LOGIN}`, 'screen-control.held.log': recorded(['+key 42', '+button right']) } });
  assert.equal(existsSync(f.record) && existsSync(f.marker), true);
  f.register();
  assert.deepEqual([f.service.status().permissions.accessibility, f.service.status().desktop.accessibility], [false, false]);
  assert.equal(f.state.calls.filter(call => call[0] === 'releaseCandidates').length, 1);
  refuse = false;
  assert.ok(await until(() => !existsSync(f.record) && !existsSync(f.marker), 2500), 'the health tick tries again');
  assert.deepEqual(f.state.calls.filter(call => call[0] === 'releaseCandidates').at(-1), ['releaseCandidates', [0x2a], ['right']]);
  assert.ok(await until(() => f.service.status().permissions.accessibility === true));
});

test('a marker without a record means nothing was pressed: nothing is lifted and the marker goes', async t => {
  const untouched = await windowsService(t, { files: { 'screen-control.active': `1 ${LOGIN}` } });
  assert.deepEqual(untouched.state.calls.filter(call => call[0].startsWith('release')), []);
  assert.equal(existsSync(untouched.marker), false);
  assert.equal(untouched.service.status().permissions.accessibility, true);
  // A Mac-format marker from before (a time only) is the same thing.
  const old = await windowsService(t, { files: { 'screen-control.active': '1795199520533' } });
  assert.deepEqual([old.state.calls.filter(call => call[0].startsWith('release')), existsSync(old.marker)], [[], false]);
  // No files at all: nothing happens.
  const clean = await windowsService(t);
  assert.deepEqual([clean.state.calls.filter(call => call[0].startsWith('release')), clean.logs.includes('screen_stale_record_invalid')], [[], false]);
});

test('a record that cannot be read lifts nothing, clears nothing and keeps control off for this login session', async t => {
  for (const content of ['{"format":1,"keys":[42],"buttons":[]}\n', recorded(['+key 42', 'junk']), recorded(['+key 999']), 'tarobot-screen-held 9 x\n+key 42\n']) {
    const f = await windowsService(t, { files: { 'screen-control.active': `1 ${LOGIN}`, 'screen-control.held.log': content } });
    const control = f.register();
    assert.deepEqual(f.state.calls.filter(call => call[0].startsWith('release')), [], 'no key is guessed');
    assert.ok(f.logs.includes('screen_stale_record_invalid'));
    assert.equal(readFileSync(f.record, 'utf8'), content, 'the evidence is not erased');
    assert.equal(existsSync(f.marker), true);
    assert.deepEqual([f.service.status().permissions.accessibility, f.service.status().error, control.sent[0].desktop.accessibility], [false, 'screen_stale_record_invalid', false]);
    // Not by waiting either: the health tick does not clear it.
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.deepEqual([existsSync(f.record), existsSync(f.marker), f.service.status().permissions.accessibility], [true, true, false]);
    assert.deepEqual(f.state.calls.filter(call => call[0].startsWith('release')), []);
  }
});

test('a record from another login session, readable or not, is dropped without lifting anything: those keys cannot be down any more', async t => {
  const other = 'wts-7-00000000000aaaaa-1db0000000000000';
  for (const files of [
    { 'screen-control.active': `1 ${other}`, 'screen-control.held.log': recorded(['+key 42', '+button left'], other) },
    { 'screen-control.active': `1 ${other}`, 'screen-control.held.log': recorded(['+key 42', 'junk'], other) },
    { 'screen-control.active': `1 ${other}`, 'screen-control.held.log': 'not a record\n' },  // only the marker still names the session
  ]) {
    const f = await windowsService(t, { files });
    assert.deepEqual(f.state.calls.filter(call => call[0].startsWith('release')), []);
    assert.deepEqual([existsSync(f.record), existsSync(f.marker), f.service.status().permissions.accessibility, f.service.status().error], [false, false, true, undefined]);
  }
  // While the current session cannot be read, nothing is decided: it may be this very session.
  const state = { session: { available: false, onConsole: false, locked: true, unique: null } };
  const unknown = await windowsService(t, { state, files: { 'screen-control.active': `1 ${other}`, 'screen-control.held.log': 'not a record\n' } });
  assert.deepEqual([existsSync(unknown.record), existsSync(unknown.marker)], [true, true]);
  // And an unreadable record that names no session at all, under a marker that names none, stays.
  const nameless = await windowsService(t, { files: { 'screen-control.active': '1', 'screen-control.held.log': 'not a record\n' } });
  assert.deepEqual([existsSync(nameless.record), nameless.service.status().error], [true, 'screen_stale_record_invalid']);
});

test('the takeover distance is measured in the pointer units of the monitor', async t => {
  let cursor = { x: 960, y: 540 };
  const f = await controlling(t);
  f.service.addon.screenCursor = () => cursor;
  f.lease(); assert.ok(await f.ready());
  f.input({ kind: 'move', x: 0.5, y: 0.5 });
  // 14 physical pixels at 125 % is 11.2 points: inside the 12-point tolerance.
  cursor = { x: 974, y: 540 };
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(f.service.input.lease, 'not a takeover');
  cursor = { x: 976, y: 540 };  // 16 pixels is 12.8 points
  assert.ok(await until(() => !f.service.input.lease, 1500));
  assert.ok(f.control.sent.some(message => message.type === 'stop' && message.reason === 'screen_local_takeover'));
});
