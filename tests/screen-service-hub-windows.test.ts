// A Windows computer as the controlled target (#48), against a real HubServer,
// its real control socket and its real HTTP and WebSocket screen API. The
// native addon is a recorder and capture a fake: nothing is posted or captured.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID, sign } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { deviceFields, enrollTrusted, loginFor, testDevice } from "./helpers/pairing-invite.js";
import { hashSecret } from "../src/hub/auth.js";
import { SCREEN_CONTROL_WINDOWS_CAPABILITY, screenConfigureText, screenDisplaySchema, screenJoinSchema, screenStatusSchema } from "../src/client-protocol/remote-screen.js";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import { writeScreenFrame } from "../src/client-protocol/screen-wire.js";
// @ts-expect-error untyped Electron main module
import { readHeldJournal } from "../client/electron/screen-held-journal.mjs";
// @ts-expect-error untyped Electron main module
import { ScreenService } from "../client/electron/screen-service.mjs";
// @ts-expect-error untyped Electron main module
import { screenServiceTicket } from "../client/electron/screen-host-control.mjs";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });
const wait = async (check: () => unknown, ms = 3000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error("test_wait_timeout"); await new Promise(r => setTimeout(r, 5)); } };
type Any = any;

/** The `desktop` of a status reply exactly as an App from before Windows
 * targets parses it (the released `screenDesktopSchema`): strict, macOS only. */
const legacyDesktop = z.object({
  desktopId: z.string(), instanceId: z.string(), loginSession: z.string(), platform: z.literal("macos"),
  capture: z.enum(["granted", "denied", "not-determined", "unavailable"]), accessibility: z.boolean(), locked: z.boolean(), displays: z.array(screenDisplaySchema).max(16),
}).strict();
const legacyStatus = z.object({ supported: z.literal(true), enabled: z.boolean(), canManage: z.boolean(), permission: z.enum(["none", "view", "control"]),
  policy: z.unknown().optional(), devices: z.unknown().optional(), desktop: legacyDesktop.nullable(), sessions: z.array(z.unknown()).max(2), serverTime: z.number() }).strict();

