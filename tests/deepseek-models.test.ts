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
