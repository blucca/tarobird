// ACCEPTANCE-ONLY (#48 full chain) orchestrator for a DISPOSABLE GitHub-hosted
// Windows runner. Real HubServer; A = product ScreenService (real capture,
// real native input) + owned test window; B = real RemoteScreenPanel in an
// Electron shell with the product DesktopServices/ScreenViewers, driven by
// Playwright. Pairing: B's device pairs and the Hub owner approves/grants via
// the Hub's owner API (no pairing UI). Report: counts, coordinates, RGB
// samples and UI strings only. No uploads.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';
import { _electron } from '@playwright/test';
import { HubServer } from '../../../dist/src/hub/server.js';
import { startHubControl } from '../../../dist/src/hub/service.js';
import { deviceProof, hashSecret } from '../../../dist/src/hub/auth.js';
import { deviceActionProofText } from '../../../dist/src/client-protocol/device-actions.js';
import { screenConfigureText } from '../../../dist/src/client-protocol/remote-screen.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)), CLIENT = path.resolve(HERE, '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 8000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); } try { return await fn(); } catch { return false; } };
const checks = [], texts = {};
const rec = (phase, id, status, detail) => { checks.push({ phase, id, status, detail: String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1400) }); console.log(`[${status}] ${phase}/${id}: ${checks.at(-1).detail.slice(0, 600)}`); };
const expect = (phase, id, ok, detail) => rec(phase, id, ok ? 'pass' : 'fail', detail);

