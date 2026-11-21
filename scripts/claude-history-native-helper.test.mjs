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
test('without an SDK summary the stored records stand in for it, still fenced by cwd and session', async () => {
  const stored = (records) => async (id, store, options) => {
    assert.equal(id, sessionId); assert.equal(options.dir, workspace); assert.equal(options.includeSubagents, false);
    await store.append({ projectKey: 'fixture', sessionId: id }, records);
  };
  const own = ids.map(uuid => ({ uuid, sessionId, cwd: workspace }));
  const { sdk, calls } = sdkFixture({ getSessionInfo: async () => { calls.push('info'); return undefined; }, importSessionToStore: stored(own) });
  const result = await handle(request(), sdk);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.messages.length, 2);
  const foreign = path.join(temporary, 'stored-other'); await mkdir(foreign, { recursive: true });
  for (const [records, code] of [[ids.map(uuid => ({ uuid, sessionId, cwd: foreign })), 'workspace_mismatch'], [[{ uuid: ids[0], sessionId: forkId, cwd: workspace }], 'session_unreadable'],
    [[{ uuid: ids[0], sessionId, cwd: workspace, isSidechain: true }], 'session_unreadable'], [[{ type: 'mode', sessionId }], 'session_unreadable'], [[], 'session_unreadable']]) {
    const fixture = sdkFixture({ getSessionInfo: async () => undefined, importSessionToStore: stored(records) });
    const refused = await handle(request('fork'), fixture.sdk); assert.equal(refused.error.code, code); assert.ok(!fixture.calls.includes('fork'));
  }
  let reads = 0;
  const changing = sdkFixture({ getSessionInfo: async () => undefined, importSessionToStore: async (id, store) => store.append({ projectKey: 'fixture', sessionId: id }, [...own, ...Array(reads++).fill({ type: 'cost-state', sessionId })]) });
  assert.equal((await handle(request('fork'), changing.sdk)).error.code, 'source_changed');
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
const guardSource = `import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);for(const m of ['node:http','node:https'])for(const k of ['request','get'])require(m)[k]=()=>{throw Error('network forbidden')};for(const k of ['connect','createConnection'])require('node:net')[k]=()=>{throw Error('network forbidden')};for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])require('node:child_process')[k]=()=>{throw Error('process forbidden')};globalThis.fetch=()=>{throw Error('network forbidden')};syncBuiltinESMExports();`;
/** A Claude profile with one project directory for `directory`, named as Claude Code names short paths. */
async function profile(name, directory) {
  const config = path.join(temporary, name);
  const project = path.join(config, 'projects', directory.replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(project, { recursive: true });
  return { config, project };
}
/** Runs the bundled helper the way the Gateway does: its own process, no network, no child processes. */
async function runBundled(config, value) {
  const guard = path.join(temporary, 'network-guard.mjs'); await writeFile(guard, guardSource);
  const child = spawn(process.execPath, ['--import', guard, output], { cwd: temporary, env: { PATH: path.dirname(process.execPath), CLAUDE_CONFIG_DIR: config, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const closed = once(child, 'close'); child.stdin.end(JSON.stringify(value)); const [code] = await closed;
  assert.equal(code, 0, stderr); assert.equal(stderr, ''); return JSON.parse(stdout);
}
test('bundled helper forks persistent native-format fixtures without model, network or optional CLI', async () => {
  const { config, project } = await profile('claude-profile', workspace);
  const source = path.join(project, `${sessionId}.jsonl`);
  const records = ids.map((uuid, i) => ({ uuid, parentUuid: i ? ids[i - 1] : null, type: i ? 'assistant' : 'user', isSidechain: false, sessionId, cwd: workspace, version: '2.1.329', timestamp: '2026-11-20T00:00:00.000Z', message: { role: i ? 'assistant' : 'user', content: i ? [{ type: 'text', text: 'Fixture reply' }] : 'Fixture prompt' } }));
  await writeFile(source, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const hash = async () => createHash('sha256').update(await readFile(source)).digest('hex'); const before = await hash();
  const run = value => runBundled(config, value);
  const original = await run(request()); assert.equal(original.ok, true);
  const fork = await run(request('fork', { expectedHead: original.head, upToMessageId: ids[0] })); assert.equal(fork.ok, true); assert.notEqual(fork.sessionId, sessionId);
  const reopened = await run(request('inspect', { sessionId: fork.sessionId })); assert.equal(reopened.ok, true); assert.equal(reopened.messages.length, 1);
  assert.notEqual(reopened.messages[0].uuid, ids[0]); assert.equal(await hash(), before);
  const whole = await run(request('fork', { expectedHead: original.head })); assert.equal(whole.ok, true);
  assert.equal((await run(request('inspect', { sessionId: whole.sessionId }))).messages.length, 2);
});
// tests/fixtures/claude-app-session.jsonl was recorded from Claude Code 2.1.330 in
// `-p --output-format stream-json` mode with a TaroBird-style instruction prefix on
// every prompt, then stripped to harmless fixture text. Every prompt begins with a
// tag, `last-prompt` records carry only `leafUuid`, and nothing sets a title, so the
// SDK's getSessionInfo finds no summary for it. App-created conversations look like this.
const appSessionId = '5f0c3a52-7d1e-4c55-9a61-2f8d6b0e9c11';
async function appSession(name) {
  const directory = path.join(temporary, `${name}-workspace`); await mkdir(directory, { recursive: true });
  const { config, project } = await profile(`${name}-profile`, directory);
  const text = (await readFile(path.join(root, 'tests/fixtures/claude-app-session.jsonl'), 'utf8')).replaceAll('__WORKSPACE__', directory);
  const file = path.join(project, `${appSessionId}.jsonl`); await writeFile(file, text);
  return { config, directory, file, run: value => runBundled(config, value) };
}
test('a session recorded the way TaroBird runs Claude can be inspected and forked although the SDK finds no summary for it', async () => {
  const session = await appSession('app-prompt');
  const ask = (operation = 'inspect', fields = {}) => ({ v: 1, operation, sessionId: appSessionId, workspace: session.directory, ...fields });
  const before = await readFile(session.file);
  const inspected = await session.run(ask());
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.deepEqual(inspected.messages.map(message => message.type), ['user', 'assistant', 'system', 'user', 'assistant']);
  assert.ok(!JSON.stringify(inspected).includes(session.directory)); assert.ok(!JSON.stringify(inspected).includes('fruit'));
  const anchored = await session.run(ask('fork', { expectedHead: inspected.head, upToMessageId: inspected.messages[1].uuid }));
  assert.equal(anchored.ok, true, JSON.stringify(anchored)); assert.notEqual(anchored.sessionId, appSessionId);
  const copy = await session.run(ask('inspect', { sessionId: anchored.sessionId }));
  assert.equal(copy.ok, true, JSON.stringify(copy)); assert.deepEqual(copy.messages.map(message => message.type), ['user', 'assistant']);
  const whole = await session.run(ask('fork', { expectedHead: inspected.head }));
  assert.equal(whole.ok, true, JSON.stringify(whole));
  assert.equal((await session.run(ask('inspect', { sessionId: whole.sessionId }))).messages.length, 5);
  assert.deepEqual(await readFile(session.file), before);
});
test('without an SDK summary the session is still fenced to its own workspace and session', async () => {
  const session = await appSession('app-fence');
  const foreign = path.join(temporary, 'app-fence-other'); await mkdir(foreign, { recursive: true });
  const moved = (await readFile(session.file, 'utf8')).replaceAll(session.directory, foreign);
  await writeFile(session.file, moved);
  const result = await session.run({ v: 1, operation: 'fork', sessionId: appSessionId, workspace: session.directory });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'workspace_mismatch');
  // A subagent transcript: its first record is a sidechain message.
  const lines = moved.replaceAll(foreign, session.directory).split('\n').filter(line => line && !line.includes('"type":"queue-operation"'));
  await writeFile(session.file, [lines[0].replace('"isSidechain":false', '"isSidechain":true'), ...lines.slice(1)].join('\n') + '\n');
  const sidechain = await session.run({ v: 1, operation: 'inspect', sessionId: appSessionId, workspace: session.directory });
  assert.equal(sidechain.ok, false); assert.equal(sidechain.error.code, 'session_unreadable');
});
test('bookkeeping records Claude appends on exit do not change the head; a new message does', async () => {
  for (const name of ['head-untitled', 'head-titled']) {
    const session = await appSession(name);
    if (name === 'head-titled') await writeFile(session.file, (await readFile(session.file, 'utf8')) + JSON.stringify({ type: 'custom-title', customTitle: 'Fixture title', sessionId: appSessionId }) + '\n');
    const ask = { v: 1, operation: 'inspect', sessionId: appSessionId, workspace: session.directory };
    const first = await session.run(ask); assert.equal(first.ok, true, JSON.stringify(first));
    // What a Claude process writes when it ends or resumes without a turn: no uuid, not on the message chain.
    const bookkeeping = [{ type: 'cost-state', sessionId: appSessionId, hasUnknownModelCost: false, totalCostUSD: 0 }, { type: 'last-prompt', sessionId: appSessionId, leafUuid: first.messages.at(-1).uuid }, { type: 'mode', sessionId: appSessionId, mode: 'normal' }];
    await writeFile(session.file, (await readFile(session.file, 'utf8')) + bookkeeping.map(value => JSON.stringify(value)).join('\n') + '\n');
    const later = await session.run(ask); assert.equal(later.ok, true); assert.equal(later.head, first.head, name);
    const parent = first.messages.at(-1).uuid, uuid = '7b4c1e2a-9d3f-4a6b-8c5d-0e1f2a3b4c5d';
    await writeFile(session.file, (await readFile(session.file, 'utf8')) + JSON.stringify({ type: 'user', uuid, parentUuid: parent, isSidechain: false, sessionId: appSessionId, cwd: session.directory, timestamp: '2026-11-21T09:00:00.000Z', message: { role: 'user', content: 'One more fixture question' } }) + '\n');
    const moved = await session.run(ask); assert.equal(moved.ok, true); assert.notEqual(moved.head, first.head, name);
  }
});
