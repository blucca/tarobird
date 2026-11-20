// ACCEPTANCE-ONLY (#48 E4): real Windows screen capture on a DISPOSABLE
// GitHub-hosted runner. Product path end to end: real HubServer + real Windows
// named-pipe control + product ScreenService + product ScreenCaptureHost +
// product desktopSource(desktopCapturer) + the packaged capture renderer.
// The viewer is a protocol client granted VIEW only; it selects the product
// displayId from the Hub status, receives the real encoded stream, acks it and
// has the target decode it to check the colour test window's blocks, its
// toggling block, a keyframe/stream reset and a reconnect.
//
// The runner desktop is covered by the target's own full-screen colour window
// (no text, no data). No input is posted, no hook/keyboard/injection tool is
// used, no image is stored or uploaded: the report holds counts, ids and a few
// averaged RGB samples only.
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build as esbuild } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';
import { HubServer } from '../../dist/src/hub/server.js';
import { startHubControl } from '../../dist/src/hub/service.js';
import { deviceProof, hashSecret } from '../../dist/src/hub/auth.js';
import { deviceActionProofText } from '../../dist/src/client-protocol/device-actions.js';
import { screenConfigureText, screenJoinSchema, screenStatusSchema } from '../../dist/src/client-protocol/remote-screen.js';
import { readScreenFrame } from '../../dist/src/client-protocol/screen-wire.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.dirname(HERE);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async (check, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(25); }
  return Boolean(await check());
};

