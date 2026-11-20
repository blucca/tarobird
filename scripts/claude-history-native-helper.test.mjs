import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildClaudeHistoryHelper } from './build-claude-history-helper.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = '11111111-1111-4111-8111-111111111111';
const forkId = '22222222-2222-4222-8222-222222222222';
const ids = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
let temporary, workspace, output, handle, buildResult;
before(async () => {
  temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'claude-history-helper-')));
  workspace = path.join(temporary, 'workspace'); await mkdir(workspace);
  output = path.join(temporary, 'native-helper.mjs');
  buildResult = await buildClaudeHistoryHelper({ directory: root, output, notices: path.join(temporary, 'notices') });
  handle = (await import(pathToFileURL(output).href)).handleClaudeHistoryRequest;
});
after(async () => { await rm(temporary, { recursive: true, force: true }); });
function sdkFixture(overrides = {}) {
  const calls = [];
  return { calls, sdk: {
    async getSessionInfo() { calls.push('info'); return { sessionId, cwd: workspace, lastModified: 1, fileSize: 10, summary: 'Fixture' }; },
    async getSessionMessages(id, options) { calls.push('messages'); assert.equal(id, sessionId); assert.equal(options.limit, 10001); assert.equal(options.includeSystemMessages, true); return ids.map((uuid, i) => ({ uuid, session_id: sessionId, type: i ? 'assistant' : 'user', message: { content: 'private fixture text' } })); },
    async forkSession(id, options) { calls.push('fork'); assert.equal(id, sessionId); assert.equal(options.dir, workspace); return { sessionId: forkId }; },
    ...overrides,
  } };
}
const request = (operation = 'inspect', fields = {}) => ({ v: 1, operation, sessionId, workspace, ...fields });

