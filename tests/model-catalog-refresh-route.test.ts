import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeHost } from "../src/host-cli/setup.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { ModelCatalogCache } from "../src/hub/model-catalog-cache.js";
import type { ModelCatalogRead } from "../src/runtime/model-catalog.js";

/**
 * "Refresh models" in New Bot must be a real read even inside the short
 * window in which an unanswered read is otherwise served again; opening the
 * dialog or looking again must not start the engine each time.
 */

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("reads DeepSeek's models again when the owner asks, and only then", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "catalog-refresh-")); roots.push(root);
  const dsh = path.join(root, "dsh"); await writeFile(dsh, "a fixture, never executed"); await chmod(dsh, 0o700);
  await initializeHost(root, "Catalog refresh fixture");
  const env = { HOME: root, USERPROFILE: root, PATH: "/usr/bin:/bin", DSH_EXECUTABLE: dsh, TAROBOT_MODEL_DISCOVERY: "0" };
  const hub = await HubServer.start({ stateDir: root, managedBots: { entrypoint: path.resolve("dist/src/index.js"), env } });
  const reads: Array<{ engine: string; fresh: boolean }> = [];
  const unanswered: ModelCatalogRead = { choices: [{ id: "", efforts: [""] }], answered: false, status: "unavailable" } as ModelCatalogRead;
  const cache = new ModelCatalogCache({}, async (engine, _env, _cwd, fresh) => {
    reads.push({ engine, fresh });
    return engine === "deepseek" ? unanswered : { choices: [{ id: "", efforts: [""] }], answered: true };
  });
  (hub as unknown as { botManager: { catalogCache?: ModelCatalogCache } }).botManager.catalogCache = cache;
  const close = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const client = await LocalHostClient.connect(root, { enroll: true });
  const deepseekReads = () => reads.filter(read => read.engine === "deepseek");
  try {
    await client.request("/api/bots/catalog?includePi=1");
    expect(deepseekReads()).toHaveLength(1);
    // A second look within the retry window is served from the cache.
    await client.request("/api/bots/catalog?includePi=1");
    expect(deepseekReads()).toHaveLength(1);
    // The owner's reread starts a new read of that engine only.
    const before = reads.length;
    await client.request("/api/bots/catalog?includePi=1&refresh=deepseek");
    expect(deepseekReads()).toHaveLength(2);
    expect(deepseekReads()[1]!.fresh).toBe(true);
    // Kimi reads one local file on every look and starts nothing; no other CLI is started again.
    expect(reads.slice(before).map(read => read.engine).filter(engine => engine !== "kimi")).toEqual(["deepseek"]);
    await expect(client.request("/api/bots/catalog?includePi=1&refresh=nonsense")).rejects.toThrow();
  } finally { client.close(); await close(); await hub.close(); }
});
