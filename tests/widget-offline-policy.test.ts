import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// Widgets have no network (1.5.1 policy, restored 2026-11-23). The browser engine enforces the content policy of
// the widget frame, so these three strings are the boundary: the guest document, the relay page and the Electron
// response header. None may name a network source again without a decision.
const policies = async () => {
  const guest = /export const WIDGET_CSP = "([^"]+)"/.exec(await readFile("client/src/widget-document.ts", "utf8"))?.[1];
  const electron = /export const WIDGET_CSP = "([^"]+)"/.exec(await readFile("client/electron/assets.mjs", "utf8"))?.[1];
  const relay = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(await readFile("client/public/widget-sandbox.html", "utf8"))?.[1];
  return { guest, electron, relay };
};

it("no widget content policy names a network source", async () => {
  for (const [name, policy] of Object.entries(await policies())) {
    expect(policy, name).toBeTruthy();
    expect(policy, name).toContain("default-src 'none'");
    expect(policy, name).not.toMatch(/https?:|wss?:|\*/);
    expect(policy, name).toMatch(/img-src data:(;|$)/);
    expect(policy, name).toMatch(/font-src data:(;|$)/);
    expect(policy, name).toMatch(/style-src 'unsafe-inline'(;|$)/);
    // No media-src: it falls back to default-src 'none'.
    expect(policy, name).not.toContain("media-src");
  }
});

it("the guest document closes connections, frames, objects and forms by name", async () => {
  const { guest } = await policies();
  for (const directive of ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(guest).toContain(directive);
});

it("Electron cancels every request that is not one of the App's own resources", async () => {
  const source = await readFile("client/electron/security.mjs", "utf8");
  expect(source).toContain("session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !internalResource(details.url) }));");
});
