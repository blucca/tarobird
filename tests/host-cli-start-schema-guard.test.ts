import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runHostCli } from "../src/host-cli/cli.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import * as setup from "../src/host-cli/setup.js";
import * as runtime from "../src/host-cli/update.js";
import * as manager from "../src/host-cli/service-manager.js";
import * as desktop from "../src/hub/desktop.js";
import { HubStore } from "../src/hub/store.js";
import { readHostSchema } from "../src/host-cli/schema-guard.js";

// Same commands as host-cli-start-migration.test.ts, but with the real schema
// guard reading a real database: only the host process itself is faked.
const roots: string[] = [];
async function hostAtSchema(schema: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t63-guard-")); roots.push(directory);
  const store = await HubStore.open(directory); await store.db.run("UPDATE meta SET value=? WHERE key='schema_version'", [String(schema)]); await store.db.close();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(setup, "requireInitialized").mockResolvedValue(undefined as never);
  // The repository package.json declares the runtime's schema range (1-28).
  vi.spyOn(runtime, "resolveHostRuntime").mockResolvedValue({ entrypoint: path.resolve("dist/src/index.js"), executable: process.execPath } as never);
  vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ deviceId: "cli_fixture", publicKey: "same-host", close: vi.fn() } as never);
  vi.spyOn(manager, "managedServiceStatus").mockResolvedValue({ configured: false } as never);
  const host = vi.spyOn(desktop, "desktopHost").mockImplementation(async action => (action === "status" ? { available: true, running: false } : { available: true, running: true, publicKey: "same-host" }) as never);
  return { directory, host };
}
afterEach(async () => { vi.restoreAllMocks(); for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("start explains a database from a newer version before starting anything", async () => {
  const f = await hostAtSchema(29);
  const failure = runHostCli(["start", "--state-dir", f.directory]);
  await expect(failure).rejects.toThrow("来自更新版本的 TaroBird");
  await expect(failure).rejects.toThrow("数据库未修改");
  expect(f.host.mock.calls.map(call => call[0])).toEqual(["status"]);
  expect(LocalHostClient.connect).not.toHaveBeenCalled();
  expect(await readHostSchema(f.directory)).toBe(29);
});

it("restart explains a database from a newer version and does not stop the host", async () => {
  const f = await hostAtSchema(29);
  await expect(runHostCli(["restart", "--force", "--state-dir", f.directory])).rejects.toThrow("来自更新版本的 TaroBird");
  expect(f.host).not.toHaveBeenCalled();
});

it("restart of a desktop-managed host on an older database is admitted like start", async () => {
  const f = await hostAtSchema(25);
  await runHostCli(["restart", "--force", "--state-dir", f.directory]);
  expect(f.host.mock.calls.map(call => call[0])).toEqual(["stop", "status", "start"]);
});

it("migrates schema 27 without dropping designated group settings", async () => {
  const f = await hostAtSchema(27);
  // Simulate rows already written by the separate schema-27 group feature.
  const sqlite = new (await import("sqlite3")).default.Database(path.join(f.directory, "hub.sqlite"));
  await new Promise<void>((resolve, reject) => {
    sqlite.run("INSERT INTO group_discussion_settings VALUES('fixture_group','designated','[]',1,'owner',1)", error => error ? reject(error) : resolve());
  });
  await new Promise<void>((resolve, reject) => { sqlite.close(error => error ? reject(error) : resolve()); });
  const store = await HubStore.open(f.directory);
  try {
    expect(await store.db.get("SELECT mode FROM group_discussion_settings WHERE group_id='fixture_group'")).toEqual({ mode: "designated" });
    expect(await store.db.get("SELECT value FROM meta WHERE key='schema_version'")).toEqual({ value: "28" });
  } finally { await store.db.close(); }
});
