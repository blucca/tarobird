// ACCEPTANCE-ONLY (#48 E4). Isolated Electron target for a DISPOSABLE
// GitHub-hosted Windows runner. Wires the product ScreenService exactly like
// client/electron/main.mjs: the real ScreenCaptureHost whose resolveSource is
// the product desktopSource(electron.desktopCapturer, display). Before any
// capture it covers every runner display with ONE owned full-screen colour
// test window (fixed colour blocks + one toggling block, no text, no data), so
// the only pixels the capture sees are this window's.
//
// No input of any kind is posted: the viewer is granted view only, nothing
// here calls an injection, hook or keyboard API. Thumbnails are never
// requested (0x0). Decoded pixels are reduced to a few averaged RGB samples;
// no image is written to disk or sent anywhere except the parent's report.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as electron from 'electron';
import { WebSocket } from 'ws';
import { SCHEMES } from '../electron/assets.mjs';
import { ScreenService } from '../electron/screen-service.mjs';
import { ScreenCaptureHost, desktopSource } from '../electron/screen-capture-host.mjs';
import { screenServiceTicket } from '../electron/screen-host-control.mjs';

const { app, BrowserWindow, protocol, screen, session } = electron;

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--') && i + 1 < argv.length) out[argv[i].slice(2)] = argv[++i];
  return out;
}
const args = parseCli(process.argv.slice(1));
const addonFile = path.resolve(args.addon || '');
const hostDir = path.resolve(args['host-dir'] || '');
const appState = path.resolve(args['app-state'] || '');
const assets = path.resolve(args.assets || '');
const profileDir = path.resolve(args.profile || path.join(appState, 'electron-profile'));
const rpcUrl = args['rpc-url'] || '';

// As in main.mjs: the capture renderer's scheme must be privileged before ready.
protocol.registerSchemesAsPrivileged(SCHEMES);
app.setPath('userData', profileDir);
app.setPath('sessionData', profileDir);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let rpcWs = null;
const emitMsg = payload => { if (rpcWs?.readyState === WebSocket.OPEN) rpcWs.send(JSON.stringify(payload)); };

/** Per-display colour layout. Quadrants rotate with the display index so a
 * session on display k must decode display k's order (display-id mapping). */
const BASE_QUADS = [[220, 40, 40], [40, 170, 60], [40, 80, 220], [235, 205, 40]];
const TOGGLE = [[200, 40, 200], [40, 200, 210]];
const quadsFor = index => BASE_QUADS.map((_, i) => BASE_QUADS[(i + index) % BASE_QUADS.length]);
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const testHtml = index => {
  const [tl, tr, bl, br] = quadsFor(index);
  return `<!doctype html><meta charset="utf-8"><title>TaroBird capture acceptance</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:none;background:#000}
.q{position:fixed;width:50%;height:50%}#c{position:fixed;left:40%;top:40%;width:20%;height:20%}
#m{position:fixed;left:0;top:0;width:4%;height:3%;background:#fff}</style>
<div class="q" style="left:0;top:0;background:${rgb(tl)}"></div><div class="q" style="left:50%;top:0;background:${rgb(tr)}"></div>
<div class="q" style="left:0;top:50%;background:${rgb(bl)}"></div><div class="q" style="left:50%;top:50%;background:${rgb(br)}"></div>
<div id="c" style="background:${rgb(TOGGLE[0])}"></div><div id="m"></div>
<script>let on=false;const c=document.getElementById('c'),m=document.getElementById('m');setInterval(()=>{on=!on;c.style.background=on?'${rgb(TOGGLE[1])}':'${rgb(TOGGLE[0])}';},400);
let x=0;const step=()=>{x=(x+0.5)%96;m.style.left=x+'%';requestAnimationFrame(step);};requestAnimationFrame(step);</script>`;
};

