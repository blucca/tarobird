import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotManager } from '../src/hub/bot-manager.js';
import { HubServer } from '../src/hub/server.js';
import { discoverDeepSeekModels } from '../src/runtime/deepseek-model-discovery.js';
vi.mock('../src/runtime/deepseek-model-discovery.js', () => ({ discoverDeepSeekModels: vi.fn() }));
it('validates creation against fresh exact models and efforts with no registration on failed catalog', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-create-'));
  const hub = await HubServer.start({ stateDir: root });
  const manager = new BotManager(hub.store, root, { entrypoint: path.resolve('tests/fixtures/managed-bot-worker.mjs'), env: { ...process.env, DSH_EXECUTABLE: process.execPath } }, () => hub.instanceUrl, async () => {});
  vi.spyOn(manager as any, 'launch').mockImplementation(() => {});
  const catalog = { status: 'ready' as const, defaultModel: 'a/org/model', models: [{ id: 'a/org/model', provider: 'a', modelId: 'org/model', label: 'Shared', efforts: ['', 'off', 'medium'] as ('off'|'medium'|'')[] }, { id: 'b/org/model', provider: 'b', modelId: 'org/model', label: 'Shared', efforts: [''] as ''[] }] };
  const discovery = vi.mocked(discoverDeepSeekModels); discovery.mockResolvedValue(catalog);
  const spec = { requestId: 'deepseek_create', name: 'Fixture', engine: 'deepseek' as const, model: 'b/org/model', effort: 'off' as const, workspace: root };
  try {
    await expect(manager.create('owner', spec)).rejects.toThrow('bot_effort_incompatible');
    await expect(manager.create('owner', { ...spec, model: 'missing', effort: '' })).rejects.toThrow('model_unavailable');
    discovery.mockResolvedValue({ ...catalog, status: 'unavailable' });
    await expect(manager.create('owner', { ...spec, model: 'a/org/model' })).rejects.toThrow('model_catalog_unavailable');
    expect(await hub.store.bots('owner')).toHaveLength(0);
    discovery.mockResolvedValue(catalog);
    const result = await manager.create('owner', { ...spec, model: 'a/org/model' });
    expect(JSON.parse(await readFile(path.join(root, 'bots', result.id, 'config.json'), 'utf8'))).toMatchObject({ model: 'a/org/model', effort: 'off', workspacePath: root });
    expect(discovery.mock.calls.some(([, cwd, fresh]) => cwd === root && fresh === true)).toBe(true);
    discovery.mockResolvedValue({ status: 'unavailable', models: [] });
    expect((await manager.create('owner', { ...spec, model: 'a/org/model' })).id).toBe(result.id);
  } finally { await manager.close(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
