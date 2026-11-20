import { test, expect } from "@playwright/test";
import { ScreenTouch, type ScreenTransform } from "../src/screen-touch.js";
import type { ScreenInputEvent } from "../../src/client-protocol/remote-screen.js";
function fixture(control = true) {
  const events: ScreenInputEvent[] = [], transforms: ScreenTransform[] = [];
  const touch = new ScreenTouch({ width: 400, height: 400, imageWidth: 800, imageHeight: 400 }, value => events.push(value), value => transforms.push(value)); touch.setControl(control);
  return { touch, events, transforms };
}
test("touch taps commit on release, while letterbox margins never click an edge", () => {
  const f = fixture(); f.touch.down(1, { x: 100, y: 200 }, 0); expect(f.events).toEqual([]); f.touch.up(1);
  expect(f.events).toEqual([{ kind: "button", x: .25, y: .5, button: 0, down: true, clicks: 1 }, { kind: "button", x: .25, y: .5, button: 0, down: false, clicks: 1 }]);
  f.events.length = 0; f.touch.down(1, { x: 100, y: 20 }, 0); f.touch.up(1); expect(f.events).toEqual([]);
});
test("stationary hold produces only a right click, never a later left click", () => {
  const f = fixture(); f.touch.down(1, { x: 200, y: 200 }, 0); f.touch.hold(549); expect(f.events).toEqual([]); f.touch.hold(550); f.touch.up(1);
  expect(f.events.map(value => value.kind === "button" && [value.button, value.down])).toEqual([[2, true], [2, false]]);
});
test("a second finger cancels a candidate tap and releases an already committed drag", () => {
  const f = fixture(); f.touch.down(1, { x: 100, y: 200 }, 0); f.touch.down(2, { x: 300, y: 200 }, 0); f.touch.hold(600); f.touch.up(1); f.touch.up(2); expect(f.events).toEqual([]);
  f.touch.down(1, { x: 100, y: 200 }, 0); f.touch.move(1, { x: 120, y: 200 }); f.touch.down(2, { x: 300, y: 200 }, 0); f.touch.cancel();
  expect(f.events.map(value => value.kind === "button" ? value.down : value.kind)).toEqual([true, "move", false]);
});
test("parallel two-finger movement scrolls and cannot turn into pinch or click", () => {
  const f = fixture(); f.touch.down(1, { x: 100, y: 200 }, 0); f.touch.down(2, { x: 300, y: 200 }, 0);
  f.touch.move(1, { x: 100, y: 220 }); f.touch.move(2, { x: 300, y: 220 }); f.touch.flush();
  f.touch.move(1, { x: 20, y: 220 }); f.touch.move(2, { x: 380, y: 220 }); f.touch.flush(); f.touch.up(1); f.touch.up(2);
  expect(f.events.every(value => value.kind === "wheel")).toBe(true); expect(f.events[0]).toMatchObject({ kind: "wheel", dx: 0, dy: -20 }); expect(f.touch.transform.zoom).toBe(1);
});
test("pinch stays local, bounds zoom and pan, and transforms target coordinates", () => {
  const f = fixture(); f.touch.down(1, { x: 100, y: 200 }, 0); f.touch.down(2, { x: 300, y: 200 }, 0);
  f.touch.move(1, { x: 0, y: 200 }); f.touch.move(2, { x: 400, y: 200 }); f.touch.flush(); f.touch.up(1); f.touch.up(2);
  expect(f.touch.transform.zoom).toBe(2); expect(f.events).toEqual([]); expect(f.touch.point({ x: 0, y: 200 })).toEqual({ x: .25, y: .5 });
  f.touch.setControl(false); f.touch.down(1, { x: 200, y: 200 }, 0); f.touch.move(1, { x: 2000, y: 200 }); f.touch.up(1); expect(f.touch.transform.x).toBe(200); expect(f.events).toEqual([]);
  f.touch.resize({ width: 800, height: 300, imageWidth: 800, imageHeight: 400 }); expect(f.touch.transform).toEqual({ zoom: 1, x: 0, y: 0 });
});
test("viewing never emits remote events and control loss clears drag exactly once", () => {
  const f = fixture(false); f.touch.down(1, { x: 100, y: 200 }, 0); f.touch.hold(900); f.touch.move(1, { x: 200, y: 200 }); f.touch.up(1); expect(f.events).toEqual([]);
  f.touch.setControl(true); f.touch.down(1, { x: 100, y: 200 }, 0); f.touch.move(1, { x: 120, y: 200 }); f.touch.setControl(false); f.touch.cancel(); f.touch.up(1);
  expect(f.events.filter(value => value.kind === "button" && !value.down)).toHaveLength(1);
});

