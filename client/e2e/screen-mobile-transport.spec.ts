import { test, expect } from "@playwright/test";
import { createMobileScreenViewerTransport, SCREEN_NATIVE_CLOSE_GRACE_MS, type ScreenAllocation, type ScreenNativeBridge } from "../src/screen-mobile-transport.js";
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
  const options: { allocate?: Promise<ScreenAllocation>; read?: Promise<void>; send?: Promise<void>; opening?: Promise<void>; reject: Record<string, string>; refuse: Record<string, string>; bytes: Uint8Array } = { bytes: frame(), reject: {}, refuse: {} };
  const bridge: ScreenNativeBridge = { allocate: async () => options.allocate ?? allocation, invoke: async <T>(name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "net_screen_open") { deliver = (args.events as { onmessage(value: unknown): void }).onmessage; await options.opening; }
    // A native rejection, as the plugin returns it: an Error whose message is the code.
    if (options.reject[name]) throw new Error(options.reject[name]);
    if (name === "net_screen_send" && options.refuse[(args.command as { type: string }).type]) throw new Error(options.refuse[(args.command as { type: string }).type]);
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

// F-AND-2(b). Native emits a session's close event and then retires its slot; a page call
// running at that moment is rejected first, and that rejection reaches the page before the
// close event queued behind it on the same plugin thread. The rejection only says the call
// lost to the session's end; the close event carries why the session ended.
const closes = (values: unknown[]) => values.filter(value => (value as { type?: string })?.type === "closed");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const attached = (f: ReturnType<typeof fixture>, deliverySequence = 1) => f.event({ kind: "screen", deliverySequence, value: { type: "attached", sessionId: "session" } });
for (const [call, code] of [["ack", "native_document_retired"], ["ack", "native_request_cancelled"], ["ack", "screen_inactive"], ["receipt", "native_request_cancelled"], ["send", "native_request_cancelled"], ["read", "native_document_retired"]] as const)
  test(`a ${call} rejected with ${code} does not hide the native close reason that follows it`, async () => {
    const f = fixture(); f.options.reject[call === "send" ? "net_screen_send" : call === "read" ? "net_screen_read" : "net_screen_ack"] = code; await f.open();
    if (call === "ack") attached(f);
    if (call === "receipt") { f.event({ kind: "binary", deliverySequence: 1, byteLength: f.options.bytes.byteLength }); await expect.poll(() => f.values.length).toBe(1); f.post({ type: "received", sequence: 7 }); }
    if (call === "send") f.post({ type: "keyframe", ...stamp });
    if (call === "read") f.event({ kind: "binary", deliverySequence: 1, byteLength: f.options.bytes.byteLength });
    await expect.poll(() => f.calls.some(value => value.name === `net_screen_${call === "receipt" ? "ack" : call}`)).toBe(true); await tick();
    f.event({ kind: "close", reason: "screen_viewer_congested" });
    expect(closes(f.values)).toEqual([{ type: "closed", reason: "screen_viewer_congested" }]);
    expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1);
  });

test("native's own local close reason is shown as it is, never a guessed Host reason or the raw call code", async () => {
  const f = fixture(); f.options.reject.net_screen_send = "native_request_cancelled"; await f.open();
  f.post({ type: "keyframe", ...stamp }); await expect.poll(() => f.calls.some(value => value.name === "net_screen_send")).toBe(true); await tick();
  f.event({ kind: "close", reason: "screen_network_closed" });
  expect(closes(f.values)).toEqual([{ type: "closed", reason: "screen_network_closed" }]);
});

test("without a native close the rejected call ends as a plain local disconnect, sending nothing more", async () => {
  const f = fixture(); f.options.reject.net_screen_ack = "native_request_cancelled"; await f.open(); attached(f);
  await expect.poll(() => f.calls.some(value => value.name === "net_screen_ack")).toBe(true); await tick();
  f.post({ type: "keyframe", ...stamp }); await tick();
  // A close for another document or group is still not this session's.
  f.event({ document: "retired", kind: "close", reason: "screen_locked" }); f.event({ id: "other-group", kind: "close", reason: "screen_locked" });
  expect(closes(f.values)).toEqual([]); expect(f.calls.filter(value => value.name === "net_screen_send")).toHaveLength(0);
  await expect.poll(() => closes(f.values), { timeout: SCREEN_NATIVE_CLOSE_GRACE_MS + 2000 }).toEqual([{ type: "closed", reason: "screen_disconnected" }]);
  f.event({ kind: "close", reason: "screen_locked" }); expect(closes(f.values)).toHaveLength(1);
  expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1);
});

test("a user disconnect while a rejected call waits for native stays a user disconnect", async () => {
  const f = fixture(); f.options.reject.net_screen_ack = "native_document_retired"; await f.open(); attached(f);
  await expect.poll(() => f.calls.some(value => value.name === "net_screen_ack")).toBe(true); await tick();
  f.channel.close(); f.event({ kind: "close", reason: "screen_viewer_congested" });
  await new Promise(resolve => setTimeout(resolve, SCREEN_NATIVE_CLOSE_GRACE_MS + 200));
  expect(closes(f.values)).toEqual([]); expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1);
});

