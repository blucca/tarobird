import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// Issue #63. Actual HostApp + IndexedDB; only native IPC and network delivery
// are fixtures. A stopped local host offers an explicit start in the banner and
// on the devices page; automatic recovery (resume) never starts it.
const html = `<!doctype html><html lang="zh"><body><div id="root"></div><script type="module">
const calls=[], starts=[];
const key=n=>btoa(String.fromCharCode(...[48,42,48,5,6,3,43,101,112,3,33,0,...Array(32).fill(n)]));
const localKey=key(1), remoteKey=key(2);
window.host={enabled:false,mode:'fail',release:undefined};
const running=()=>({available:true,running:true,publicKey:localKey,hostName:'Local',controlCapabilities:['desktop-controller-challenge','enroll-desktop-controller']});
const stopped=()=>({available:true,running:false,hostEnabled:false,hostName:'Local'});
const invoke=async(command,args={})=>{
  calls.push({command,action:args.action});
  if(command==='desktop_host'){
    if(args.action==='pair') return {};
    if(args.action==='start'){
      await new Promise(resolve=>{window.host.release=resolve;});
      if(window.host.mode==='fail') return {...stopped(),startIssue:{code:'schema_incompatible',schema:27,minHubSchema:1,maxHubSchema:26}};
      window.host.enabled=true; return running();
    }
    return window.host.enabled?running():stopped();
  }
  if(command==='net_document') return 'fixture-document';
  if(command==='github_update_info') return {configured:false,version:'1.0.120',provider:'default',authenticated:false};
  if(command==='desktop_launch_links') return [];
  if(command==='desktop_notifications_supported') return false;
  if(command==='unread_count') return null;
  throw Error('fixture_unhandled_'+command);
};
window.tarobotDesktop={version:1,engine:'electron',platform:'darwin',invoke,on:()=>()=>{},openSocket:async()=>{throw Error('unexpected_socket');}};
const [{createElement},{createRoot},{HostApp},{HostRegistry},{HostConnections},{HubConnection}]=await Promise.all([
  import('react'),import('react-dom/client'),import('/src/HostApp.tsx'),import('/src/host-registry.ts'),
  import('/src/host-connections.ts'),import('/src/connection.ts')]);
import '/src/styles.css';import '/src/brand-theme.css';import '/src/palette-tokens.css';
const registry=new HostRegistry();
const params=new URLSearchParams(location.search);
if(params.has('locale')){
  const {defaultPreferences}=await import('/src/storage.ts'),{setLocale}=await import('/src/i18n.ts');
  setLocale(params.get('locale'));await registry.savePreferences({...defaultPreferences,locale:params.get('locale')});
}
const add=async(name,hubPublicKey,deviceId)=>registry.add({deviceId,keyRef:deviceId,name,platform:'macos',publicKey:key(3),hubPublicKey,routes:[]},name);
if(!(await registry.list()).length){await add('Local',localKey,'device_local');await add('Remote',remoteKey,'device_remote');}
await registry.rememberNativeLocalHost(localKey);
HubConnection.prototype.start=async function(){starts.push(this.identity.hubPublicKey);};
const start=HostConnections.prototype.start;
HostConnections.prototype.start=async function(){await start.call(this);window.bootPool=this;};
window.readback=()=>({calls:calls.slice(),starts:starts.slice(),localKey,remoteKey,pending:window.bootPool?.localControllerPending});
// The fixture workspace only exposes the shell's own "open devices" entry.
createRoot(document.getElementById('root')).render(createElement(HostApp,{Workspace:({forget})=>createElement('button',{type:'button',onClick:()=>forget()},'OPEN_DEVICES'),Pairing:()=>createElement('div',null,'PAIRING')}));
</script></body></html>`;

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "local-host-start-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/__local-host-start")) return next();
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__local-host-start", html));
    });
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen(); url = server.resolvedUrls!.local[0]! + "__local-host-start";
});
test.afterAll(async () => { await server?.close(); });
test.use({ serviceWorkers: "block" });
const actions = async (page: import("@playwright/test").Page) => (await page.evaluate(() => (window as any).readback())).calls.filter((c: any) => c.command === "desktop_host").map((c: any) => c.action);

