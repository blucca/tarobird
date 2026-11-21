// ACCEPTANCE-ONLY controller preload: the parts of electron/preload.mjs the
// remote screen uses. invoke → product DesktopServices; the viewer MessagePort
// is forwarded exactly like the product preload does.
import { contextBridge, ipcRenderer } from 'electron';
import { SCREEN_PORT, APP_ORIGIN } from '../../electron/contract.mjs';
ipcRenderer.on(SCREEN_PORT, (event, value) => {
  if (!value || typeof value.channelId !== 'string' || typeof value.sessionId !== 'string' || event.ports.length !== 1) { for (const p of event.ports) p.close(); return; }
  window.postMessage({ type: SCREEN_PORT, ...value }, APP_ORIGIN, event.ports);
});
contextBridge.exposeInMainWorld('tarobotDesktop', { version: 1, engine: 'electron', platform: process.platform,
  invoke: (command, args) => ipcRenderer.invoke('acc:invoke', command, args),
  openSocket: () => Promise.reject(new Error('not_used_in_this_acceptance')), on: () => () => {} });
contextBridge.exposeInMainWorld('accHub', { request: (route, init) => ipcRenderer.invoke('acc:hub', route, init) });
