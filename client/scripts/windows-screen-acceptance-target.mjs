// Isolated Electron target for #48 Windows acceptance on a disposable runner.
// Runs real official ScreenService + real compiled tarobot-desktop-native.node
// + real Windows named-pipe hostControl against a synthetic capture host (NEVER
// calls desktopCapturer or captures the real desktop) and ONE owned synthetic
// test BrowserWindow. Communicates with the parent Node orchestrator via
// newline-delimited JSON prefixed with `TAROBIRD_ACC_MSG:`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, powerMonitor, screen, shell, systemPreferences } from 'electron';
import { WebSocket } from 'ws';
import { ScreenService } from '../electron/screen-service.mjs';
import { screenServiceTicket } from '../electron/screen-host-control.mjs';
import { readHeldJournal } from '../electron/screen-held-journal.mjs';
import { writeScreenFrame } from '../../src/client-protocol/screen-wire.ts';

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--') && i + 1 < argv.length) {
      out[token.slice(2)] = argv[++i];
    }
  }
  return out;
}

const args = parseCli(process.argv.slice(1));
const addonFile = path.resolve(args.addon || '');
const hostDir = path.resolve(args['host-dir'] || '');
const appState = path.resolve(args['app-state'] || '');
const profileDir = path.resolve(args.profile || path.join(appState, 'electron-profile'));
const rpcUrl = args['rpc-url'] || '';

app.setPath('userData', profileDir);
app.setPath('sessionData', profileDir);

let rpcWs = null;
const emitMsg = payload => {
  if (rpcWs && rpcWs.readyState === WebSocket.OPEN) {
    rpcWs.send(JSON.stringify(payload));
  }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const TEST_HTML = `<!doctype html><meta charset="utf-8"><title>TaroBird remote screen test</title>
<style>html,body{margin:0;height:100%;font:14px system-ui;background:#fffbe6}#note{padding:10px}textarea{position:absolute;left:10%;top:55%;width:80%;height:30%}</style>
<div id="note"><b>TaroBird remote screen acceptance window.</b> Synthetic window only.</div>
<textarea id="text" spellcheck="false"></textarea>
<script>
const { ipcRenderer } = require('electron');
const send = value => ipcRenderer.send('acc-seen', value);
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, e => send({
    type, code: e.code, key: e.key, location: e.location, repeat: e.repeat,
    numLock: typeof e.getModifierState === 'function' ? e.getModifierState('NumLock') : null,
  }), true);
}
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'mousemove']) {
  window.addEventListener(type, e => {
    if (type === 'contextmenu') e.preventDefault();
    send({ type, button: e.button, x: e.clientX, y: e.clientY, detail: e.detail });
  }, true);
}
window.addEventListener('wheel', e => send({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, x: e.clientX, y: e.clientY }), { capture: true, passive: true });
document.getElementById('text').addEventListener('input', e => send({ type: 'input', value: e.target.value }));
</script>`;

const FOCUS_STEALER_HTML = `<!doctype html><meta charset="utf-8"><title>TaroBird focus loss test</title>
<style>html,body{margin:0;height:100%;font:14px system-ui;background:#e8f0fe;padding:12px}</style>
<div>Synthetic foreground-loss test window</div>`;

let addon;
let service;
let win;
let stealerWin;
let seen = [];
let lostFocus = false;
let shuttingDown = false;
let sequence = 0;
const sentStreams = new Set();

const capture = {
  hooks: null,
  starts: [],
  resets: [],
  paused: [],
  stops: [],
  closed: false,
};

const inFront = () => !!win && !win.isDestroyed() && win.isVisible() && win.isFocused() && BrowserWindow.getFocusedWindow() === win;
const pageEval = script => win.webContents.executeJavaScript(script, true);
const waitUntil = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return Boolean(await fn());
};