class Receipt {
  checks = [];
  add(phase, id, status, detail = '') { this.checks.push({ phase, id, status, detail: String(detail).slice(0, 1500) }); return status === 'pass'; }
  expect(phase, id, ok, detail) { return this.add(phase, id, ok ? 'pass' : 'fail', detail); }
  skip(phase, id, detail) { return this.add(phase, id, 'skip', detail); }
  info(phase, id, detail) { return this.add(phase, id, 'info', detail); }
  get outcome() {
    if (this.checks.some(c => c.status === 'fail')) return 'fail';
    if (this.checks.some(c => c.status === 'skip')) return 'incomplete';
    return 'pass';
  }
  markdown(meta) {
    const icon = { pass: 'pass', fail: 'FAIL', skip: 'skip (not pass)', info: 'info (not judged)' };
    const rows = this.checks.map(c => `| ${c.phase} | ${c.id} | ${icon[c.status]} | ${c.detail.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ')} |`);
    return [`# #48 E4 Windows real-capture disposable runner acceptance`, '', `- Started: ${meta.startedAt}`, `- Outcome: **${this.outcome}** (skips are never passes)`,
      `- Source commit: \`${meta.sourceCommit}\``, `- Native addon sha256: \`${meta.addonSha256}\``, `- Capture renderer capture.js sha256: \`${meta.captureJsSha256}\``,
      `- Product capture files sha256: ${Object.entries(meta.productSha256).map(([k, v]) => `\`${k}\`=\`${v.slice(0, 16)}\``).join(', ')}`,
      '', '| phase | check | status | detail |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
  }
}

function makeDevice(deviceId) {
  const keys = generateKeyPairSync('ed25519');
  return { deviceId, name: deviceId, platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: keys.privateKey };
}
async function loginFor(auth, device) {
  const connection = `acc_${randomBytes(8).toString('hex')}`;
  const clientNonce = randomBytes(32).toString('base64url');
  const { nonce } = await auth.challenge(connection, device.deviceId, clientNonce, '127.0.0.1');
  const signature = sign(null, deviceProof(device.deviceId, nonce, clientNonce), device.privateKey).toString('base64');
  const { token } = await auth.authenticate(connection, signature);
  return { token, session: await auth.authorize(token, '127.0.0.1') };
}
function connectWs(url, cleanups, onBinary) {
  const ws = new WebSocket(url);
  const values = [];
  ws.on('message', (data, binary) => {
    if (binary) { const bytes = new Uint8Array(data); values.push(bytes); onBinary?.(bytes); }
    else { try { values.push(JSON.parse(data.toString())); } catch { /* ignore */ } }
  });
  ws.on('error', () => {});
  let closed = null;
  ws.on('close', (code, reason) => { closed = { code, reason: String(reason).slice(0, 64) }; });
  cleanups.push(async () => { try { ws.terminate(); } catch { /* ignore */ } });
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, values, ready, send: v => ws.send(JSON.stringify(v)), closed: () => closed };
}

async function spawnTarget(electronBin, entryFile, argv) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  const rpcUrl = `ws://127.0.0.1:${wss.address().port}`;
  let nextId = 1, clientWs = null, readyResolve, readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  wss.on('connection', ws => {
    clientWs = ws;
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.event === 'ready') { readyResolve(); return; }
      const entry = msg.id && pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result); else entry.reject(new Error(msg.error || 'target_rpc_failed'));
    });
  });
  const child = spawn(electronBin, [entryFile, ...argv, '--rpc-url', rpcUrl], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const stderr = [];
  child.stderr.on('data', chunk => { if (stderr.length < 40) stderr.push(String(chunk).slice(0, 400)); });
  child.stdout.on('data', () => {});
  child.once('error', err => readyReject(err));
  child.once('exit', code => { for (const [, e] of pending) e.reject(new Error(`target_exited_${code}`)); pending.clear(); readyReject(new Error(`target_exited_before_ready_${code}`)); });
  const call = (op, payload = {}, timeoutMs = 35000) => new Promise((resolve, reject) => {
    if (clientWs?.readyState !== WebSocket.OPEN) { reject(new Error(`target_rpc_not_connected:${op}`)); return; }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`target_rpc_timeout:${op}`)); }, timeoutMs);
    pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
    clientWs.send(JSON.stringify({ id, op, ...payload }));
  });
  const close = async () => {
    try { await call('shutdown', {}, 5000); } catch { /* ignore */ }
    try { clientWs?.terminate(); } catch { /* ignore */ }
    try { wss.close(); } catch { /* ignore */ }
    await sleep(200);
    try { child.kill(); } catch { /* ignore */ }
  };
  return { ready, call, close, stderr: () => stderr.join('').replace(/[A-Za-z]:\\[^\s"']+/g, '<path>').slice(0, 600) };
}

// Five averaged 5x5 patches per region; the medians are judged.
const REGIONS = {
  tl: [[0.15, 0.15], [0.3, 0.12], [0.12, 0.3], [0.25, 0.25], [0.08, 0.08]],
  tr: [[0.85, 0.15], [0.7, 0.12], [0.88, 0.3], [0.75, 0.25], [0.92, 0.08]],
  bl: [[0.15, 0.85], [0.3, 0.88], [0.12, 0.7], [0.25, 0.75], [0.08, 0.92]],
  br: [[0.85, 0.85], [0.7, 0.88], [0.88, 0.7], [0.75, 0.75], [0.92, 0.92]],
  c: [[0.5, 0.5], [0.46, 0.54], [0.54, 0.46], [0.46, 0.46], [0.54, 0.54]],
};
const POINTS = Object.values(REGIONS).flat();
const TOLERANCE = 48;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const near = (a, b) => a && b && Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= TOLERANCE;
function regionsOf(samples) {
  const out = {}; let i = 0;
  for (const [name, pts] of Object.entries(REGIONS)) {
    const list = samples.slice(i, i + pts.length); i += pts.length;
    out[name] = [0, 1, 2].map(ch => median(list.map(s => s[ch])));
  }
  return out;
}
function judgeFrames(decoded, layout, index) {
  const quads = layout.quads[index] ?? layout.quads[0];
  const frames = (decoded?.frames ?? []).map(f => ({ seq: f.seq, w: f.w, h: f.h, r: regionsOf(f.s) }));
  const quadOk = frames.filter(f => near(f.r.tl, quads[0]) && near(f.r.tr, quads[1]) && near(f.r.bl, quads[2]) && near(f.r.br, quads[3]));
  const toggleA = frames.filter(f => near(f.r.c, layout.toggle[0])).length;
  const toggleB = frames.filter(f => near(f.r.c, layout.toggle[1])).length;
  const allBlack = frames.filter(f => Object.values(f.r).every(c => Math.max(...c) < 16)).length;
  // Which display's layout a frame matches (to prove the display mapping).
  const layoutMatch = frames.slice(0, 3).map(f => layout.quads.findIndex(q => near(f.r.tl, q[0]) && near(f.r.tr, q[1]) && near(f.r.bl, q[2]) && near(f.r.br, q[3])));
  return { decoded: frames.length, submitted: decoded?.submitted ?? 0, errors: decoded?.errors ?? [], quadOk: quadOk.length, toggleA, toggleB, allBlack, layoutMatch,
    size: frames[0] ? `${frames[0].w}x${frames[0].h}` : null, firstRegions: frames[0]?.r ?? null, lastRegions: frames.at(-1)?.r ?? null };
}

// Standby view-only entry (windows-viewonly-entry.mjs), bundled exactly as it
// would be handed over, checked against the same Hub: registration, frames
// that decode to ITS OWN window's colours (not the desktop), and a control
// request from a device granted control that must be refused with no input.
async function viewOnlyPhase({ receipt, evidence, target, electronBin, addonPath, app, workDir, hub, api, remote, ctl, layout, cleanups, hostDir }) {
  const phase = 'viewonly';
  await target.call('stop-service');
  await wait(async () => (await (await api('/api/screens/status?includeWindows=1', remote.token)).json()).desktop === null, 8000);
  const bundle = path.join(app, 'viewonly-entry.cjs');
  await esbuild({ entryPoints: [path.join(HERE, 'windows-viewonly-entry.mjs')], outfile: bundle, bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron', '*.node'] });
  const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const manifest = { 'viewonly-entry.cjs': await sha(bundle), 'screen-capture/capture.js': await sha(path.join(app, 'screen-capture/capture.js')),
    'screen-capture/capture.html': await sha(path.join(app, 'screen-capture/capture.html')), 'screen-capture-preload.cjs': await sha(path.join(app, 'screen-capture-preload.cjs')) };
  evidence.viewonly = { manifest };
  receipt.info(phase, 'bundle-manifest-sha256', JSON.stringify(manifest));
  const lines = [];
  const child = spawn(electronBin, [bundle, '--addon', addonPath, '--host-dir', hostDir, '--app-state', path.join(workDir, 'viewonly-state'), '--minutes', '3'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  cleanups.push(async () => { try { child.kill(); } catch { /* ignore */ } });
  child.stdout.on('data', chunk => { for (const line of String(chunk).split(/\r?\n/)) if (line.startsWith('viewonly: ') && lines.length < 200) lines.push(line.slice(10, 170)); });
  child.stderr.on('data', () => {});
  const statusNow = async token => screenStatusSchema.parse(await (await api('/api/screens/status?includeWindows=1', token)).json());
  const up = await wait(async () => (await statusNow(remote.token)).desktop !== null, 20000);
  const status = await statusNow(remote.token);
  receipt.expect(phase, 'registers-with-existing-hub', up && lines.some(l => l.startsWith('started registered=true')) && status.desktop?.platform === 'windows',
    `up=${up}, lines=${JSON.stringify(lines.slice(0, 4))}, displays=${status.desktop?.displays?.length ?? 0}`);
  if (!up || !status.desktop?.displays?.length) return;
  const display = status.desktop.displays[0];
  const wsBase = hub.instanceUrl.replace('http:', 'ws:');
  const watch = async (login, label, onReady) => {
    const opened = await api('/api/screens/sessions?includeWindows=1', login.token, { desktopId: status.desktop.desktopId, displayId: display.id, displayRevision: display.revision, requestId: randomUUID(), codecs: ['h264', 'vp8'] });
    const join = opened.status === 201 ? screenJoinSchema.parse(await opened.json()) : null;
    if (!join) return { label, http: opened.status };
    const frames = [];
    let control;
    control = connectWs(`${wsBase}/screen/v1/control`, cleanups);
    const media = connectWs(`${wsBase}/screen/v1/media`, cleanups, bytes => {
      let header; try { header = readScreenFrame(bytes); } catch { return; }
      frames.push({ header, bytes, at: Date.now() });
      try { control.send({ type: 'ack', sessionId: join.session.id, generation: join.session.generation, frameSequence: header.sequence }); } catch { /* closed */ }
    });
    await Promise.all([control.ready, media.ready]);
    control.send({ type: 'hello', ticket: join.controlTicket }); media.send({ type: 'hello', ticket: join.mediaTicket });
    await wait(() => frames.length >= 20, 12000);
    const extra = onReady ? await onReady({ join, control, frames }) : undefined;
    control.send({ type: 'disconnect', sessionId: join.session.id, generation: join.session.generation });
    await wait(() => control.values.some(v => v.type === 'state' && v.session.state === 'closed'), 4000);
    const streams = media.values.filter(v => !(v instanceof Uint8Array) && v.type === 'stream');
    return { label, http: opened.status, controlAllowed: join.session.controlAllowed, frames, streams, states: control.values.filter(v => v.type === 'state').map(v => `${v.session.state}${v.session.reason ? `:${v.session.reason}` : ''}${v.lease ? '+lease' : ''}`), extra };
  };
  const view = await watch(remote, 'view');
  const gen = view.frames?.[0]?.header.streamGeneration;
  const chunk = (view.frames ?? []).filter(f => f.header.streamGeneration === gen).slice(0, 30);
  const codecString = view.streams?.find(s => s.streamGeneration === gen)?.codecString;
  const judged = chunk.length && codecString ? judgeFrames(await target.call('decode', { codec: codecString, frames: chunk.map(f => Buffer.from(f.bytes).toString('base64')), points: POINTS }, 60000), layout, 0) : null;
  evidence.viewonly.view = { http: view.http, controlAllowed: view.controlAllowed, frames: view.frames?.length ?? 0, states: view.states, judged: judged && { ...judged, firstRegions: judged.firstRegions } };
  receipt.expect(phase, 'phone-view-gets-frames-of-own-window', view.http === 201 && view.controlAllowed === false && !!judged && judged.decoded >= 10 && judged.quadOk >= Math.ceil(judged.decoded * 0.9) && judged.toggleA > 0 && judged.toggleB > 0,
    `http=${view.http}, controlAllowed=${view.controlAllowed}, frames=${view.frames?.length ?? 0}, codec=${codecString}, decoded=${judged?.decoded}, quadOk=${judged?.quadOk}, toggle=${judged?.toggleA}/${judged?.toggleB}, first=${JSON.stringify(judged?.firstRegions)}`);
  const ctlRun = await watch(ctl, 'control', async ({ join, control, frames }) => {
    const last = frames.at(-1)?.header.sequence ?? 1;
    control.send({ type: 'control', sessionId: join.session.id, generation: join.session.generation, frameSequence: last });
    await sleep(4000);
    return { lease: control.values.some(v => v.type === 'state' && v.lease && v.session.state === 'controlling') };
  });
  const refused = lines.filter(l => l.startsWith('input_refused'));
  evidence.viewonly.control = { http: ctlRun.http, controlAllowed: ctlRun.controlAllowed, states: ctlRun.states, lease: ctlRun.extra?.lease ?? null, refused };
  receipt.expect(phase, 'control-request-refused-without-input', ctlRun.http === 201 && ctlRun.controlAllowed === true && ctlRun.extra?.lease === false
    && refused.length >= 1 && refused.every(l => l === 'input_refused screenMonitorStart'),
    `controlAllowed=${ctlRun.controlAllowed}, leaseObserved=${ctlRun.extra?.lease}, states=${JSON.stringify(ctlRun.states)}, refused=${JSON.stringify(refused)}`);
  try { child.kill(); } catch { /* ignore */ }
  const code = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
  receipt.info(phase, 'entry-log', JSON.stringify({ exit: code, lines: lines.filter(l => !l.startsWith('sharing')).slice(0, 20) }));
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    'confirm-disposable-windows': { type: 'boolean', default: false }, electron: { type: 'string' }, addon: { type: 'string' },
    report: { type: 'string' }, 'source-commit': { type: 'string', default: 'unknown' }, 'with-viewonly': { type: 'boolean', default: false } } });
  if (process.platform !== 'win32' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable' || !values['confirm-disposable-windows']) {
    throw new Error('Refusing to run: requires a disposable GitHub-hosted Windows runner with TAROBOT_WINDOWS_ACCEPTANCE=disposable and --confirm-disposable-windows');
  }
  const electronBin = path.resolve(values.electron || '');
  const addonPath = path.resolve(values.addon || '');
  const reportDir = path.resolve(values.report || '');
  if (!existsSync(electronBin)) throw new Error('Electron binary not found');
  if (!existsSync(addonPath)) throw new Error('Native addon not found');
  await mkdir(reportDir, { recursive: true });
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'tarobird-48-capture-'));
  const cleanups = [() => rm(workDir, { recursive: true, force: true })];
  const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const productFiles = ['screen-capture-host.mjs', 'screen-capture-core.mjs', 'screen-capture-page.mjs', 'screen-capture-preload.mjs', 'screen-geometry.mjs', 'screen-service.mjs'];
  const productSha256 = {};
  for (const name of productFiles) productSha256[name] = createHash('sha256').update((await readFile(path.join(CLIENT, 'electron', name), 'utf8')).replaceAll('\r\n', '\n')).digest('hex');
  const receipt = new Receipt();
  const meta = { startedAt: new Date().toISOString(), sourceCommit: values['source-commit'], addonSha256: await sha(addonPath), captureJsSha256: null, productSha256 };
  const evidence = { meta, preflight: null, e4: null, sessions: [] };

  try {
    // 1. The packaged capture renderer, built with the same options as scripts/electron-package.mjs.
    const app = path.join(workDir, 'app');
    await mkdir(path.join(app, 'screen-capture'), { recursive: true });
    await Promise.all([
      esbuild({ entryPoints: [path.join(CLIENT, 'electron/screen-capture-preload.mjs')], outfile: path.join(app, 'screen-capture-preload.cjs'), bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron'] }),
      esbuild({ entryPoints: [path.join(CLIENT, 'electron/screen-capture-page.mjs')], outfile: path.join(app, 'screen-capture/capture.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome140' }),
      cp(path.join(CLIENT, 'electron/screen-capture.html'), path.join(app, 'screen-capture/capture.html')),
    ]);
    meta.captureJsSha256 = await sha(path.join(app, 'screen-capture/capture.js'));
    const bundleFile = path.join(workDir, 'capture-target.cjs');
    await esbuild({ entryPoints: [path.join(HERE, 'windows-capture-acceptance-target.mjs')], outfile: bundleFile, bundle: true, format: 'cjs', platform: 'node', target: 'node24', external: ['electron', '*.node'] });

    // 2. Real Hub; the viewer is granted VIEW only.
    const hostDir = path.join(workDir, 'hub'), appState = path.join(workDir, 'app-state'), profileDir = path.join(workDir, 'electron-profile');
    await mkdir(hostDir, { recursive: true }); await mkdir(appState, { recursive: true });
    const hub = await HubServer.start({ stateDir: hostDir });
    cleanups.push(() => hub.close());
    const owner = makeDevice('acc-local'), viewer = makeDevice('acc-viewer'), controller = makeDevice('acc-controller');
    await hub.enrollLocalController({ deviceId: owner.deviceId, name: owner.name, platform: owner.platform, publicKey: owner.publicKey });
    const { code } = await hub.auth.pair({ deviceId: viewer.deviceId, name: viewer.name, platform: viewer.platform, publicKey: viewer.publicKey }, '127.0.0.1');
    await hub.auth.approve(code, 'local-owner', 'owner');
    const paired = await hub.auth.pair({ deviceId: controller.deviceId, name: controller.name, platform: controller.platform, publicKey: controller.publicKey }, '127.0.0.1');
    await hub.auth.approve(paired.code, 'local-owner', 'owner');
    const local = await loginFor(hub.auth, owner), remote = await loginFor(hub.auth, viewer), ctl = await loginFor(hub.auth, controller);
    // The capture phases use the VIEW device only. The control grant exists solely
    // for the view-only entry's refusal check (a misconfigured grant must not inject).
    const cfg = { operation: 'screen.configure', expectedRevision: 0, enabled: true, requestId: randomUUID(), grants: [
      { deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: 'view' }, { deviceId: controller.deviceId, publicKey: controller.publicKey, permission: 'control' }] };
    const statement = await hub.auth.prepareDeviceAction({ operation: 'screen-grant', target: hashSecret(screenConfigureText(cfg)) }, local.token, local.session);
    await hub.remoteScreen.configure(local.session, cfg, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString('base64') });
    const stopControl = await startHubControl(hostDir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }), () => {},
      { screenServiceTicket: id => hub.remoteScreen.serviceTicket(id) });
    cleanups.push(stopControl);

    // 3. Isolated Electron target: colour window + product ScreenService/ScreenCaptureHost.
    const target = await spawnTarget(electronBin, bundleFile, ['--addon', addonPath, '--host-dir', hostDir, '--app-state', appState, '--profile', profileDir, '--assets', app]);
    cleanups.push(() => target.close());
    await target.ready;
    const started = await target.call('start-service', {}, 40000);
    evidence.preflight = { preflight: started.preflight, status: started.status };
    const pre = started.preflight;
    receipt.info('preflight', 'runner-desktop', JSON.stringify({ session: pre.session, interactive: pre.interactive, monitors: pre.monitors, displays: pre.displays, windows: pre.windows }));
    receipt.expect('service', 'windows-target-and-registration', pre.targetPlatform === 'windows' && started.registered && started.status.desktop?.platform === 'windows',
      `targetPlatform=${pre.targetPlatform}, registered=${started.registered}, phase=${started.status.phase}, error=${started.status.error}, capture=${started.status.desktop?.capture}, displays=${started.status.desktop?.displays?.length}`);
    receipt.expect('preflight', 'colour-window-covers-every-display', pre.windows.length === pre.displays.length && pre.windows.every(w => w.visible),
      `windows=${JSON.stringify(pre.windows)}`);

    // 4. E4: the desktopCapturer source list (ids only) against the product geometry.
    const diag0 = await target.call('diag');
    evidence.e4 = { sources: diag0.sources, geometry: diag0.geometry };
    receipt.expect('e4', 'every-display-has-one-matching-source', diag0.geometry.length > 0 && diag0.geometry.every(g => g.matches === 1),
      `geometry=${JSON.stringify(diag0.geometry)}, sources=${JSON.stringify(diag0.sources)}`);

    if (!pre.interactive) {
      receipt.skip('capture', 'real-capture', `runner has no interactive, unlocked console session: ${JSON.stringify(pre.session)}; no capture attempted, no bypass`);
      return;
    }

    const api = (route, token, body) => fetch(hub.url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const status = screenStatusSchema.parse(await (await api('/api/screens/status?includeWindows=1', remote.token)).json());
    const displays = status.desktop?.displays ?? [];
    receipt.expect('select', 'viewer-sees-product-displays', status.permission === 'view' && displays.length === pre.displays.length,
      `permission=${status.permission}, displays=${JSON.stringify(displays.map(d => ({ id: d.id, nativeId: d.nativeId, w: d.width, h: d.height, scale: d.scale })))}`);
    const indexOf = display => pre.windows.findIndex(w => String(w.displayId) === display.nativeId);

    // One viewing session: open with the product displayId → stream → ack → keyframe reset → disconnect.
    const runSession = async (display, label) => {
      const record = { label, displayId: display.id, index: indexOf(display) };
      const opened = await api('/api/screens/sessions?includeWindows=1', remote.token, { desktopId: status.desktop.desktopId, displayId: display.id,
        displayRevision: display.revision, requestId: randomUUID(), codecs: ['h264', 'vp8'] });
      const join = opened.status === 201 ? screenJoinSchema.parse(await opened.json()) : null;
      record.open = { http: opened.status, controlAllowed: join?.session.controlAllowed ?? null, body: join ? undefined : (await opened.text()).slice(0, 120) };
      if (!join) return record;
      const wsBase = hub.instanceUrl.replace('http:', 'ws:');
      const frames = [];
      let control;
      const onFrame = bytes => {
        let header; try { header = readScreenFrame(bytes); } catch (error) { frames.push({ bad: String(error.message) }); return; }
        frames.push({ header, bytes, at: Date.now() });
        try { control.send({ type: 'ack', sessionId: join.session.id, generation: join.session.generation, frameSequence: header.sequence }); } catch { /* closed */ }
      };
      control = connectWs(`${wsBase}/screen/v1/control`, cleanups);
      const media = connectWs(`${wsBase}/screen/v1/media`, cleanups, onFrame);
      await Promise.all([control.ready, media.ready]);
      control.send({ type: 'hello', ticket: join.controlTicket });
      media.send({ type: 'hello', ticket: join.mediaTicket });
      const good = () => frames.filter(f => f.header);
      await wait(() => good().length >= 24 || control.values.some(v => v.type === 'state' && v.session.state === 'closed'), 15000);
      const firstGen = good()[0]?.header.streamGeneration;
      // Keyframe request: the Hub resets the stream; the capture page restarts on a new generation.
      const beforeReset = good().length;
      control.send({ type: 'keyframe', sessionId: join.session.id, generation: join.session.generation });
      await wait(() => good().slice(beforeReset).filter(f => f.header.streamGeneration > firstGen).length >= 8, 8000);
      const stateBefore = control.values.filter(v => v.type === 'state').map(v => v.session.state);
      control.send({ type: 'disconnect', sessionId: join.session.id, generation: join.session.generation });
      const closed = await wait(() => control.values.some(v => v.type === 'state' && v.session.state === 'closed'), 5000);
      const closeState = control.values.findLast(v => v.type === 'state' && v.session.state === 'closed');
      const released = await wait(async () => !(await target.call('host-active')).active, 5000);
      const streams = media.values.filter(v => !(v instanceof Uint8Array) && v.type === 'stream').map(s => ({ gen: s.streamGeneration, codec: s.codec, codecString: s.codecString, w: s.width, h: s.height }));
      const list = good();
      const gens = [...new Set(list.map(f => f.header.streamGeneration))];
      record.stream = { streams, frames: list.length, bad: frames.length - list.length, generations: gens,
        keyFirstPerGeneration: gens.every(g => list.find(f => f.header.streamGeneration === g)?.header.key === true),
        sequenceIncreasing: list.every((f, i) => !i || f.header.sequence > list[i - 1].header.sequence),
        maxAgeMs: Math.max(0, ...list.map(f => f.at - f.header.captureMs)), maxBytes: Math.max(0, ...list.map(f => f.bytes.byteLength)),
        frameReady: control.values.filter(v => v.type === 'frame-ready').length, states: stateBefore.slice(-4), closed, closeReason: closeState?.session.reason ?? null, released };
      // Decode the first generation from its key frame, and the post-reset generation.
      const decodeGen = async gen => {
        const stream = streams.find(s => s.gen === gen);
        const chunk = list.filter(f => f.header.streamGeneration === gen).slice(0, 30);
        if (!stream || !chunk.length) return null;
        const decoded = await target.call('decode', { codec: stream.codecString, frames: chunk.map(f => Buffer.from(f.bytes).toString('base64')), points: POINTS }, 60000);
        return { codec: stream.codec, codecString: stream.codecString, ...judgeFrames(decoded, started.layout, Math.max(0, record.index)) };
      };
      record.decodeFirst = await decodeGen(gens[0]);
      record.decodeReset = gens.length > 1 ? await decodeGen(gens.at(-1)) : null;
      return record;
    };

    const checkSession = (record, phase) => {
      const s = record.stream, d = record.decodeFirst, r = record.decodeReset;
      receipt.expect(phase, 'open-with-product-display-id', record.open.http === 201 && record.open.controlAllowed === false, `display=${record.displayId}, http=${record.open.http}, controlAllowed=${record.open.controlAllowed} ${record.open.body ?? ''}`);
      if (!s) return;
      receipt.expect(phase, 'real-stream-frames', s.frames >= 10 && s.bad === 0 && s.keyFirstPerGeneration && s.sequenceIncreasing && s.maxAgeMs < 2000,
        `frames=${s.frames}, bad=${s.bad}, streams=${JSON.stringify(s.streams)}, keyFirst=${s.keyFirstPerGeneration}, seqUp=${s.sequenceIncreasing}, maxAgeMs=${s.maxAgeMs}, maxBytes=${s.maxBytes}, frameReady=${s.frameReady}`);
      receipt.expect(phase, 'decoded-colour-blocks', !!d && d.decoded >= Math.min(10, d.submitted - 2) && d.errors.length === 0 && d.quadOk >= Math.ceil(d.decoded * 0.9) && d.allBlack === 0,
        d ? `codec=${d.codecString}, size=${d.size}, submitted=${d.submitted}, decoded=${d.decoded}, quadOk=${d.quadOk}, allBlack=${d.allBlack}, errors=${JSON.stringify(d.errors)}, first=${JSON.stringify(d.firstRegions)}` : 'no decodable generation');
      receipt.expect(phase, 'decoded-change-toggle-block', !!d && d.toggleA > 0 && d.toggleB > 0,
        d ? `toggleA=${d.toggleA}, toggleB=${d.toggleB}, of ${d.decoded}` : 'no decode');
      receipt.expect(phase, 'keyframe-request-resets-stream', s.generations.length >= 2 && !!r && r.decoded > 0 && r.quadOk >= Math.ceil(r.decoded * 0.9),
        `generations=${JSON.stringify(s.generations)}, resetDecoded=${r?.decoded ?? 0}, resetQuadOk=${r?.quadOk ?? 0}, resetCodec=${r?.codecString ?? null}`);
      receipt.expect(phase, 'disconnect-closes-and-releases-capture', s.closed && s.released, `closed=${s.closed}, reason=${s.closeReason}, rendererReleased=${s.released}`);
    };

    if (!displays.length) {
      receipt.expect('capture', 'product-display-list', false, 'Hub status lists no display for this runner');
    } else {
      // 5. First session on the first product display.
      const first = await runSession(displays[0], 'first');
      evidence.sessions.push(first);
      checkSession(first, 'capture');
      // 6. Reconnect: a fresh session on the same display re-resolves the source and streams again.
      const again = await runSession(displays[0], 'reconnect');
      evidence.sessions.push(again);
      checkSession(again, 'reconnect');
      // 6b. H.264-only viewer (as a sharp/h264Only session or a decoder without VP8 would ask):
      // observed only, since a GPU-less runner may have no H.264 encoder.
      {
        const opened = await api('/api/screens/sessions?includeWindows=1', remote.token, { desktopId: status.desktop.desktopId, displayId: displays[0].id,
          displayRevision: displays[0].revision, requestId: randomUUID(), codecs: ['h264'] });
        const join = opened.status === 201 ? screenJoinSchema.parse(await opened.json()) : null;
        let result = { http: opened.status };
        if (join) {
          const wsBase = hub.instanceUrl.replace('http:', 'ws:');
          const frames = [];
          let control;
          control = connectWs(`${wsBase}/screen/v1/control`, cleanups);
          const media = connectWs(`${wsBase}/screen/v1/media`, cleanups, bytes => {
            try { const h = readScreenFrame(bytes); frames.push(h); control.send({ type: 'ack', sessionId: join.session.id, generation: join.session.generation, frameSequence: h.sequence }); } catch { /* ignore */ }
          });
          await Promise.all([control.ready, media.ready]);
          control.send({ type: 'hello', ticket: join.controlTicket }); media.send({ type: 'hello', ticket: join.mediaTicket });
          await wait(() => frames.length >= 5 || control.values.some(v => v.type === 'state' && v.session.state === 'closed'), 12000);
          const closed = control.values.findLast(v => v.type === 'state' && v.session.state === 'closed');
          if (!closed) control.send({ type: 'disconnect', sessionId: join.session.id, generation: join.session.generation });
          await wait(async () => !(await target.call('host-active')).active, 5000);
          const streams = media.values.filter(v => !(v instanceof Uint8Array) && v.type === 'stream').map(v => v.codecString);
          const events = (await target.call('diag')).captureEvents.filter(e => e.type === 'ended').slice(-2);
          result = { http: opened.status, frames: frames.length, streams, closedReason: closed?.session.reason ?? null, captureEnded: events };
        }
        evidence.h264Only = result;
        receipt.info('codec', 'h264-only-viewer-on-this-runner', JSON.stringify(result));
      }
      // 7. Display switching only where the runner really has more than one display.
      if (displays.length > 1) {
        for (const display of displays.slice(1, 4)) {
          const other = await runSession(display, `display-${display.id}`);
          evidence.sessions.push(other);
          checkSession(other, `switch:${display.id}`);
          const idx = indexOf(display);
          receipt.expect(`switch:${display.id}`, 'frames-show-this-displays-layout', !!other.decodeFirst && other.decodeFirst.layoutMatch.every(m => m === idx),
            `expectedIndex=${idx}, layoutMatch=${JSON.stringify(other.decodeFirst?.layoutMatch)}`);
        }
      } else {
        receipt.info('switch', 'display-switching', `runner exposes ${displays.length} display (${displays[0].width}x${displays[0].height} @${displays[0].scale}); no physical or virtual second display, switching not tested; no virtual display driver installed`);
      }
    }
    const diag1 = await target.call('diag');
    if (values['with-viewonly']) await viewOnlyPhase({ receipt, evidence, target, electronBin, addonPath, app, workDir, hub, api, remote, ctl, layout: started.layout, cleanups, hostDir });
    evidence.e4.resolveCalls = diag1.resolveCalls;
    evidence.e4.captureEvents = diag1.captureEvents;
    receipt.expect('e4', 'product-desktopSource-matched-on-every-start', diag1.resolveCalls.length > 0 && diag1.resolveCalls.every(c => c.matched),
      `resolveCalls=${JSON.stringify(diag1.resolveCalls)}`);
    receipt.info('capture', 'capture-host-events', JSON.stringify(diag1.captureEvents.filter(e => e.type !== 'sharing').slice(-16)));
    receipt.info('capture', 'target-stderr', target.stderr() || '(empty)');
  } catch (error) {
    receipt.expect('harness', 'unexpected-error', false, String(error?.stack ?? error).replace(/[A-Za-z]:\\[^\s"']+/g, '<path>').slice(0, 900));
  } finally {
    for (const s of evidence.sessions) delete s.raw;
    await writeFile(path.join(reportDir, 'windows-capture-acceptance.json'), JSON.stringify({ outcome: receipt.outcome, checks: receipt.checks, evidence }, null, 1));
    await writeFile(path.join(reportDir, 'windows-capture-acceptance.md'), receipt.markdown(meta));
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* ignore */ } }
  }
  console.log(`windows capture acceptance outcome: ${receipt.outcome}`);
  for (const c of receipt.checks) console.log(`[${c.status}] ${c.phase}/${c.id}: ${c.detail.slice(0, 400)}`);
  if (receipt.outcome !== 'pass') process.exitCode = 1;
}

await main();