test("a stopped local host can be started from the banner and the devices page", async ({ page }) => {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).bootPool))).toBe(true);
  const banner = page.locator(".host-error");
  await expect(banner).toContainText("本机主机已停用，App 不会自动重新启用。点「启动本机主机」即可恢复");
  await expect(banner.getByRole("button", { name: "启动本机主机" })).toBeEnabled();
  await expect(banner.getByRole("button", { name: "关闭" })).toBeVisible();
  // Automatic recovery checks never start it, even on focus/visibility events.
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  expect(await actions(page)).not.toContain("start");
  // The other host still connects.
  expect((await page.evaluate(() => (window as any).readback())).starts).toEqual([await page.evaluate(() => (window as any).readback().remoteKey)]);
  await page.screenshot({ path: test.info().outputPath("stopped-banner.png") });

  // Failure: busy keeps focus on the button; closing the banner while starting
  // does not hide why it failed; the reason and the button stay.
  const startButton = banner.getByRole("button", { name: "启动本机主机" });
  await startButton.focus(); await page.keyboard.press("Enter");
  const busy = banner.getByRole("button", { name: "正在启动本机主机…" });
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await expect(busy).toBeFocused();
  await banner.getByRole("button", { name: "关闭" }).click();
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => (window as any).host.release());
  await expect(banner.locator(".local-host-start-error")).toHaveText("未启动：主机数据来自更新版本的 TaroBird。请先更新 App，再启动本机主机。数据未改动。");
  await expect(banner.locator(".local-host-start-error")).not.toHaveAttribute("role");
  await expect(banner.getByRole("button", { name: "启动本机主机" })).not.toHaveAttribute("aria-disabled");
  await page.screenshot({ path: test.info().outputPath("start-failed.png") });

  // Devices page: the local entry carries the same action and shared state.
  await page.getByRole("button", { name: "OPEN_DEVICES" }).click();
  const manager = page.locator(".network-manager");
  const localRow = manager.getByRole("button", { name: /Local.*本机主机已停用，App 不会自动重新启用。.*已停止/ });
  await expect(localRow).toBeVisible();
  const pageStart = manager.locator(".network-local-start").getByRole("button", { name: "启动本机主机" });
  await expect(pageStart).toBeEnabled();
  await expect(manager.locator(".network-local-start").getByRole("status")).toContainText("更新版本的 TaroBird");
  await page.screenshot({ path: test.info().outputPath("devices-local-entry.png") });

  // Success: reconnects through the ordinary recovery path; entries disappear.
  await page.evaluate(() => { (window as any).host.mode = "ok"; });
  await pageStart.click();
  await expect(manager.locator(".network-local-start").getByRole("button", { name: "正在启动本机主机…" })).toHaveAttribute("aria-disabled", "true");
  await expect(banner.getByRole("button", { name: "正在启动本机主机…" })).toHaveAttribute("aria-disabled", "true");
  await page.evaluate(() => (window as any).host.release());
  await expect(banner).toHaveCount(0);
  await expect(manager.locator(".network-local-start")).toHaveCount(0);
  const result = await page.evaluate(() => (window as any).readback());
  expect(result.calls.filter((c: any) => c.command === "desktop_host" && c.action === "start")).toHaveLength(2);
  // After start: resume, then the native controller pairing, then the connection.
  expect(result.calls.filter((c: any) => c.command === "desktop_host").map((c: any) => c.action).slice(-3)).toEqual(["start", "resume", "pair"]);
  expect(result.starts).toContain(result.localKey);
  expect(result.pending).toBe(false);
});

test("English copy for the stopped host and its start action", async ({ page }) => {
  await page.goto(`${url}?locale=en`);
  const banner = page.locator(".host-error");
  await expect(banner).toContainText("This computer's host is stopped, and the App won't turn it back on by itself. Choose Start local host to resume.");
  await expect(banner.getByRole("button", { name: "Start local host" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("stopped-banner-en.png") });
});