async function fixture(platform: "win32" | "darwin" = "win32") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "screen-win-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const appState = path.join(dir, "app");
  const hub = await HubServer.start({ stateDir: dir }); cleanups.push(() => hub.close());
  const owner = testDevice("local"), viewer = testDevice("viewer");
  await hub.enrollLocalController(deviceFields(owner)); await enrollTrusted(hub.auth, viewer);
  const local = await loginFor(hub.auth, owner), remote = await loginFor(hub.auth, viewer);
  const command = { operation: "screen.configure" as const, expectedRevision: 0, enabled: true, requestId: randomUUID(), grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "control" as const }] };
  const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(command)) }, local.token, local.session);
  await hub.remoteScreen.configure(local.session, command, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") });
  const tickets: Any[] = [];
  const stopControl = await startHubControl(dir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }), () => {},
    { screenServiceTicket: (id: string) => hub.remoteScreen.serviceTicket(id) }); cleanups.push(stopControl);

  const posted: Any[] = [], monitor = { alive: false };
  const windows = platform === "win32";
  const addon = {
    ...(windows ? { screenTargetPlatform: () => "windows", screenMonitors: () => [{ x: 0, y: 0, width: 1920, height: 1080 }], screenReleasePending: () => 0,
      screenReleaseCandidates: (keys: number[], buttons: string[]) => { posted.push(["releaseCandidates", keys, buttons]); return 0; }, screenDisplayUuid: () => null,
      screenPhysicalButton: (name: string) => name }
      : { screenDisplayUuid: () => "display" }),
    screenSession: () => ({ available: true, onConsole: true, locked: false, unique: windows ? "2-000000000004c2a1-1db123456789abc" : "00000000-0000-0000-0000-000000000001", audit: 1 }),
    screenCursor: () => ({ x: 0, y: 0 }), screenCaptureAccess: () => true, screenMonitorAccess: () => true,
    screenMouse: (...a: Any[]) => posted.push(["mouse", ...a]), screenScroll: (...a: Any[]) => posted.push(["scroll", ...a]),
    screenKey: (...a: Any[]) => posted.push(["key", ...a]), screenText: (t: string) => posted.push(["text", t]),
    screenReleaseAll: () => { posted.push(["releaseAll"]); return 0; }, screenReleaseStale: () => posted.push(["releaseStale"]),
    screenMonitorStart: () => { monitor.alive = true; }, screenMonitorPoll: () => ({ alive: monitor.alive, failed: false, foreign: 0, interrupted: 0 }), screenMonitorStop: () => { monitor.alive = false; },
  };
  const display = windows ? { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, scaleFactor: 1.25, rotation: 0, label: "Display" } : { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1, rotation: 0, label: "Display" };
  const macOnly = () => { if (windows) throw new Error("a Mac permission API was used on Windows"); return true; };
  const electron = { screen: Object.assign(new EventEmitter(), { getAllDisplays: () => [display], dipToScreenPoint: () => ({ x: 0, y: 0 }) }), powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: () => macOnly() && "granted", isTrustedAccessibilityClient: macOnly }, shell: { openExternal: async () => {} } };
  const capture: Any = { starts: [] as Any[], resets: [] as Any[] };
  const service = new ScreenService({ electron, addon, stateDir: appState, platform,
    hostControl: { ticket: async (id: string) => { const ticket = await screenServiceTicket(dir, id); tickets.push(ticket); return ticket; } },
    captureHost: (hooks: Any) => Object.assign(capture, { hooks,
      start: async (s: Any) => { capture.starts.push(s); hooks.onMessage({ type: "started", sessionId: s.sessionId, cursor: "always" }); },
      reset: (id: string, generation: number) => { capture.resets.push([id, generation]); return true; }, pause: () => true, keyframe: () => {}, credit: () => {}, stop: () => {}, close: () => {} }) });
  cleanups.push(async () => service.dispose());
  let sequence = 0;
  const emit = (sessionId: string, generation: number, size: { width: number; height: number }, captureMs = Date.now()) => {
    capture.hooks.onMessage({ type: "stream", sessionId, stream: { type: "stream", streamGeneration: generation, geometryRevision: 1, codec: "h264", codecString: "avc1.640028", ...size, contentRect: { x: 0, y: 0, ...size } } });
    capture.hooks.onMessage({ type: "captured", sessionId, captureMs });
    const seq = ++sequence;
    capture.hooks.onMessage({ type: "frame", sessionId, sequence: seq, streamGeneration: generation, captureMs, geometryRevision: 1, key: true,
      bytes: writeScreenFrame({ key: true, codec: "h264", sequence: seq, geometryRevision: 1, streamGeneration: generation, captureMs, ...size }, new Uint8Array([0, 0, 0, 1, 0x65])) });
    return seq;
  };
  const api = (route: string, token: string, body?: unknown) => fetch(hub.url + route, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  await service.start();
  await wait(() => service.status().registered);
  return { dir, appState, hub, local, remote, service, capture, posted, emit, tickets, api };
}
function connect(url: string) {
  const ws = new WebSocket(url); const values: Any[] = [];
  ws.on("message", (data, binary) => values.push(binary ? new Uint8Array(data as Buffer) : JSON.parse(data.toString())));
  ws.on("error", () => {});
  cleanups.push(async () => ws.terminate());
  return { ws, values, ready: new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); }), send: (v: unknown) => ws.send(JSON.stringify(v)) };
}

it("the Host's control socket says it accepts Windows targets, and a Windows desktop registers with it", async () => {
  const f = await fixture();
  expect(f.tickets[0].capabilities).toContain(SCREEN_CONTROL_WINDOWS_CAPABILITY);
  expect(f.service.status()).toMatchObject({ supported: true, registered: true, desktop: { platform: "windows", capture: "granted", accessibility: true, locked: false, loginSession: "wts-2-000000000004c2a1-1db123456789abc" } });
});

