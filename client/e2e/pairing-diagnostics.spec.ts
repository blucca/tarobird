import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { HubServer } from "../../src/hub/server.js";
import { createServer } from "./fixtures/vite.js";
import { preparePairing } from "./fixtures/pairing-invite.js";
import { selectConversation, showDisconnectedBots, waitForClientOnline } from "./fixtures/mobile.js";
import type { PairingProps } from "../src/HostApp.js";
import type { HubConnection } from "../src/connection.js";

declare global {
  interface Window {
    nativeTransportFixture: {
      mockIPC: (cb: (cmd: string, args?: Record<string, unknown>) => unknown) => void;
      renderPairing(props?: Partial<PairingProps>): void;
      renderRoutes(connection: HubConnection): void;
      setLocale(locale: "zh" | "en"): void;
      HubConnection: typeof HubConnection;
    };
  }
}

const HUB_KEY = "MCowBQYDK2VwAyEAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
let server: ViteDevServer;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});

async function importInvitation(page: Page, route: { name: "Tailscale" | "Direct" | "VPS"; url: string }, locale: "zh" | "en") {
  const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify({ v: 1, kind: "connect", hubPublicKey: HUB_KEY, routes: [route] }))}&invite=${"i".repeat(43)}`;
  await page.getByRole("button", { name: locale === "zh" ? "粘贴连接信息" : "Paste connection details", exact: true }).click();
  await page.getByLabel(locale === "zh" ? "配对信息" : "Pairing information", { exact: true }).fill(link);
  await page.getByRole("button", { name: locale === "zh" ? "使用配对信息" : "Use pairing information", exact: true }).click();
}

for (const locale of ["zh", "en"] as const) {
  for (const scenario of [
    {
      name: "tailscale unreachable",
      route: { name: "Tailscale" as const, url: "https://100.64.0.1:8788" },
      errorCode: "native_request_timeout",
      zh: /无法通过 Tailscale 连接到主机.*Tailscale/,
      en: /Could not reach the host over Tailscale.*tailnet/i,
      forbidden: /本地网络|Local Network permission/,
    },
    {
      name: "tailscale connection refused (host not running)",
      route: { name: "Tailscale" as const, url: "https://100.64.0.1:8788" },
      errorCode: "native_connection_refused",
      zh: /已连通 Tailscale 地址，但主机拒绝了连接.*TaroBird/,
      en: /Reached the Tailscale address, but the host refused the connection/,
    },
    {
      name: "lan away from Wi-Fi",
      route: { name: "Direct" as const, url: "https://192.168.1.100:8788" },
      errorCode: "native_request_timeout",
      zh: /似乎不在同一 Wi-Fi \/ 局域网内.*Tailscale.*VPS/,
      en: /away from that Wi-Fi or LAN.*Tailscale.*VPS/,
      forbidden: /本地网络|Local Network permission/,
    },
    {
      name: "ios local network permission denied",
      route: { name: "Direct" as const, url: "https://192.168.1.100:8788" },
      errorCode: "local_network_permission_denied",
      zh: /没有获得“本地网络”权限.*设置 → 隐私与安全性 → 本地网络/,
      en: /does not have Local Network permission.*Settings → Privacy & Security → Local Network/,
    },
  ]) {
    test(`pairing explains ${scenario.name} (${locale})`, async ({ page }) => {
      await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
      await page.waitForFunction(() => !!window.nativeTransportFixture);
      await page.evaluate(({ locale, errorCode }) => {
        const fixture = window.nativeTransportFixture;
        fixture.setLocale(locale);
        let seq = 0;
        fixture.mockIPC((cmd) => {
          if (cmd === "desktop_host") return { available: true, running: true, hostName: "macmini" };
          if (cmd === "net_allocate") return `diag-${++seq}`;
          if (cmd === "net_http_open") return Promise.reject(new Error(errorCode));
        });
        fixture.renderPairing({ localHostReady: true });
      }, { locale, errorCode: scenario.errorCode });

      await page.getByRole("button", { name: locale === "zh" ? "连接已有主机" : "Connect to an existing host", exact: true }).click();
      await importInvitation(page, scenario.route, locale);
      await page.getByRole("button", { name: locale === "zh" ? "配对此设备" : "Pair this device", exact: true }).click();
      const alert = page.getByRole("alert");
      await expect(alert).toHaveText(scenario[locale]);
      if (scenario.forbidden) {
        await expect(alert).not.toHaveText(scenario.forbidden);
      }
    });
  }
}

test("saved routes settings show per-route failure reason and summary in zh and en", async ({ page }) => {
  await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/native-transport.html");
  await page.waitForFunction(() => !!window.nativeTransportFixture);
  await page.evaluate(async () => {
    const fixture = window.nativeTransportFixture;
    let seq = 0;
    fixture.mockIPC((cmd, args) => {
      if (cmd === "net_allocate") return `saved-${++seq}`;
      if (cmd === "net_http_open") {
        const origin = (args!.input as { origin: string }).origin;
        throw new Error(origin.includes("192.168.") ? "local_network_permission_denied" : "native_request_timeout");
      }
    });
    const connection = new fixture.HubConnection(
      {
        deviceId: "fixture",
        name: "Fixture",
        publicKey: "device",
        hubPublicKey: "trusted",
        routes: [
          { name: "Direct", url: "https://192.168.1.100:8788" },
          { name: "Tailscale", url: "https://100.64.0.1:8788" },
        ],
      },
      undefined,
      () => "macmini",
    );
    await (connection as unknown as { connect(): Promise<void> }).connect();
    connection.close();
    fixture.renderRoutes(connection);
  });

  await expect(page.getByText("缺少本地网络权限", { exact: true })).toBeVisible();
  await expect(page.getByText("连接超时", { exact: true })).toBeVisible();
  await expect(page.locator(".connection-summary")).toContainText("本地网络");

  await page.evaluate(() => window.nativeTransportFixture.setLocale("en"));
  await expect(page.getByText("Local network permission denied", { exact: true })).toBeVisible();
  await expect(page.getByText("Connection timed out", { exact: true })).toBeVisible();
});

test("real Hub pairing surfaces expired invite explanation and saved phone connection details show host-down reason", async ({ page }) => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "diag-real-hub-"));
  const clientDir = path.resolve("dist");
  const hub = await HubServer.start({ stateDir: root, clientDir });
  try {
    await hub.profile.update({ name: "macmini", revision: (await hub.profile.read()).revision });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('diag','Diag Bot','fixture')");
    const chat = await hub.store.createConversation("owner", ["diag"], "诊断对话", "diag-chat");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(hub.url);
    await preparePairing(page, hub);
    await page.route("**/api/pair", (route) =>
      route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "pairing_invite_expired" }) }),
    );
    await page.getByRole("button", { name: "配对此设备", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("此连接码已过期或失效");
    await expect(page.getByRole("button", { name: "扫描新的连接码", exact: true })).toBeVisible();

    await page.unroute("**/api/pair");
    await preparePairing(page, hub);
    await hub.auth.approve(await page.getByLabel("配对码", { exact: true }).innerText(), "local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden", timeout: 15_000 });
    await waitForClientOnline(page);
    await showDisconnectedBots(page);
    await selectConversation(page, chat.title);

    await hub.close();
    const notice = page.locator(".phone-connection-notice");
    await expect(notice).toBeVisible();
    expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(46);
    await notice.locator("summary").click();
    await expect(notice.locator(".connection-notice-reason")).toContainText("无法连接到本机 TaroBird 主机");
  } finally {
    await page.close();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  }
});