test('bundles official SDK JavaScript without runtime packages or private builder paths', async () => {
  const text = await readFile(output, 'utf8');
  assert.ok(text.includes('claude-history-sdk:@anthropic-ai/claude-agent-sdk'));
  assert.ok(!text.includes(root)); assert.ok(!text.includes(temporary));
  assert.ok(Object.keys(buildResult.metafile.inputs).every(file => !/claude-agent-sdk-(darwin|linux|win32)/.test(file)));
  const license = await readFile(path.join(temporary, 'notices/LICENSE.md'), 'utf8');
  assert.match(license, /Anthropic/);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'], undefined);
  assert.equal(manifest.devDependencies['@anthropic-ai/claude-agent-sdk'], '0.3.329');
});
test('inspects the complete ordered native chain without returning text or paths', async () => {
  const { sdk } = sdkFixture(); const result = await handle(request(), sdk);
  assert.equal(result.ok, true); assert.match(result.head, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.messages, ids.map((uuid, i) => ({ uuid, type: i ? 'assistant' : 'user' })));
  assert.ok(!JSON.stringify(result).includes(workspace)); assert.ok(!JSON.stringify(result).includes('private fixture text'));
  assert.equal((await handle(request(), sdk)).head, result.head);
});
test('checks expected head and exact inclusive anchor before any write', async () => {
  const { sdk, calls } = sdkFixture(); const state = await handle(request(), sdk);
  assert.equal((await handle(request('fork', { expectedHead: '0'.repeat(64) }), sdk)).error.code, 'source_changed');
  assert.equal((await handle(request('fork', { upToMessageId: forkId }), sdk)).error.code, 'anchor_missing');
  assert.ok(!calls.includes('fork'));
  sdk.forkSession = async (id, options) => { calls.push('fork'); assert.equal(options.upToMessageId, ids[1]); return { sessionId: forkId }; };
  calls.length = 0;
  const result = await handle(request('fork', { expectedHead: state.head, upToMessageId: ids[1] }), sdk);
  assert.deepEqual(result, { v: 1, ok: true, sessionId: forkId });
  assert.deepEqual(calls, ['info', 'messages', 'info', 'fork']); // no read after the confirmed write
});
test('rejects sibling-worktree discovery, absent cwd and unreadable sources', async () => {
  const foreign = path.join(temporary, 'other-workspace'); await mkdir(foreign);
  for (const [info, code] of [[{ sessionId, cwd: foreign, lastModified: 1 }, 'workspace_mismatch'], [{ sessionId, lastModified: 1 }, 'session_unreadable'], [undefined, 'session_unreadable']]) {
    const { sdk, calls } = sdkFixture({ getSessionInfo: async () => info });
    const result = await handle(request('fork'), sdk); assert.equal(result.error.code, code); assert.ok(!calls.includes('fork'));
  }
});
test('refuses truncated, duplicate or foreign-session message histories', async () => {
  for (const [messages, code] of [[Array(10001).fill({}), 'history_too_large'], [ids.map(uuid => ({ uuid: ids[0], session_id: sessionId, type: 'user' })), 'session_unreadable'], [[{ uuid: ids[0], session_id: forkId, type: 'user' }], 'session_unreadable'], [[], 'session_unreadable']]) {
    const { sdk, calls } = sdkFixture({ getSessionMessages: async () => messages });
    assert.equal((await handle(request('fork'), sdk)).error.code, code); assert.ok(!calls.includes('fork'));
  }
});
test('fences a source changed while inspecting', async () => {
  let count = 0;
  const { sdk, calls } = sdkFixture({ getSessionInfo: async () => ({ sessionId, cwd: workspace, lastModified: ++count, summary: 'Fixture' }) });
  const result = await handle(request('fork'), sdk);
  assert.equal(result.error.code, 'source_changed'); assert.equal(result.phase, 'validate'); assert.ok(!calls.includes('fork'));
});
test('keeps ambiguous native write failures distinct and redacts SDK errors', async () => {
  const { sdk } = sdkFixture({ forkSession: async () => { throw new Error(`failed after writing ${workspace}/private-session`); } });
  const result = await handle(request('fork'), sdk);
  assert.equal(result.ok, false); assert.equal(result.phase, 'fork'); assert.equal(result.error.code, 'fork_unconfirmed');
  assert.ok(!JSON.stringify(result).includes(workspace));
});
test('rejects malformed requests without consulting native history', async () => {
  const { sdk, calls } = sdkFixture();
  for (const value of [null, request('fork', { workspace: '.' }), request('fork', { sessionId: '../other' }), request('inspect', { expectedHead: '0'.repeat(64) }), request('fork', { unexpected: true })]) assert.equal((await handle(value, sdk)).error.code, 'invalid_request');
  assert.equal(calls.length, 0);
});
test('bundled helper forks persistent native-format fixtures without model, network or optional CLI', async () => {
  const config = path.join(temporary, 'claude-profile');
  const project = path.join(config, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(project, { recursive: true });
  const source = path.join(project, `${sessionId}.jsonl`);
  const records = ids.map((uuid, i) => ({ uuid, parentUuid: i ? ids[i - 1] : null, type: i ? 'assistant' : 'user', isSidechain: false, sessionId, cwd: workspace, version: '2.1.329', timestamp: '2026-11-20T00:00:00.000Z', message: { role: i ? 'assistant' : 'user', content: i ? [{ type: 'text', text: 'Fixture reply' }] : 'Fixture prompt' } }));
  await writeFile(source, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const hash = async () => createHash('sha256').update(await readFile(source)).digest('hex'); const before = await hash();
  const guard = path.join(temporary, 'network-guard.mjs');
  await writeFile(guard, `import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);for(const m of ['node:http','node:https'])for(const k of ['request','get'])require(m)[k]=()=>{throw Error('network forbidden')};for(const k of ['connect','createConnection'])require('node:net')[k]=()=>{throw Error('network forbidden')};for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[k]=()=>{throw Error('process forbidden')};globalThis.fetch=()=>{throw Error('network forbidden')};syncBuiltinESMExports();`);
  async function run(value) {
    const child = spawn(process.execPath, ['--import', guard, output], { cwd: temporary, env: { PATH: path.dirname(process.execPath), CLAUDE_CONFIG_DIR: config, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const closed = once(child, 'close'); child.stdin.end(JSON.stringify(value)); const [code] = await closed;
    assert.equal(code, 0, stderr); assert.equal(stderr, ''); return JSON.parse(stdout);
  }
  const original = await run(request()); assert.equal(original.ok, true);
  const fork = await run(request('fork', { expectedHead: original.head, upToMessageId: ids[0] })); assert.equal(fork.ok, true); assert.notEqual(fork.sessionId, sessionId);
  const reopened = await run(request('inspect', { sessionId: fork.sessionId })); assert.equal(reopened.ok, true); assert.equal(reopened.messages.length, 1);
  assert.notEqual(reopened.messages[0].uuid, ids[0]); assert.equal(await hash(), before);
  const whole = await run(request('fork', { expectedHead: original.head })); assert.equal(whole.ok, true);
  assert.equal((await run(request('inspect', { sessionId: whole.sessionId }))).messages.length, 2);
});