async function startService() {
  const addonBytes = fs.readFileSync(addonFile);
  const addonSha256 = crypto.createHash('sha256').update(addonBytes).digest('hex');
  addon = createRequire(pathToFileURL(addonFile).href)(addonFile);
  const targetPlatform = addon.screenTargetPlatform?.() ?? null;
  const session = addon.screenSession();
  const monitors = addon.screenMonitors?.() ?? [];
  const physicalLeft = addon.screenPhysicalButton?.('left') ?? null;
  const cursor = (() => { try { return addon.screenCursor(); } catch { return null; } })();
  const displays = screen.getAllDisplays().map(d => ({
    id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, rotation: d.rotation,
  }));

  win = new BrowserWindow({
    width: 640, height: 420, show: false, alwaysOnTop: true, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false,
    title: 'TaroBird remote screen test',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, spellcheck: false, devTools: false },
  });
  win.setMenuBarVisibility(false);
  ipcMain.on('acc-seen', (_event, value) => { if (seen.length < 4000) seen.push(value); });
  win.on('blur', () => { if (!shuttingDown) lostFocus = true; });
  const pageFile = path.join(profileDir, 'acc-stage-page.html');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(pageFile, TEST_HTML);
  await win.loadFile(pageFile);
  win.center();
  win.show();
  win.focus();
  for (let waited = 0; waited < 5000 && !inFront(); waited += 100) {
    await sleep(100);
    if (!inFront()) win.focus();
  }
  const windowInFront = inFront();

  // Official ScreenService wired to real Electron + real native addon + real
  // Windows named pipe, paired with a synthetic captureHost (never captures real desktop).
  const electronBinding = { screen, powerMonitor, systemPreferences, shell };
  service = new ScreenService({
    electron: electronBinding,
    addon,
    stateDir: appState,
    platform: 'win32',
    hostControl: { ticket: id => screenServiceTicket(hostDir, id) },
    captureHost: hooks => Object.assign(capture, {
      hooks,
      start: async spec => {
        capture.starts.push({ sessionId: spec.sessionId, displayId: spec.displayId, encode: spec.encode });
        hooks.onMessage({ type: 'started', sessionId: spec.sessionId, cursor: 'always' });
      },
      reset: (id, generation) => { capture.resets.push([id, generation]); return true; },
      pause: (id, paused) => { capture.paused.push([id, paused]); return true; },
      keyframe: () => {},
      credit: () => {},
      stop: id => { capture.stops.push(id); },
      close: () => { capture.closed = true; },
    }),
  });
  await service.start();
  const registered = await waitUntil(() => service.status().registered === true, 12000);
  const status = service.status();

  return {
    addonSha256,
    preflight: {
      targetPlatform,
      session: {
        available: !!session.available,
        onConsole: !!session.onConsole,
        locked: !!session.locked,
        hasUnique: Boolean(session.unique),
      },
      interactive: targetPlatform === 'windows' && !!session.available && !!session.onConsole && !session.locked,
      windowInFront,
      monitorCount: monitors.length,
      monitors,
      displays,
      physicalLeft,
      cursor,
      bounds: win.getContentBounds(),
    },
    registered,
    status: {
      supported: status.supported,
      phase: status.phase,
      registered: status.registered,
      error: status.error ?? null,
      desktop: status.desktop ? {
        desktopId: status.desktop.desktopId,
        platform: status.desktop.platform,
        capture: status.desktop.capture,
        accessibility: status.desktop.accessibility,
        locked: status.desktop.locked,
        loginSessionPrefix: typeof status.desktop.loginSession === 'string' ? status.desktop.loginSession.slice(0, 4) : null,
        displayCount: status.desktop.displays.length,
        displays: status.desktop.displays.map(d => ({ id: d.id, width: d.width, height: d.height, scale: d.scale, revision: d.revision })),
      } : null,
    },
  };
}

