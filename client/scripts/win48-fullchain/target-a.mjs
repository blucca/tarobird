// ACCEPTANCE-ONLY (#48 full chain), controlled side A on a DISPOSABLE runner.
// Product ScreenService wired exactly like client/electron/main.mjs: real
// ScreenCaptureHost + desktopSource(desktopCapturer) whole-display capture and
// the REAL native addon (real Windows input). Plus one owned test window
// (colour blocks, event log, textarea) that the remote input must reach.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as electron from 'electron';
import { WebSocket } from 'ws';
import { SCHEMES } from '../../electron/assets.mjs';
import { ScreenService } from '../../electron/screen-service.mjs';
import { ScreenCaptureHost, desktopSource } from '../../electron/screen-capture-host.mjs';
import { screenServiceTicket } from '../../electron/screen-host-control.mjs';
import { readHeldJournal } from '../../electron/screen-held-journal.mjs';

const { app, BrowserWindow, ipcMain, protocol, screen } = electron;
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const addonFile = path.resolve(arg('addon')), hostDir = path.resolve(arg('host-dir')), appState = path.resolve(arg('app-state')), assets = path.resolve(arg('assets'));
protocol.registerSchemesAsPrivileged(SCHEMES);
app.setPath('userData', path.join(appState, 'profile')); app.setPath('sessionData', path.join(appState, 'profile'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let rpc, service, win, addon; const seen = []; const mouseCalls = []; const resolveCalls = []; const captureEvents = [];
const TEST = `<!doctype html><meta charset="utf-8"><title>TaroBird full-chain test window</title>
<style>html,body{margin:0;height:100%;overflow:hidden;font:14px system-ui;background:#111}
.q{position:absolute;width:50%;height:30%}#t{position:absolute;left:5%;top:66%;width:88%;height:28%;font:16px system-ui}</style>
<div class="q" style="left:0;top:0;background:rgb(220,40,40)"></div><div class="q" style="left:50%;top:0;background:rgb(40,170,60)"></div>
<div class="q" style="left:0;top:30%;background:rgb(40,80,220)"></div><div class="q" style="left:50%;top:30%;background:rgb(235,205,40)"></div>
<textarea id="t" spellcheck="false">seed text</textarea>
<script>const {ipcRenderer}=require('electron');const s=v=>ipcRenderer.send('seen',v);
for(const k of ['mousedown','mouseup','click','dblclick','contextmenu']) addEventListener(k,e=>{if(k==='contextmenu')e.preventDefault();s({type:k,button:e.button,x:e.clientX,y:e.clientY,detail:e.detail});},true);
let lm=0;addEventListener('mousemove',e=>{const n=Date.now();if(n-lm>30||e.buttons){lm=n;s({type:'mousemove',x:e.clientX,y:e.clientY,buttons:e.buttons});}},true);
addEventListener('wheel',e=>s({type:'wheel',dx:e.deltaX,dy:e.deltaY,x:e.clientX,y:e.clientY}),{capture:true,passive:true});
for(const k of ['keydown','keyup']) addEventListener(k,e=>s({type:k,code:e.code,key:e.key,ctrl:e.ctrlKey,meta:e.metaKey,alt:e.altKey,shift:e.shiftKey}),true);
const t=document.getElementById('t');t.addEventListener('input',()=>s({type:'input',value:t.value}));
document.addEventListener('selectionchange',()=>{if(document.activeElement===t)s({type:'selection',start:t.selectionStart,end:t.selectionEnd,len:t.value.length});});</script>`;
async function start() {
  const real = createRequire(pathToFileURL(addonFile).href)(addonFile);
  // Read-only tap: every call is passed through unchanged; only the mouse call shape is recorded.
  addon = Object.create(real); addon.screenMouse = (...args) => { if (mouseCalls.length < 2000) mouseCalls.push({ at: Date.now(), action: args[0], button: args[1], x: args[2], y: args[3] }); return real.screenMouse(...args); };
  const display = screen.getPrimaryDisplay();
  // --no-activate: a window Windows never activates (WS_EX_NOACTIVATE via focusable:false); mouse input still arrives.
  const noActivate = process.argv.includes('--no-activate');
  win = new BrowserWindow({ x: 0, y: 0, width: 500, height: 720, frame: false, resizable: false, show: false, alwaysOnTop: true, skipTaskbar: noActivate, focusable: !noActivate,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, spellcheck: false, backgroundThrottling: false } });
  ipcMain.on('seen', (_e, v) => { if (seen.length < 6000) seen.push({ at: Date.now(), ...v }); });
  const file = path.join(appState, 'test-window.html'); fs.writeFileSync(file, TEST);
  await win.loadFile(file); win.setBounds({ x: 0, y: 0, width: 500, height: 720 }); if (noActivate) win.showInactive(); else win.show(); await sleep(800);
  service = new ScreenService({ electron, addon, stateDir: appState, log: code => captureEvents.push({ log: String(code).slice(0, 80) }),
    hostControl: { ticket: id => screenServiceTicket(hostDir, id) },
    captureHost: hooks => new ScreenCaptureHost({ electron, root: path.join(assets, 'screen-capture'), preload: path.join(assets, 'screen-capture-preload.cjs'),
      resolveSource: async d => { const s = await desktopSource(electron.desktopCapturer, d); resolveCalls.push({ nativeId: d.nativeId, matched: !!s }); return s; }, ...hooks,
      onMessage: m => { if (m?.type === 'ended' || m?.type === 'started' || m?.type === 'stream') captureEvents.push({ type: m.type, reason: m.reason, detail: m.detail, codec: m.stream?.codec, w: m.stream?.width ?? m.width, h: m.stream?.height ?? m.height }); hooks.onMessage(m); } }),
    onSharing: items => captureEvents.push({ type: 'sharing', count: items.length, controlling: items.filter(i => i.controlling).length }) });
  await service.start();
  for (let i = 0; i < 150 && service.status().registered !== true; i++) await sleep(100);
  const st = service.status(), session = addon.screenSession();
  return { registered: st.registered === true, phase: st.phase, error: st.error ?? null, platform: st.desktop?.platform, displays: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor })),
    session: { available: !!session.available, onConsole: !!session.onConsole, locked: !!session.locked }, addonSha256: crypto.createHash('sha256').update(fs.readFileSync(addonFile)).digest('hex'), primary: display.bounds };
}
async function info() {
  const c = win.getContentBounds();
  const rect = await win.webContents.executeJavaScript(`(()=>{const r=document.getElementById('t').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,iw:innerWidth,ih:innerHeight,focused:document.activeElement&&document.activeElement.id};})()`, true);
  return { content: c, textarea: rect, value: await win.webContents.executeJavaScript(`document.getElementById('t').value`, true), focused: win.isFocused() };
}
async function handle(cmd) {
  switch (cmd.op) {
    case 'start': return start();
    case 'info': return info();
    case 'seen': return { events: seen.slice(cmd.from ?? 0), count: seen.length };
    case 'held': { const j = readHeldJournal(path.join(appState, 'screen-control.held.log')); return { journal: JSON.parse(JSON.stringify(j)), active: fs.existsSync(path.join(appState, 'screen-control.active')), focusedWindow: !!BrowserWindow.getFocusedWindow() }; }
    case 'mouse-calls': return { calls: mouseCalls.filter(c => c.at >= (cmd.since ?? 0)) };
    case 'diag': return { resolveCalls, captureEvents: captureEvents.slice(-40), status: { registered: service?.status().registered, phase: service?.status().phase } };
    case 'shutdown': { try { service?.dispose(); } catch {} setTimeout(() => app.exit(0), 50); return { ok: true }; }
    default: throw new Error('unknown_op');
  }
}
app.whenReady().then(() => {
  setTimeout(() => app.exit(1), 30 * 60000).unref?.();
  // Main-thread heartbeat on stdout: the orchestrator measures gaps (a blocked main loop).
  setInterval(() => process.stdout.write(`HB ${Date.now()}\n`), 200);
  rpc = new WebSocket(arg('rpc-url'));
  rpc.on('open', () => rpc.send(JSON.stringify({ event: 'ready' })));
  rpc.on('message', async raw => { let c; try { c = JSON.parse(String(raw)); } catch { return; }
    try { rpc.send(JSON.stringify({ id: c.id, ok: true, result: await handle(c) })); } catch (e) { rpc.send(JSON.stringify({ id: c.id, ok: false, error: String(e?.message ?? e).slice(0, 300) })); } });
  rpc.on('close', () => { try { service?.dispose(); } catch {} app.exit(0); });
});
app.on('window-all-closed', () => {});
