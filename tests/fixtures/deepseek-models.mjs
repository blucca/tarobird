#!/usr/bin/env node
import http from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const trace = process.env.DSH_FIXTURE_TRACE;
// Mode can change between reads without changing the discovery cache key (env/config signatures).
const mode = process.env.DSH_FIXTURE_MODE_FILE && existsSync(process.env.DSH_FIXTURE_MODE_FILE) ? readFileSync(process.env.DSH_FIXTURE_MODE_FILE, 'utf8').trim() : process.env.DSH_FIXTURE_STARTUP ?? '';
// Records whether any earlier instance's private home still existed when this one started.
const earlier = trace && existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.kind === 'start') : [];
if (trace) appendFileSync(trace, JSON.stringify({ kind: 'start', args: process.argv.slice(2), home: process.env.DSH_HOME, cwd: process.cwd(), pid: process.pid, mode, earlierHomesPresent: earlier.filter(event => existsSync(event.home)).length }) + '\n');
if (mode.includes('slow-exit')) process.on('SIGTERM', () => {});
// Deliberately emulate a native boot/model-default write. The real shared
// profile and credential file must remain byte-identical through discovery.
writeFileSync(path.join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml'), 'private fixture boot\n');
writeFileSync(path.join(process.env.DSH_HOME, '.credentials.yaml'), 'private fixture credentials\n');
const server = http.createServer((request, response) => {
  let bytes = ''; request.on('data', chunk => bytes += chunk);
  request.on('end', () => {
    const frame = JSON.parse(bytes);
    if (trace) appendFileSync(trace, JSON.stringify({ kind: 'request', method: frame.method, payload: frame.payload }) + '\n');
    const result = frame.method === 'session/modelCatalog'
      ? { ok: true, value: JSON.parse(readFileSync(process.env.DSH_FIXTURE_CATALOG, 'utf8')) }
      : { ok: false, error: { code: 'unexpected_method', message: 'unexpected native mutation' } };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId: frame.rpcId, result }));
  });
});
const delay = Number(/delay-(\d+)/.exec(mode)?.[1] ?? 0);
server.listen(0, '127.0.0.1', () => { if (!mode.includes('hang')) setTimeout(() => process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\n`), delay); });