async function emitSyntheticFrame({ sessionId, generation, size }) {
  const captureMs = Date.now();
  const streamKey = `${sessionId}:${generation}`;
  if (!sentStreams.has(streamKey)) {
    sentStreams.add(streamKey);
    capture.hooks.onMessage({
      type: 'stream',
      sessionId,
      stream: {
        type: 'stream',
        streamGeneration: generation,
        geometryRevision: 1,
        codec: 'h264',
        codecString: 'avc1.640028',
        width: size.width,
        height: size.height,
        contentRect: { x: 0, y: 0, width: size.width, height: size.height },
      },
    });
  }
  capture.hooks.onMessage({ type: 'captured', sessionId, captureMs });
  const seq = ++sequence;
  // Synthetic H.264 IDR NAL header only; no pixels from any real desktop.
  const payload = new Uint8Array([0, 0, 0, 1, 0x65, seq & 0xff, 0xaa, 0x55]);
  capture.hooks.onMessage({
    type: 'frame',
    sessionId,
    sequence: seq,
    streamGeneration: generation,
    captureMs,
    geometryRevision: 1,
    key: true,
    bytes: writeScreenFrame({
      key: true, codec: 'h264', sequence: seq, geometryRevision: 1,
      streamGeneration: generation, captureMs, width: size.width, height: size.height,
    }, payload),
  });
  return { sequence: seq, captureMs };
}

function windowPoint({ fx, fy, displayId }) {
  const bounds = win.getContentBounds();
  const page = { x: Math.round(bounds.width * fx), y: Math.round(bounds.height * fy) };
  const physical = screen.dipToScreenPoint({ x: bounds.x + page.x, y: bounds.y + page.y });
  const rect = service.geometry.physical(displayId);
  if (!rect) throw new Error('display_physical_rect_missing');
  const norm = {
    x: (physical.x - rect.x + 0.5) / rect.width,
    y: (physical.y - rect.y + 0.5) / rect.height,
  };
  return { inFront: inFront(), lostFocus, bounds, page, physical, rect, norm };
}

async function windowState() {
  const activeMarkerExists = await stat(path.join(appState, 'screen-control.active')).then(() => true, () => false);
  const heldJournal = readHeldJournal(path.join(appState, 'screen-control.held.log'));
  const pending = addon.screenReleasePending();
  const cursor = (() => { try { return addon.screenCursor(); } catch { return null; } })();
  const activeElement = win && !win.isDestroyed() ? await pageEval('document.activeElement && document.activeElement.id') : null;
  const textareaValue = win && !win.isDestroyed() ? await pageEval('document.getElementById("text").value') : null;
  return {
    inFront: inFront(),
    lostFocus,
    activeElement,
    textareaValue,
    seenCount: seen.length,
    pending,
    cursor,
    activeMarkerExists,
    heldJournal: { state: heldJournal.state, keys: heldJournal.keys ?? [], buttons: heldJournal.buttons ?? [] },
  };
}

