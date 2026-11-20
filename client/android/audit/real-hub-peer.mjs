// A real HubServer (TLS listener, auth, grants, screen routes, heartbeat) with a
// real target ScreenService whose capture is synthetic. A paired, granted viewer
// device opens sessions over the Hub's HTTPS API; the native transport under test
// connects to the Hub's own screen sockets. No real screen is captured or input
// posted. Run with `node --import tsx` from the repository root.
// Usage: node --import tsx client/android/audit/real-hub-peer.mjs <private-scratch>
import { execFileSync } from 'node:child_process';
import { X509Certificate, randomUUID, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { HubServer } from '../../../src/hub/server.js';
import { startHubControl } from '../../../src/hub/service.js';
import { hashSecret } from '../../../src/hub/auth.js';
import { screenConfigureText } from '../../../src/client-protocol/remote-screen.js';
import { deviceActionProofText } from '../../../src/client-protocol/device-actions.js';
import { writeScreenFrame } from '../../../src/client-protocol/screen-wire.js';
import { deviceFields, enrollTrusted, loginFor, testDevice } from '../../../tests/helpers/pairing-invite.js';
import { ScreenService } from '../../electron/screen-service.mjs';
import { screenServiceTicket } from '../../electron/screen-host-control.mjs';

const root = path.resolve(process.argv[2]); mkdirSync(root, { recursive: true });
const openssl = args => execFileSync('openssl', args, { cwd: root, stdio: 'ignore' });
openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'hub-ca.key', '-out', 'hub-ca.crt', '-days', '1', '-subj', '/CN=Synthetic Hub CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
writeFileSync(path.join(root, 'hub-leaf.ext'), 'subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'hub.key', '-out', 'hub.csr', '-subj', '/CN=Synthetic Hub']);
openssl(['x509', '-req', '-in', 'hub.csr', '-CA', 'hub-ca.crt', '-CAkey', 'hub-ca.key', '-CAcreateserial', '-out', 'hub.crt', '-days', '1', '-extfile', 'hub-leaf.ext']);
const ca = readFileSync(path.join(root, 'hub-ca.crt'));

// A short directory: the Hub's local control socket path is limited to 100 bytes.
const dir = mkdtempSync(path.join(process.platform === 'win32' ? root : '/tmp', 'tarobird-hub-'));
const hub = await HubServer.start({ stateDir: dir, tls: { key: readFileSync(path.join(root, 'hub.key')), cert: readFileSync(path.join(root, 'hub.crt')) } });
const owner = testDevice('local'), viewer = testDevice('viewer');
await hub.enrollLocalController(deviceFields(owner)); await enrollTrusted(hub.auth, viewer);
const local = await loginFor(hub.auth, owner); let remote = await loginFor(hub.auth, viewer);
const command = { operation: 'screen.configure', expectedRevision: 0, enabled: true, requestId: randomUUID(), grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: 'control' }] };
const statement = await hub.auth.prepareDeviceAction({ operation: 'screen-grant', target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
await hub.remoteScreen.configure(local.session, command, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString('base64') });
const stopControl = await startHubControl(dir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }), () => {},
  { screenServiceTicket: id => hub.remoteScreen.serviceTicket(id) });

// A Mac target with a scripted addon; capture only reports what it is asked to send.
const addon = { screenDisplayUuid: () => 'display', screenSession: () => ({ available: true, onConsole: true, locked: false, unique: '00000000-0000-0000-0000-000000000001', audit: 1 }),
  screenCursor: () => ({ x: 0, y: 0 }), screenCaptureAccess: () => true, screenMonitorAccess: () => true, screenMouse: () => {}, screenScroll: () => {}, screenKey: () => {}, screenText: () => {},
  screenReleaseAll: () => 0, screenReleaseStale: () => {}, screenMonitorStart: () => {}, screenMonitorPoll: () => ({ alive: true, failed: false, foreign: 0, interrupted: 0 }), screenMonitorStop: () => {} };
const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0, label: 'Display' };
const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], dipToScreenPoint: () => ({ x: 0, y: 0 }) }), powerMonitor: new EventEmitter(),
  systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => true }, shell: { openExternal: async () => {} } };
