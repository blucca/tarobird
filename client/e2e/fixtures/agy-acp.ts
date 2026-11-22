import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HubServer } from '../../../src/hub/server.js';
import { hashSecret } from '../../../src/hub/auth.js';
import { attachGateway } from '../../../src/gateway/service.js';
import { createCoreServiceRuntime } from '../../../src/core/runtime.js';
import { EngineSteeringRejectedError } from '../../../src/codex/adapter.js';

/** A real Hub/Gateway for an Antigravity Bot on the ACP runtime, with a
 * deterministic engine: steering, a background command and native commands. */
export async function agyAcpFixture(locale: 'zh' | 'en' = 'zh') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agy-acp-ui-'));
  const stateDir = path.join(root, 'bot'); await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'antigravity', antigravityRuntime: 'acp', approvalMode: 'normal', locale }));
  const hub = await HubServer.start({ stateDir: root, clientDir: path.resolve('dist') });
  // A neutral host name: screenshots must not show the machine's own name.
  await hub.profile.update({ name: 'example-host', revision: (await hub.profile.read()).revision });
  const secret = randomBytes(32).toString('base64url');
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Antigravity',?,'antigravity')", [hashSecret(secret)]);
  const turns: string[] = [], inputs: string[] = [], gates = new Map<number, () => void>();
  const options = { rejectSteer: false };
  let closing = false, running = false;
  const now = Date.now();
  const gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace('http', 'ws') + '/instance', secret, botId: 'bot', engine: 'antigravity', runtime: createCoreServiceRuntime(), bridge: {
    supportsSteering: () => true,
    inFlightSendBehavior: async () => 'steer',
    steerActiveTurn: async input => { if (options.rejectSteer) throw new EngineSteeringRejectedError('not_ready'); inputs.push(input.text); return true; },
    listTasks: async () => ({ supported: true, tasks: running ? [{ id: 'bg-build', label: 'npm run build -- --watch --mode production', kind: 'shell', mode: 'background', status: 'running', canStop: false, startedAt: now - 90_000, updatedAt: now, owner: 'bound' }] : [] }),
    advertisedCommands: () => [
      { name: 'grill-me', description: 'Interview me to align on a plan.' },
      { name: 'boost', description: 'Invoke the Boost multi-agent orchestrator for complex tasks.' },
      { name: 'teamwork', description: 'Invoke a team of agents to autonomously tackle large projects.' },
      { name: 'goal', description: 'Run until the specified goal is completely finished.' },
    ],
    handleAuthorizedMessage: async input => {
      const index = turns.push(input.text) - 1;
      if (closing) return { text: 'closing' };
      running = true;
      await input.onEngineEvent?.({ type: 'tool_use', toolName: 'run_command', toolInput: { CommandLine: 'npm run build -- --watch --mode production' }, toolUseId: 'call_bg' });
      await input.onEngineEvent?.({ type: 'assistant_text', text: locale === 'en' ? 'Checking the build.' : '正在检查构建。', delta: true });
      await new Promise<void>(resolve => { gates.set(index, resolve); input.abortSignal?.addEventListener('abort', resolve, { once: true }); });
      gates.delete(index); return { text: locale === 'en' ? 'This turn is complete.' : '本轮已完成。' };
    },
  } });
  const chats = [await hub.store.createConversation('owner', ['bot'], locale === 'en' ? 'AGY build check' : 'AGY 构建检查', 'first')];
  return { hub, chats, turns, inputs, options, finish: (index = 0) => gates.get(index)?.(), stopBackground: () => { running = false; },
    close: async () => { closing = true; for (const resolve of gates.values()) resolve(); await gateway.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); },
  };
}
