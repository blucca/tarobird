// Private native runner entry: production renderer/transport/decoder, a
// synthetic signed TLS peer supplied by instrumentation. No fake Capacitor,
// VideoDecoder, allocation, frame delivery, input transport or lifecycle.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { RemoteScreenPanel } from "../../src/RemoteScreenPanel.js";
import { setLocale } from "../../src/i18n.js";
import type { HubConnection } from "../../src/connection.js";
import type { ScreenJoin } from "../../../src/client-protocol/remote-screen.js";
import "../../src/styles.css";
import "../../src/side-conversation.css";

type Fixture = { network: {url:string;publicKey:string;certificateAuthority?:string}; joins: ScreenJoin[] };
const log = { opens: [] as unknown[], stops: [] as string[], errors: [] as string[] };
setLocale("en");document.documentElement.dataset.platform=Capacitor.getPlatform();
window.addEventListener("error",event=>log.errors.push(event.message));window.addEventListener("unhandledrejection",event=>log.errors.push(String(event.reason)));
function connection(fixture: Fixture): HubConnection {
  let next=0;
  return { identity:{hubPublicKey:fixture.network.publicKey},state:{screenAvailable:true,screenQualityAvailable:true},
    screenStatus:async()=>{const session=fixture.joins[Math.min(next,fixture.joins.length-1)]!.session;return {supported:true,enabled:true,canManage:false,permission:session.controlAllowed?"control":"view",desktop:{desktopId:session.desktopId,instanceId:"integration",loginSession:"integration",platform:"macos",capture:"granted",accessibility:true,locked:false,displays:[session.display]},sessions:[],serverTime:Date.now()};},
    screenOpen:async(input:unknown)=>{const join=fixture.joins[next++];if(!join)throw Error("synthetic_sessions_exhausted");log.opens.push(input);return {join,network:fixture.network};},
    screenStop:async(id:string)=>{log.stops.push(id);},
  } as unknown as HubConnection;
}
function App(){const[current,setCurrent]=useState<HubConnection>();const[visible,setVisible]=useState(true);
  Object.assign(window,{screenIntegrationStart:(fixture:Fixture)=>{setCurrent(connection(fixture));setVisible(true);},screenIntegrationVisibility:(value:boolean)=>setVisible(value)});
  return current?<RemoteScreenPanel connection={current} hostName="Synthetic TLS peer" visible={visible} standalone close={()=>setCurrent(undefined)}/>:<p>Ready for a synthetic native screen fixture.</p>;
}
Object.assign(window,{
  screenIntegrationState:()=>{const canvas=document.querySelector("canvas"),panel=document.querySelector<HTMLElement>(".remote-screen-panel");let pixel:number[]|undefined;
    if(canvas&&canvas.width>1)pixel=Array.from(canvas.getContext("2d")!.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data);
    return {...log,pixel,canvas:canvas?{width:canvas.width,height:canvas.height}:null,hidden:!panel||panel.hidden,state:document.querySelector(".screen-state")?.textContent,buttons:Array.from(panel?.querySelectorAll("button")??[]).map(button=>({text:button.textContent,label:button.getAttribute("aria-label"),disabled:button.disabled}))};},
  screenIntegrationAction:(action:string)=>{const labels:Record<string,string>={connect:"Connect screen",control:"Start control",release:"Stop control",keyboard:"Keyboard and shortcuts",close:"Disconnect and close screen"};const label=labels[action]??action;const button=[...document.querySelectorAll<HTMLButtonElement>(".remote-screen-panel button")].find(value=>value.textContent===label||value.getAttribute("aria-label")===label);if(!button||button.disabled)throw Error(`action_unavailable:${action}`);button.click();},
});
createRoot(document.getElementById("root")!).render(<App/>);
