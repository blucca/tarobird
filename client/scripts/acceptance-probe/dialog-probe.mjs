// Acceptance-only seconds-level pre-check (#50 extension D) on a disposable
// GitHub-hosted runner: reads the real BirdProblem dialog of a fixture built
// from the product's own .nsh files (makensis -INPUTCHARSET UTF8, as the product)
// with windows-dialog-text-driver.ps1, as UTF-16 code units, in English and
// Simplified Chinese; compares the setup note; shows what a default Windows
// PowerShell console pipe does to U+00B7 and U+2014. Installs nothing.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = path.win32;
const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('disposable GitHub-hosted runner only');
const out = (kind, data) => console.log(JSON.stringify({ kind, data }));
const units = hex => (hex ?? '').trim().split(/\s+/).filter(Boolean).map(u => parseInt(u, 16));
const show = list => list.map(u => `U+${u.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
const beforeTB = list => { for (let i = 3; i < list.length - 2; i++) if (list[i] === 0x54 && list[i + 1] === 0x42 && list[i + 2] === 0x2d) return list.slice(i - 3, i); return []; };
const run = (file, args, opts = {}) => new Promise(resolve => {
  const child = spawn(file, args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const chunks = []; child.stdout?.on('data', c => chunks.push(c));
  child.once('exit', code => resolve({ code, bytes: Buffer.concat(chunks) })); child.once('error', () => resolve({ code: -1, bytes: Buffer.alloc(0) }));
});

// The transport question: default (redirected) Windows PowerShell console output.
const t = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([string][char]0xB7 + [string][char]0x2014 + "|" + [Console]::OutputEncoding.WebName)'], { windowsHide: true });
const bar = t.bytes.indexOf(0x7c);
out('default-console-transport', { bytesForU00B7U2014: t.bytes.subarray(0, bar).toString('hex'), consoleEncoding: t.bytes.subarray(bar + 1).toString('latin1'), readAsUtf8: t.bytes.subarray(0, bar).toString('utf8') });

const notes = W.join(process.env.LOCALAPPDATA, 'TaroBird Setup Notes', 'setup-notes.txt');
for (const [label, args] of [['en', []], ['zh', ['/ZH']]]) {
  const outFile = W.join(process.env.RUNNER_TEMP, `dialog-${label}.json`);
  const driver = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, '..', 'windows-dialog-text-driver.ps1'), '-TimeoutSec', '90', '-OutFile', outFile], { windowsHide: true });
  const setup = await run(process.argv[2], args);
  await driver;
  let result; try { result = JSON.parse((await readFile(outFile, 'utf8')).replace(/^﻿/, '')); } catch (error) { result = { error: String(error) }; }
  const ev = kind => (result.events ?? []).find(e => e.kind === kind)?.detail;
  out(`${label}-driver`, { setupExit: setup.code, captured: result.captured, events: (result.events ?? []).map(e => e.kind), error: result.error });
  for (const source of ['uia', 'win32']) {
    const list = units(ev(`problem-${source}-hex`));
    out(`${label}-${source}`, { text: ev(`problem-${source}`), beforeTB: show(beforeTB(list)), separatorIsU00B7: beforeTB(list)[1] === 0xb7, hasU2014: list.includes(0x2014), hasUFFFD: list.includes(0xfffd), cjk: list.filter(u => u >= 0x4e00 && u <= 0x9fff).length, units: list.length });
  }
  if (existsSync(notes)) {
    const line = (await readFile(notes)).toString('utf16le').replaceAll('﻿', '').split(/\r?\n/).filter(Boolean).at(-1) ?? '';
    const list = [...line].map(ch => ch.codePointAt(0));
    out(`${label}-setup-note`, { line, beforeTB: show(beforeTB(list)), hasU00B7: list.includes(0xb7), hasUFFFD: list.includes(0xfffd) });
    await rm(notes, { force: true });
  } else out(`${label}-setup-note`, 'no setup notes written');
}
