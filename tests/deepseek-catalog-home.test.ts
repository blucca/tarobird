import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Count full profile mirrors against root-file refreshes without changing either.
const profile = vi.hoisted(() => ({ prepare: 0, sync: 0 }));
vi.mock("../src/codex/deepseek-harness-profile.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/codex/deepseek-harness-profile.js")>();
  return {
    ...actual,
    prepareDeepSeekHarnessPrivateProfile: (...args: Parameters<typeof actual.prepareDeepSeekHarnessPrivateProfile>) => { profile.prepare++; return actual.prepareDeepSeekHarnessPrivateProfile(...args); },
    syncDeepSeekHarnessProfileRootFiles: (...args: Parameters<typeof actual.syncDeepSeekHarnessProfileRootFiles>) => { profile.sync++; return actual.syncDeepSeekHarnessProfileRootFiles(...args); },
  };
});
const { discoverDeepSeekModels, resetDeepSeekModelDiscoveryForTest } = await import("../src/runtime/deepseek-model-discovery.js");

const dirs: string[] = [], tmpdir = process.env.TMPDIR;
afterEach(async () => {
  resetDeepSeekModelDiscoveryForTest(); profile.prepare = 0; profile.sync = 0;
  if (tmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmpdir;
  // Reads answer before their cleanup ends; let it finish before removing its directories.
  await Promise.all(pending.splice(0).map(wait => wait()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});
const pending: (() => Promise<void>)[] = [];
const catalog = { default: { provider: "alpha", model: "family/model", reasoningEffort: "medium" }, routableProviders: ["alpha"], failures: [], groups: [
  { id: "alpha", name: "A", models: [{ id: "family/model", name: "Shared", reasoning: { efforts: [{ id: "medium", name: "Medium" }], defaultEffort: "medium" } }] },
] };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-catalog-home-")); dirs.push(root);
  const shared = path.join(root, "shared"), web = path.join(shared, "profiles", "web"), workspace = path.join(root, "workspace");
  const catalogHome = path.join(root, "host", "deepseek-catalog"), source = path.join(root, "catalog.json"), trace = path.join(root, "trace.jsonl"), mode = path.join(root, "mode");
  await mkdir(path.join(web, "node_modules", "plugin"), { recursive: true }); await mkdir(workspace);
  await writeFile(path.join(web, "cordis.patch.yml"), "shared profile\n");
  await writeFile(path.join(web, "package.json"), "{\"dependencies\":{\"plugin\":\"1.0.0\"}}\n");
  await writeFile(path.join(web, "node_modules", "plugin", "package.json"), "{\"version\":\"1.0.0\"}\n");
  await writeFile(path.join(web, "node_modules", "plugin", "index.js"), "export default 1;\n");
  await writeFile(path.join(shared, ".credentials.yaml"), "shared credentials\n"); await writeFile(path.join(shared, "settings.yaml"), "shared: true\n");
  await writeFile(source, JSON.stringify(catalog)); await writeFile(mode, "");
  const env = { ...process.env, TAROBOT_MODEL_DISCOVERY: "1", DSH_EXECUTABLE: path.resolve("tests/fixtures/deepseek-models.mjs"), DSH_HOME: shared, DSH_FIXTURE_CATALOG: source, DSH_FIXTURE_TRACE: trace, DSH_FIXTURE_MODE_FILE: mode };
  const starts = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === "start");
  // Each read here is a new one: the in-process 30 s answer cache is not under test.
  const read = async (cwd: string | undefined = workspace, timing = {}) => { resetDeepSeekModelDiscoveryForTest(); return discoverDeepSeekModels(env, cwd, false, { catalogHome, ...timing }); };
  pending.push(async () => {
    for (const event of await starts()) await expect.poll(() => alive(event.pid), { timeout: 5000 }).toBe(false);
    await expect.poll(() => stat(path.join(catalogHome, "catalog.mutex.lock")).then(() => true, () => false), { timeout: 5000 }).toBe(false);
  });
  return { root, shared, web, workspace, catalogHome, env, starts, read, setMode: (value: string) => writeFile(mode, value) };
}

it("keeps one private catalog home, mirrors packages once, and leaves no credentials copy after a read", async () => {
  const f = await fixture(), home = path.join(f.catalogHome, "home");
  expect((await f.read()).status).toBe("ready");
  expect(profile).toEqual({ prepare: 1, sync: 0 });
  expect(await readFile(path.join(home, "profiles", "web", "node_modules", "plugin", "index.js"), "utf8")).toBe("export default 1;\n");
  // Copied for the read, removed once its child has exited, with everything
  // else but the package mirror: configuration and what dsh wrote at boot.
  await expect.poll(() => stat(path.join(home, ".credentials.yaml")).then(() => true, () => false), { timeout: 3000 }).toBe(false);
  await expect.poll(async () => (await readdir(home)).sort(), { timeout: 3000 }).toEqual([".tarobird-catalog-mirror.json", "profiles"]);
  expect((await readdir(path.join(home, "profiles", "web"))).sort()).toEqual([".tarobird-profile-mirror.json", "node_modules"]);
  // The shared home is only read.
  expect(await readFile(path.join(f.web, "cordis.patch.yml"), "utf8")).toBe("shared profile\n");
  expect(await readFile(path.join(f.shared, ".credentials.yaml"), "utf8")).toBe("shared credentials\n");

  // Unchanged packages: only root files are refreshed. The patch the last read's
  // dsh rewrote is the shared one again at boot, and credentials are present for it.
  expect((await f.read()).status).toBe("ready");
  expect(profile).toEqual({ prepare: 1, sync: 1 });
  const [first, second] = await f.starts();
  expect(second.home).toBe(first.home); expect(first.home).toBe(home);
  expect(first.patchSeen).toBe("shared profile\n"); expect(second.patchSeen).toBe("shared profile\n");
  expect(second.credentialsSeen).toBe(true);

  // A changed root file is still picked up without a full mirror.
  await writeFile(path.join(f.web, "cordis.patch.yml"), "shared profile v2\n");
  await f.read();
  expect(profile).toEqual({ prepare: 1, sync: 2 }); expect((await f.starts())[2].patchSeen).toBe("shared profile v2\n");

  // An added package, or an updated one, is mirrored.
  await mkdir(path.join(f.web, "node_modules", "plugin2")); await writeFile(path.join(f.web, "node_modules", "plugin2", "package.json"), "{}\n");
  await f.read();
  expect(profile.prepare).toBe(2);
  expect(await readFile(path.join(home, "profiles", "web", "node_modules", "plugin2", "package.json"), "utf8")).toBe("{}\n");
  await writeFile(path.join(f.web, "node_modules", "plugin", "package.json"), "{\"version\":\"1.0.1\"}\n");
  await writeFile(path.join(f.web, "node_modules", "plugin", "index.js"), "export default 2;\n");
  await f.read();
  expect(profile.prepare).toBe(3);
  expect(await readFile(path.join(home, "profiles", "web", "node_modules", "plugin", "index.js"), "utf8")).toBe("export default 2;\n");
  // Shared configuration removed since the last read is removed from the private home too.
  await rm(path.join(f.shared, "settings.yaml")); await f.read();
  await expect(stat(path.join(home, "settings.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("answers as soon as the catalog is read, before its child has finished exiting", async () => {
  const f = await fixture();
  await f.setMode("slow-exit");
  expect((await f.read()).status).toBe("ready");
  const [start] = await f.starts();
  // The child ignores SIGTERM; it is still being stopped when the answer arrives.
  expect(alive(start.pid)).toBe(true);
  await expect.poll(() => alive(start.pid), { timeout: 5000 }).toBe(false);
}, 15_000);

it("reads one at a time in the shared home, whatever the workspace", async () => {
  const f = await fixture(), other = path.join(f.root, "other");
  await mkdir(other); await f.setMode("delay-200");
  resetDeepSeekModelDiscoveryForTest();
  const [a, b] = await Promise.all([discoverDeepSeekModels(f.env, f.workspace, false, { catalogHome: f.catalogHome }), discoverDeepSeekModels(f.env, other, false, { catalogHome: f.catalogHome })]);
  expect(a.status).toBe("ready"); expect(b.status).toBe("ready");
  const starts = await f.starts();
  expect(starts).toHaveLength(2); expect(starts.map(event => event.overlapped)).toEqual([false, false]);
  expect(starts.map(event => event.cwd).sort()).toEqual([f.workspace, other].sort());
}, 20_000);

it("removes temporary homes earlier versions abandoned, and only those", async () => {
  const f = await fixture(), tmp = path.join(f.root, "tmp");
  await mkdir(tmp); process.env.TMPDIR = tmp;
  const abandoned = path.join(tmp, "tarobird-dsh-catalog-aaaaaa"), recent = path.join(tmp, "tarobird-dsh-catalog-bbbbbb"), unrelated = path.join(tmp, "tarobird-other-cccccc");
  for (const directory of [abandoned, recent, unrelated]) { await mkdir(path.join(directory, "home"), { recursive: true }); await writeFile(path.join(directory, "home", ".credentials.yaml"), "copy\n"); }
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(abandoned, old, old); await utimes(unrelated, old, old);
  expect((await f.read()).status).toBe("ready");
  await expect.poll(() => stat(abandoned).then(() => true, () => false), { timeout: 3000 }).toBe(false);
  expect((await stat(recent)).isDirectory()).toBe(true); expect((await stat(unrelated)).isDirectory()).toBe(true);
}, 15_000);
