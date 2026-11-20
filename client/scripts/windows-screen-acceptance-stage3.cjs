// Windows remote-screen target, stage 3: REAL input, into ONE visible test
// window that this program creates, and nowhere else.
//
//   electron.exe stage3-test-window.cjs <path-to-tarobot-desktop-native.node>
//
// What it does: opens a small always-on-top window titled "TaroBird remote
// screen test", waits until that window is the foreground window, installs the
// local-takeover monitor, then posts a short fixed list of pointer, wheel, key
// and text events at points inside that window, and writes down what the page
// in the window actually received. It prints one JSON object and exits.
//
// What it never does: post anything before its own window is in front; post at
// a point outside that window; press the Windows key, Alt, Tab or Escape (they
// would leave the window); read the screen; touch the installed App or its data.
// It stops at once, lifting what it holds, if the window loses the foreground,
// if the monitor reports input from anyone else, or after 45 seconds.
'use strict';
const path = require('node:path'), crypto = require('node:crypto'), fs = require('node:fs');
const { app, BrowserWindow, screen, ipcMain } = require('electron');
const file = path.resolve(process.argv.find((value, index) => index > 0 && value.endsWith('.node')) ?? 'tarobot-desktop-native.node');
const profile = path.join(__dirname, 'electron-profile');
app.setPath('userData', profile); app.setPath('sessionData', profile);

const E0 = 0x100, KEY = { KeyA: 0x1e, ShiftLeft: 0x2a, ControlRight: E0 | 0x1d, ArrowLeft: E0 | 0x4b, Numpad4: 0x4b, NumLock: E0 | 0x45 };
const out = { stage: 'windows-screen-stage3-test-window', file: path.basename(file), versions: { electron: process.versions.electron, node: process.versions.node },
  steps: [], posted: [], monitor: { foreign: 0, interrupted: 0, polls: 0 }, aborted: null };
let addon, win, seen = [], stopped = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name, ok, detail) => { out.steps.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); return !!ok; };
/** Counts are reset by every native poll, so they are added up here, in one place. */
function poll() {
  const value = addon.screenMonitorPoll(); out.monitor.polls++;
  out.monitor.foreign += value.foreign; out.monitor.interrupted += value.interrupted; out.monitor.last = { alive: value.alive, failed: value.failed };
  return value;
}
class Stop extends Error {}
const inFront = () => !!win && !win.isDestroyed() && win.isVisible() && win.isFocused() && BrowserWindow.getFocusedWindow() === win;
/** Before every single post: this window is in front, and nobody else has touched the computer. */
function clear() {
  if (stopped) throw new Stop('stopped');
  if (!inFront()) throw new Stop('test_window_not_in_front');
  poll();
  if (out.monitor.foreign) throw new Stop('input_from_someone_else');
}
/** A point of the page, as a fraction of its size, in physical screen pixels and in page pixels. */
function at(fx, fy) {
  const bounds = win.getContentBounds(), page = { x: Math.round(bounds.width * fx), y: Math.round(bounds.height * fy) };
  const physical = screen.dipToScreenPoint({ x: bounds.x + page.x, y: bounds.y + page.y });
  return { page, physical };
}
const post = (name, ...args) => { clear(); out.posted.push([name, ...args]); return addon[name](...args); };
const mouse = (action, button, point) => post('screenMouse', action, button, point.physical.x, point.physical.y, 1, 0);
const key = (code, down) => post('screenKey', KEY[code], down, 0, ['ShiftLeft', 'ControlRight'].includes(code), false);
async function tap(code) { key(code, true); await sleep(40); key(code, false); await sleep(120); }
/** What the page received since `from`, of the given kinds. */
const got = (from, ...kinds) => seen.slice(from).filter(event => kinds.includes(event.type));
const page = script => win.webContents.executeJavaScript(script, true);
const near = (event, point) => !!event && Math.abs(event.x - point.page.x) <= 2 && Math.abs(event.y - point.page.y) <= 2;

const HTML = `<!doctype html><meta charset="utf-8"><title>TaroBird remote screen test</title>
<style>html,body{margin:0;height:100%;font:14px system-ui;background:#fffbe6}#note{padding:10px}textarea{position:absolute;left:10%;top:55%;width:80%;height:30%}</style>
<div id="note"><b>TaroBird remote screen test.</b> This window receives a few seconds of scripted input and closes. Please do not use the computer while it is open.</div>
<textarea id="text" spellcheck="false"></textarea>
<script>
const { ipcRenderer } = require('electron');
const send = value => ipcRenderer.send('seen', value);
for (const type of ['keydown', 'keyup']) window.addEventListener(type, e => send({ type, code: e.code, key: e.key, location: e.location, repeat: e.repeat }), true);
for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'mousemove']) window.addEventListener(type, e => { if (type === 'contextmenu') e.preventDefault(); send({ type, button: e.button, x: e.clientX, y: e.clientY, detail: e.detail }); }, true);
window.addEventListener('wheel', e => send({ type: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, x: e.clientX, y: e.clientY }), { capture: true, passive: true });
document.getElementById('text').addEventListener('input', e => send({ type: 'input', value: e.target.value }));
</script>`;