const DECODER_HTML = `<!doctype html><meta charset="utf-8"><title>decoder</title><script>
window.__frames=[];
window.__push=b64=>{window.__frames.push(b64);return window.__frames.length;};
window.__decode=async(codec,points)=>{
 const frames=window.__frames.splice(0),out=[],errors=[];let canvas,ctx;
 const decoder=new VideoDecoder({output:f=>{try{const w=f.displayWidth,h=f.displayHeight;
  if(!canvas||canvas.width!==w||canvas.height!==h){canvas=new OffscreenCanvas(w,h);ctx=canvas.getContext('2d',{willReadFrequently:true});}
  ctx.drawImage(f,0,0);
  const s=points.map(([px,py])=>{const x=Math.min(w-3,Math.max(2,Math.round(px*w))),y=Math.min(h-3,Math.max(2,Math.round(py*h)));
   const d=ctx.getImageData(x-2,y-2,5,5).data;let r=0,g=0,b=0;for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];}
   const n=d.length/4;return[Math.round(r/n),Math.round(g/n),Math.round(b/n)];});
  out.push({seq:f.timestamp,w,h,s});}catch(e){errors.push('sample:'+String(e&&e.message||e).slice(0,100));}finally{f.close();}},
  error:e=>errors.push(String(e&&e.message||e).slice(0,120))});
 try{decoder.configure({codec,optimizeForLatency:true,hardwareAcceleration:'no-preference'});}catch(e){return{submitted:frames.length,decoded:0,errors:['configure:'+String(e&&e.message||e).slice(0,120)],frames:[]};}
 for(const b64 of frames){const bin=atob(b64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  const v=new DataView(u.buffer);const key=v.getUint8(1)===1,seq=v.getUint32(4,true);
  try{decoder.decode(new EncodedVideoChunk({type:key?'key':'delta',timestamp:seq,data:u.subarray(32)}));}catch(e){errors.push('decode:'+String(e&&e.message||e).slice(0,100));}}
 try{await decoder.flush();}catch(e){errors.push('flush:'+String(e&&e.message||e).slice(0,120));}
 try{decoder.close();}catch{}
 return{submitted:frames.length,decoded:out.length,errors,frames:out};};
</script>`;

let addon, service, captureRef, decoderWin, shuttingDown = false;
const testWindows = [];
const resolveCalls = [];
const captureEvents = [];
const frameCounts = new Map();

