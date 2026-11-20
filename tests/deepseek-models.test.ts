import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { decodeDeepSeekModel, encodeDeepSeekModel, parseDeepSeekModelCatalog, findDeepSeekModel } from "../src/codex/deepseek-models.js";
import { discoverDeepSeekModels, resetDeepSeekModelDiscoveryForTest } from "../src/runtime/deepseek-model-discovery.js";
import { readModelCatalog } from "../src/runtime/model-catalog.js";

const dirs: string[] = [];
afterEach(async () => { resetDeepSeekModelDiscoveryForTest(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const catalog = { default: { provider: "alpha", model: "family/model", reasoningEffort: "medium" }, routableProviders: ["alpha", "beta"], failures: [], groups: [
  { id: "alpha", name: "A", models: [{ id: "family/model", name: "Shared", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "medium", name: "Medium" }], defaultEffort: "medium", secretMapping: "do-not-project" } }] },
  { id: "beta", name: "B", models: [{ id: "family/model", name: "Shared", apiKey: "do-not-project" }] },
] };

it("keeps exact provider/model identities and never conflates off with default or invents model effort", () => {
  expect(parseDeepSeekModelCatalog(catalog)).toEqual({ status: "ready", defaultModel: "alpha/family/model", defaultEffort: "medium", models: [
    { id: "alpha/family/model", label: "Shared", provider: "alpha", modelId: "family/model", efforts: ["", "off", "medium"] },
    { id: "beta/family/model", label: "Shared", provider: "beta", modelId: "family/model", efforts: [""] },
  ] });
  for (const [provider, modelId] of [["provider/route", "family/model"], ["route%2F", "model%name"], ["native provider", "model with space"], ["provider", "model/😀"]]) {
    expect(decodeDeepSeekModel(encodeDeepSeekModel(provider!, modelId!))).toEqual({ provider, modelId });
  }
  expect(findDeepSeekModel([{ id: encodeDeepSeekModel("legacy", "model%2Fraw"), provider: "legacy", modelId: "model%2Fraw" }], "legacy/model%2Fraw")?.provider).toBe("legacy");
  expect(decodeDeepSeekModel("legacy/model%2Fraw")).toEqual({ provider: "legacy", modelId: "model%2Fraw" });
});

it("distinguishes no models from provider failure and omits failure details", () => {
  expect(parseDeepSeekModelCatalog({ ...catalog, groups: [], routableProviders: [] }).status).toBe("no-models");
  const failed = parseDeepSeekModelCatalog({ ...catalog, failures: [{ id: "other", name: "Other", message: "private credential/path" }] });
  expect(failed.status).toBe("unavailable"); expect(failed.models).toHaveLength(2);
  expect(JSON.stringify(failed)).not.toMatch(/credential|path|secretMapping|apiKey/);
  expect(parseDeepSeekModelCatalog({ groups: [] }).status).toBe("unavailable");
});

it("queries only the public catalog using the selected executable and a private copy, coalescing concurrent reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-dsh-models-")); dirs.push(root);
  const shared = path.join(root, "shared"), profile = path.join(shared, "profiles", "web"), workspace = path.join(root, "workspace");
  await mkdir(profile, { recursive: true }); await mkdir(workspace);
  const patch = path.join(profile, "cordis.patch.yml"), credentials = path.join(shared, ".credentials.yaml"), source = path.join(root, "catalog.json"), trace = path.join(root, "trace.jsonl");
  await writeFile(patch, "shared profile\n"); await writeFile(credentials, "shared credentials\n"); await writeFile(source, JSON.stringify(catalog));
  const env = { ...process.env, TAROBOT_MODEL_DISCOVERY: "1", DSH_EXECUTABLE: path.resolve("tests/fixtures/deepseek-models.mjs"), DSH_HOME: shared, DSH_FIXTURE_CATALOG: source, DSH_FIXTURE_TRACE: trace };
  const [first, second] = await Promise.all([readModelCatalog("deepseek", env, workspace), readModelCatalog("deepseek", env, workspace)]);
  expect(first).toEqual(second); expect(first.status).toBe("ready");
  expect(first.choices[0]).toMatchObject({ id: "", label: "alpha / Shared", provider: "alpha", modelId: "family/model", efforts: ["", "off", "medium"] });
  const events = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(events.filter(event => event.kind === "start")).toHaveLength(1);
  expect(events.filter(event => event.kind === "request").map(event => event.method)).toEqual(["session/modelCatalog"]);
  expect(events[0].home).not.toBe(shared); expect(events[0].cwd).toBe(workspace);
  expect(await readFile(patch, "utf8")).toBe("shared profile\n"); expect(await readFile(credentials, "utf8")).toBe("shared credentials\n");
  expect(await discoverDeepSeekModels({ ...env, DSH_EXECUTABLE: path.join(root, "missing") }, workspace)).toEqual({ status: "unavailable", models: [] });
});

