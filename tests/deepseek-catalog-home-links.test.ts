import { lstatSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Windows reports a directory junction as a link, and its unlink can fail with EPERM
// (see removeLink in deepseek-harness-profile.ts). `rm` here does the same for any link
// while `junctionFails` is set, so the Windows failure can be pinned on this machine.
const fails = vi.hoisted(() => ({ junction: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rm: typeof actual.rm = async (target, options) => {
    if (fails.junction && !options?.recursive) {
      let link = false; try { link = lstatSync(target).isSymbolicLink(); } catch { /* missing */ }
      if (link) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${String(target)}'`), { code: "EPERM" });
    }
    return actual.rm(target, options);
  };
  return { ...actual, rm, default: { ...actual, rm } };
});
const { discoverDeepSeekModels, resetDeepSeekModelDiscoveryForTest } = await import("../src/runtime/deepseek-model-discovery.js");

const dirs: string[] = [];
afterEach(async () => {
  resetDeepSeekModelDiscoveryForTest(); fails.junction = false;
  await new Promise(resolve => setTimeout(resolve, 200));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});
const catalog = { default: { provider: "alpha", model: "family/model", reasoningEffort: "medium" }, routableProviders: ["alpha"], failures: [], groups: [
  { id: "alpha", name: "A", models: [{ id: "family/model", name: "Shared", reasoning: { efforts: [{ id: "medium", name: "Medium" }], defaultEffort: "medium" } }] },
] };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-catalog-links-")); dirs.push(root);
  const shared = path.join(root, "shared"), web = path.join(shared, "profiles", "web"), workspace = path.join(root, "workspace");
  const catalogHome = path.join(root, "host", "deepseek-catalog"), source = path.join(root, "catalog.json"), mode = path.join(root, "mode");
  await mkdir(path.join(web, "node_modules", "plugin"), { recursive: true }); await mkdir(workspace);
  await writeFile(path.join(web, "cordis.patch.yml"), "shared profile\n");
  await writeFile(path.join(web, "package.json"), "{\"dependencies\":{\"plugin\":\"1.0.0\"}}\n");
  await writeFile(path.join(web, "node_modules", "plugin", "package.json"), "{\"version\":\"1.0.0\"}\n");
  // A plugin the owner develops elsewhere and linked into the profile's root.
  const dev = path.join(root, "dev-plugin"); await mkdir(dev); await writeFile(path.join(dev, "index.js"), "export default 2;\n");
  await symlink(dev, path.join(web, "dev-plugin"), "dir");
  await writeFile(path.join(shared, ".credentials.yaml"), "shared credentials\n");
  await writeFile(source, JSON.stringify(catalog)); await writeFile(mode, "");
  const env = { ...process.env, TAROBOT_MODEL_DISCOVERY: "1", DSH_EXECUTABLE: path.resolve("tests/fixtures/deepseek-models.mjs"), DSH_HOME: shared, DSH_FIXTURE_CATALOG: source, DSH_FIXTURE_MODE_FILE: mode };
  // A read answers before its cleanup ends; wait for the cleanup so what it leaves is what is checked.
  const settled = () => expect.poll(() => stat(path.join(catalogHome, "catalog.mutex.lock")).then(() => true, () => false), { timeout: 5000 }).toBe(false);
  const read = async () => { resetDeepSeekModelDiscoveryForTest(); const result = await discoverDeepSeekModels(env, workspace, false, { catalogHome }); await settled(); return result; };
  const readFrom = async (home: string) => { resetDeepSeekModelDiscoveryForTest(); const result = await discoverDeepSeekModels({ ...env, DSH_HOME: home }, workspace, false, { catalogHome }); await settled(); return result; };
  return { root, dev, read, readFrom, home: path.join(catalogHome, "home"), link: path.join(catalogHome, "home", "profiles", "web", "dev-plugin") };
}

it("keeps a directory linked into the profile's root across catalog reads", async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe("ready");
  const dev = await realpath(f.dev);
  expect(await realpath(f.link)).toBe(dev);
  expect((await f.read()).status).toBe("ready");
  // The second read only refreshes root files; the link must still be there for dsh to load.
  expect(await realpath(f.link)).toBe(dev);
});

it("still reads when removing a linked directory would fail, as a junction's unlink can on Windows", async () => {
  const f = await fixture();
  fails.junction = true;
  expect((await f.read()).status).toBe("ready");
  // The scrub before this read meets the link the first read left.
  expect((await f.read()).status).toBe("ready");
});

it("does not keep another DeepSeek home's packages when the current one has no profile", async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe("ready");
  expect(await stat(path.join(f.home, "profiles", "web", "node_modules", "plugin")).then(() => true, () => false)).toBe(true);
  const bare = path.join(f.root, "bare"); await mkdir(bare);
  expect((await f.readFrom(bare)).status).toBe("ready");
  // dsh would load the plugins of the home read before; this home has none.
  expect(await stat(path.join(f.home, "profiles", "web", "node_modules")).then(() => true, () => false)).toBe(false);
  // Reading the first home again mirrors it again.
  expect((await f.read()).status).toBe("ready");
  expect(await stat(path.join(f.home, "profiles", "web", "node_modules", "plugin", "package.json")).then(() => true, () => false)).toBe(true);
});
