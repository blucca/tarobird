import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearDiscoveryCaches, type CommandRunner } from "../src/host-cli/engine-discovery.js";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import { engineDiscoveryCacheFile } from "../src/runtime/host-engine-settings.js";
import { withFileMutex } from "../src/state/file-mutex.js";

const roots: string[] = [];
afterEach(async () => {
  clearDiscoveryCaches();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A state folder plus an environment whose PATH holds a `codex`, so discovery has a path to cache. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-cache-close-"));
  roots.push(root);
  const state = path.join(root, "state"), bin = path.join(root, "bin");
  await mkdir(state, { recursive: true, mode: 0o700 }); await mkdir(bin);
  await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, "codex"), 0o755);
  return { state, env: { HOME: root, PATH: bin } as NodeJS.ProcessEnv };
}
const cacheEntries = async (state: string) => (await readdir(state)).filter(name => name.startsWith("engine-discovery-cache"));
const until = async (check: () => boolean) => { while (!check()) await new Promise(resolve => setImmediate(resolve)); };

it.runIf(process.platform !== "win32")("writes no discovery cache or lock after close() when a probe finishes later", async () => {
  const { state, env } = await fixture();
  let finishProbe!: () => void;
  const probeGate = new Promise<void>(resolve => { finishProbe = resolve; });
  const runner: CommandRunner = async () => { await probeGate; return { stdout: "", stderr: "" }; };
  const settings = new HubEngineSettings(state, () => env);
  const warm = settings.warmDiscovery({ runner });
  await settings.close();
  finishProbe();
  await warm;
  expect(settings.hasDiscoverySnapshot).toBe(true);
  expect(await cacheEntries(state)).toEqual([]);
});

it.runIf(process.platform !== "win32")("close() waits for a cache write already in progress and leaves it complete", async () => {
  const { state, env } = await fixture();
  const file = engineDiscoveryCacheFile(state);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Hold the cache's mutex so the writer is provably in progress when close() starts.
  let locked!: () => void;
  const lockTaken = new Promise<void>(resolve => { locked = resolve; });
  const holder = withFileMutex(file, async () => { locked(); await held; });
  await lockTaken;
  const settings = new HubEngineSettings(state, () => env);
  const runner: CommandRunner = async () => ({ stdout: "", stderr: "" });
  const warm = settings.warmDiscovery({ runner });
  await until(() => settings.hasDiscoverySnapshot);
  let closed = false;
  const closing = settings.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(closed).toBe(false);
  release();
  await holder; await closing; await warm;
  expect(await cacheEntries(state)).toEqual(["engine-discovery-cache.json"]);
  const written = JSON.parse(await readFile(file, "utf8"));
  expect(written.paths.codex).toBe(path.join(env.PATH!, "codex"));
});