async function scripted() {
  // 1. Pointer position: centre, then near each corner. The page reports where it saw the pointer.
  for (const [fx, fy] of [[0.5, 0.25], [0.1, 0.1], [0.9, 0.1], [0.1, 0.45], [0.9, 0.45]]) {
    const point = at(fx, fy), from = seen.length;
    mouse('move', 'left', point); await sleep(180);
    const moved = got(from, 'mousemove').at(-1), cursor = addon.screenCursor();
    record(`pointer lands where asked (${fx}, ${fy})`, near(moved, point) && cursor.x === point.physical.x && cursor.y === point.physical.y, { asked: point, pageSaw: moved ?? null, cursor });
  }
  // 2. Buttons. A click, two clicks close together, and the secondary button.
  const spot = at(0.5, 0.25);
  let from = seen.length;
  mouse('down', addon.screenPhysicalButton('left'), spot); await sleep(40); mouse('up', addon.screenPhysicalButton('left'), spot); await sleep(200);
  record('main button: down, up and click at the point', got(from, 'mousedown', 'mouseup', 'click').map(e => e.type).join() === 'mousedown,mouseup,click' && got(from, 'click').every(e => e.button === 0 && near(e, spot)), got(from, 'mousedown', 'mouseup', 'click'));
  await sleep(700);  // well outside the double-click time, so the next pair starts clean
  from = seen.length;
  for (let press = 0; press < 2; press++) { mouse('down', addon.screenPhysicalButton('left'), spot); await sleep(30); mouse('up', addon.screenPhysicalButton('left'), spot); await sleep(70); }
  await sleep(200);
  record('two presses close together are a double click', got(from, 'dblclick').length === 1, got(from, 'click', 'dblclick'));
  from = seen.length;
  mouse('down', addon.screenPhysicalButton('right'), spot); await sleep(40); mouse('up', addon.screenPhysicalButton('right'), spot); await sleep(250);
  record('secondary button opens the context menu event', got(from, 'contextmenu').length === 1 && got(from, 'mousedown').every(e => e.button === 2), got(from, 'mousedown', 'mouseup', 'contextmenu'));
  // 3. Wheel. One notch each way; the page reports the sign and size it saw.
  for (const [name, vertical, horizontal, check] of [['wheel towards the user scrolls down', -120, 0, e => e.dy > 0 && e.dx === 0], ['wheel away scrolls up', 120, 0, e => e.dy < 0 && e.dx === 0], ['wheel right scrolls right', 0, 120, e => e.dx > 0], ['a tenth of a notch still arrives', -12, 0, e => e.dy > 0]]) {
    from = seen.length; post('screenScroll', spot.physical.x, spot.physical.y, vertical, horizontal, 0); await sleep(220);
    const wheel = got(from, 'wheel'); record(name, wheel.length >= 1 && wheel.every(check), { asked: { vertical, horizontal }, pageSaw: wheel });
  }
  // 4. Keys. Click into the text box first, with the pointer.
  const box = at(0.5, 0.7);
  mouse('down', addon.screenPhysicalButton('left'), box); await sleep(40); mouse('up', addon.screenPhysicalButton('left'), box); await sleep(250);
  record('the text box has the keyboard', await page('document.activeElement && document.activeElement.id') === 'text');
  from = seen.length; await tap('KeyA');
  record('a letter key arrives as its position', got(from, 'keydown')[0]?.code === 'KeyA' && got(from, 'keyup')[0]?.code === 'KeyA', got(from, 'keydown', 'keyup'));
  from = seen.length; key('ShiftLeft', true); await sleep(40); await tap('KeyA'); key('ShiftLeft', false); await sleep(150);
  record('Shift held by this program applies to the next key', got(from, 'keydown').map(e => e.code).join() === 'ShiftLeft,KeyA' && got(from, 'keydown')[1]?.key !== got(from, 'keydown')[1]?.key.toLowerCase(), got(from, 'keydown', 'keyup'));
  for (const [code, expected] of [['ControlRight', 'ControlRight'], ['ArrowLeft', 'ArrowLeft'], ['Numpad4', 'Numpad4']]) {
    from = seen.length; await tap(code);
    record(`${code} arrives as ${expected}, not as its plain or extended twin`, got(from, 'keydown')[0]?.code === expected, got(from, 'keydown', 'keyup'));
  }
  // Num Lock is pressed twice, so the computer's Num Lock state ends as it began.
  from = seen.length; await tap('NumLock'); await tap('NumLock');
  record('the extended 0x45 scan code is Num Lock, not Pause', got(from, 'keydown').length === 2 && got(from, 'keydown').every(e => e.code === 'NumLock'), got(from, 'keydown'));
  // 5. Text, as Unicode and with a real Enter.
  await page('document.getElementById("text").value = ""; undefined');
  post('screenText', '中文😀 ok'); await sleep(350);
  const typed = await page('document.getElementById("text").value');
  record('Unicode text arrives whole and in order', typed === '中文😀 ok', { expected: '中文😀 ok', pageHas: typed });
  post('screenText', 'x\ny'); await sleep(350);
  const lines = await page('document.getElementById("text").value');
  record('a line break in text is a real Enter', lines === '中文😀 okx\ny', { pageHas: lines });
  // 6. Holding and releasing.
  from = seen.length; key('ShiftLeft', true); await sleep(80);
  const held = addon.screenReleasePending();
  clear(); out.posted.push(['screenReleaseAll']); const lifted = addon.screenReleaseAll(); await sleep(200);
  record('release lifts what is held and nothing stays pending', held === 1 && lifted === 1 && addon.screenReleasePending() === 0 && got(from, 'keyup').some(e => e.code === 'ShiftLeft'), { held, lifted, pendingAfter: addon.screenReleasePending(), pageSaw: got(from, 'keydown', 'keyup') });
  // 7. The monitor saw this program's own input and counted none of it as someone else's.
  await sleep(450); const last = poll();
  record('the monitor is alive and saw no one else', last.alive && !last.failed && out.monitor.foreign === 0 && out.monitor.interrupted === 0, { ...out.monitor });
}