const { values } = parseArgs({ options: { electron: { type: 'string' }, addon: { type: 'string' }, report: { type: 'string' }, 'source-commit': { type: 'string', default: 'unknown' } } });
if (process.platform !== 'win32' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable') throw new Error('disposable GitHub-hosted Windows runner only');
const electronBin = path.resolve(values.electron), addonPath = path.resolve(values.addon), reportDir = path.resolve(values.report);
await mkdir(reportDir, { recursive: true });
const work = await mkdtemp(path.join(os.tmpdir(), 'tarobird-48-fullchain-'));
const cleanups = [];

function device(id) { const k = generateKeyPairSync('ed25519'); return { deviceId: id, name: id, platform: 'windows', publicKey: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: k.privateKey }; }
async function login(auth, d) { const c = `acc_${randomBytes(8).toString('hex')}`, n = randomBytes(32).toString('base64url'); const { nonce } = await auth.challenge(c, d.deviceId, n, '127.0.0.1');
  const { token } = await auth.authenticate(c, sign(null, deviceProof(d.deviceId, nonce, n), d.privateKey).toString('base64')); return { token, session: await auth.authorize(token, '127.0.0.1') }; }

try {
  // ---- builds (product capture renderer exactly as electron-package.mjs) ----
  const assets = path.join(work, 'a-assets'); await mkdir(path.join(assets, 'screen-capture'), { recursive: true });
  await Promise.all([
    build({ entryPoints: [path.join(CLIENT, 'electron/screen-capture-preload.mjs')], outfile: path.join(assets, 'screen-capture-preload.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] }),
    build({ entryPoints: [path.join(CLIENT, 'electron/screen-capture-page.mjs')], outfile: path.join(assets, 'screen-capture/capture.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome140' }),
    cp(path.join(CLIENT, 'electron/screen-capture.html'), path.join(assets, 'screen-capture/capture.html')),
    build({ entryPoints: [path.join(HERE, 'target-a.mjs')], outfile: path.join(work, 'a.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron', '*.node'] }),
  ]);
  const broot = path.join(work, 'b'); await mkdir(path.join(broot, 'profile'), { recursive: true });
  await build({ entryPoints: [path.join(HERE, 'b-entry.tsx')], outfile: path.join(broot, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome140',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false' } });
  await writeFile(path.join(broot, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/renderer.css"><div id="root"></div><script src="/renderer.js"></script>');
  await build({ entryPoints: [path.join(HERE, 'b-preload.mjs')], outfile: path.join(broot, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  await build({ entryPoints: [path.join(HERE, 'b-main.mjs')], outfile: path.join(broot, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });

  // ---- real Hub, owner, controller device B ----
  const hostDir = path.join(work, 'hub'); await mkdir(hostDir, { recursive: true });
  const hub = await HubServer.start({ stateDir: hostDir }); cleanups.push(() => hub.close());
  const owner = device('acc-owner'), ctl = device('acc-controller-b');
  await hub.enrollLocalController({ deviceId: owner.deviceId, name: owner.name, platform: owner.platform, publicKey: owner.publicKey });
  const { code } = await hub.auth.pair({ deviceId: ctl.deviceId, name: 'Controller B', platform: ctl.platform, publicKey: ctl.publicKey }, '127.0.0.1');
  await hub.auth.approve(code, 'local-owner', 'owner');
  const local = await login(hub.auth, owner), remote = await login(hub.auth, ctl);
  let revision = 0;
  const grant = async permission => {
    const grants = permission ? [{ deviceId: ctl.deviceId, publicKey: ctl.publicKey, permission }] : [];
    const cfg = { operation: 'screen.configure', expectedRevision: revision, enabled: true, requestId: randomUUID(), grants };
    const st = await hub.auth.prepareDeviceAction({ operation: 'screen-grant', target: hashSecret(screenConfigureText(cfg)) }, local.token, local.session);
    const policy = await hub.remoteScreen.configure(local.session, cfg, { nonce: st.nonce, signature: sign(null, Buffer.from(deviceActionProofText(st)), owner.privateKey).toString('base64') });
    revision = policy?.revision ?? revision + 1; return policy;
  };
  await grant('control');
  cleanups.push(await startHubControl(hostDir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }), () => {}, { screenServiceTicket: id => hub.remoteScreen.serviceTicket(id) }));
  // Which listener the controller's route uses (the real client uses its route URL).
  const probe = async base => new Promise(res => { const ws = new WebSocket(base.replace('http', 'ws') + '/screen/v1/control'); const t = setTimeout(() => { ws.terminate(); res(false); }, 3000); ws.on('open', () => { clearTimeout(t); ws.close(); res(true); }); ws.on('error', () => { clearTimeout(t); res(false); }); });
  const routeUrl = (await probe(hub.url)) ? hub.url : hub.instanceUrl;
  rec('setup', 'controller-route', 'info', { routeIsHubUrl: routeUrl === hub.url });

  // ---- A ----
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => wss.once('listening', r)); cleanups.push(() => wss.close());
  let aws, next = 1; const pending = new Map(); let aReady; const aUp = new Promise(r => { aReady = r; });
  wss.on('connection', ws => { aws = ws; ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.event === 'ready') { aReady(); return; } const p = pending.get(m.id); if (p) { pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)); } }); });
  const a = (op, payload = {}, ms = 30000) => new Promise((resolve, reject) => { const id = next++; const t = setTimeout(() => { pending.delete(id); reject(new Error('a_timeout:' + op)); }, ms); pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } }); aws.send(JSON.stringify({ id, op, ...payload })); });
  const aChild = spawn(electronBin, [path.join(work, 'a.cjs'), '--addon', addonPath, '--host-dir', hostDir, '--app-state', path.join(work, 'a-state'), '--assets', assets, '--rpc-url', `ws://127.0.0.1:${wss.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  aChild.stdout.on('data', () => {}); aChild.stderr.on('data', () => {}); cleanups.push(async () => { try { await a('shutdown', {}, 3000); } catch {} try { aChild.kill(); } catch {} });
  await aUp;
  const aStart = await a('start', {}, 40000); globalThis.accDiag = () => a('diag', {}, 5000);
  expect('a', 'product-screen-service-registered', aStart.registered && aStart.platform === 'windows', aStart);
  const aInfo0 = await a('info');
  rec('a', 'test-window', 'info', aInfo0);

  // ---- B ----
  const runB = async lang => {
    const bApp = await _electron.launch({ executablePath: electronBin, args: [path.join(broot, 'main.cjs'), `--root=${broot}`, `--hub=${routeUrl}`, `--token=${remote.token}`, `--hpk=${hub.auth.publicKey}`, `--lang=${lang}`], timeout: 30000 });
    const page = await bApp.firstWindow(); page.setDefaultTimeout(12000);
    // Same machine: keep B's document focused while A's input moves the OS foreground to the test window.
    const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return { bApp, page };
  };
  const L = lang => s => lang === 'en' ? (EN[s] ?? s) : s;
  const EN = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(CLIENT, 'src/locales/en.json'), 'utf8'));
  const stateLine = page => page.locator('.screen-state[role=status]').first().innerText().catch(() => null);
  const buttons = page => page.locator('.remote-screen-panel button').evaluateAll(els => els.filter(e => e.offsetParent !== null).map(e => (e.getAttribute('aria-label') || e.innerText || '').trim()).filter(Boolean));
  const snap = async (page, lang, label) => { (texts[lang] ??= []).push({ label, state: await stateLine(page), buttons: await buttons(page) }); };
  const canvasInfo = page => page.evaluate(() => { const c = document.querySelector('.remote-screen-panel canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height }; });
  const D = aStart.primary; // runner display (DIP == physical at scale 1)
  const toB = (ci, x, y) => ({ x: ci.x + (x + 0.5) / D.width * ci.w, y: ci.y + (y + 0.5) / D.height * ci.h });
  const sampleB = (page, pts) => page.evaluate(points => { const c = document.querySelector('.remote-screen-panel canvas'); const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; const g = t.getContext('2d'); g.drawImage(c, 0, 0);
    return points.map(([x, y]) => { const px = Math.round(x * c.width), py = Math.round(y * c.height); const d = g.getImageData(Math.max(0, px - 2), Math.max(0, py - 2), 5, 5).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)]; }); }, pts.map(([x, y]) => [x / D.width, y / D.height]));
  const QUADS = [[125, 108, [220, 40, 40]], [375, 108, [40, 170, 60]], [125, 324, [40, 80, 220]], [375, 324, [235, 205, 40]]];
  const near = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= 48;
  const seenFrom = async from => (await a('seen', { from })).events;
  const count = async () => (await a('seen', { from: 1e9 })).count;
  const pixelCheck = async (page, phase) => { const s = await sampleB(page, QUADS.map(q => [q[0], q[1]])); const ok = s.every((v, i) => near(v, QUADS[i][2])); expect(phase, 'b-canvas-shows-test-window-colours', ok, { samples: s, expected: QUADS.map(q => q[2]), canvas: await canvasInfo(page) }); };
  const near2 = (e, x, y) => Math.abs(e.x - x) <= 3 && Math.abs(e.y - y) <= 3;

  // ===== Chinese run: full input chain =====
  {
    const lang = 'zh', t = L(lang); const { bApp, page } = await runB(lang); cleanups.push(() => bApp.close().catch(() => {}));
    const btn = name => page.getByRole('button', { name: t(name), exact: true });
    await snap(page, lang, 'loaded');
    await btn('连接屏幕').click(); await btn('开始控制').waitFor({ state: 'visible', timeout: 20000 });
    await until(async () => (await canvasInfo(page))?.cw > 0 && await btn('开始控制').isEnabled(), 15000);
    await sleep(1500); await snap(page, lang, 'viewing');
    await pixelCheck(page, 'view');
    await btn('开始控制').click(); const ctlOk = await until(() => btn('停止控制').isVisible(), 10000);
    await snap(page, lang, 'controlling');
    expect('control', 'start-control', !!ctlOk, texts[lang].at(-1));
    let ci = await canvasInfo(page);
    await page.evaluate(() => document.querySelector('.remote-screen-panel canvas').focus());
    // move
    let from = await count(); let p = toB(ci, 125, 108); await page.mouse.move(p.x, p.y, { steps: 4 });
    let ev = await until(async () => (await seenFrom(from)).filter(e => e.type === 'mousemove').find(e => near2(e, 125, 108)), 4000);
    const lastMove = (await seenFrom(from)).filter(e => e.type === 'mousemove').at(-1);
    expect('input', 'move', !!ev, { want: [125, 108], got: ev ? [ev.x, ev.y] : lastMove && [lastMove.x, lastMove.y] });
    await snap(page, lang, 'after-move');
    // single click
    from = await count(); p = toB(ci, 375, 108); await page.mouse.click(p.x, p.y);
    let evs = await until(async () => { const l = await seenFrom(from); return l.some(e => e.type === 'click') && l; }, 4000) || await seenFrom(from);
    let c1 = evs.find(e => e.type === 'click'); expect('input', 'click', !!c1 && c1.button === 0 && near2(c1, 375, 108), { want: [375, 108], got: evs.filter(e => e.type !== 'mousemove').map(e => [e.type, e.button, e.x, e.y]) });
    // Unmodified behaviour on ONE shared desktop: the click activated A's test window.
    await sleep(1500); await snap(page, lang, 'after-click-unmodified');
    const released = await btn('开始控制').isVisible().catch(() => false);
    rec('same-desktop', 'controller-blur-releases-control', 'info', { controlReleased: released, windowBlurs: await page.evaluate(() => (window).accHarness.blurs()), state: texts[lang].at(-1).state });
    await page.evaluate(() => (window).accHarness.suppressBlur(true));
    await bApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    if (await btn('开始控制').isVisible().catch(() => false)) { await btn('开始控制').click(); await until(() => btn('停止控制').isVisible(), 8000); }
    await page.evaluate(() => document.querySelector('.remote-screen-panel canvas').focus());
    await snap(page, lang, 'control-again-with-blur-suppressed');
    // double click
    from = await count(); p = toB(ci, 125, 324); await page.mouse.dblclick(p.x, p.y);
    evs = await until(async () => { const l = await seenFrom(from); return l.some(e => e.type === 'dblclick') && l; }, 4000) || await seenFrom(from);
    await snap(page, lang, 'after-dblclick');
    const dc = evs.find(e => e.type === 'dblclick'); expect('input', 'double-click', !!dc && near2(dc, 125, 324), { got: evs.filter(e => e.type !== 'mousemove').map(e => [e.type, e.detail, e.x, e.y]) });
    // right click
    from = await count(); p = toB(ci, 375, 324); await page.mouse.click(p.x, p.y, { button: 'right' });
    evs = await until(async () => { const l = await seenFrom(from); return l.some(e => e.type === 'contextmenu') && l; }, 4000) || await seenFrom(from);
    await snap(page, lang, 'after-right-click');
    const cm = evs.find(e => e.type === 'contextmenu'); expect('input', 'right-click', !!cm && cm.button === 2 && near2(cm, 375, 324), { got: evs.filter(e => e.type !== 'mousemove').map(e => [e.type, e.button, e.x, e.y]) });
    // wheel
    from = await count(); p = toB(ci, 250, 200); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, 240);
    evs = await until(async () => { const l = await seenFrom(from); return l.some(e => e.type === 'wheel') && l; }, 4000) || await seenFrom(from);
    await snap(page, lang, 'after-wheel');
    const wh = evs.filter(e => e.type === 'wheel'); expect('input', 'wheel', wh.length > 0 && wh.every(e => near2(e, 250, 200)), { wheel: wh.slice(0, 4).map(e => [e.dx, e.dy, e.x, e.y]) });
    // drag
    from = await count(); const s0 = toB(ci, 100, 300), s1 = toB(ci, 300, 350);
    await page.mouse.move(s0.x, s0.y); await page.mouse.down(); await page.mouse.move(s1.x, s1.y, { steps: 10 }); await page.mouse.up();
    evs = await until(async () => { const l = await seenFrom(from); return l.some(e => e.type === 'mouseup') && l; }, 4000) || await seenFrom(from);
    await snap(page, lang, 'after-drag');
    const dn = evs.find(e => e.type === 'mousedown'), up = evs.find(e => e.type === 'mouseup'), dragMoves = evs.filter(e => e.type === 'mousemove' && e.buttons === 1);
    expect('input', 'drag', !!dn && !!up && near2(dn, 100, 300) && near2(up, 300, 350) && dragMoves.length > 0, { down: dn && [dn.x, dn.y], up: up && [up.x, up.y], movesWithButton: dragMoves.length });
    // focus the remote textarea with a real remote click, then text with Chinese and a newline
    const ti = (await a('info')).textarea; const tx = Math.round(ti.x + ti.w / 2), ty = Math.round(ti.y + ti.h / 2);
    p = toB(ci, tx, ty); await page.mouse.click(p.x, p.y);
    await until(async () => (await a('info')).textarea.focused === 't', 3000);
    await snap(page, lang, 'remote-textarea-focused');
    // Desktop text box: 屏幕更多操作 → 发送文本 (this releases control by design), type, start control, send.
    if (!(await page.getByLabel(t('发送到远端的文本'), { exact: true }).isVisible().catch(() => false))) { await btn('屏幕更多操作').click(); await btn('发送文本').click(); }
    const box = page.getByLabel(t('发送到远端的文本'), { exact: true }); await box.fill('你好 TaroBird\n第二行');
    if (await btn('开始控制').isVisible().catch(() => false)) { await btn('开始控制').click(); await until(() => btn('停止控制').isVisible(), 8000); }
    await snap(page, lang, 'text-ready');
    await page.locator('.screen-text button').first().click();
    const val = await until(async () => { const v = (await a('info')).value; return v.includes('第二行') && v; }, 6000);
    expect('input', 'text-chinese-and-newline', typeof val === 'string' && val.includes('你好 TaroBird\n第二行'), { value: (await a('info')).value });
    // platform shortcut: Ctrl+A on the Windows target selects the whole textarea
    if (await btn('开始控制').isVisible().catch(() => false)) { await btn('开始控制').click(); await until(() => btn('停止控制').isVisible(), 8000); }
    await page.evaluate(() => document.querySelector('.remote-screen-panel canvas').focus());
    from = await count(); await page.keyboard.press('Control+a');
    evs = await until(async () => { const l = await seenFrom(from); return l.some(e => e.type === 'selection' && e.start === 0 && e.end === e.len && e.len > 0) && l; }, 4000) || await seenFrom(from);
    const kd = evs.find(e => e.type === 'keydown' && e.code === 'KeyA');
    expect('input', 'shortcut-ctrl-a', !!kd && kd.ctrl && evs.some(e => e.type === 'selection' && e.start === 0 && e.end === e.len && e.len > 0), { keydown: kd, selection: evs.filter(e => e.type === 'selection').at(-1) });
    // stop control: further input never arrives
    await btn('停止控制').click(); await until(() => btn('开始控制').isVisible(), 6000); await snap(page, lang, 'stopped');
    from = await count(); p = toB(ci, 125, 108); await page.mouse.click(p.x, p.y); await page.keyboard.press('z'); await sleep(1500);
    const after = (await seenFrom(from)).filter(e => e.type !== 'mousemove' || true);
    expect('control', 'no-input-after-stop', after.filter(e => ['mousedown', 'mouseup', 'click', 'keydown'].includes(e.type)).length === 0, { eventsAfterStop: after.map(e => e.type).slice(0, 10) });
    // disconnect and reconnect
    await btn('断开').click(); await until(() => btn('连接屏幕').isVisible(), 8000); await snap(page, lang, 'disconnected');
    await btn('连接屏幕').click(); const re = await until(async () => await btn('开始控制').isEnabled(), 20000); await sleep(1200); await snap(page, lang, 'reconnected');
    expect('reconnect', 'reconnect-shows-frames', !!re, texts[lang].at(-1)); await pixelCheck(page, 'reconnect');
    // grant control -> view on the live session
    await grant('view'); await until(async () => !(await btn('开始控制').isVisible().catch(() => false)), 8000); await sleep(800); await snap(page, lang, 'downgraded-to-view');
    expect('grant', 'downgrade-hides-control', !(await btn('开始控制').isVisible().catch(() => false)), texts[lang].at(-1));
    // revoke
    await grant(null); await sleep(2500); await page.evaluate(() => (window).accRefresh()); await sleep(1000); await snap(page, lang, 'revoked');
    rec('grant', 'revoke-ends-session', 'info', texts[lang].at(-1));
    // narrowest width check (viewing state needs a session: re-grant control)
    await bApp.close();
  }

  // ===== English run + narrow-width checks in both languages =====
  for (const lang of ['en', 'zh']) {
    await grant('control'); const t = L(lang); const { bApp, page } = await runB(lang);
    const btn = name => page.getByRole('button', { name: t(name), exact: true });
    await snap(page, lang, 'loaded');
    await btn('连接屏幕').click(); await until(async () => await btn('开始控制').isEnabled(), 20000); await sleep(1200); await snap(page, lang, 'viewing');
    await btn('开始控制').click(); await until(() => btn('停止控制').isVisible(), 8000); await snap(page, lang, 'controlling');
    for (const width of [512, 360, 300]) {
      await bApp.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 720), width); await sleep(600);
      const m = await page.evaluate(() => { const panel = document.querySelector('.remote-screen-panel'); const pr = panel.getBoundingClientRect();
        const els = [...panel.querySelectorAll('.screen-state, button, select, .screen-heading *')].filter(e => e.offsetParent !== null);
        const bad = els.filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > pr.right + 1 || e.getBoundingClientRect().left < pr.left - 1)
          .map(e => ({ tag: e.tagName, text: (e.getAttribute('aria-label') || e.innerText || '').trim().slice(0, 60), sw: e.scrollWidth, cw: e.clientWidth, right: Math.round(e.getBoundingClientRect().right), panelRight: Math.round(pr.right) }));
        return { panelWidth: Math.round(pr.width), minWidth: getComputedStyle(panel).minWidth, docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, checked: els.length, bad }; });
      rec(`width:${lang}`, `controlling-at-window-${width}`, m.bad.length === 0 && !m.docScroll ? 'pass' : 'fail', m);
    }
    await bApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(512, 720));
    await btn('停止控制').click(); await until(() => btn('开始控制').isVisible(), 6000); await snap(page, lang, 'stopped');
    await grant('view'); await sleep(2500); await snap(page, lang, 'downgraded-to-view');
    await grant(null); await sleep(2500); await page.evaluate(() => (window).accRefresh()); await sleep(1000); await snap(page, lang, 'revoked');
    await bApp.close();
  }
  const diag = await a('diag');
  rec('a', 'capture-and-service', 'info', diag);
  expect('a', 'desktopSource-matched', diag.resolveCalls.length > 0 && diag.resolveCalls.every(c => c.matched), diag.resolveCalls);
} catch (error) {
  rec('harness', 'unexpected-error', 'fail', String(error?.stack ?? error).replace(/[A-Za-z]:\\[^\s"']+/g, '<path>'));
  try { rec('a', 'diag-at-failure', 'info', await globalThis.accDiag?.()); } catch { /* A gone */ }
} finally {
  const outcome = checks.some(c => c.status === 'fail') ? 'fail' : 'pass';
  await writeFile(path.join(reportDir, 'win48-fullchain.json'), JSON.stringify({ outcome, sourceCommit: values['source-commit'], checks, texts }, null, 1));
  console.log('===== UI TEXTS =====\n' + JSON.stringify(texts, null, 1));
  console.log(`win48 full-chain outcome: ${outcome}`);
  for (const c of cleanups.reverse()) { try { await c(); } catch { /* ignore */ } }
  await rm(work, { recursive: true, force: true }).catch(() => {});
  process.exit(outcome === 'pass' ? 0 : 1);
}
