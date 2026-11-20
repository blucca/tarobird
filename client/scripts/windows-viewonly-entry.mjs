// ACCEPTANCE-ONLY standby entry (#48 view-only). A minimal, time-limited
// Windows remote-screen target for checking that a phone sees frames:
//   electron <bundle> --addon <tarobot-desktop-native.node> --host-dir <existing isolated Hub state dir>
//                     --app-state <new empty dir> [--minutes 15]
// - Registers the product ScreenService with an EXISTING isolated Hub through
//   its named pipe (screenServiceTicket). It creates no invitation, pairing,
//   grant or approval; the Hub's own grants decide who may view.
// - Pixels come only from this entry's own visible synthetic window (its
//   WebFrameMain is the capture source, as in electron/tests/screen-capture-
//   smoke-main.mjs). desktopCapturer is never called, so the desktop is never
//   captured.
// - View only: every native input entry point (mouse, scroll, key, text,
//   and the local-takeover monitor start) throws before reaching
//   Windows, so a control request is refused (screen_takeover_unavailable)
//   and nothing is ever posted. No hooks, no diagnostics, no RPC, no other mode.
// - Exits by itself after --minutes (1..30, default 15). Logs codes and counts only.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as electron from 'electron';
import { SCHEMES } from '../electron/assets.mjs';
import { ScreenService } from '../electron/screen-service.mjs';
import { ScreenCaptureHost } from '../electron/screen-capture-host.mjs';
import { screenServiceTicket } from '../electron/screen-host-control.mjs';

const { app, BrowserWindow, protocol } = electron;
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined; };
const addonFile = path.resolve(arg('addon') ?? '');
const hostDir = path.resolve(arg('host-dir') ?? '');
const appState = path.resolve(arg('app-state') ?? '');
const minutes = Math.min(30, Math.max(1, Number.parseInt(arg('minutes') ?? '15', 10) || 15));
const here = path.dirname(process.argv[1] ? path.resolve(process.argv[1]) : process.cwd());
const log = (code, extra = '') => console.log(`viewonly: ${code}${extra ? ` ${extra}` : ''}`);

if (process.platform !== 'win32' || !arg('addon') || !arg('host-dir') || !arg('app-state')) {
  log('refused', 'requires Windows and --addon, --host-dir, --app-state');
  process.exit(2);
}
protocol.registerSchemesAsPrivileged(SCHEMES);
mkdirSync(appState, { recursive: true });
app.setPath('userData', path.join(appState, 'profile'));
app.setPath('sessionData', path.join(appState, 'profile'));

// The product addon behind a view-only facade: reads pass through; anything
// that would post input or start the takeover monitor throws first.
const VIEW_ONLY_BLOCKED = new Set(['screenMouse', 'screenScroll', 'screenKey', 'screenText', 'screenMonitorStart']);
let blocked = 0;
function viewOnly(addon) {
  return new Proxy(addon, { get(target, key) {
    if (typeof key === 'string' && VIEW_ONLY_BLOCKED.has(key)) {
      // Kept truthy so the facade looks like a target; calling it never reaches Windows.
      return () => { blocked++; log('input_refused', key); throw new Error('view_only_entry'); };
    }
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>TaroBird view-only test</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;font:600 28px system-ui;color:#fff}
.q{position:fixed;width:50%;height:50%}#c{position:fixed;left:40%;top:40%;width:20%;height:20%}#m{position:fixed;left:0;top:0;width:4%;height:3%;background:#fff}
#t{position:fixed;right:2%;bottom:2%;background:rgba(0,0,0,.55);padding:6px 12px;border-radius:8px}</style>
<div class="q" style="left:0;top:0;background:rgb(220,40,40)"></div><div class="q" style="left:50%;top:0;background:rgb(40,170,60)"></div>
<div class="q" style="left:0;top:50%;background:rgb(40,80,220)"></div><div class="q" style="left:50%;top:50%;background:rgb(235,205,40)"></div>
<div id="c" style="background:rgb(200,40,200)"></div><div id="m"></div><div id="t">VIEW-ONLY TEST</div>
<script>let on=false,x=0;const c=document.getElementById('c'),m=document.getElementById('m'),t=document.getElementById('t'),end=Date.now()+${minutes}*60000;
setInterval(()=>{on=!on;c.style.background=on?'rgb(40,200,210)':'rgb(200,40,200)';const s=Math.max(0,Math.round((end-Date.now())/1000));t.textContent='VIEW-ONLY TEST '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');},400);
const step=()=>{x=(x+0.5)%96;m.style.left=x+'%';requestAnimationFrame(step);};requestAnimationFrame(step);</script>`;

let service, win, stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  try { service?.dispose(); } catch { /* best effort */ }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  log('stopped', `${code} blockedInputCalls=${blocked}`);
  setTimeout(() => app.exit(0), 100);
}

app.whenReady().then(async () => {
  const addon = viewOnly(createRequire(pathToFileURL(addonFile).href)(addonFile));
  win = new BrowserWindow({ width: 960, height: 540, show: false, resizable: false, maximizable: false, fullscreenable: false, title: 'TaroBird view-only test',
    backgroundColor: '#000000', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, devTools: false, spellcheck: false } });
  win.setMenuBarVisibility(false);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.show();
  win.on('closed', () => { void stop('window_closed'); });
  service = new ScreenService({ electron, addon, stateDir: appState, log: code => log('service', String(code).slice(0, 64)),
    hostControl: { ticket: id => screenServiceTicket(hostDir, id) },
    captureHost: hooks => new ScreenCaptureHost({ electron, root: path.join(here, 'screen-capture'), preload: path.join(here, 'screen-capture-preload.cjs'),
      // Only this entry's own window: never the desktop.
      resolveSource: async () => (win && !win.isDestroyed() ? win.webContents.mainFrame : undefined), ...hooks }),
    onSharing: items => log('sharing', `sessions=${items.length} controlling=${items.filter(i => i.controlling).length}`) });
  await service.start();
  const status = service.status();
  log('started', `registered=${status.registered} phase=${status.phase} error=${status.error ?? 'none'} minutes=${minutes}`);
  setTimeout(() => { void stop('time_limit'); }, minutes * 60000).unref?.();
}).catch(error => { log('failed', String(error?.message ?? error).slice(0, 120)); void stop('failed'); });
app.on('window-all-closed', () => { void stop('windows_closed'); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(signal); });