it('bounds native startup and closes the temporary child/home without a fallback mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-catalog-timeout-')); dirs.push(root);
  const trace = path.join(root, 'trace.jsonl');
  const result = await discoverDeepSeekModels({ ...process.env, TAROBOT_MODEL_DISCOVERY: '1', DSH_EXECUTABLE: path.resolve('tests/fixtures/deepseek-models.mjs'), DSH_HOME: path.join(root, 'shared'), DSH_FIXTURE_STARTUP: 'hang', DSH_FIXTURE_TRACE: trace }, root);
  expect(result).toEqual({ status: 'unavailable', models: [] });
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(events).toHaveLength(1);
  await expect.poll(() => { try { process.kill(events[0].pid, 0); return true; } catch { return false; } }, { timeout: 1500 }).toBe(false);
  await expect.poll(async () => await readFile(path.join(events[0].home, '.credentials.yaml')).then(() => true, () => false), { timeout: 1500 }).toBe(false);
}, 12_000);

// Explicit reloads after a failed read: wait (bounded) for the old child and private home, then read again.
async function rereadFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-catalog-reread-")); dirs.push(root);
  const shared = path.join(root, "shared"), workspace = path.join(root, "workspace"), source = path.join(root, "catalog.json"), trace = path.join(root, "trace.jsonl"), mode = path.join(root, "mode");
  await mkdir(path.join(shared, "profiles", "web"), { recursive: true }); await mkdir(workspace);
  await writeFile(source, JSON.stringify(catalog)); await writeFile(mode, "");
  const env = { ...process.env, TAROBOT_MODEL_DISCOVERY: "1", DSH_EXECUTABLE: path.resolve("tests/fixtures/deepseek-models.mjs"), DSH_HOME: shared, DSH_FIXTURE_CATALOG: source, DSH_FIXTURE_TRACE: trace, DSH_FIXTURE_MODE_FILE: mode };
  const starts = async () => (await readFile(trace, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === "start");
  return { env, workspace, setMode: (value: string) => writeFile(mode, value), starts, read: (fresh = false, timing = {}) => discoverDeepSeekModels(env, workspace, fresh, timing) };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

it.each([false, true])("a reload right after a timed-out read really reads again once the old child is reclaimed (refresh=%s)", async fresh => {
  const f = await rereadFixture();
  await f.setMode("hang");
  expect(await f.read(false, { deadlineMs: 300 })).toEqual({ status: "unavailable", models: [] });
  await f.setMode("");
  // Immediately, while the timed-out child may still be stopping: no reuse of the failure, no overlap.
  expect((await f.read(fresh)).status).toBe("ready");
  const [first, second] = await f.starts();
  expect(second).toBeDefined(); expect(second.earlierHomesPresent).toBe(0); expect(alive(first.pid)).toBe(false);
}, 15_000);

it("concurrent reloads after a failure join one new read", async () => {
  const f = await rereadFixture();
  await f.setMode("hang"); await f.read(false, { deadlineMs: 300 }); await f.setMode("delay-200");
  const results = await Promise.all([f.read(), f.read(true), f.read()]);
  expect(results.map(result => result.status)).toEqual(["ready", "ready", "ready"]);
  expect(await f.starts()).toHaveLength(2);
}, 15_000);

it("an explicit refresh joins an unanswered read instead of starting a second child", async () => {
  const f = await rereadFixture(); await f.setMode("delay-300");
  const [passive, refresh] = await Promise.all([f.read(), new Promise(resolve => setTimeout(resolve, 50)).then(() => f.read(true))]);
  expect(passive.status).toBe("ready"); expect(refresh).toEqual(passive); expect(await f.starts()).toHaveLength(1);
  // A ready answer is reused by passive reads, never by an explicit refresh.
  await f.read(); expect(await f.starts()).toHaveLength(1);
  await f.read(true); expect(await f.starts()).toHaveLength(2);
}, 15_000);

it("does not start another child while the old one is still exiting past the bounded wait", async () => {
  const f = await rereadFixture();
  await f.setMode("hang slow-exit"); await f.read(false, { deadlineMs: 300 }); await f.setMode("");
  // The old child ignores SIGTERM until the kill grace ends; a 20 ms wait cannot see it reclaimed.
  expect(await f.read(true, { reclaimWaitMs: 20 })).toEqual({ status: "unavailable", models: [] });
  expect(await f.starts()).toHaveLength(1);
  await expect.poll(async () => (await f.read(true)).status, { timeout: 8000 }).toBe("ready");
  const starts = await f.starts();
  expect(starts).toHaveLength(2); expect(starts[1].earlierHomesPresent).toBe(0);
}, 20_000);

it("gives an explicit refresh, and a reload after a failure, the longer startup budget", async () => {
  const f = await rereadFixture(); await f.setMode("delay-700");
  const timing = { deadlineMs: 300, refreshDeadlineMs: 4000 };
  expect((await f.read(false, timing)).status).toBe("unavailable");
  expect((await f.read(false, timing)).status).toBe("ready");
  resetDeepSeekModelDiscoveryForTest();
  expect((await f.read(true, timing)).status).toBe("ready");
}, 20_000);

it("keeps the Hub's model/effort RPC budget above the explicit DeepSeek refresh budget", async () => {
  const { DEEPSEEK_CATALOG_REFRESH_DEADLINE_MS } = await import("../src/runtime/deepseek-model-discovery.js");
  const { BOT_MODEL_SETTINGS_RPC_TIMEOUT_MS } = await import("../src/hub/server.js");
  expect(BOT_MODEL_SETTINGS_RPC_TIMEOUT_MS - DEEPSEEK_CATALOG_REFRESH_DEADLINE_MS).toBeGreaterThanOrEqual(2000);
});