it("an App from before Windows targets is told there is no desktop, which it can parse; it is never handed one it cannot", async () => {
  const f = await fixture();
  for (const token of [f.remote.token, f.local.token]) {
    // What such an App sends: no query. It parses the whole reply strictly.
    const legacy = await (await f.api("/api/screens/status", token)).json();
    expect(legacy.desktop).toBeNull();
    expect(legacyStatus.safeParse(legacy).success).toBe(true);
    // What this App sends. The same reply would have failed that App entirely:
    const current = await (await f.api("/api/screens/status?includeWindows=1", token)).json();
    expect(current.desktop).toMatchObject({ platform: "windows", desktopId: f.service.desktopId });
    expect(legacyStatus.safeParse(current).success).toBe(false);
    expect(screenStatusSchema.parse(current).desktop?.platform).toBe("windows");
    // Nothing else in the reply depends on the question.
    expect({ ...current, desktop: null, serverTime: 0 }).toEqual({ ...legacy, serverTime: 0 });
  }
  // Any other value of the query is not the opt-in.
  for (const query of ["?includeWindows=0", "?includeWindows=true", "?includeWindows", "?windows=1"]) expect((await (await f.api(`/api/screens/status${query}`, f.remote.token)).json()).desktop).toBeNull();
  // It cannot open a session there either, even if it had the identifiers: it would drive Windows with Mac keys.
  const open = { desktopId: f.service.desktopId, displayId: "win-1", displayRevision: 1, requestId: randomUUID(), codecs: ["h264"] };
  const refused = await f.api("/api/screens/sessions", f.remote.token, open);
  expect([refused.status, (await refused.json()).error]).toEqual([409, "screen_client_update_required"]);
  expect(f.capture.starts).toEqual([]);
});

it("a repeated open is asked the same question as the first: a receipt admitted with the opt-in is not replayed to a request without it", async () => {
  const f = await fixture();
  const open = { desktopId: f.service.desktopId, displayId: "win-1", displayRevision: 1, requestId: randomUUID(), codecs: ["h264"] };
  const first = await f.api("/api/screens/sessions?includeWindows=1", f.remote.token, open);
  expect(first.status).toBe(201);
  const join = await first.json();
  // The same device, request id and body, without the opt-in: no tickets for the Windows session.
  const replay = await f.api("/api/screens/sessions", f.remote.token, open);
  expect([replay.status, (await replay.json()).error]).toEqual([409, "screen_client_update_required"]);
  // With it, the same receipt as before, and still only that one session.
  const again = await f.api("/api/screens/sessions?includeWindows=1", f.remote.token, open);
  expect([again.status, await again.json()]).toEqual([201, join]);
  expect((await f.hub.remoteScreen.status(f.local.session, { windows: true })).sessions.map(session => session.id)).toEqual([join.session.id]);
  // A different body under the same request id is still the conflict it always was, with or without the opt-in.
  for (const query of ["", "?includeWindows=1"]) expect((await f.api(`/api/screens/sessions${query}`, f.remote.token, { ...open, codecs: ["vp8"] })).status).toBe(409);
});

it("a Mac desktop is returned to every client exactly as before, whatever it asks", async () => {
  const f = await fixture("darwin");
  const legacy = await (await f.api("/api/screens/status", f.remote.token)).json(), current = await (await f.api("/api/screens/status?includeWindows=1", f.remote.token)).json();
  expect(legacy.desktop).toMatchObject({ platform: "macos", desktopId: f.service.desktopId });
  expect({ ...current, serverTime: 0 }).toEqual({ ...legacy, serverTime: 0 });
  expect(legacyStatus.safeParse(legacy).success).toBe(true);
  // The Mac hello carries nothing new, and opening needs no opt-in.
  const open = { desktopId: f.service.desktopId, displayId: "display", displayRevision: 1, requestId: randomUUID(), codecs: ["h264"] };
  const opened = await f.api("/api/screens/sessions", f.remote.token, open);
  expect(opened.status).toBe(201);
  // And a replay of it is the same receipt, asked either way.
  const join = await opened.json();
  for (const query of ["", "?includeWindows=1"]) { const replay = await f.api(`/api/screens/sessions${query}`, f.remote.token, open); expect([replay.status, await replay.json()]).toEqual([201, join]); }
  expect(f.posted.filter(call => call[0] === "releaseCandidates")).toEqual([]);
});