const capture = { starts: [] };
const service = new ScreenService({ electron, addon, stateDir: path.join(dir, 'app'), platform: 'darwin',
  hostControl: { ticket: id => screenServiceTicket(dir, id) },
  captureHost: hooks => Object.assign(capture, { hooks,
    start: async s => { capture.starts.push(s); hooks.onMessage({ type: 'started', sessionId: s.sessionId, cursor: 'always' }); },
    reset: () => true, pause: () => true, keyframe: () => {}, credit: () => {}, stop: () => {}, close: () => {} }) });
await service.start();
const until = async (check, ms = 10000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('peer_wait_timeout'); await new Promise(r => setTimeout(r, 10)); } };
await until(() => service.status().registered);

// The viewer's own HTTPS requests, trusting only the synthetic Hub CA.
const api = (route, body) => new Promise((resolve, reject) => {
  const url = new URL(route, hub.url), payload = body === undefined ? undefined : JSON.stringify(body);
  const req = request(url, { method: payload ? 'POST' : 'GET', ca, headers: { Authorization: `Bearer ${remote.token}`, ...(payload ? { 'content-type': 'application/json' } : {}) } }, res => {
    let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch (error) { reject(error); } });
  });
  req.on('error', reject); req.end(payload);
});
let sequence = 0;
const live = id => hub.remoteScreen['sessions'].get(id);
const emit = id => {
  const start = capture.starts.find(s => s.sessionId === id), size = start.encode, captureMs = Date.now(), seq = ++sequence;
  capture.hooks.onMessage({ type: 'stream', sessionId: id, stream: { type: 'stream', streamGeneration: 1, geometryRevision: 1, codec: 'h264', codecString: 'avc1.640028', ...size, contentRect: { x: 0, y: 0, ...size } } });
  capture.hooks.onMessage({ type: 'captured', sessionId: id, captureMs });
  capture.hooks.onMessage({ type: 'frame', sessionId: id, sequence: seq, streamGeneration: 1, captureMs, geometryRevision: 1, key: true,
    bytes: writeScreenFrame({ key: true, codec: 'h264', sequence: seq, geometryRevision: 1, streamGeneration: 1, captureMs, ...size }, new Uint8Array([0, 0, 0, 1, 0x65])) });
  return seq;
};

console.log(JSON.stringify({ url: hub.url, publicKey: hub.auth.publicKey, certificateAuthority: new X509Certificate(ca).raw.toString('base64') }));
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line); let reply = {};
  try {
    if (input.action === 'join') {
      const status = await api('/api/screens/status?includeWindows=1'); if (status.status !== 200 || !status.body.desktop) throw new Error(`status ${status.status} ${status.body.error ?? 'no desktop'}`);
      const desktop = status.body.desktop, shown = desktop.displays[0];
      const opened = await api('/api/screens/sessions?includeWindows=1', { desktopId: desktop.desktopId, displayId: shown.id, displayRevision: shown.revision, requestId: randomUUID(), codecs: ['h264'], quality: 'smooth' });
      if (opened.status !== 201) throw new Error(`open ${opened.status} ${opened.body.error}`);
      reply = { join: opened.body };
    } else if (input.action === 'frame') {
      await until(() => capture.starts.some(s => s.sessionId === input.id) && live(input.id)?.media && live(input.id)?.control);
      reply = { sequence: emit(input.id) };
    } else if (input.action === 'live') {
      const value = live(input.id); reply = { live: !!value, attached: !!(value?.media && value?.control) };
    } else if (input.action === 'end') {
      // Each is the Host's own path for that ending, not a scripted close frame.
      if (input.how === 'stop') await hub.remoteScreen.stop(local.session, input.id);
      // The session holds the viewer's sign-in: expiring it is what the Host's tick ends; the device then signs in again.
      else if (input.how === 'expire') { live(input.id).auth.expiresAt = Date.now() - 1; hub.remoteScreen.tick(); await until(() => !live(input.id), 5000); remote = await loginFor(hub.auth, viewer); }
      else if (input.how === 'revoke') await hub.auth.revoke(viewer.deviceId, 'local-owner');
      else throw new Error('unknown ending');
      await until(() => !live(input.id), 5000);
    } else if (input.action === 'stop') { console.log('{}'); break; }
    else throw new Error('unknown action');
  } catch (error) { reply = { error: String(error?.message ?? error) }; }
  console.log(JSON.stringify(reply));
}
service.dispose(); await stopControl(); await hub.close(); rmSync(dir, { recursive: true, force: true });