async function main() {
  record('addon sha256', true, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  addon = require(file);
  const session = addon.screenSession();
  if (!record('the session can be controlled', addon.screenTargetPlatform() === 'windows' && session.available && session.onConsole && !session.locked, { available: session.available, onConsole: session.onConsole, locked: session.locked })) return;
  win = new BrowserWindow({ width: 640, height: 420, show: false, alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, title: 'TaroBird remote screen test',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, spellcheck: false, devTools: false } });
  win.setMenuBarVisibility(false);
  ipcMain.on('seen', (_event, value) => { if (seen.length < 2000) seen.push(value); });
  win.on('blur', () => { if (!stopped && out.steps.length > 2) out.lostFocusAt = out.posted.length; });
  // The page is a file next to this script, inside the same throw-away directory.
  const pageFile = path.join(__dirname, 'stage3-page.html'); fs.writeFileSync(pageFile, HTML);
  await win.loadFile(pageFile);
  win.center(); win.show(); win.focus();
  // Windows decides whether a new window may take the foreground. If it does not, nothing is posted at all.
  for (let waited = 0; waited < 5000 && !inFront(); waited += 100) { await sleep(100); if (!inFront()) win.focus(); }
  if (!record('the test window is the foreground window', inFront(), { bounds: win.getContentBounds() })) { out.aborted = 'test_window_not_in_front'; return; }
  addon.screenMonitorStart();
  for (let waited = 0; waited < 1500 && !poll().alive; waited += 50) await sleep(50);
  if (!record('the local-input monitor started', out.monitor.last.alive && !out.monitor.last.failed, { ...out.monitor })) { out.aborted = 'monitor_not_alive'; return; }
  await sleep(400); poll();
  if (!record('nobody is using the computer right now', out.monitor.foreign === 0, { foreign: out.monitor.foreign })) { out.aborted = 'input_from_someone_else'; return; }
  await scripted();
}

function finish() {
  if (stopped) return; stopped = true;
  // Whatever happened: lift what this program holds, stop the monitor, close the window.
  try { if (addon && addon.screenReleasePending() > 0) { out.posted.push(['screenReleaseAll (cleanup)']); addon.screenReleaseAll(); } } catch (error) { out.cleanupError = String(error && error.message || error).slice(0, 120); }
  try { out.pendingAtExit = addon ? addon.screenReleasePending() : null; } catch { out.pendingAtExit = 'unknown'; }
  try { addon && addon.screenMonitorStop(); } catch { /* not started */ }
  try { win && !win.isDestroyed() && win.destroy(); } catch { /* already gone */ }
  out.received = seen.filter(event => event.type !== 'mousemove').slice(0, 300);
  out.passed = out.steps.filter(step => step.ok).length; out.failed = out.steps.filter(step => !step.ok).map(step => step.name);
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  app.exit(out.aborted || out.failed.length ? 1 : 0);
}
app.whenReady().then(async () => {
  const limit = setTimeout(() => { out.aborted ??= 'time_limit'; finish(); }, 45000);
  try { await main(); }
  catch (error) { out.aborted ??= error instanceof Stop ? error.message : 'error'; out.error = String(error && error.message || error).slice(0, 200); }
  clearTimeout(limit); finish();
});
app.on('window-all-closed', () => { /* the script decides when to exit */ });
