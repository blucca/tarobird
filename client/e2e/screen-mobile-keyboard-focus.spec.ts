import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
// Real RemoteScreenPanel and viewer over the native plugin double
// (fixtures/screen-mobile.tsx). With `renewals` the double answers each renew
// with a new challenge, as a Host does; a viewer that stops renewing would lose
// its lease on a real Host (F-49-5 on the iPhone: paused after ~9 s).
let server: ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
test.use({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
const url=(platform:string)=>server.resolvedUrls!.local[0]+`e2e/fixtures/screen-mobile.html?platform=${platform}`;
const log=(page:Page)=>page.evaluate(()=>(window as any).screenMobileFixture);
const sent=async(page:Page,type:string)=>(await log(page)).commands.filter((value:any)=>value.type===type).length;
const focusName=(page:Page)=>page.evaluate(()=>{const node=document.activeElement as HTMLElement|null;return !node||node===document.body?"body":node.getAttribute("aria-label")??node.tagName;});
type Press=(page:Page,name:string)=>Promise<void>;
const presses:Record<string,Press>={
  touch:async(page,name)=>{await page.getByRole("button",{name,exact:true}).tap();},
  mouse:async(page,name)=>{await page.getByRole("button",{name,exact:true}).click();},
};
async function controlling(page:Page,platform:string){
  await page.goto(url(platform));await page.waitForFunction(()=>!!(window as any).screenMobileFixture);
  await page.evaluate(()=>{(window as any).screenMobileFixture.renewals=true;});
  await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await page.getByRole("button",{name:"开始控制",exact:true}).click();
  await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
}
async function typeInTray(page:Page,press:Press){
  await press(page,"键盘与快捷键");const editor=page.getByLabel("发送到远端的文本");await editor.tap();await editor.fill("已输入的文字");await expect(editor).toBeFocused();
}

for(const [platform,pointer] of [["ios","touch"],["ios","mouse"],["android","touch"]] as const)
test(`${platform} ${pointer}: closing the keyboard after typing keeps control and its renewals`,async({page})=>{
  await controlling(page,platform);const press=presses[pointer]!;await typeInTray(page,press);
  const controls=await sent(page,"control"),inputs=(await log(page)).commands.filter((value:any)=>value.type==="input").length;
  await press(page,"键盘与快捷键");await expect(page.getByLabel("发送到远端的文本")).toHaveCount(0);
  expect.soft(await focusName(page),"focus returns to the picture").toBe(await page.locator(".screen-mobile canvas").getAttribute("aria-label"));
  const renewed=await sent(page,"renew");await page.waitForTimeout(3500);
  expect(await sent(page,"renew"),"renewals continue while the viewer keeps focus").toBeGreaterThanOrEqual(renewed+2);
  await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  // Only focus moved: no new control request and no remote input (no simulated tap).
  expect(await sent(page,"control")).toBe(controls);
  expect((await log(page)).commands.filter((value:any)=>value.type==="input").length).toBe(inputs);
});

test("a real blur, stopped control, closed session or background is not undone by closing the keyboard",async({page})=>{
  await controlling(page,"ios");const press=presses.touch!;
  // Focus left the viewer (chat draft): control is released and stays released.
  await typeInTray(page,press);await page.getByLabel("Local chat draft").focus();
  await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();
  const controls=await sent(page,"control");await press(page,"键盘与快捷键");
  expect(await focusName(page)).toBe("Local chat draft");await page.waitForTimeout(1500);
  await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();expect(await sent(page,"control")).toBe(controls);
  // The person stopped control; closing the keyboard returns focus but never control.
  await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();
  await typeInTray(page,press);await press(page,"停止控制");await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();
  const stopped=await sent(page,"control");await press(page,"键盘与快捷键");
  expect(await focusName(page)).toBe(await page.locator(".screen-mobile canvas").getAttribute("aria-label"));
  await page.waitForTimeout(1500);await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();expect(await sent(page,"control")).toBe(stopped);
  // The Host ended the session: focus goes to the keyboard button, nothing reconnects.
  const opens=(await log(page)).opens;await typeInTray(page,press);
  await page.evaluate(()=>(window as any).screenMobileHostClose("screen_host_stopped"));await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeVisible();
  await press(page,"键盘与快捷键");expect(await focusName(page)).toBe("键盘与快捷键");
  // Background with the keyboard open: on return nothing reconnects or resumes.
  await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeVisible();
  await typeInTray(page,press);await page.evaluate(()=>(window as any).screenMobileActive(false));await page.evaluate(()=>(window as any).screenMobileActive(true));
  await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeVisible();
  await press(page,"键盘与快捷键");expect(await focusName(page)).not.toBe(await page.locator(".screen-mobile canvas").getAttribute("aria-label"));
  await page.waitForTimeout(1000);expect((await log(page)).opens).toBe(opens+1);await expect(page.getByRole("button",{name:"连接屏幕",exact:true})).toBeVisible();
});

test("keyboard users keep their place, and without a session focus returns to the keyboard button",async({page})=>{
  await page.goto(url("ios"));await page.waitForFunction(()=>!!(window as any).screenMobileFixture);
  const toggle=page.getByRole("button",{name:"键盘与快捷键",exact:true});
  await toggle.focus();await page.keyboard.press("Enter");await expect(page.getByLabel("发送到远端的文本")).toBeVisible();
  await expect(toggle).toBeFocused();await page.keyboard.press("Enter");await expect(page.getByLabel("发送到远端的文本")).toHaveCount(0);await expect(toggle).toBeFocused();
  await typeInTray(page,presses.touch!);await presses.touch!(page,"键盘与快捷键");await expect(toggle).toBeFocused();
});
