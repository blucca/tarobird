import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import type { mobileNetwork } from "../src/native-network.js";
declare global { interface Window { mobileNetwork: typeof mobileNetwork } }
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => { await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/mobile-network.html"); await page.waitForFunction(() => !!window.mobileNetwork); });

for (const pageToken of [undefined, "0123456789abcdef0123456789abcdef"]) test(`screen native bridge scopes listener, routes and receipts (${pageToken ? "iOS" : "Android"})`, async ({ page }) => {
  expect(await page.evaluate(async pageToken => {
    const calls: { name: string; args: Record<string, unknown> }[] = [], received: string[] = [];
    let release!: () => void, emit!: (event: { id: string; kind: string }) => void;
    const invoke = window.mobileNetwork({
      addListener: async (name, callback) => { if (name !== (pageToken ? `socket:${pageToken}` : "socket")) throw Error("wrong scope"); emit = callback; await new Promise<void>(resolve => { release = resolve; }); return { remove: async () => {} }; },
      screenOpen: async args => { calls.push({ name: "open", args }); emit({ id: String(args.id), kind: "screen" }); },
      screenSend: async args => { calls.push({ name: "send", args }); },
      screenAck: async args => { calls.push({ name: "ack", args }); },
      screenClose: async args => { calls.push({ name: "close", args }); return { value: true }; },
    } as Parameters<typeof window.mobileNetwork>[0], pageToken);
    const network = { url: "https://fixture.invalid", publicKey: "pinned-key", certificateAuthority: "PUBLIC_CA" }, join = { session: { id: "session" } };
    const open = invoke("net_screen_open", { id: "screen", network, join, events: { onmessage: (event: { kind: string }) => received.push(event.kind) } });
    await Promise.resolve(); const before = calls.length; release(); await open;
    await invoke("net_screen_send", { id: "screen", command: { type: "input-focus", enabled: false } });
    await invoke("net_screen_ack", { id: "screen", deliverySequence: 2 });
    const closed = await invoke("net_screen_close", { id: "screen" }); emit({ id: "screen", kind: "binary" });
    return { before, received, closed, calls, network, join };
  }, pageToken)).toEqual({ before: 0, received: ["screen"], closed: true,
    network: { url: "https://fixture.invalid", publicKey: "pinned-key", certificateAuthority: "PUBLIC_CA" }, join: { session: { id: "session" } },
    calls: [
      { name: "open", args: { id: "screen", network: { url: "https://fixture.invalid", publicKey: "pinned-key", certificateAuthority: "PUBLIC_CA" }, join: { session: { id: "session" } }, ...(pageToken ? { pageToken } : {}) } },
      { name: "send", args: { id: "screen", command: { type: "input-focus", enabled: false }, ...(pageToken ? { pageToken } : {}) } },
      { name: "ack", args: { id: "screen", deliverySequence: 2, ...(pageToken ? { pageToken } : {}) } },
      { name: "close", args: { id: "screen", ...(pageToken ? { pageToken } : {}) } },
    ] });
});

test("screen native pull is bounded and missing old App methods never fall back", async ({ page }) => {
  expect(await page.evaluate(async () => {
    let data = "AP+A";
    const invoke = window.mobileNetwork({ screenRead: async () => ({ data }), addListener: async () => ({ remove: async () => {} }) } as Parameters<typeof window.mobileNetwork>[0]);
    const bytes = [...new Uint8Array(await invoke("net_screen_read", { id: "screen", deliverySequence: 1, offset: 0, maxBytes: 3 }) as ArrayBuffer)];
    data = btoa("a".repeat(262145)); const oversized = await invoke("net_screen_read").then(() => false, () => true);
    const missing = await invoke("net_screen_open", { id: "screen", events: { onmessage: () => {} } }).then(() => "", (error: Error) => error.message);
    const old = window.mobileNetwork({ screenSend: async () => { throw Object.assign(Error("not implemented"), { code: "UNIMPLEMENTED" }); } } as unknown as Parameters<typeof window.mobileNetwork>[0]);
    const unavailable = await old("net_screen_send").then(() => "", (error: Error) => error.message);
    return { bytes, oversized, missing, unavailable };
  })).toEqual({ bytes: [0, 255, 128], oversized: true, missing: "screen_mobile_update_required", unavailable: "screen_mobile_update_required" });
});
