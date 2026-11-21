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
// Same-desktop accommodation, off by default and switched on by the harness
// only after recording the unmodified behaviour: A's remote click activates
// A's test window on the ONE shared desktop, which blurs B's window, and the
// panel releases control on window blur (by design). On two machines B keeps
// its own foreground. Registered first, so it runs before the page's listener.
let suppressBlur = false, blurs = 0;
window.addEventListener('blur', event => { blurs++; if (suppressBlur) event.stopImmediatePropagation(); }, true);
contextBridge.exposeInMainWorld('accHarness', { suppressBlur: value => { suppressBlur = !!value; }, blurs: () => blurs });
contextBridge.exposeInMainWorld('accHub', { request: (route, init) => ipcRenderer.invoke('acc:hub', route, init) });
