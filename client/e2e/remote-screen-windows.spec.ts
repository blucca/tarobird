// The viewer when the controlled computer runs Windows (#48): its own shortcut
// buttons, the keyboard-layout note, and which keyboards get a modifier choice.
import { test, expect, type Page } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
let server:ViteDevServer;
test.beforeAll(async()=>{server=await createServer({server:{host:"127.0.0.1",port:0}});await server.listen();});
test.afterAll(async()=>{await server?.close();});
const open=async(page:Page,query:string)=>{await page.goto(server.resolvedUrls!.local[0]+"e2e/fixtures/remote-screen.html"+query);await page.getByRole("button",{name:"连接屏幕",exact:true}).click();await expect(page.getByRole("button",{name:"开始控制",exact:true})).toBeEnabled({timeout:15000});};
const keys=(page:Page)=>page.evaluate(()=>(window as any).screenFixture.commands.filter((c:any)=>c.type==="input"&&c.event.kind==="key").map((c:any)=>`${c.event.code}:${c.event.down?"down":"up"}`));
const control=async(page:Page)=>{await page.getByRole("button",{name:"开始控制",exact:true}).click();await expect(page.getByRole("button",{name:"停止控制",exact:true})).toBeVisible();await expect(page.locator("canvas")).toBeFocused();};
const LAYOUT="按键按键位发送，字符由目标电脑的键盘布局决定。";

test("a Windows target offers its own shortcut buttons, none of them a letter, and says keys follow its keyboard layout",async({page})=>{
 await open(page,"?target=windows");
 await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
 await expect(page.getByText(LAYOUT)).toBeVisible();
 await page.getByText("发送组合键",{exact:true}).click();
 const labels=await page.locator(".screen-shortcuts details button").allTextContents();
 expect(labels).toEqual(["Esc","切换窗口 Alt+Tab","开始菜单 Win","任务视图 Win+Tab","切换输入法 Win+空格","关闭窗口 Alt+F4","关闭标签页 Ctrl+F4"]);
 // No Mac shortcut, and no button whose key the target's layout could move.
 for(const label of labels)expect(label).not.toMatch(/[⌘⌥⌃]|\+[A-Z]$/);
 // The list stays open while control starts; a button then sends its keys in order.
 await control(page);
 await page.getByRole("button",{name:"关闭窗口 Alt+F4",exact:true}).click();
 await expect.poll(()=>keys(page)).toEqual(["AltLeft:down","F4:down","F4:up","AltLeft:up"]);
});

test("a Mac keyboard keeps its main shortcut key on a Windows target, and can be switched to plain positions",async({page})=>{
 await open(page,"?target=windows");
 await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
 const mode=page.getByLabel("Mac 修饰键",{exact:true});
 await expect(mode).toBeVisible();await expect(mode).toHaveValue("command");
 await expect(mode.locator("option")).toHaveText(["⌘ → Ctrl · ⌃ → Win","⌃ → Ctrl · ⌘ → Win"]);
 await expect(page.getByText("Command 对应 Ctrl，Control 对应 Win，Option 对应 Alt")).toBeVisible();
 await expect(page.getByLabel("Windows 修饰键",{exact:true})).toHaveCount(0);
 await control(page);
 await page.keyboard.down("Meta");await page.keyboard.press("KeyC");await page.keyboard.up("Meta");
 await page.keyboard.down("Control");await page.keyboard.up("Control");
 await expect.poll(()=>keys(page)).toEqual(["ControlLeft:down","KeyC:down","KeyC:up","ControlLeft:up","MetaLeft:down","MetaLeft:up"]);
 // Plain positions: Command is the Windows key, Control is Ctrl.
 await mode.selectOption("physical");
 await expect(page.getByText("Control 对应 Ctrl，Command 对应 Win，Option 对应 Alt")).toBeVisible();
 await page.evaluate(()=>{(window as any).screenFixture.commands.length=0;});
 await control(page);
 await page.keyboard.down("Meta");await page.keyboard.up("Meta");await page.keyboard.down("Control");await page.keyboard.up("Control");
 await expect.poll(()=>keys(page)).toEqual(["MetaLeft:down","MetaLeft:up","ControlLeft:down","ControlLeft:up"]);
});

test("a Windows keyboard controls a Windows target key for key, with no modifier choice to make",async({page})=>{
 await open(page,"?target=windows&shell=win32");
 await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
 await expect(page.getByText(LAYOUT)).toBeVisible();
 await expect(page.getByLabel("Windows 修饰键",{exact:true})).toHaveCount(0);
 await expect(page.getByLabel("Mac 修饰键",{exact:true})).toHaveCount(0);
 await control(page);
 await page.keyboard.down("Control");await page.keyboard.press("KeyC");await page.keyboard.up("Control");await page.keyboard.down("Meta");await page.keyboard.up("Meta");
 await expect.poll(()=>keys(page)).toEqual(["ControlLeft:down","KeyC:down","KeyC:up","ControlLeft:up","MetaLeft:down","MetaLeft:up"]);
});

test("a Mac target is unchanged: Mac shortcuts, a modifier choice only for a Windows keyboard, no layout note",async({page})=>{
 await open(page,"");
 await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
 await expect(page.getByText(LAYOUT)).toHaveCount(0);
 await expect(page.getByLabel("Mac 修饰键",{exact:true})).toHaveCount(0);await expect(page.getByLabel("Windows 修饰键",{exact:true})).toHaveCount(0);
 await page.getByText("发送组合键",{exact:true}).click();
 await expect(page.getByRole("button",{name:"退出应用 ⌘Q",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"关闭窗口 Alt+F4",exact:true})).toHaveCount(0);
 await open(page,"?shell=win32");
 await page.getByRole("button",{name:"屏幕更多操作",exact:true}).click();
 const mode=page.getByLabel("Windows 修饰键",{exact:true});
 await expect(mode).toHaveValue("command");await expect(mode.locator("option")).toHaveText(["Ctrl → ⌘ · Win → ⌃","Ctrl → ⌃ · Win → ⌘"]);
 await control(page);
 await page.keyboard.down("Control");await page.keyboard.up("Control");
 await expect.poll(()=>keys(page)).toEqual(["MetaLeft:down","MetaLeft:up"]);
});

test("after a Windows target's desktop goes away, the ending reason still names no Mac",async({page})=>{
 await open(page,"?target=windows");
 // The target sleeps or its App quits: later status reads carry no desktop, so no platform.
 await page.evaluate(()=>{const w=window as any,c=w.screenConnection,read=c.screenStatus;w.desktopGoneReads=0;c.screenStatus=async()=>{w.desktopGoneReads++;return {...(await read()),desktop:null};};});
 await page.evaluate(()=>(window as any).screenStream({type:"closed",reason:"screen_network_timeout"}));
 await expect.poll(()=>page.evaluate(()=>(window as any).desktopGoneReads)).toBeGreaterThan(0);
 await expect(page.getByText("屏幕连接超时，请检查目标电脑和当前线路。",{exact:true})).toBeVisible();
 await expect(page.getByText("屏幕连接超时，请检查目标 Mac 和当前线路。",{exact:true})).toHaveCount(0);
});