test("document retirement while a rejected call waits still ends as a connection change", async () => {
  const f = fixture(); f.options.reject.net_screen_ack = "native_request_cancelled"; await f.open(); attached(f);
  await expect.poll(() => f.calls.some(value => value.name === "net_screen_ack")).toBe(true); await tick();
  f.life.abort(); f.event({ kind: "close", reason: "screen_viewer_congested" });
  expect(closes(f.values)).toEqual([{ type: "closed", reason: "screen_connection_changed" }]);
});

test("a rejection that is not about the session ending still closes with its own code", async () => {
  const f = fixture(); f.options.reject.net_screen_ack = "invalid_screen_receipt"; await f.open(); attached(f);
  await expect.poll(() => closes(f.values)).toEqual([{ type: "closed", reason: "invalid_screen_receipt" }]);
});

test("an open rejected after native already ended the session reports that session's reason", async () => {
  const f = fixture(); let release!: () => void; f.options.opening = new Promise(resolve => { release = resolve; }); f.options.reject.net_screen_open = "native_request_cancelled";
  const opened = f.open(); await expect.poll(() => f.calls.some(value => value.name === "net_screen_open")).toBe(true);
  f.event({ kind: "close", reason: "screen_permission_revoked" }); release();
  await expect(opened).rejects.toThrow("screen_permission_revoked");
  expect(closes(f.values)).toEqual([{ type: "closed", reason: "screen_permission_revoked" }]);
});

// A-5. The target's three-frame credit window belongs to one stream generation. A restart
// (start control, keyframe, resume) retires it and the next generation may send three packets
// at once while the page is still reading the old generation's.
const streamConfig = (streamGeneration: number) => ({ type: "stream", streamGeneration, geometryRevision: 1, codec: "h264", codecString: "avc1.42c01e", width: 1280, height: 720, contentRect: { x: 0, y: 0, width: 1280, height: 720 } });
function restarts(f: ReturnType<typeof fixture>) {
  let delivery = 0;
  return { binary: () => f.event({ kind: "binary", deliverySequence: ++delivery, byteLength: f.options.bytes.byteLength }),
    stream: (generation: number) => f.event({ kind: "screen", deliverySequence: ++delivery, value: streamConfig(generation) }) };
}
test("a stream restart admits the new generation's window behind a packet the page is still reading", async () => {
  const f = fixture(); f.options.read = new Promise(() => {}); await f.open(); const s = restarts(f);
  s.binary(); s.stream(2); for (let i = 0; i < 3; i++) s.binary(); await tick();
  expect(closes(f.values)).toEqual([]); expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(0);
  // The new generation's own window is still three.
  s.binary(); expect(closes(f.values)).toEqual([{ type: "closed", reason: "screen_congested" }]);
});

test("packets of superseded generations still count against a bounded total", async () => {
  const f = fixture(); f.options.read = new Promise(() => {}); await f.open(); const s = restarts(f);
  for (let i = 0; i < 3; i++) s.binary(); s.stream(2); for (let i = 0; i < 3; i++) s.binary(); await tick();
  expect(closes(f.values)).toEqual([]);
  s.stream(3); s.binary(); expect(closes(f.values)).toEqual([{ type: "closed", reason: "screen_congested" }]);
});

// F-AND-3. The Hub withdrew control while this page, not yet through the state that says so,
// sent a renew or input. Native refuses it as control having ended; the viewing session stays.
const lateRenew = { type: "renew", ...stamp, leaseId: "l".repeat(43), frameSequence: 1, challenge: "c".repeat(43) };
const lateInput = { type: "input", ...stamp, desktopId: "desktop", displayId: "display", displayRevision: 1, leaseId: "l".repeat(43), sequence: 1, frameSequence: 1, expiresAt: Date.now() + 60_000, event: { kind: "move", x: .5, y: .5 } };
for (const late of [lateRenew, lateInput]) test(`a ${late.type} refused because control already ended leaves the viewing session open`, async () => {
  const f = fixture(); f.options.refuse[late.type] = "screen_control_ended"; await f.open();
  f.post({ type: "input-focus", ...stamp, enabled: true }); f.post(late);
  await expect.poll(() => f.calls.filter(value => value.name === "net_screen_send" && (value.args.command as { type: string }).type === late.type).length).toBe(1); await tick();
  expect(closes(f.values)).toEqual([]); expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(0);
  // The session goes on: the state that ended control arrives, frames and commands still flow.
  attached(f); await expect.poll(() => f.values).toEqual([{ type: "attached", sessionId: "session" }]);
  f.post({ type: "keyframe", ...stamp }); await expect.poll(() => f.calls.some(value => value.name === "net_screen_send" && (value.args.command as { type: string }).type === "keyframe")).toBe(true);
  f.channel.close(); expect(f.calls.filter(value => value.name === "net_screen_close")).toHaveLength(1);
});

test("a renew native rejects as a protocol violation still ends the session", async () => {
  const f = fixture(); f.options.refuse.renew = "screen_protocol_invalid"; await f.open();
  f.post({ type: "input-focus", ...stamp, enabled: true }); f.post(lateRenew);
  await expect.poll(() => closes(f.values)).toEqual([{ type: "closed", reason: "screen_protocol_invalid" }]);
});

test("control having ended is only accepted for a renew or input", async () => {
  const f = fixture(); f.options.refuse.keyframe = "screen_control_ended"; await f.open();
  f.post({ type: "keyframe", ...stamp });
  await expect.poll(() => closes(f.values)).toEqual([{ type: "closed", reason: "screen_control_ended" }]);
});
