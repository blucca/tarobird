import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { modelEffortChoices, readModelCatalog } from "../src/runtime/model-catalog.js";
import { modelSettings } from "../src/runtime/model-settings.js";
import { getEngineEffortValidationError } from "../src/state/instance-config.js";

const directories: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it("uses exact DeepSeek model reasoning metadata, including explicit off and no reasoning", () => {
  const choices = [
    { id: "provider-a/namespace/model", efforts: ["", "off", "medium"] as const },
    { id: "provider-b/namespace/model", efforts: [""] as const },
  ].map(choice => ({ ...choice, efforts: [...choice.efforts] }));
  expect(modelEffortChoices("deepseek", choices[0]!.id, choices)).toEqual(["", "off", "medium"]);
  expect(modelEffortChoices("deepseek", choices[1]!.id, choices)).toEqual([""]);
  expect(modelEffortChoices("deepseek", "unlisted", choices)).toEqual([""]);
});

it("defers DeepSeek's known public effort names to exact native model validation without weakening other engines", () => {
  for (const effort of ["off", "medium"] as const) expect(getEngineEffortValidationError("deepseek", effort)).toBeUndefined();
  expect(getEngineEffortValidationError("kimi", "medium")).toBeDefined();
  expect(getEngineEffortValidationError("claude", "off")).toBeDefined();
});

it("distinguishes unavailable discovery from an empty configured DeepSeek catalog", async () => {
  expect(await readModelCatalog("deepseek", { TAROBOT_MODEL_DISCOVERY: "0" })).toEqual({ choices: [{ id: "", efforts: [""] }], status: "unavailable" });
});

it("keeps saved model and effort when catalog discovery fails, and refuses a replacement without writing", async () => {
  vi.stubEnv("TAROBOT_MODEL_DISCOVERY", "0");
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-deepseek-model-")); directories.push(root);
  const file = path.join(root, "config.json"), original = JSON.stringify({ engine: "deepseek", model: "provider-a/retained/model", effort: "high", workspacePath: root });
  await writeFile(file, original);
  const before = await modelSettings(root, "deepseek", 1);
  expect(before).toMatchObject({ ok: true, settings: { model: "provider-a/retained/model", effort: "high", catalogStatus: "unavailable" } });
  if (!before.ok) throw new Error(before.error);
  expect(await modelSettings(root, "deepseek", 1, { revision: before.settings.revision, model: "provider-b/unverified", effort: "" }))
    .toEqual({ ok: false, error: "model_catalog_unavailable" });
  expect(await readFile(file, "utf8")).toBe(original);
});

it('persists exact identities/off/default atomically and rejects a changed catalog before every write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-settings-native-')); directories.push(root);
  const source = path.join(root, 'catalog.json'), file = path.join(root, 'config.json');
  const raw = { default: { provider: 'a', model: 'org/model', reasoningEffort: 'medium' }, routableProviders: ['a', 'b'], failures: [] as unknown[], groups: [
    { id: 'a', models: [{ id: 'org/model', reasoning: { efforts: [{ id: 'off' }, { id: 'medium' }] } }] },
    { id: 'b', models: [{ id: 'org/model' }] },
  ] };
  await writeFile(source, JSON.stringify(raw));
  for (const [name, value] of Object.entries({ TAROBOT_MODEL_DISCOVERY: '1', DSH_EXECUTABLE: path.resolve('tests/fixtures/deepseek-models.mjs'), DSH_HOME: path.join(root, 'shared'), DSH_FIXTURE_CATALOG: source })) vi.stubEnv(name, value);
  await writeFile(file, JSON.stringify({ engine: 'deepseek', model: 'a/org/model', effort: 'medium', workspacePath: root, customField: 'keep' }));
  await writeFile(path.join(root, 'session.json'), 'keep session');
  const read = async () => { const result = await modelSettings(root, 'deepseek', 1); if (!result.ok) throw Error(result.error); return result.settings; };
  let before = await read();
  expect(before.catalogStatus).toBe('ready');
  expect(await modelSettings(root, 'deepseek', 1, { revision: before.revision, model: 'a/org/model', effort: 'off' })).toMatchObject({ ok: true, settings: { effort: 'off' } });
  before = await read(); let bytes = await readFile(file, 'utf8');
  expect(await modelSettings(root, 'deepseek', 1, { revision: before.revision, model: 'b/org/model', effort: 'off' })).toEqual({ ok: false, error: 'model_effort_incompatible' });
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect(await modelSettings(root, 'deepseek', 1, { revision: before.revision, model: '', effort: '' })).toMatchObject({ ok: true, settings: { model: '', effort: '' } });
  before = await read(); bytes = await readFile(file, 'utf8');
  raw.failures = [{ message: 'private native failure' }]; await writeFile(source, JSON.stringify(raw));
  expect(await modelSettings(root, 'deepseek', 1, { revision: before.revision, model: 'a/org/model', effort: 'off' })).toEqual({ ok: false, error: 'model_catalog_unavailable' });
  expect(await readFile(file, 'utf8')).toBe(bytes);
  raw.failures = []; raw.groups = [raw.groups[1]!]; await writeFile(source, JSON.stringify(raw));
  expect(await modelSettings(root, 'deepseek', 1, { revision: before.revision, model: 'a/org/model', effort: '' })).toEqual({ ok: false, error: 'model_unavailable' });
  expect(await readFile(file, 'utf8')).toBe(bytes);
  expect(await readFile(path.join(root, 'session.json'), 'utf8')).toBe('keep session');
});

it('shares model/effort CAS and preserves config/session through competing native-validated saves', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-cas-')); directories.push(root);
  const source = path.join(root, 'catalog.json'), file = path.join(root, 'config.json');
  await writeFile(source, JSON.stringify({ default: { provider: 'a', model: 'm' }, groups: [{ id: 'a', models: [{ id: 'm', reasoning: { efforts: [{ id: 'off' }, { id: 'medium' }] } }] }], routableProviders: ['a'], failures: [] }));
  for (const [name, value] of Object.entries({ TAROBOT_MODEL_DISCOVERY: '1', DSH_EXECUTABLE: path.resolve('tests/fixtures/deepseek-models.mjs'), DSH_HOME: path.join(root, 'shared'), DSH_FIXTURE_CATALOG: source })) vi.stubEnv(name, value);
  await writeFile(file, JSON.stringify({ engine: 'deepseek', model: 'a/m', workspacePath: root, bus: { secret: 'preserve' } }));
  const before = await modelSettings(root, 'deepseek', 0); if (!before.ok) throw Error(before.error);
  const { effortSettings } = await import('../src/runtime/effort-settings.js');
  const results = await Promise.all([
    modelSettings(root, 'deepseek', 0, { revision: before.settings.revision, model: 'a/m', effort: 'off' }),
    effortSettings(root, 'deepseek', 0, { revision: before.settings.revision, effort: 'medium' }),
  ]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok).map(result => result.error)).toEqual([expect.stringMatching(/^(model|effort)_conflict$/)]);
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ bus: { secret: 'preserve' } });
  const status = await effortSettings(root, 'deepseek', 0);
  expect(status).toMatchObject({ ok: true, settings: { catalogStatus: 'ready', choices: ['', 'off', 'medium'] } });
});