it("a current App views and controls a Windows desktop end to end: scan codes and physical pixels reach the target", async () => {
  const f = await fixture();
  const status = screenStatusSchema.parse(await (await f.api("/api/screens/status?includeWindows=1", f.remote.token)).json());
  const display = status.desktop!.displays[0]!;
  expect(display).toMatchObject({ id: "win-1", width: 1536, height: 864, scale: 1.25 });
  const opened = await f.api("/api/screens/sessions?includeWindows=1", f.remote.token, { desktopId: status.desktop!.desktopId, displayId: display.id, displayRevision: display.revision, requestId: randomUUID(), codecs: ["h264"] });
  expect(opened.status).toBe(201);
  const join = screenJoinSchema.parse(await opened.json()), session = join.session;
  const base = f.hub.instanceUrl.replace("http:", "ws:");
  const control = connect(base + "/screen/v1/control"), media = connect(base + "/screen/v1/media");
  await Promise.all([control.ready, media.ready]);
  control.send({ type: "hello", ticket: join.controlTicket }); media.send({ type: "hello", ticket: join.mediaTicket });
  await wait(() => f.capture.starts.length === 1);
  const size = f.capture.starts[0].encode;
  expect(size).toEqual({ width: 1920, height: 1080 });

  const first = f.emit(session.id, 1, size);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => control.values.some(v => v.type === "frame-ready"));
  control.send({ type: "control", sessionId: session.id, generation: session.generation, frameSequence: first });
  await wait(() => f.capture.resets.length === 1);
  const key = f.emit(session.id, f.capture.resets[0][1], size);
  control.send({ type: "ack", sessionId: session.id, generation: session.generation, frameSequence: key });
  await wait(() => control.values.some(v => v.type === "state" && v.lease && v.session.state === "controlling"));
  const state = control.values.findLast(v => v.type === "state" && v.lease), ready = control.values.findLast(v => v.type === "frame-ready");
  await stat(path.join(f.appState, "screen-control.active"));

  let sequence = 0;
  const input = (event: Any) => control.send({ type: "input", sessionId: session.id, desktopId: status.desktop!.desktopId, generation: session.generation, displayId: display.id, displayRevision: display.revision,
    leaseId: state.lease.id, sequence: ++sequence, frameSequence: ready.frameSequence, expiresAt: ready.expiresAt, event });
  input({ kind: "key", code: "ControlLeft", down: true });
  input({ kind: "key", code: "KeyC", down: true });
  input({ kind: "key", code: "KeyC", down: false });
  input({ kind: "key", code: "ControlLeft", down: false });
  input({ kind: "button", x: 1, y: 1, button: 0, down: true, clicks: 1 });
  await wait(() => f.posted.some(call => call[0] === "mouse"));
  // While the button is held it is the only thing on record: the keys were released and are no longer candidates.
  expect(readHeldJournal(path.join(f.appState, "screen-control.held.log"))).toMatchObject({ state: "valid", keys: [], buttons: ["left"] });
  input({ kind: "button", x: 1, y: 1, button: 0, down: false, clicks: 1 });
  input({ kind: "wheel", x: 0.5, y: 0.5, dx: 0, dy: 100 });
  await wait(() => f.posted.some(call => call[0] === "scroll"));
  expect(f.posted.filter(call => ["key", "mouse", "scroll"].includes(call[0]))).toEqual([
    ["key", 0x1d, true, 0, true, false], ["key", 0x2e, true, 0, false, false], ["key", 0x2e, false, 0, false, false], ["key", 0x1d, false, 0, true, false],
    ["mouse", "down", "left", 1919, 1079, 1, 0], ["mouse", "up", "left", 1919, 1079, 1, 0],
    ["scroll", 960, 540, -120, 0, 0],
  ]);
  expect(readHeldJournal(path.join(f.appState, "screen-control.held.log"))).toMatchObject({ state: "valid", keys: [], buttons: [] });
  expect(await readFile(path.join(f.appState, "screen-control.held.log"), "utf8")).toBe("tarobot-screen-held 1 wts-2-000000000004c2a1-1db123456789abc\n+key 29\n+key 46\n-key 46\n-key 29\n+button left\n-button left\n");

  control.send({ type: "release", sessionId: session.id, generation: session.generation });
  await wait(() => stat(path.join(f.appState, "screen-control.active")).then(() => false, () => true));
  await expect(stat(path.join(f.appState, "screen-control.held.log"))).rejects.toThrow();
  expect(f.posted.at(-1)).toEqual(["releaseAll"]);
});
