// The Hub-wide media allowance is shared only by sessions on the default
// budget. A local-network session neither draws on it nor may be ended by it.
// Real WebSockets into RemoteScreenSockets; the authority is a stub.
import http from "node:http";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { RemoteScreenSockets } from "../src/hub/remote-screen-sockets.js";
import { isLocalNetworkAddress } from "../src/hub/network.js";
import { SCREEN_MEDIA_BYTES_PER_MS, SCREEN_MEDIA_DIRECT_BYTES_PER_MS } from "../src/client-protocol/remote-screen.js";
import { SCREEN_PACKET_LIMIT, writeScreenFrame } from "../src/client-protocol/screen-wire.js";
type Any = any;

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.reverse()) await close(); cleanups.length = 0; });

it("a Tailscale IPv6 viewer is not on the local network, like its IPv4 range", () => {
  for (const address of ["fd7a:115c:a1e0::1234:5678", "FD7A:115C:A1E0:ab12::1"]) expect(isLocalNetworkAddress(address), address).toBe(false);
  expect(isLocalNetworkAddress("fd7b:115c:a1e0::1")).toBe(true);
});

it("a default-budget session overrunning the shared allowance does not end a local-network session", async () => {
  const rates = new Map<string, number>(), framed: string[] = [];
  const authority: Any = {
    serviceMedia: (ticket: string) => ({ epoch: "e", sessionId: ticket, generation: "g" }),
    mediaBytesPerMs: (id: string) => rates.get(id) ?? SCREEN_MEDIA_BYTES_PER_MS,
    frame: (_e: string, id: string) => { framed.push(id); return true; },
    closeSession() {}, serviceLost() {},
  };
  const sockets = new RemoteScreenSockets(authority);
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => sockets.upgrade(req, socket, head, true, req.headers["x-direct"] === "1"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)), () => sockets.dispose());
  const port = (server.address() as Any).port;
  const open = async (name: string, direct = false) => {
    const ticket = name.padEnd(43, "x");
    rates.set(ticket, direct ? SCREEN_MEDIA_DIRECT_BYTES_PER_MS : SCREEN_MEDIA_BYTES_PER_MS);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/screen/v1/target-media`, { headers: direct ? { "x-direct": "1" } : {} });
    let reason: string | undefined; ws.on("close", (_c, r) => { reason = r.toString(); }); ws.on("error", () => {});
    await new Promise(resolve => ws.once("open", resolve));
    const attached = new Promise(resolve => ws.once("message", resolve));
    ws.send(JSON.stringify({ type: "hello", ticket })); await attached;
    return { ticket, ws, get reason() { return reason; } };
  };
  const frame = (bytes: number) => writeScreenFrame({ key: true, codec: "h264", sequence: 1, geometryRevision: 1, streamGeneration: 1, captureMs: Date.now(), width: 1280, height: 720 }, new Uint8Array(bytes));
  const big = Math.floor(SCREEN_PACKET_LIMIT * 0.9);
  const a = await open("a"), b = await open("b"), c = await open("c"), lan = await open("lan", true);
  const until = async (check: () => boolean) => { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw new Error("test_wait_timeout"); await new Promise(r => setTimeout(r, 2)); } };
  a.ws.send(frame(big)); await until(() => framed.length === 1);
  b.ws.send(frame(big)); await until(() => framed.length === 2);
  // Three default-budget frames are more than the shared allowance: the third session is refused.
  c.ws.send(frame(big)); await until(() => c.reason !== undefined);
  expect(c.reason).toBe("screen_bandwidth_exceeded");
  lan.ws.send(frame(1000)); await until(() => framed.includes(lan.ticket) || lan.reason !== undefined);
  expect(lan.reason).toBeUndefined();
  expect(framed).toEqual([a.ticket, b.ticket, lan.ticket]);
});
