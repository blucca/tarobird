// ACCEPTANCE-ONLY (Windows /P language). Never merge into main.
// Compiles probe.nsi with the product's installer-language.nsh (candidate) and
// with cfbf8f0's two language lines (baseline), runs both on a disposable
// GitHub-hosted Windows runner and checks: /P (also the updater's
// `/P /UPDATE /R`) and a /P uninstall never stop at "Installer Language";
// interactive runs still ask when nothing is saved; a saved language is reused.
// It writes only a lab HKCU key (never Software\tarocub) and lab folders, and
// removes the key at the end.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  'confirm-disposable-windows': { type: 'boolean' }, report: { type: 'string' }, baseline: { type: 'string' }, product: { type: 'string' },
} });
const refuse = reason => { console.error(`Refusing: ${reason}`); process.exit(3); };
if (process.platform !== 'win32') refuse('Windows only');
if (process.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable' || !options['confirm-disposable-windows']) refuse('set TAROBOT_WINDOWS_ACCEPTANCE=disposable and pass --confirm-disposable-windows');
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') refuse('only on a disposable GitHub-hosted runner');
if (!options.report?.includes('.noindex')) refuse('--report must lie under a .noindex folder');
if (!/^[0-9a-f]{40}$/.test(options.baseline ?? '') || !/^[0-9a-f]{40}$/.test(options.product ?? '')) refuse('--baseline and --product need full commit SHAs');

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const template = path.join(repo, 'client', 'windows-electron');
const probeSource = fileURLToPath(new URL('./probe.nsi', import.meta.url));
const LAB_KEY = 'Software\\TaroBirdLanguageProbe';
const REG_KEY = `HKCU\\${LAB_KEY}`, PRODUCT_KEY = 'HKCU\\Software\\tarocub\\TaroBot', VALUE = 'Installer Language';
const lab = path.resolve(options.report);
await fs.mkdir(lab, { recursive: true });
if (/\s/.test(lab)) refuse('the lab folder must not contain spaces (NSIS /D= and _?=)');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const record = (name, detail) => { results.push({ name, ok: null, detail: String(detail) }); console.log(`INFO ${name} — ${detail}`); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reg = (...args) => spawnSync('reg', args, { encoding: 'utf8' });
const keyExists = key => reg('query', key).status === 0;
const saved = () => { const out = reg('query', REG_KEY, '/v', VALUE); return out.status === 0 ? (out.stdout.match(/Installer Language\s+REG_SZ\s+(.*)$/m)?.[1]?.trim() ?? '') : null; };
const setSaved = value => {
  if (value === null) { if (keyExists(REG_KEY)) reg('delete', REG_KEY, '/v', VALUE, '/f'); }
  else if (reg('add', REG_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', value, '/f').status !== 0) throw new Error('reg add failed');
  if (saved() !== value) throw new Error(`lab language is ${saved()}, wanted ${value}`);
};
const pwsh = script => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).stdout.trim();
const windowTitle = pid => pwsh(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`);

if (keyExists(REG_KEY)) refuse(`${REG_KEY} already exists: not a fresh runner`);
const productKeyBefore = keyExists(PRODUCT_KEY);
record('product key before (never written by this probe)', `${PRODUCT_KEY}: ${productKeyBefore ? 'present' : 'absent'}`);

// --- Source binding.
const blob = 'client/windows-electron/installer-language.nsh';
check('candidate installer-language.nsh is the product commit\'s', git('rev-parse', `HEAD:${blob}`) === git('rev-parse', `${options.product}:${blob}`), git('rev-parse', `HEAD:${blob}`));
check('product commit is an ancestor of the tested HEAD', spawnSync('git', ['merge-base', '--is-ancestor', options.product, 'HEAD'], { cwd: repo }).status === 0);
const fn = (source, name) => { const body = source.replace(/\r\n/g, '\n'); const from = body.indexOf(`Function ${name}\n`); return body.slice(from, body.indexOf('FunctionEnd', from)); };
const productNsi = git('show', `${options.product}:client/windows-electron/installer.nsi`), baseNsi = git('show', `${options.baseline}:client/windows-electron/installer.nsi`);
for (const name of ['.onInit', 'un.onInit']) {
  const body = fn(productNsi, name);
  check(`product ${name} reads /P, then BirdChooseLanguage, and has no other language dialog`, body.indexOf('"/P" $PassiveMode') >= 0 && body.indexOf('!insertmacro BirdChooseLanguage') > body.indexOf('"/P" $PassiveMode') && !/MUI_LANGDLL_DISPLAY|MUI_UNGETLANGUAGE/.test(body));
}
const baseInit = fn(baseNsi, '.onInit'), baseUnInit = fn(baseNsi, 'un.onInit');
check('baseline control mirrors cfbf8f0: .onInit always runs MUI_LANGDLL_DISPLAY', /\n    !insertmacro MUI_LANGDLL_DISPLAY\n/.test(baseInit) && !baseInit.includes('PassiveMode = 1'));
check('baseline control mirrors cfbf8f0: un.onInit runs MUI_UNGETLANGUAGE before reading /P', baseUnInit.indexOf('!insertmacro MUI_UNGETLANGUAGE') >= 0 && baseUnInit.indexOf('!insertmacro MUI_UNGETLANGUAGE') < baseUnInit.indexOf('"/P" $PassiveMode'));

// --- Which language NSIS picks before .onInit (NSIS docs 4.10.1): exact, then primary, then first.
const ui = Number(pwsh(`Add-Type -Namespace Probe -Name Lang -MemberDefinition '[DllImport("kernel32.dll")] public static extern ushort GetUserDefaultUILanguage();'; [Probe.Lang]::GetUserDefaultUILanguage()`));
const languages = { 2052: 'zh', 1033: 'en' };
const system = languages[ui] ? String(ui) : ({ 4: '2052', 9: '1033' })[ui & 0x3ff] ?? null;
record('Windows display language (GetUserDefaultUILanguage)', `${ui}; NSIS match ${system ?? 'none (first language)'}`);

function compile(out, extra = []) {
  const result = spawnSync('makensis', ['-V2', '-INPUTCHARSET', 'UTF8', `-DTEMPLATE=${template}`, `-DOUT=${out}`, `-DKEY=${LAB_KEY}`, ...extra, probeSource], { encoding: 'utf8' });
  check(`compile ${path.basename(out)}`, result.status === 0 && !/warning/i.test(result.stdout + result.stderr), (result.stdout + result.stderr).trim().split('\n').slice(-2).join(' | '));
  return out;
}
record('makensis', execFileSync('makensis', ['-VERSION'], { encoding: 'utf8' }).trim());
const exe = { candidate: compile(path.join(lab, 'probe-candidate.exe')), baseline: compile(path.join(lab, 'probe-baseline.exe'), ['-DBASELINE']) };

let labCount = 0;
const freshDir = async name => { const dir = path.join(lab, `${String(++labCount).padStart(2, '0')}-${name}`); await fs.mkdir(dir, { recursive: true }); return dir; };
const language = file => existsSync(file) ? readFileSync(file).toString('utf16le').replace(/^﻿/, '').trim() : '';

// Runs one setup. Stops waiting once it exits, or once the language dialog is
// up (then it is closed), or after the limit; a run still open is killed.
async function runSetup(file, tail, limit = 25000) {
  const started = Date.now();
  const child = spawn(file, [tail], { windowsVerbatimArguments: true, stdio: 'ignore' });
  let status, title = '';
  child.on('exit', code => { status = code; });
  while (status === undefined && Date.now() - started < limit) {
    await sleep(500);
    if (status === undefined && Date.now() - started > 1500) {
      title = windowTitle(child.pid) || title;
      if (title === 'Installer Language') break;
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (status !== undefined) return { exited: true, status, seconds, title };
  title = windowTitle(child.pid) || title;
  child.kill();
  for (let i = 0; i < 20 && status === undefined; i++) await sleep(250);
  return { exited: false, status: null, seconds, title };
}
const describe = r => r.exited ? `exit ${r.status} in ${r.seconds} s` : `still open after ${r.seconds} s, window "${r.title}", closed by the probe`;

async function makeUninstaller(variant) {
  const dir = await freshDir(`${variant}-uninstaller`);
  setSaved(null);
  const r = await runSetup(exe[variant], `/S /MAKEUN /D=${dir}`);
  check(`${variant}: silent install writes the probe uninstaller`, r.exited && r.status === 0 && existsSync(path.join(dir, 'probe-uninstall.exe')), describe(r));
  return dir;
}
const uninstallers = { candidate: await makeUninstaller('candidate'), baseline: await makeUninstaller('baseline') };

// expect: 'finish' (exit 0, recorded language) or 'dialog' (language dialog shown).
async function scenario(variant, label, { kind, flags, savedValue, expect, language: wanted, keepSaved }) {
  const dir = kind === 'install' ? await freshDir(`${variant}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`) : uninstallers[variant];
  if (kind === 'uninstall') await fs.rm(path.join(dir, 'uninstall-language.txt'), { force: true });
  setSaved(savedValue);
  const file = kind === 'install' ? exe[variant] : path.join(dir, 'probe-uninstall.exe');
  const tail = `${flags}${flags ? ' ' : ''}${kind === 'install' ? `/D=${dir}` : `_?=${dir}`}`;
  const r = await runSetup(file, tail);
  const used = language(path.join(dir, kind === 'install' ? 'install-language.txt' : 'uninstall-language.txt'));
  const name = `${variant}: ${kind} ${flags || '(interactive)'} with ${savedValue === null ? 'no saved language' : `saved "${savedValue}"`}`;
  if (expect === 'dialog') {
    check(`${name} — asks for the language`, !r.exited && r.title === 'Installer Language', describe(r));
  } else if (expect === 'blocked') {
    check(`${name} — stops at the language dialog (bug reproduced)`, !r.exited && r.title === 'Installer Language', describe(r));
  } else {
    const id = used.split(' ')[0];
    check(`${name} — finishes without a dialog in ${wanted}`, r.exited && r.status === 0 && id === wanted && used.split(' ')[1] === languages[wanted], `${describe(r)}; used "${used}"`);
  }
  const after = saved();
  if (keepSaved) check(`${name} — saved language left as is`, after === savedValue, `after: ${after}`);
  else record(`${name} — saved language after`, after === null ? 'none' : `"${after}"`);
  return r;
}

const sys = system ?? '2052';
// Negative control: cfbf8f0's language lines.
await scenario('baseline', 'passive', { kind: 'install', flags: '/P', savedValue: null, expect: 'blocked' });
await scenario('baseline', 'updater', { kind: 'install', flags: '/P /UPDATE /R', savedValue: null, expect: 'blocked' });
await scenario('baseline', 'passive-un', { kind: 'uninstall', flags: '/P', savedValue: null, expect: 'blocked' });
await scenario('baseline', 'passive-saved', { kind: 'install', flags: '/P', savedValue: '2052', expect: 'finish', language: '2052' });

// Candidate: /P never asks, picks a valid saved or the system language.
await scenario('candidate', 'passive', { kind: 'install', flags: '/P', savedValue: null, expect: 'finish', language: sys });
await scenario('candidate', 'updater', { kind: 'install', flags: '/P /UPDATE /R', savedValue: null, expect: 'finish', language: sys });
await scenario('candidate', 'passive-zh', { kind: 'install', flags: '/P', savedValue: '2052', expect: 'finish', language: '2052', keepSaved: true });
await scenario('candidate', 'passive-en', { kind: 'install', flags: '/P', savedValue: '1033', expect: 'finish', language: '1033', keepSaved: true });
await scenario('candidate', 'updater-zh', { kind: 'install', flags: '/P /UPDATE /R', savedValue: '2052', expect: 'finish', language: '2052', keepSaved: true });
await scenario('candidate', 'passive-unknown', { kind: 'install', flags: '/P', savedValue: '1041', expect: 'finish', language: sys });
await scenario('candidate', 'passive-garbage', { kind: 'install', flags: '/P', savedValue: 'x', expect: 'finish', language: sys });
await scenario('candidate', 'passive-un', { kind: 'uninstall', flags: '/P', savedValue: null, expect: 'finish', language: sys, keepSaved: true });
await scenario('candidate', 'passive-un-zh', { kind: 'uninstall', flags: '/P', savedValue: '2052', expect: 'finish', language: '2052', keepSaved: true });
await scenario('candidate', 'passive-un-unknown', { kind: 'uninstall', flags: '/P', savedValue: '1041', expect: 'finish', language: sys, keepSaved: true });
// Candidate: interactive and silent runs keep MUI's behaviour.
await scenario('candidate', 'gui', { kind: 'install', flags: '', savedValue: null, expect: 'dialog' });
await scenario('candidate', 'gui-zh', { kind: 'install', flags: '', savedValue: '2052', expect: 'finish', language: '2052' });
await scenario('candidate', 'gui-un', { kind: 'uninstall', flags: '', savedValue: null, expect: 'dialog' });
await scenario('candidate', 'gui-un-zh', { kind: 'uninstall', flags: '', savedValue: '2052', expect: 'finish', language: '2052', keepSaved: true });
await scenario('candidate', 'silent', { kind: 'install', flags: '/S', savedValue: null, expect: 'finish', language: sys });

// --- Cleanup: only the lab key; the product key is never touched.
reg('delete', REG_KEY, '/f');
check('lab key removed', !keyExists(REG_KEY));
check('product key unchanged', keyExists(PRODUCT_KEY) === productKeyBefore, `${PRODUCT_KEY}: ${keyExists(PRODUCT_KEY) ? 'present' : 'absent'}`);

const failed = results.filter(result => result.ok === false);
await fs.writeFile(path.join(lab, 'passive-language.json'), JSON.stringify({ product: options.product, baseline: options.baseline, head: git('rev-parse', 'HEAD'), image: process.env.ImageVersion, results }, null, 2));
console.log(`\n${results.filter(result => result.ok).length} passed, ${failed.length} failed, ${results.filter(result => result.ok === null).length} info`);
process.exit(failed.length ? 1 : 0);
