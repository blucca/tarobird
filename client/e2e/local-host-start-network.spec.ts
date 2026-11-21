import { expect, test } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";

// Issue #63: when the stopped local host is the coordinator, the network
// status explains it and offers the same start entry as the local row.
test("the stopped coordinator's network status offers the local start entry", async ({ page }) => {
  const html = '<!doctype html><html><body><div id="root"></div><script type="module" src="/e2e/fixtures/local-host-start-network.tsx"></script></body></html>';
  const vite = await createServer({ optimizeDeps: { entries: ["e2e/fixtures/local-host-start-network.tsx"] }, plugins: [{ name: "local-start-network-fixture", configureServer(server) { server.middlewares.use(async (request, response, next) => { if (request.url !== "/__local-start-network") return next(); response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml("/__local-start-network", html)); }); } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await vite.listen();
  try {
    await page.goto(`${vite.resolvedUrls!.local[0]}__local-start-network`);
    const summary = page.getByRole("region", { name: "网络概况" });
    await expect(summary.getByText("未连接协调主机")).toBeVisible();
    await expect(summary.getByRole("status")).toHaveText("协调主机「macmini」就是这台电脑上的主机，目前已停用，所以暂时无法管理网络。启动后会自动重新连接。");
    const summaryStart = summary.getByRole("button", { name: "启动本机主机" });
    const members = page.getByRole("region", { name: "网络成员" });
    await expect(members.getByRole("button", { name: /macmini.*协调.*本机.*本机主机已停用，App 不会自动重新启用。.*已停止/ })).toBeVisible();
    const rowStart = members.getByRole("button", { name: "启动本机主机" });
    // This desktop's stopped coordinator is a listed member, not "not joined";
    // another saved member without a connection keeps its existing place.
    const unjoined = page.getByRole("region", { name: "未加入网络" });
    await expect(unjoined.getByRole("button", { name: /离线工作机/ })).toBeVisible();
    await expect(unjoined.getByText("macmini")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "启动本机主机" })).toHaveCount(2);
    await expect(summaryStart).toBeEnabled(); await expect(rowStart).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("coordinator-stopped.png"), fullPage: true });
    await summaryStart.click();
    // One shared state: both entries are busy, then both show the reason; it
    // is announced once (the member row), not twice.
    await expect(summary.getByRole("button", { name: "正在启动本机主机…" })).toHaveAttribute("aria-disabled", "true");
    await expect(members.getByRole("button", { name: "正在启动本机主机…" })).toHaveAttribute("aria-disabled", "true");
    await page.evaluate(() => (window as any).startFixture.release());
    await expect(summary.locator(".local-host-start-error")).toContainText("数据未改动");
    await expect(members.locator(".local-host-start-error")).toContainText("数据未改动");
    await expect(page.locator(".local-host-start-error[role]")).toHaveCount(1);
    await expect(summaryStart).not.toHaveAttribute("aria-disabled");
    expect(await page.evaluate(() => (window as any).startFixture.starts.length)).toBe(1);
  } finally { await vite.close(); }
});
