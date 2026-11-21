import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ScreenViewers } from '../screen-viewer.mjs';

// The main-process focus gate turns a `control` from an unfocused window into a
// Hub `release`. The Hub answers nothing for a session it never leased, so the
// document must be told, or it waits for a lease forever ("等待新画面…").
class Port extends EventEmitter { constructor() { super(); this.posted = []; } start() {} close() { this.emit('close'); } postMessage(value) { this.posted.push(value); } }
class Channel { constructor() { this.port1 = new Port(); this.port2 = new Port(); } }

async function harness({ focused }) {
  const received = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  server.on('connection', ws => ws.on('message', raw => {
    const value = JSON.parse(String(raw));
    if (value.type === 'hello') { ws.send(JSON.stringify({ type: 'attached', sessionId: 'screen_session' })); return; }
    received.push(value);
  }));
  const display = { id: 'display', nativeId: '1', name: 'Display', revision: 1, x: 0, y: 0, width: 640, height: 360, scale: 1, rotation: 0 };
  const join = { session: { id: 'screen_session', desktopId: 'desktop', deviceId: 'viewer', deviceName: 'Viewer', generation: 'generation', display, controlAllowed: true, state: 'viewing', createdAt: Date.now() },
    controlTicket: 'c'.repeat(43), mediaTicket: 'm'.repeat(43), expiresAt: Date.now() + 30000, serverTime: Date.now() };
  let page;
  const window = { isDestroyed: () => false, isFocused: () => focused, isVisible: () => true, isMinimized: () => false,
    webContents: { postMessage: (_channel, _value, ports) => { page = ports[0]; }, setIgnoreMenuShortcuts: () => {} } };
  const viewers = new ScreenViewers(window, { MessageChannelMain: Channel });
  await viewers.open({ channelId: randomUUID(), join, network: { url: `http://127.0.0.1:${server.address().port}`, publicKey: 'a'.repeat(59) + '=' } }, () => true);
  const main = viewers.viewers.get('screen_session').port;
  const fromPage = data => main.emit('message', { data });
  const until = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20)); return check(); };
  await until(() => viewers.viewers.get('screen_session')?.controlReady);
  return { received, main, page, fromPage, until, close: () => { viewers.retire(); server.close(); } };
}

test('a control refused by the focus gate is reported to the document, never forwarded', async () => {
  const h = await harness({ focused: false });
  try {
    h.fromPage({ type: 'control', sessionId: 'screen_session', generation: 'generation', frameSequence: 1 });
    assert.equal(await h.until(() => h.received.length > 0), true);
    assert.deepEqual(h.received.map(v => v.type), ['release'], 'the Hub only sees a release');
    assert.ok(h.main.posted.some(v => v?.type === 'control-refused'), 'the document learns its request was refused');
  } finally { h.close(); }
});

test('a focused window still forwards control and is not told it was refused', async () => {
  const h = await harness({ focused: true });
  try {
    h.fromPage({ type: 'control', sessionId: 'screen_session', generation: 'generation', frameSequence: 1 });
    assert.equal(await h.until(() => h.received.length > 0), true);
    assert.deepEqual(h.received.map(v => v.type), ['control']);
    assert.equal(h.main.posted.some(v => v?.type === 'control-refused'), false);
  } finally { h.close(); }
});
