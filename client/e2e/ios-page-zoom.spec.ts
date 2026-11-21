import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// The real index.html and main.tsx startup. Capacitor reads the platform from
// the bridge marker each native App injects; without native plugins the page
// stops at its native checks, after the viewport is already settled.
let server: ViteDevServer;
test.beforeAll(async () => { server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen(); });
test.afterAll(async () => { await server?.close(); });
test.use({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true });

const shipped = "width=device-width,initial-scale=1,viewport-fit=cover";
for (const [platform, viewport] of [["ios", `${shipped},maximum-scale=1`], ["android", shipped], ["web", shipped]] as const)
  test(`${platform}: the page viewport ${platform === "ios" ? "cannot zoom past its own scale" : "stays as shipped"}`, async ({ page }) => {
    await page.addInitScript((platform: string) => {
      const bridge = { postMessage() {} };
      if (platform === "ios") Object.assign(window, { webkit: { messageHandlers: { bridge } } });
      if (platform === "android") Object.assign(window, { androidBridge: bridge });
    }, platform);
    await page.goto(server.resolvedUrls!.local[0]);
    await expect(page.locator("html")).toHaveAttribute("data-platform", platform);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", viewport);
  });
