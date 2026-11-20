// Real Hub peer for the iOS native screen audit (SCREEN_AUDIT_FOCUS=real-hub in
// client/ios/tests/HubScreenChecks.swift): this checkout's HubServer over its own
// pinned TLS, one trusted viewer with a control grant and a synthetic target
// service (generated frames only; no capture and no input). It exists so the
// native viewer is checked against the Hub's real message order, not a fixture's.
// Line protocol on stdout as in client/android/audit/screen-fixture.mjs.
// Usage: node --import tsx tests/helpers/ios-screen-real-hub.ts <private-scratch-directory>
import { mkdtemp, readFile } from "node:fs/promises";
import { randomUUID, sign } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";

const reply = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + "\n"); };
// Nothing but protocol lines may reach stdout.
for (const name of ["log", "info", "warn", "debug"] as const) console[name] = (...args: unknown[]) => { process.stderr.write(args.map(String).join(" ") + "\n"); };
const { HubServer } = await import("../../src/hub/server.js");
const { desktopTls } = await import("../../src/hub/desktop-tls.js");
const { hashSecret } = await import("../../src/hub/auth.js");
const { screenConfigureText } = await import("../../src/client-protocol/remote-screen.js");
const { deviceActionProofText } = await import("../../src/client-protocol/device-actions.js");
const { writeScreenFrame } = await import("../../src/client-protocol/screen-wire.js");
const { deviceFields, enrollTrusted, loginFor, testDevice } = await import("./pairing-invite.js");

const scratch = process.argv[2];
if (!scratch) throw new Error("private scratch directory required");
const dir = await mkdtemp(path.join(scratch, "real-hub-"));
const certs = await desktopTls(dir, ["127.0.0.1"]);
const hub = await HubServer.start({ stateDir: dir, tls: { cert: await readFile(certs.cert), key: await readFile(certs.key) } });
const owner = testDevice("local"), viewer = testDevice("viewer");
await hub.enrollLocalController(deviceFields(owner)); await enrollTrusted(hub.auth, viewer);
const local = await loginFor(hub.auth, owner), remote = await loginFor(hub.auth, viewer);
const configure = { operation: "screen.configure" as const, expectedRevision: 0, enabled: true, requestId: randomUUID(),
  grants: [{ deviceId: viewer.deviceId, publicKey: viewer.publicKey, permission: "control" as const }] };
const statement = await hub.auth.prepareDeviceAction({ operation: "screen-grant", target: hashSecret(screenConfigureText(configure)) }, local.token, local.session);
await hub.remoteScreen.configure(local.session, configure, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64") });
const display = { id: "display", nativeId: "1", name: "Display", revision: 1, x: 0, y: 0, width: 1280, height: 720, scale: 1, rotation: 0 };
const desktop = { desktopId: "desktop", instanceId: "instance", loginSession: "login", platform: "macos", capture: "granted", accessibility: true, locked: false, displays: [display] };

// Synthetic target service on the instance listener, as the desktop ScreenService registers.
const base = hub.instanceUrl.replace("http:", "ws:");
const targets = new Map<string, { ws: WebSocket; generation: number; sequence: number }>(), stops = new Map<string, string>();
const service = new WebSocket(base + "/screen/v1/target");
await new Promise<void>((resolve, reject) => { service.once("open", () => resolve()); service.once("error", reject); });
const registered = new Promise<void>(resolve => service.once("message", () => resolve()));
service.send(JSON.stringify({ type: "hello", ticket: hub.remoteScreen.serviceTicket("desktop").ticket, desktop }));
await registered;
const frame = (sessionId: string): boolean => {
  const target = targets.get(sessionId); if (!target || target.ws.readyState !== WebSocket.OPEN) return false;
  target.sequence++;
  target.ws.send(writeScreenFrame({ key: target.sequence === 1, codec: "vp8", streamGeneration: target.generation, geometryRevision: 1, sequence: target.sequence,
    captureMs: Date.now(), width: 1280, height: 720 }, new Uint8Array(64).fill(97)));
  return true;
};
service.on("message", data => {
  const value = JSON.parse(data.toString()) as { type: string; sessionId?: string; reason?: string; mediaTicket?: string; streamGeneration?: number; session?: { id: string } };
  if (value.type === "stop" && value.sessionId) { stops.set(value.sessionId, value.reason ?? ""); targets.get(value.sessionId)?.ws.close(); return; }
  if (value.type !== "start" || !value.session || !value.mediaTicket) return;
  const sessionId = value.session.id, ws = new WebSocket(base + "/screen/v1/target-media");
  targets.set(sessionId, { ws, generation: value.streamGeneration ?? 1, sequence: 0 });
  ws.on("error", () => {});
  ws.once("open", () => ws.send(JSON.stringify({ type: "hello", ticket: value.mediaTicket })));
  ws.once("message", () => {
    ws.send(JSON.stringify({ type: "stream", streamGeneration: value.streamGeneration ?? 1, geometryRevision: 1, codec: "vp8", codecString: "vp8", width: 1280, height: 720,
      contentRect: { x: 0, y: 0, width: 1280, height: 720 } }));
    frame(sessionId);
  });
});

reply({ url: hub.url, publicKey: hub.auth.publicKey, certificateAuthority: certs.certificateAuthority });
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line) as { action: string; id?: string };
  try {
    if (input.action === "open") reply({ join: await hub.remoteScreen.open(remote.session, { desktopId: "desktop", displayId: "display", displayRevision: 1, requestId: randomUUID() }) });
    else if (input.action === "frame") reply({ sent: frame(input.id ?? "") });
    else if (input.action === "stats") reply({ stops: Object.fromEntries(stops), targets: targets.size });
    else if (input.action === "stop") { reply({}); break; }
    else reply({ error: "unknown_action" });
  } catch (error) { reply({ error: error instanceof Error ? error.message : String(error) }); }
}
for (const target of targets.values()) target.ws.terminate();
service.terminate(); await hub.close();
process.exit(0);
