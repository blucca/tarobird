import { test, expect } from "@playwright/test";
import { createMobileScreenViewerTransport, type ScreenAllocation, type ScreenNativeBridge } from "../src/screen-mobile-transport.js";
import type { ScreenViewerPort } from "../src/screen-viewer-transport.js";
import type { ScreenJoin } from "../../src/client-protocol/remote-screen.js";
import { writeScreenFrame } from "../../src/client-protocol/screen-wire.js";

const display = { id: "display", nativeId: "1", name: "Fixture display", revision: 1, x: 0, y: 0, width: 1280, height: 720, scale: 1, rotation: 0 as const };
const join: ScreenJoin = { session: { id: "session", desktopId: "desktop", deviceId: "device", deviceName: "Fixture", generation: "generation", display, controlAllowed: true, state: "viewing", createdAt: 1 }, controlTicket: "c".repeat(43), mediaTicket: "m".repeat(43), expiresAt: 2, serverTime: 1 };
const stamp = { sessionId: "session", generation: "generation" };
const frame = () => writeScreenFrame({ key: true, codec: "h264", sequence: 7, geometryRevision: 1, streamGeneration: 1, captureMs: 1, width: 1280, height: 720 }, new Uint8Array(300_000));
function fixture() {
  const life = new AbortController(), calls: { name: string; args: Record<string, unknown> }[] = [], values: unknown[] = [];
  let deliver: (value: unknown) => void = () => {}, port: ScreenViewerPort;
  const allocation: ScreenAllocation = { id: "native-group", document: "native-document", signal: life.signal };
  const options: { allocate?: Promise<ScreenAllocation>; read?: Promise<void>; send?: Promise<void>; bytes: Uint8Array } = { bytes: frame() };
  const bridge: ScreenNativeBridge = { allocate: async () => options.allocate ?? allocation, invoke: async <T>(name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "net_screen_open") deliver = (args.events as { onmessage(value: unknown): void }).onmessage;
    if (name === "net_screen_send") await options.send;
    if (name === "net_screen_read") { await options.read; return options.bytes.slice(args.offset as number, (args.offset as number) + (args.maxBytes as number)).buffer as T; }
    return {} as T;
  } };
  const channel = createMobileScreenViewerTransport(bridge)(join);
  const open = () => channel.open({ url: "https://fixture.invalid", publicKey: "fixture" }, { attach: value => { port = value; value.start(data => values.push(data)); }, fail: reason => { throw new Error(reason); } });
  return { life, allocation, calls, values, options, channel, open, post: (value: Record<string, unknown>) => port.postMessage(value), event: (value: Record<string, unknown>) => deliver({ id: allocation.id, document: allocation.document, ...value }) };
}

test("mobile screen bridge orders JSON and bounded chunks, separating delivery and decoded receipts", async () => {
  const f = fixture(); await f.open();
  f.event({ kind: "screen", deliverySequence: 1, value: { type: "attached", sessionId: "session" } });
  f.event({ kind: "binary", deliverySequence: 2, byteLength: f.options.bytes.byteLength });
  await expect.poll(() => f.values.length).toBe(2);
  expect(f.values[0]).toEqual({ type: "attached", sessionId: "session" }); expect(new Uint8Array(f.values[1] as ArrayBuffer)).toEqual(f.options.bytes);
  expect(f.calls.filter(value => value.name === "net_screen_read").map(value => [value.args.offset, value.args.maxBytes])).toEqual([[0, 262144], [262144, 37888]]);
  expect(f.calls.filter(value => value.name === "net_screen_ack").map(value => value.args.deliverySequence)).toEqual([1]);
  f.post({ type: "received", sequence: 7 }); await expect.poll(() => f.calls.filter(value => value.name === "net_screen_ack").length).toBe(2);
  f.post({ type: "ack", frameSequence: 7, ...stamp }); await expect.poll(() => f.calls.some(value => value.name === "net_screen_send")).toBe(true);
  expect(f.calls.find(value => value.name === "net_screen_send")!.args.command).toEqual({ type: "ack", frameSequence: 7, ...stamp });
  f.channel.close(); expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1);
});

test("closing before allocation prevents late native open and only retires its own group", async () => {
  const f = fixture(); let release!: (value: ScreenAllocation) => void;
  f.options.allocate = new Promise(resolve => { release = resolve; }); const opened = f.open(); f.channel.close(); release(f.allocation); await opened;
  expect(f.calls.map(value => value.name)).toEqual(["net_screen_close"]); expect(f.values).toEqual([]);
});

test("a retired allocation rejects open instead of leaving its caller connecting", async () => {
  const f=fixture();f.life.abort();await expect(f.open()).rejects.toThrow("screen_connection_changed");
  expect(f.calls.map(value=>value.name)).toEqual(["net_screen_close"]);expect(f.values).toEqual([]);
});