async function makeTestWindows() {
  const displays = screen.getAllDisplays();
  for (const [index, display] of displays.entries()) {
    const { x, y, width, height } = display.bounds;
    const win = new BrowserWindow({ x, y, width, height, show: false, frame: false, resizable: false, movable: false, minimizable: false,
      maximizable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, backgroundColor: '#000000', title: 'TaroBird capture acceptance',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, devTools: false, spellcheck: false } });
    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testHtml(index))}`);
    win.setBounds(display.bounds);
    win.show();
    win.setFullScreen(true);
    testWindows.push({ index, displayId: display.id, win });
  }
  await sleep(1200);
  return testWindows.map(({ index, displayId, win }) => ({ index, displayId, bounds: win.getBounds(), visible: win.isVisible(), fullScreen: win.isFullScreen() }));
}

async function openDecoder() {
  const ses = session.fromPartition('acc-capture-decoder');
  ses.protocol.handle('tarobot-screen', () => new Response(DECODER_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  decoderWin = new BrowserWindow({ show: false, width: 64, height: 64, skipTaskbar: true, focusable: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, devTools: false } });
  await decoderWin.loadURL('tarobot-screen://decoder/decoder.html');
}

async function startService() {
  const addonSha256 = crypto.createHash('sha256').update(fs.readFileSync(addonFile)).digest('hex');
  addon = createRequire(pathToFileURL(addonFile).href)(addonFile);
  const targetPlatform = addon.screenTargetPlatform?.() ?? null;
  const loginSession = addon.screenSession();
  const monitors = addon.screenMonitors?.() ?? [];
  const displays = screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, rotation: d.rotation, internal: d.internal }));
  const windows = await makeTestWindows();
  await openDecoder();
  const root = path.join(assets, 'screen-capture');
  const preload = path.join(assets, 'screen-capture-preload.cjs');
  // Same wiring as main.mjs; the tee only records what the host reports.
  service = new ScreenService({ electron, addon, stateDir: appState, log: code => captureEvents.push({ log: String(code).slice(0, 80) }),
    hostControl: { ticket: id => screenServiceTicket(hostDir, id) },
    captureHost: hooks => (captureRef = new ScreenCaptureHost({ electron, root, preload,
      resolveSource: async display => {
        const source = await desktopSource(electron.desktopCapturer, display);
        resolveCalls.push({ at: Date.now(), displayId: display.id, nativeId: display.nativeId, matched: !!source, sourceKind: source ? String(source.id).split(':')[0] : null });
        return source;
      },
      ...hooks,
      onMessage: message => {
        if (message?.type === 'frame') frameCounts.set(message.sessionId, (frameCounts.get(message.sessionId) ?? 0) + 1);
        else if (message?.type === 'started') captureEvents.push({ type: 'started', cursor: message.cursor, width: message.width, height: message.height });
        else if (message?.type === 'ended') captureEvents.push({ type: 'ended', reason: message.reason, detail: message.detail });
        else if (message?.type === 'stream') captureEvents.push({ type: 'stream', codec: message.stream?.codec, codecString: message.stream?.codecString, width: message.stream?.width, height: message.stream?.height, streamGeneration: message.stream?.streamGeneration });
        hooks.onMessage(message);
      },
      onGone: (sessions, reason) => { captureEvents.push({ type: 'gone', reason, sessions: sessions.length }); hooks.onGone(sessions, reason); } })),
    onSharing: items => captureEvents.push({ type: 'sharing', count: items.length }) });
  await service.start();
  const end = Date.now() + 12000;
  while (Date.now() < end && service.status().registered !== true) await sleep(50);
  const status = service.status();
  return {
    addonSha256,
    preflight: { targetPlatform, session: { available: !!loginSession.available, onConsole: !!loginSession.onConsole, locked: !!loginSession.locked },
      interactive: targetPlatform === 'windows' && !!loginSession.available && !!loginSession.onConsole && !loginSession.locked,
      monitorCount: monitors.length, monitors, displays, windows },
    layout: { quads: displays.map((_, index) => quadsFor(index)), toggle: TOGGLE },
    registered: status.registered === true,
    status: { supported: status.supported, phase: status.phase, registered: status.registered, error: status.error ?? null,
      desktop: status.desktop ? { platform: status.desktop.platform, capture: status.desktop.capture, locked: status.desktop.locked,
        loginSessionPrefix: typeof status.desktop.loginSession === 'string' ? status.desktop.loginSession.slice(0, 4) : null,
        displays: status.desktop.displays.map(d => ({ id: d.id, nativeId: d.nativeId ?? null, width: d.width, height: d.height, scale: d.scale, revision: d.revision })) } : null },
  };
}

async function diag() {
  // Source list only (ids, no thumbnails/pixels): the E4 evidence for every display.
  const sources = await electron.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
  const geometry = service?.geometry?.displays() ?? [];
  return {
    sources: sources.map(s => ({ kind: String(s.id).split(':')[0], displayId: s.display_id, displayIdEmpty: s.display_id === '' })),
    geometry: geometry.map(d => ({ id: d.id, nativeId: d.nativeId, matches: sources.filter(s => s.display_id === d.nativeId).length })),
    resolveCalls: resolveCalls.map(({ at, ...rest }) => rest),
    captureEvents: captureEvents.slice(-60),
    frameCounts: [...frameCounts.values()],
    hostActive: !!captureRef?.active,
    windows: testWindows.map(({ index, displayId, win }) => ({ index, displayId, visible: !win.isDestroyed() && win.isVisible(), fullScreen: !win.isDestroyed() && win.isFullScreen() })),
  };
}

async function decode({ codec, frames, points }) {
  if (!decoderWin) throw new Error('decoder_missing');
  for (const b64 of frames) await decoderWin.webContents.executeJavaScript(`window.__push(${JSON.stringify(b64)})`, true);
  return decoderWin.webContents.executeJavaScript(`window.__decode(${JSON.stringify(codec)}, ${JSON.stringify(points)})`, true);
}

async function shutdown() {
  if (shuttingDown) return { ok: true };
  shuttingDown = true;
  try { service?.dispose(); } catch { /* best effort */ }
  try { captureRef?.close(); } catch { /* best effort */ }
  for (const { win } of testWindows) { try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ } }
  try { if (decoderWin && !decoderWin.isDestroyed()) decoderWin.destroy(); } catch { /* ignore */ }
  return { ok: true };
}

async function handle(cmd) {
  switch (cmd.op) {
    case 'start-service': return startService();
    case 'diag': return diag();
    case 'host-active': return { active: !!captureRef?.active };
    case 'decode': return decode(cmd);
    case 'shutdown': { const res = await shutdown(); setTimeout(() => app.exit(0), 50); return res; }
    default: throw new Error(`unknown_op:${cmd.op}`);
  }
}

app.whenReady().then(() => {
  const hardLimit = setTimeout(async () => { await shutdown(); emitMsg({ event: 'timeout' }); app.exit(1); }, 240000);
  hardLimit.unref?.();
  if (!rpcUrl) { app.exit(2); return; }
  rpcWs = new WebSocket(rpcUrl);
  rpcWs.on('open', () => emitMsg({ event: 'ready' }));
  rpcWs.on('message', async raw => {
    let cmd;
    try { cmd = JSON.parse(String(raw)); } catch { return; }
    try { emitMsg({ id: cmd.id, ok: true, result: await handle(cmd) }); } catch (error) { emitMsg({ id: cmd.id, ok: false, error: String(error?.message ?? error).slice(0, 300) }); }
  });
  rpcWs.on('error', async () => { await shutdown(); app.exit(1); });
  rpcWs.on('close', async () => { if (!shuttingDown) { await shutdown(); app.exit(0); } });
});
app.on('window-all-closed', () => { /* controlled by shutdown */ });