async function triggerForegroundLoss() {
  lostFocus = false;
  stealerWin = new BrowserWindow({
    width: 320, height: 180, show: false, alwaysOnTop: true,
    title: 'TaroBird focus loss test',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  stealerWin.setMenuBarVisibility(false);
  const file = path.join(profileDir, 'acc-focus-stealer.html');
  fs.writeFileSync(file, FOCUS_STEALER_HTML);
  await stealerWin.loadFile(file);
  stealerWin.show();
  stealerWin.focus();
  await waitUntil(() => !inFront() && lostFocus, 2500);
  return {
    inFront: inFront(),
    lostFocus,
    stealerFocused: !stealerWin.isDestroyed() && stealerWin.isFocused(),
  };
}

async function closeFocusWindow() {
  if (stealerWin && !stealerWin.isDestroyed()) stealerWin.destroy();
  stealerWin = null;
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    await waitUntil(() => inFront(), 2500);
    lostFocus = false;
  }
  return { inFront: inFront() };
}

/** Record-only observations from Fable's Section 5 checklist. Never gates pass/fail. */
async function runObservations() {
  const obs = { skipped: false, reason: null };
  const session = addon.screenSession();
  if (!session.available || !session.onConsole || session.locked || !inFront()) {
    obs.skipped = true;
    obs.reason = !inFront() ? 'window_not_in_front' : 'session_not_interactive';
    return obs;
  }
  // Start clean monitor observation (service has no active lease now).
  addon.screenMonitorStart();
  await waitUntil(() => addon.screenMonitorPoll().alive, 1500);
  await sleep(250);
  addon.screenMonitorPoll(); // reset baseline counters
  try {
    // 1. NumLock: compare 0x145 (extended) vs 0x45 (plain), each tapped twice to preserve state.
    const box = windowPoint({ fx: 0.5, fy: 0.7, displayId: service.geometry.displays()[0].id });
    if (!inFront()) { obs.aborted = 'lost_front_before_numlock'; return obs; }
    addon.screenMouse('down', addon.screenPhysicalButton('left'), box.physical.x, box.physical.y, 1, 0);
    await sleep(30);
    addon.screenMouse('up', addon.screenPhysicalButton('left'), box.physical.x, box.physical.y, 1, 0);
    await sleep(150);
    obs.numLock = {};
    for (const [label, desc] of [['extended_0x145', 0x145], ['plain_0x45', 0x45]]) {
      if (!inFront()) break;
      const from = seen.length;
      for (let i = 0; i < 2; i++) {
        addon.screenKey(desc, true, 0, false, false); await sleep(35);
        addon.screenKey(desc, false, 0, false, false); await sleep(90);
      }
      obs.numLock[label] = seen.slice(from).filter(e => e.type === 'keydown' || e.type === 'keyup').map(e => ({
        type: e.type, code: e.code, key: e.key, numLock: e.numLock,
      }));
    }

    // 2. Same-pixel double move + wheel + click hook liveness check.
    if (inFront()) {
      const spot = windowPoint({ fx: 0.5, fy: 0.25, displayId: service.geometry.displays()[0].id });
      addon.screenMonitorPoll();
      addon.screenMouse('move', 'left', spot.physical.x, spot.physical.y, 1, 0);
      addon.screenMouse('move', 'left', spot.physical.x, spot.physical.y, 1, 0);
      addon.screenScroll(spot.physical.x, spot.physical.y, -120, 0, 0);
      addon.screenMouse('down', addon.screenPhysicalButton('left'), spot.physical.x, spot.physical.y, 1, 0);
      await sleep(30);
      addon.screenMouse('up', addon.screenPhysicalButton('left'), spot.physical.x, spot.physical.y, 1, 0);
      await sleep(400);
      obs.samePixelHook = addon.screenMonitorPoll();
    }

    // 3. Row pixel precision across 64 consecutive physical pixels inside test window.
    if (inFront()) {
      const start = windowPoint({ fx: 0.2, fy: 0.3, displayId: service.geometry.displays()[0].id });
      let exact = 0, offByOne = 0, other = 0, maxDelta = 0, tested = 0;
      for (let dx = 0; dx < 64 && inFront(); dx++) {
        const tx = start.physical.x + dx;
        const ty = start.physical.y;
        addon.screenMouse('move', 'left', tx, ty, 1, 0);
        const cur = addon.screenCursor();
        const delta = Math.max(Math.abs(cur.x - tx), Math.abs(cur.y - ty));
        if (delta === 0) exact++;
        else if (delta === 1) offByOne++;
        else other++;
        if (delta > maxDelta) maxDelta = delta;
        tested++;
      }
      obs.rowPrecision = { tested, exact, offByOne, other, maxDelta };
    }

    // 4. Timing of 1000 moves inside the test window.
    if (inFront()) {
      const a = windowPoint({ fx: 0.3, fy: 0.35, displayId: service.geometry.displays()[0].id });
      const t0 = performance.now();
      let count = 0;
      for (let i = 0; i < 1000 && inFront(); i++) {
        addon.screenMouse('move', 'left', a.physical.x + (i % 100), a.physical.y, 1, 0);
        count++;
      }
      const totalMs = Math.round((performance.now() - t0) * 100) / 100;
      obs.move1000 = { count, totalMs, avgMs: count ? Math.round((totalMs / count) * 1000) / 1000 : null };
    }

    // 5. Direct native addon input diagnostic (mouse vs key vs text under monitor, plus direct click/dblclick/text delivery).
    if (inFront()) {
      const dispId = service.geometry.displays()[0].id;
      const p1 = windowPoint({ fx: 0.35, fy: 0.25, displayId: dispId });
      const p2 = windowPoint({ fx: 0.45, fy: 0.25, displayId: dispId });
      const pBox = windowPoint({ fx: 0.5, fy: 0.7, displayId: dispId });
      const btn = addon.screenPhysicalButton('left');

      // Per-input-kind monitor poll breakdown (separating mouse move, mouse click, scan key, Unicode text).
      addon.screenMonitorPoll();
      await sleep(50);
      addon.screenMonitorPoll();

      addon.screenMouse('move', btn, p1.physical.x, p1.physical.y, 1, 0);
      await sleep(160);
      const pollMove = addon.screenMonitorPoll();

      addon.screenMouse('down', btn, p2.physical.x, p2.physical.y, 1, 0);
      await sleep(30);
      addon.screenMouse('up', btn, p2.physical.x, p2.physical.y, 1, 0);
      await sleep(160);
      const pollClick = addon.screenMonitorPoll();

      addon.screenKey(0x2a, true, 0, true, false);
      await sleep(30);
      addon.screenKey(0x2a, false, 0, true, false);
      await sleep(160);
      const pollKey = addon.screenMonitorPoll();

      // Click textarea, clear, test Unicode + Enter text delivery directly via addon.
      addon.screenMouse('down', btn, pBox.physical.x, pBox.physical.y, 1, 0);
      await sleep(30);
      addon.screenMouse('up', btn, pBox.physical.x, pBox.physical.y, 1, 0);
      await sleep(180);
      await pageEval('document.getElementById("text").value = ""; undefined');
      addon.screenMonitorPoll();
      const sampleText = 'hello 中文😀\nline2';
      addon.screenText(sampleText);
      await sleep(220);
      const pollText = addon.screenMonitorPoll();
      const activeEl = await pageEval('document.activeElement && document.activeElement.id');
      const gotText = await pageEval('document.getElementById("text").value');

      // Direct double-click delivery via addon.
      await sleep(700);
      const fromDbl = seen.length;
      for (let press = 1; press <= 2; press++) {
        addon.screenMouse('down', btn, p1.physical.x, p1.physical.y, press, 0);
        await sleep(30);
        addon.screenMouse('up', btn, p1.physical.x, p1.physical.y, press, 0);
        if (press === 1) await sleep(60);
      }
      await sleep(220);
      const dblTypes = seen.slice(fromDbl).filter(e => ['mousedown', 'mouseup', 'click', 'dblclick'].includes(e.type)).map(e => `${e.type}:${e.detail}`);

      obs.hookBreakdown = {
        mouseMove1: pollMove,
        mouseClick4: pollClick,
        keyShift2: pollKey,
        textUnicode: pollText,
        directText: { activeEl, expectedLen: sampleText.length, gotLen: gotText?.length ?? 0, match: gotText === sampleText },
        directDblClick: dblTypes,
      };
    }
  } finally {
    try { if (addon.screenReleasePending() > 0) addon.screenReleaseAll(); } catch { /* ignore */ }
    try { addon.screenMonitorStop(); } catch { /* ignore */ }
  }
  return obs;
}

/** Fires one mouse move + one ShiftLeft tap while an external read-only hook probe observes flags & dwExtraInfo. */
async function probeAddonInputs() {
  if (!inFront()) return { skipped: true };
  const dispId = service.geometry.displays()[0].id;
  const p = windowPoint({ fx: 0.4, fy: 0.3, displayId: dispId });
  addon.screenMouse('move', 'left', p.physical.x, p.physical.y, 1, 0);
  await sleep(60);
  addon.screenKey(0x2a, true, 0, true, false);
  await sleep(30);
  addon.screenKey(0x2a, false, 0, true, false);
  await sleep(60);
  return { skipped: false };
}

async function shutdown() {
  if (shuttingDown) return { pendingAtExit: 0 };
  shuttingDown = true;
  try { service?.dispose(); } catch { /* ignore */ }
  try { if (addon && addon.screenReleasePending() > 0) addon.screenReleaseAll(); } catch { /* ignore */ }
  const pendingAtExit = (() => { try { return addon ? addon.screenReleasePending() : null; } catch { return 'unknown'; } })();
  try { addon?.screenMonitorStop(); } catch { /* ignore */ }
  try { if (stealerWin && !stealerWin.isDestroyed()) stealerWin.destroy(); } catch { /* ignore */ }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  return { pendingAtExit };
}

async function handle(cmd) {
  switch (cmd.op) {
    case 'start-service': return startService();
    case 'wait-capture-start': {
      const ok = await waitUntil(() => capture.starts.length >= (cmd.count ?? 1), cmd.timeoutMs ?? 8000);
      return { ok, count: capture.starts.length, last: capture.starts.at(-1) ?? null };
    }
    case 'wait-capture-reset': {
      const ok = await waitUntil(() => capture.resets.length >= (cmd.count ?? 1), cmd.timeoutMs ?? 8000);
      return { ok, count: capture.resets.length, last: capture.resets.at(-1) ?? null };
    }
    case 'emit-frame': return emitSyntheticFrame(cmd);
    case 'window-point': return windowPoint(cmd);
    case 'window-state': return windowState();
    case 'get-seen': return { events: seen.slice(cmd.from ?? 0) };
    case 'clear-textarea': {
      await pageEval('document.getElementById("text").value = ""; undefined');
      return { ok: true };
    }
    case 'focus-textarea': {
      await pageEval('const el = document.getElementById("text"); el.value = ""; el.focus(); undefined');
      return { ok: true, activeElement: await pageEval('document.activeElement && document.activeElement.id') };
    }
    case 'trigger-foreground-loss': return triggerForegroundLoss();
    case 'close-focus-window': return closeFocusWindow();
    case 'run-observations': return runObservations();
    case 'probe-addon-inputs': return probeAddonInputs();
    case 'shutdown': {
      const res = await shutdown();
      setTimeout(() => app.exit(0), 50);
      return res;
    }
    default: throw new Error(`unknown_op:${cmd.op}`);
  }
}

app.whenReady().then(() => {
  const hardLimit = setTimeout(async () => {
    await shutdown();
    emitMsg({ event: 'timeout' });
    app.exit(1);
  }, 90000);
  hardLimit.unref?.();

  if (!rpcUrl) {
    app.exit(2);
    return;
  }
  rpcWs = new WebSocket(rpcUrl);
  rpcWs.on('open', () => {
    emitMsg({ event: 'ready' });
  });
  rpcWs.on('message', async raw => {
    let cmd;
    try { cmd = JSON.parse(String(raw)); } catch { return; }
    try {
      const result = await handle(cmd);
      emitMsg({ id: cmd.id, ok: true, result });
    } catch (error) {
      emitMsg({ id: cmd.id, ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  });
  rpcWs.on('error', async () => {
    await shutdown();
    app.exit(1);
  });
  rpcWs.on('close', async () => {
    if (!shuttingDown) {
      await shutdown();
      app.exit(0);
    }
  });
});

app.on('window-all-closed', () => { /* controlled by shutdown command */ });
