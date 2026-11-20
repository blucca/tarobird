import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DeepSeekHarnessAdapter, type DeepSeekHarnessGateway } from '../src/codex/deepseek-harness-adapter.js';
import { encodeDeepSeekModel } from '../src/codex/deepseek-models.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(config: Record<string, unknown> = { model: 'a/org/model', effort: 'off' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-native-model-')); roots.push(root);
  const configPath = path.join(root, 'config.json');
  const save = (next: Record<string, unknown>) => writeFile(configPath, JSON.stringify({ engine: 'deepseek', ...next }));
  await save(config);
  const baseline = { provider: 'a', model: 'org/model' };
  const state = { current: { ...baseline } as Record<string, string>, groups: [{ id: 'a', models: [{ id: 'org/model', reasoning: { efforts: [{ id: 'off' }, { id: 'medium' }] } }] }] as any[], failures: [] as unknown[], wrongAck: false };
  const request = vi.fn(async (method: string, payload: any) => {
    if (method === 'commands/execute') return { result: { kind: 'success' } };
    if (method === 'settings.describe') return { namespaces: [{ ns: 'agent-default-model', value: baseline }] };
    if (method === 'session.models') return { current: state.current, groups: state.groups, failures: state.failures, routable: true };
    if (method === 'session.selectModel') { const { sessionId, ...selection } = payload; state.current = selection; return { selected: state.wrongAck ? { ...selection, provider: 'wrong' } : selection }; }
    throw Error('unexpected RPC');
  });
  const gateway: DeepSeekHarnessGateway = { request, connect: async () => {}, close: async () => {}, respond: async () => ({ accepted: true }), respondError: async () => ({ accepted: true }) };
  const adapter = new DeepSeekHarnessAdapter({ gateway, workspacePath: root, configPath });
  const configure = () => (adapter as any).configureSession('source') as Promise<void>;
  return { root, save, state, request, configure };
}

it('revalidates an unchanged setting against the current native model inventory before every prompt boundary', async () => {
  const f = await fixture(); await f.configure(); f.state.groups = [];
  await expect(f.configure()).rejects.toThrow('model_unavailable');
});
it('rejects unsupported model effort and partial provider failure without selecting', async () => {
  const f = await fixture({ model: 'a/org/model', effort: 'high' });
  await expect(f.configure()).rejects.toThrow('effort_incompatible');
  expect(f.request.mock.calls.some(([method]) => method === 'session.selectModel')).toBe(false);
  await f.save({ model: 'a/org/model', effort: 'off' }); f.state.failures = [{ message: 'private failure' }];
  await expect(f.configure()).rejects.toThrow('model_catalog_unavailable');
});
it('requires native selection acknowledgement to match exact provider, model and effort', async () => {
  const f = await fixture(); f.state.wrongAck = true;
  await expect(f.configure()).rejects.toThrow('selection_unconfirmed');
});
it('clears explicit off when restoring a model with no explicit native default effort', async () => {
  const f = await fixture(); await f.configure(); await f.save({ model: 'a/org/model' }); await f.configure();
  expect(f.request.mock.calls.filter(([method]) => method === 'session.selectModel').at(-1)?.[1]).toEqual({ sessionId: 'source', provider: 'a', model: 'org/model' });
});
it('decodes exceptional full identities once and never falls back to another provider', async () => {
  const f = await fixture({ model: encodeDeepSeekModel('a/team', 'org/model %'), effort: 'medium' });
  f.state.groups = [{ id: 'a/team', models: [{ id: 'org/model %', reasoning: { efforts: [{ id: 'medium' }] } }] }];
  await f.configure();
  expect(f.state.current).toEqual({ provider: 'a/team', model: 'org/model %', reasoningEffort: 'medium' });
  await f.save({ model: 'removed/org/model' });
  await expect(f.configure()).rejects.toThrow('model_unavailable');
});
it('refuses an ambiguous legacy bare model instead of choosing the current provider', async () => {
  const f = await fixture({ model: 'shared' });
  f.state.groups = ['a', 'b'].map(id => ({ id, models: [{ id: 'shared' }] }));
  await expect(f.configure()).rejects.toThrow('model_unavailable');
});

it('applies a changed override even while the native read projection still shows the previous default', async () => {
  const f = await fixture(); await f.configure();
  // The real remote follow may deliver model/selection after the selectModel
  // HTTP acknowledgement. Its old default must not suppress the next write.
  f.state.current = { provider: 'a', model: 'org/model' };
  await f.save({ model: 'a/org/model' });
  await f.configure();
  expect(f.request.mock.calls.filter(([method]) => method === 'session.selectModel')).toHaveLength(2);
  expect(f.request.mock.calls.filter(([method]) => method === 'session.selectModel').at(-1)?.[1]).toEqual({ sessionId: 'source', provider: 'a', model: 'org/model' });
});