const tap = (touch: ScreenTouch, at: number, x = 100, y = 200) => { touch.down(1, { x, y }, at); touch.up(1); };
const clicks = (events: ScreenInputEvent[]) => events.filter((event): event is Extract<ScreenInputEvent, { kind: "button" }> => event.kind === "button").map(event => event.clicks);

test("touch double and triple taps preserve the mouse 450ms and 4px inclusive limits", () => {
  const f = fixture(); tap(f.touch, 0); tap(f.touch, 450, 104); tap(f.touch, 900, 108); tap(f.touch, 1000, 108);
  expect(clicks(f.events)).toEqual([1, 1, 2, 2, 3, 3, 1, 1]);
});

test("tap count resets outside the time or distance boundary and never follows a reversed clock", () => {
  for(const [at,x] of [[451,100],[450,104.01],[-1,100]]){
    const f=fixture();tap(f.touch,0);tap(f.touch,at,x);expect(clicks(f.events)).toEqual([1,1,1,1]);
    tap(f.touch,at+100,x);expect(clicks(f.events).slice(-2)).toEqual([2,2]);
  }
});

for(const interrupted of ["hold","drag","two fingers","scroll","pinch","cancel","margin","control loss","resize","fit"] as const)test(`${interrupted} breaks a touch click sequence`,()=>{
  const f=fixture();tap(f.touch,0);
  if(interrupted==="hold"){f.touch.down(1,{x:100,y:200},100);f.touch.hold(650);f.touch.up(1);}
  else if(interrupted==="drag"){f.touch.down(1,{x:100,y:200},100);f.touch.move(1,{x:109,y:200});f.touch.up(1);}
  else if(["two fingers","scroll","pinch"].includes(interrupted)){
    f.touch.down(1,{x:100,y:200},100);f.touch.down(2,{x:300,y:200},100);
    if(interrupted==="scroll"){f.touch.move(1,{x:100,y:220});f.touch.move(2,{x:300,y:220});f.touch.flush();}
    if(interrupted==="pinch"){f.touch.move(1,{x:50,y:200});f.touch.move(2,{x:350,y:200});f.touch.flush();}
    f.touch.up(1);f.touch.up(2);
  }else if(interrupted==="margin")tap(f.touch,100,100,20);
  else if(interrupted==="control loss"){f.touch.setControl(false);f.touch.setControl(true);}
  else if(interrupted==="resize")f.touch.resize({width:400,height:400,imageWidth:800,imageHeight:400});
  else if(interrupted==="fit")f.touch.fit();
  else{f.touch.down(1,{x:100,y:200},100);f.touch.cancel();}
  // A long hold consumes real time; compare its next tap against the hold's start.
  const next=interrupted==="hold"?700:200;tap(f.touch,next);expect(clicks(f.events).slice(-2)).toEqual([1,1]);
  tap(f.touch,next+100);expect(clicks(f.events).slice(-2)).toEqual([2,2]);
  expect(f.events.filter(event=>event.kind==="button"&&event.button===2).every(event=>event.clicks===1)).toBe(true);
});
