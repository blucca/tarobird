#!/usr/bin/env node
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const trace = process.env.DSH_FIXTURE_TRACE;
if (trace) appendFileSync(trace, JSON.stringify({ kind: 'start', args: process.argv.slice(2), home: process.env.DSH_HOME, cwd: process.cwd(), pid: process.pid }) + '\n');
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
server.listen(0, '127.0.0.1', () => { if (process.env.DSH_FIXTURE_STARTUP !== 'hang') process.stdout.write(`dsh web: http://127.0.0.1:${server.address().port}/\n`); });