test("document retirement cancels a partial binary read without receipt, replay or another claim", async () => {
  const f = fixture(); let release!: () => void; f.options.read = new Promise(resolve => { release = resolve; });
  await f.open(); f.event({ kind: "binary", deliverySequence: 1, byteLength: f.options.bytes.byteLength });
  await expect.poll(() => f.calls.filter(value => value.name === "net_screen_read").length).toBe(1);
  f.life.abort(); release(); await expect.poll(() => f.values.length).toBe(1);
  expect(f.values).toEqual([{ type: "closed", reason: "screen_connection_changed" }]);
  expect(f.calls.filter(value => value.name === "net_screen_ack")).toHaveLength(0);
  f.event({ kind: "close", reason: "screen_closed" }); f.channel.close(); expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1);
  expect(f.calls.some(value => value.name === "net_document")).toBe(false);
});

for (const defect of ["duplicate", "oversize", "wrong-session", "unknown-receipt", "malformed-packet"] as const) test(`mobile screen bridge retires ${defect} without forwarding an invalid delivery`, async () => {
  const f = fixture(); await f.open();
  if (defect === "duplicate") { f.event({ kind: "screen", deliverySequence: 1, value: { type: "attached", sessionId: "session" } }); await expect.poll(() => f.values.length).toBe(1); f.event({ kind: "screen", deliverySequence: 1, value: { type: "attached", sessionId: "session" } }); }
  if (defect === "oversize") f.event({ kind: "binary", deliverySequence: 1, byteLength: 1024 * 1024 + 1 });
  if (defect === "wrong-session") f.event({ kind: "screen", deliverySequence: 1, value: { type: "attached", sessionId: "other" } });
  if (defect === "unknown-receipt") f.post({ type: "received", sequence: 999 });
  if (defect === "malformed-packet") { f.options.bytes[0] = 99; f.event({ kind: "binary", deliverySequence: 1, byteLength: f.options.bytes.byteLength }); }
  await expect.poll(() => f.calls.filter(value => value.name === "net_screen_close").length).toBe(1);
  expect((f.values.at(-1) as { type: string }).type).toBe("closed"); expect(f.values.some(value => value instanceof ArrayBuffer)).toBe(false);
});

test("wrong document events cannot feed or close the current mobile viewer", async () => {
  const f = fixture(); await f.open();
  f.event({ document: "retired", kind: "close", reason: "retired" }); f.event({ document: "retired", kind: "binary", deliverySequence: 1, byteLength: 123 });
  f.event({ kind: "screen", deliverySequence: 1, value: { type: "attached", sessionId: "session" } }); await expect.poll(() => f.values.length).toBe(1);
  expect(f.values).toEqual([{ type: "attached", sessionId: "session" }]); f.channel.close();
});

test("bounded outgoing commands retire congestion and cannot replay after close", async () => {
  const f = fixture(); let release!: () => void; f.options.send = new Promise(resolve => { release = resolve; }); await f.open();
  for (let i = 0; i < 9; i++) f.post({ type: "keyframe", ...stamp });
  expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1); release(); await Promise.resolve(); await Promise.resolve();
  expect(f.calls.filter(value => value.name === "net_screen_send")).toHaveLength(0);
});

for(const kind of ["input","renew"] as const) test(`blur and refocus cannot revive ${kind} queued under an earlier focus`, async () => {
  const f = fixture(); let release!: () => void; f.options.send = new Promise(resolve => { release = resolve; }); await f.open();
  f.post({type:"keyframe",...stamp});await expect.poll(()=>f.calls.filter(value=>value.name==="net_screen_send").length).toBe(1);
  f.post({type:"input-focus",...stamp,enabled:true});
  const command=kind==="input"?{type:kind,...stamp,desktopId:"desktop",displayId:"display",displayRevision:1,leaseId:"l".repeat(43),sequence:1,frameSequence:1,expiresAt:Date.now()+1000,event:{kind:"move",x:.5,y:.5}}:{type:kind,...stamp,leaseId:"l".repeat(43),frameSequence:1,challenge:"c".repeat(43)};
  f.post(command);
  f.post({type:"input-focus",...stamp,enabled:false});f.post({type:"release",...stamp});f.post({type:"input-focus",...stamp,enabled:true});release();
  await expect.poll(()=>f.calls.filter(value=>value.name==="net_screen_send"&&(value.args.command as any).type==="input-focus").length).toBe(3);
  expect(f.calls.filter(value=>value.name==="net_screen_send"&&(value.args.command as any).type===kind)).toEqual([]);
  expect(f.calls.filter(value=>value.name==="net_screen_send"&&(value.args.command as any).type==="release")).toHaveLength(1);
  f.post({...command,frameSequence:2});await expect.poll(()=>f.calls.filter(value=>value.name==="net_screen_send"&&(value.args.command as any).type===kind).length).toBe(1);
  expect((f.calls.at(-1)!.args.command as any).frameSequence).toBe(2);f.channel.close();
});
