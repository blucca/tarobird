// ACCEPTANCE-ONLY (#48 full chain), controller side B. Same shell as
// electron/tests/screen-controls.smoke.mjs: product secure session/contents/
// webPreferences and the product DesktopServices, whose screen_viewer_open
// runs the product ScreenViewers (both Hub sockets in this main process,
// a MessagePort to the page). The page renders the real RemoteScreenPanel.
// Not the packaged App: no local Host, no native core, no chat UI; the
// panel's three Hub screen calls go through a small adapter (see b-entry.tsx).
import * as electron from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { secureSession, secureContents, secureWebPreferences } from '../../electron/security.mjs';
import { DesktopServices } from '../../electron/desktop-services.mjs';

const { app, BrowserWindow, protocol, session, net, ipcMain } = electron;
const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = arg('root'), hubUrl = arg('hub'), token = arg('token');
protocol.registerSchemesAsPrivileged([{ scheme: 'tarobot', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.setPath('userData', path.join(root, 'profile'));
// Never await ready at module scope (see electron/main.mjs).
async function run() {
await app.whenReady();
const owned = session.fromPartition('persist:win48-controller'); let window;
secureSession(owned, { owns: contents => contents === window?.webContents });
owned.protocol.handle('tarobot', request => { const file = path.resolve(root, '.' + new URL(request.url).pathname); if (!file.startsWith(root + path.sep)) return new Response('', { status: 403 }); return net.fetch(pathToFileURL(file).href); });
window = new BrowserWindow({ title: 'TaroBird controller B', x: 512, y: 0, width: 512, height: 720, show: false, webPreferences: { ...secureWebPreferences(path.join(root, 'preload.cjs'), owned), backgroundThrottling: false } });
secureContents(window.webContents);
const services = new DesktopServices(window, electron);
const mine = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
ipcMain.handle('acc:invoke', (event, command, args) => { if (!mine(event)) throw new Error('not_controller'); return services.request(command, args ?? {}, () => !window.isDestroyed()); });
// The viewer device's own bearer token (from its real pairing) stays in main.
ipcMain.handle('acc:hub', async (event, route, init = {}) => {
  if (!mine(event) || typeof route !== 'string' || !route.startsWith('/api/screens/')) throw new Error('not_controller');
  const res = await fetch(hubUrl + route, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) }, ...(init.body ? { body: init.body } : {}) });
  const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: res.status, body };
});
window.on('closed', () => services.dispose());
await window.loadURL(`tarobot://app/index.html?lang=${arg('lang') ?? 'zh'}&url=${encodeURIComponent(hubUrl)}&hpk=${encodeURIComponent(arg('hpk'))}`);
window.show();
}
void run().catch(error => { console.error(error); app.exit(1); });
