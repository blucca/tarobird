import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { HubServer } from '../../src/hub/server.js';
import { hashSecret } from '../../src/hub/auth.js';
import { attachGateway } from '../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../src/core/runtime.js';
import { selectConversation, waitForClientOnline } from './fixtures/mobile.js';

// A local https/wss origin under a public-looking name; no external site is contacted.
const HOST = 'widget-net.test';
test.use({ serviceWorkers: 'block', ignoreHTTPSErrors: true, launchOptions: { args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] } });

type Seen = { path: string; host?: string; probe?: string | null; cookie?: string; referer?: string; authorization?: string };
let tls: { key: Buffer; cert: Buffer }, certDir: string;
test.beforeAll(async () => {
  certDir = await mkdtemp(path.join(os.tmpdir(), 'widget-net-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'), '-days', '2', '-subj', `/CN=${HOST}`, '-addext', `subjectAltName=DNS:${HOST},IP:127.0.0.1`], { stdio: 'ignore' });
  tls = { key: await readFile(path.join(certDir, 'key.pem')), cert: await readFile(path.join(certDir, 'cert.pem')) };
});
test.afterAll(async () => { await rm(certDir, { recursive: true, force: true }); });

async function origin() {
  const seen: Seen[] = [], plain: string[] = [], streams: { path: string; started: number; closed?: number; bytes: number }[] = [];
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const server: Server = createHttpsServer(tls, (req, res) => {
    const url = new URL(req.url!, `https://${HOST}`);
    seen.push({ path: url.pathname, host: req.headers.host, probe: url.searchParams.get('p'), cookie: req.headers.cookie, referer: req.headers.referer, authorization: req.headers.authorization });
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url.pathname === '/set-cookie') { res.writeHead(200, { 'Set-Cookie': 'site_session=third-party; SameSite=None; Secure; Path=/', 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    if (url.pathname === '/data.json') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Set-Cookie': 'tracker=1; SameSite=None; Secure; Path=/' }); res.end('{"ok":1}'); return; }
    if (url.pathname === '/events') { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.end('data: hello\n\n'); return; }
    if (url.pathname === '/lib.js') { res.writeHead(200, { ...cors, 'Content-Type': 'text/javascript' }); res.end('(function(g){g.NetLib={double:function(x){return x*2},hasDocument:typeof document==="object"&&typeof document.createElement==="function"}})(typeof globalThis!=="undefined"?globalThis:this);'); return; }
    // A script body that never ends, streamed as fast as the client reads, and
    // one that sends its headers and then nothing.
    if (url.pathname === '/endless.js' || url.pathname === '/stalled.js') {
      const stream = { path: url.pathname, started: Date.now(), bytes: 0 }; streams.push(stream);
      res.writeHead(200, { ...cors, 'Content-Type': 'text/javascript' }); res.flushHeaders();
      const chunk = Buffer.alloc(1 << 20, '/');
      const pump = () => { while (url.pathname === '/endless.js' && !res.destroyed) { stream.bytes += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } };
      res.on('close', () => { stream.closed = Date.now(); }); pump(); return;
    }
    if (url.pathname === '/not-js') { res.writeHead(200, { ...cors, 'Content-Type': 'text/html' }); res.end('<p>no</p>'); return; }
    if (url.pathname === '/style.css') { res.writeHead(200, { ...cors, 'Content-Type': 'text/css' }); res.end(`.styled{color:rgb(1,2,3)}@font-face{font-family:NetFont;src:url(https://${HOST}:${(server.address() as AddressInfo).port}/font.woff2)}.font{font-family:NetFont,sans-serif}`); return; }
    if (url.pathname === '/pixel.png') { res.writeHead(200, { ...cors, 'Content-Type': 'image/png' }); res.end(pixel); return; }
    res.writeHead(404, cors); res.end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, req) => { seen.push({ path: '/ws', host: req.headers.host, probe: new URL(req.url!, 'wss://x').searchParams.get('p'), cookie: req.headers.cookie, referer: req.headers.referer }); socket.on('message', data => socket.send('echo:' + data)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const insecure = createHttpServer((req, res) => { plain.push(req.url!); res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('plain'); });
  await new Promise<void>(resolve => insecure.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port, httpPort = (insecure.address() as AddressInfo).port;
  return { seen, plain, streams, base: `https://${HOST}:${port}`, ws: `wss://${HOST}:${port}`, port, httpPort, close: async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); server.closeAllConnections(); insecure.closeAllConnections(); await new Promise(r => server.close(r)); await new Promise(r => insecure.close(r)); } };
}

async function fixture(page: Page, html: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'widget-net-')), stateDir = path.join(root, 'bot'); await mkdir(stateDir);
  const hub = await HubServer.start({ stateDir: path.join(root, 'hub'), clientDir: path.resolve('dist') });
  const secret = randomBytes(32).toString('base64url'); await hub.store.db.run('INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)', ['alpha', '可视化助手', hashSecret(secret)]);
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'codex', locale: 'zh' }));
  const widget = { title: '联网组件', summary: '示例：外部资源与网络请求。', html };
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: 'alpha', engine: 'codex', model: 'fixture', effort: 'high', runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async input => {
    await input.appPlatformTools!.call({ name: 'app_show_widget', arguments: widget, sessionId: 'fixture', callId: 'visual', abortSignal: input.abortSignal! }); return { text: '见组件。' };
  } } });
  const conv = await hub.store.createConversation('owner', ['alpha'], '联网', 'network_chat');
  await page.goto(hub.url); await preparePairing(page, hub); await page.getByRole('button', { name: '配对此设备', exact: true }).click(); await hub.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner'); await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await waitForClientOnline(page);
  return { conv, publish: async () => { await selectConversation(page, conv.title); await page.getByLabel('消息', { exact: true }).fill('联网试试'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); }, dispose: async () => { await page.close(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
const guest = (page: Page): FrameLocator => page.frameLocator('.widget-panel:visible > iframe').frameLocator('iframe');
const probe = (o: Awaited<ReturnType<typeof origin>>) => `<link rel="stylesheet" href="${o.base}/style.css"><p id="styled" class="styled font">外部样式</p><img id="image" src="${o.base}/pixel.png" alt="外部图片" width="12" height="12"><img id="plain-image" src="http://${HOST}:${o.httpPort}/plain.png" alt="明文图片" width="12" height="12"><audio id="audio" src="${o.base}/tone.wav" preload="auto" controls autoplay></audio><p id="results">pending</p>
<script src="${o.base}/lib.js"></script><script src="${o.base}/not-js"></script>
<script>
var out={};var B='${o.base}';
function settle(name,promise){return Promise.resolve().then(function(){return promise()}).then(function(v){out[name]=v},function(e){out[name]='blocked'})}
out.lib=typeof NetLib==='object'?[NetLib.double(21),NetLib.hasDocument]:'missing';
Promise.all([
 settle('fetch',function(){return fetch(B+'/data.json',{credentials:'include'}).then(function(r){return r.json()}).then(function(j){return j.ok})}),
 settle('xhr',function(){return new Promise(function(res,rej){var x=new XMLHttpRequest();x.open('GET',B+'/data.json');x.withCredentials=true;x.onload=function(){res(JSON.parse(x.responseText).ok)};x.onerror=rej;x.send()})}),
 settle('sse',function(){return new Promise(function(res,rej){var s=new EventSource(B+'/events');s.onmessage=function(e){s.close();res(e.data)};s.onerror=function(){s.close();rej()}})}),
 settle('ws',function(){return new Promise(function(res,rej){var w=new WebSocket('${o.ws}/ws');w.onopen=function(){w.send('ping')};w.onmessage=function(e){w.close();res(e.data)};w.onerror=rej})}),
 settle('http',function(){return fetch('http://${HOST}:${o.httpPort}/plain').then(function(){return 'reached'})}),
 settle('loopback',function(){return fetch('https://127.0.0.1:${o.port}/data.json').then(function(){return 'reached'})}),
 settle('private',function(){return fetch('https://192.168.1.1/').then(function(){return 'reached'})}),
 settle('rtc',function(){return typeof RTCPeerConnection==='function'?'available':Promise.reject()}),
]).then(function(){document.getElementById('results').textContent=JSON.stringify(out)});
</script>`;

test('https/wss resources and requests work while isolation holds', async ({ page, context }) => {
  test.setTimeout(120_000);
  const o = await origin();
  // A top-level visit gives the test origin its own cookie; widget requests must not carry it.
  const visit = await context.newPage(); await visit.goto(`${o.base}/set-cookie`); await visit.close();
  const f = await fixture(page, probe(o));
  try {
    await page.evaluate(() => { document.cookie = 'app_session=secret; path=/'; });
    await f.publish();
    await expect(guest(page).locator('#results')).not.toHaveText('pending', { timeout: 20_000 });
    const results = JSON.parse(await guest(page).locator('#results').innerText());
    expect(results).toEqual({ lib: [42, true], fetch: 1, xhr: 1, sse: 'hello', ws: 'echo:ping', http: 'blocked', loopback: 'blocked', private: 'blocked', rtc: 'blocked' });
    await expect(guest(page).locator('#styled')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect.poll(() => guest(page).locator('#image').evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
    expect(await guest(page).locator('#plain-image').getAttribute('src')).toBeNull();
    // The guest is an opaque frame: no App document, cookie or storage.
    expect(await guest(page).locator('html').evaluate(() => { const r: string[] = []; try { void window.parent.document; r.push('parent'); } catch { /* blocked */ } try { void document.cookie; r.push('cookie'); } catch { /* blocked */ } try { void localStorage; r.push('storage'); } catch { /* blocked */ } return r; })).toEqual([]);
    const paths = o.seen.map(s => s.path);
    await expect.poll(() => o.seen.some(s => s.path === '/tone.wav')).toBe(true);
    expect(await guest(page).locator('#audio').getAttribute('autoplay')).toBeNull();
    for (const expected of ['/style.css', '/pixel.png', '/lib.js', '/data.json', '/events', '/ws']) expect(paths, expected).toContain(expected);
    await expect.poll(() => o.seen.some(s => s.path === '/font.woff2')).toBe(true);
    expect(o.plain).toEqual([]);
    const fromWidget = o.seen.filter(s => s.path !== '/set-cookie');
    // No request names the App or the widget: the only referrer is an external stylesheet's own URL for its font.
    expect(fromWidget.filter(s => s.referer && !s.referer.startsWith(o.base + '/style.css') || s.authorization || s.cookie?.includes('app_session'))).toEqual([]);
    // Script-initiated requests never send cookies; record what document resource loads do.
    expect(fromWidget.filter(s => ['/data.json', '/events', '/lib.js', '/not-js'].includes(s.path) && s.cookie)).toEqual([]);
    test.info().annotations.push({ type: 'third-party cookie on document resources', description: JSON.stringify(fromWidget.filter(s => s.cookie).map(s => s.path)) });
    await expect(page.getByText('组件未能完整运行', { exact: false }).first()).toBeVisible(); // a script that fails to run reports a warning, static content stays
  } finally { await f.dispose(); await o.close(); }
});

test('an external script that never ends or stalls after its headers is cut off while the widget keeps working', async ({ page }) => {
  test.setTimeout(120_000);
  const o = await origin();
  const f = await fixture(page, `<p id="results">pending</p><script src="${o.base}/lib.js"></script><script src="${o.base}/endless.js"></script><script src="${o.base}/stalled.js"></script><script>document.getElementById('results').textContent=String(NetLib.double(21));</script>`);
  try {
    const started = Date.now();
    await f.publish();
    // Both downloads are abandoned (16 MiB shared budget, 15 s per download) and the inline script still runs.
    await expect(guest(page).locator('#results')).toHaveText('42', { timeout: 40_000 });
    await expect(page.getByText('组件未能完整运行', { exact: false }).first()).toBeVisible();
    await expect.poll(() => o.streams.every(stream => stream.closed !== undefined), { timeout: 10_000 }).toBe(true);
    const endless = o.streams.find(stream => stream.path === '/endless.js')!, stalled = o.streams.find(stream => stream.path === '/stalled.js')!;
    expect(endless.bytes).toBeGreaterThan(16 << 20);
    expect(endless.bytes).toBeLessThan(64 << 20);
    expect(stalled.bytes).toBe(0);
    expect(stalled.closed! - stalled.started).toBeGreaterThanOrEqual(14_000);
    expect(stalled.closed! - stalled.started).toBeLessThan(30_000);
    expect(Date.now() - started).toBeLessThan(60_000);
  } finally { await f.dispose(); await o.close(); }
});

// Guest code shares the Worker realm with the network guard. None of these may
// reach a loopback listener: native constructors behind the wrappers, deeper
// prototype methods, objects whose url and string form differ, or replaced
// String, RegExp, URL or Request prototype members.
test('guest code cannot get past the network guard to a loopback listener', async ({ page }) => {
  test.setTimeout(120_000);
  const o = await origin();
  const L = `https://127.0.0.1:${o.port}`, W = `wss://127.0.0.1:${o.port}`;
  const f = await fixture(page, `<p id="results">pending</p><script>
var out={},B='${o.base}',L='${L}',W='${W}';
function xhr(X,url,open){return new Promise(function(res,rej){var x=new X();(open||x.open).call(x,'GET',url);x.onload=function(){res('reached')};x.onerror=rej;x.send()})}
function deepest(proto,name){var found;for(var p=proto;p;p=Object.getPrototypeOf(p))if(Object.getOwnPropertyDescriptor(p,name))found=p[name];return found}
function socket(S,url){return new Promise(function(res,rej){var w=new S(url);w.onopen=function(){w.close();res('reached')};w.onerror=rej})}
function events(E,url){return new Promise(function(res,rej){var s=new E(url);s.onmessage=function(){s.close();res('reached')};s.onerror=function(){s.close();rej()}})}
function reach(r){return r.then(function(x){return x&&x.ok!==undefined?'reached':x})}
function tamper(object,name,descriptor,run){var saved=Object.getOwnPropertyDescriptor(object,name);Object.defineProperty(object,name,descriptor);try{return run()}finally{Object.defineProperty(object,name,saved)}}
var probes=[
 ['nativeXhr',function(){return xhr(Object.getPrototypeOf(XMLHttpRequest),L+'/data.json?p=nativeXhr')}],
 ['protoOpen',function(){return xhr(XMLHttpRequest,L+'/data.json?p=protoOpen',deepest(XMLHttpRequest.prototype,'open'))}],
 ['nativeWebSocket',function(){return socket(Object.getPrototypeOf(WebSocket),W+'/ws?p=nativeWebSocket')}],
 ['nativeEventSource',function(){return events(Object.getPrototypeOf(EventSource),L+'/events?p=nativeEventSource')}],
 ['fetchObject',function(){return reach(fetch({url:B+'/data.json',toString:function(){return L+'/data.json?p=fetchObject'}}))}],
 ['urlHostname',function(){return reach(tamper(URL.prototype,'hostname',{configurable:true,get:function(){return 'widget-net.test'}},function(){return fetch(L+'/data.json?p=urlHostname')}))}],
 ['stringLower',function(){return reach(tamper(String.prototype,'toLowerCase',{configurable:true,writable:true,value:function(){return 'widget-net.test'}},function(){return fetch(L+'/data.json?p=stringLower')}))}],
 ['regExp',function(){return reach(tamper(RegExp.prototype,'exec',{configurable:true,writable:true,value:function(){return null}},function(){return tamper(RegExp.prototype,'test',{configurable:true,writable:true,value:function(){return false}},function(){return fetch(L+'/data.json?p=regExp')})}))}],
 ['requestUrl',function(){var request=new Request(L+'/data.json?p=requestUrl');return reach(tamper(Request.prototype,'url',{configurable:true,get:function(){return B+'/data.json'}},function(){return fetch(request)}))}],
];
var chain=Promise.resolve();
probes.forEach(function(p){chain=chain.then(function(){return Promise.resolve().then(p[1])}).then(function(v){out[p[0]]=v},function(){out[p[0]]='blocked'})});
chain.then(function(){out.wrappers=[WebSocket.OPEN,EventSource.CLOSED,XMLHttpRequest.DONE,new XMLHttpRequest() instanceof XMLHttpRequest];document.getElementById('results').textContent=JSON.stringify(out)});
</script>`);
  try {
    await f.publish();
    await expect(guest(page).locator('#results')).not.toHaveText('pending', { timeout: 30_000 });
    const results = JSON.parse(await guest(page).locator('#results').innerText());
    expect(results).toEqual({ nativeXhr: 'blocked', protoOpen: 'blocked', nativeWebSocket: 'blocked', nativeEventSource: 'blocked', fetchObject: 'blocked', urlHostname: 'blocked', stringLower: 'blocked', regExp: 'blocked', requestUrl: 'blocked', wrappers: [1, 2, 4, true] });
    expect(o.seen.filter(s => s.host?.startsWith('127.0.0.1')).map(s => s.probe)).toEqual([]);
  } finally { await f.dispose(); await o.close(); }
});
