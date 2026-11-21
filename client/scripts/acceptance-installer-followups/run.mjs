// ACCEPTANCE-ONLY (#50 installer follow-ups S3, S1, S2). Never merge into main.
// Builds a probe from each variant's own installer.nsi text up to `Var
// PassiveMode` plus probe-tail.nsi, runs it on a disposable GitHub-hosted
// Windows runner and checks:
//   S3  the setup note line ends with the real version (VERSION only from
//       installer.nsi's own define; this script never passes -DVERSION);
//   S1  /P never asks, picks the saved 2052/1033, else Chinese -> 2052 and
//       anything else -> 1033, and leaves the saved value as it found it;
//       the pick is also driven with language ids the runner cannot have;
//   S2  an Electron layout with a Tauri host\ left over and no helper is never
//       stopped through the Electron program (which exits 64).
// Variants: candidate (--product), --language-baseline (47450f7+8a86382) and
// --baseline (47450f7). Writes only a lab HKCU key, lab folders and this
// runner user's %LOCALAPPDATA%\TaroBird Setup Notes; removes the key and the
// notes folder at the end. `--compile-only` compiles the probes anywhere.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  'confirm-disposable-windows': { type: 'boolean' }, 'compile-only': { type: 'boolean' }, report: { type: 'string' },
  baseline: { type: 'string' }, 'language-baseline': { type: 'string' }, product: { type: 'string' }, makensis: { type: 'string' }, 'plugins-dir': { type: 'string' },
} });
const refuse = reason => { console.error(`Refusing: ${reason}`); process.exit(3); };
const compileOnly = Boolean(options['compile-only']);
if (!compileOnly) {
  if (process.platform !== 'win32') refuse('Windows only');
  if (process.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable' || !options['confirm-disposable-windows']) refuse('set TAROBOT_WINDOWS_ACCEPTANCE=disposable and pass --confirm-disposable-windows');
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') refuse('only on a disposable GitHub-hosted runner');
}
if (!options.report?.includes('.noindex')) refuse('--report must lie under a .noindex folder');
for (const key of ['baseline', 'language-baseline', 'product']) if (!/^[0-9a-f]{40}$/.test(options[key] ?? '')) refuse(`--${key} needs a full commit SHA`);

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
const makensis = options.makensis ?? 'makensis';
const LAB_KEY = 'Software\\TaroBirdFollowupsProbe';
const REG_KEY = `HKCU\\${LAB_KEY}`, PRODUCT_KEY = 'HKCU\\Software\\tarocub\\TaroBot', VALUE = 'Installer Language';
const lab = path.resolve(options.report);
await fs.mkdir(lab, { recursive: true });
if (/\s/.test(lab)) refuse('the lab folder must not contain spaces (NSIS /D= and _?=)');
const version = JSON.parse(readFileSync(path.join(repo, 'client', 'package.json'), 'utf8')).version;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const record = (name, detail) => { results.push({ name, ok: null, detail: String(detail) }); console.log(`INFO ${name} — ${detail}`); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const gitBytes = (...args) => execFileSync('git', args, { cwd: repo });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = async () => {
  const failed = results.filter(result => result.ok === false);
  await fs.writeFile(path.join(lab, 'installer-followups.json'), JSON.stringify({ product: options.product, baseline: options.baseline, languageBaseline: options['language-baseline'], head: git('rev-parse', 'HEAD'), image: process.env.ImageVersion, results }, null, 2));
  console.log(`\n${results.filter(result => result.ok).length} passed, ${failed.length} failed, ${results.filter(result => result.ok === null).length} info`);
  process.exit(failed.length ? 1 : 0);
};

// --- Source binding.
check('product commit is an ancestor of the tested HEAD', spawnSync('git', ['merge-base', '--is-ancestor', options.product, 'HEAD'], { cwd: repo }).status === 0);
for (const file of git('ls-tree', '--name-only', `${options.product}:client/windows-electron`).split('\n')) {
  check(`candidate ${file} is the product commit's`, git('rev-parse', `HEAD:client/windows-electron/${file}`) === git('rev-parse', `${options.product}:client/windows-electron/${file}`));
}
const nsiAt = sha => git('show', `${sha}:client/windows-electron/installer.nsi`).replace(/\r\n/g, '\n');
const languageAt = sha => spawnSync('git', ['show', `${sha}:client/windows-electron/installer-language.nsh`], { cwd: repo, encoding: 'utf8' }).stdout ?? '';
const fn = (source, name) => { const from = source.indexOf(`Function ${name}\n`); return source.slice(from, source.indexOf('FunctionEnd', from)); };
const productNsi = nsiAt(options.product), langBaseNsi = nsiAt(options['language-baseline']), baseNsi = nsiAt(options.baseline);
check('candidate mirrors product: .onInstSuccess keeps the saved language', /!insertmacro BirdKeepSavedLanguage/.test(fn(productNsi, '.onInstSuccess')) && languageAt(options.product).includes('!macro BirdPassiveLanguagePick'));
check('language baseline mirrors 8a86382: choose without pick or keep', /!insertmacro BirdChooseLanguage/.test(fn(langBaseNsi, '.onInit')) && !languageAt(options['language-baseline']).includes('BirdPassiveLanguagePick') && !langBaseNsi.includes('BirdKeepSavedLanguage'));
check('baseline mirrors 47450f7: MUI_LANGDLL_DISPLAY, MUI_UNGETLANGUAGE before /P', /!insertmacro MUI_LANGDLL_DISPLAY/.test(fn(baseNsi, '.onInit')) && fn(baseNsi, 'un.onInit').indexOf('MUI_UNGETLANGUAGE') < fn(baseNsi, 'un.onInit').indexOf('"/P"'));
for (const [label, nsi] of [['candidate', productNsi], ['baseline', baseNsi]]) {
  const prefix = nsi.slice(0, nsi.indexOf('\nVar PassiveMode\n'));
  record(`${label}: hooks include is ${prefix.indexOf('!include "installer-hooks.nsh"') > prefix.indexOf('!define VERSION "${TB_VERSION}"') ? 'after' : 'before'} the VERSION define`, `${prefix.split('\n').length} product lines precede the probe tail`);
}

// --- Stand-ins and plugin.
const marks = path.join(lab, 'marks');
await fs.mkdir(marks, { recursive: true });
let plugins = options['plugins-dir'];
if (!plugins) {
  plugins = path.join(lab, 'plugins');
  const fetched = spawnSync(process.execPath, [path.join(repo, 'client', 'scripts', 'windows-electron-installer.mjs'), 'setup-nsis', '--plugins-dir', plugins], { encoding: 'utf8' });
  check('pinned nsis_tauri_utils.dll fetched and checksum-verified (setup-nsis)', fetched.status === 0, (fetched.stdout + fetched.stderr).trim().split('\n').pop());
}
function compile(source, out, defines, cwd) {
  const result = spawnSync(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([key, value]) => `-D${key}=${value}`), source], { encoding: 'utf8', cwd, env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
  const log = result.stdout + result.stderr;
  return { ok: result.status === 0, log, unknown: (log.match(/unknown variable\/constant[^\n]*/g) ?? []) };
}
const fakes = {};
for (const [name, code] of [['app', 64], ['tauriapp', 0], ['helper', 0], ['helperinst', 0]]) {
  const out = path.join(lab, `fake-${name}.exe`);
  const r = compile(path.join(here, 'fake.nsi'), out, { OUT: out, MARKS: marks, NAME: name, CODE: code }, here);
  check(`compile stand-in ${name} (exit ${code})`, r.ok, r.log.trim().split('\n').slice(-1)[0]);
  fakes[name] = out;
}

// --- Probes from each variant's own templates.
const variants = { candidate: [options.product, 'keep'], 'language-baseline': [options['language-baseline'], 'choose'], baseline: [options.baseline, 'baseline'] };
const exe = {};
const tail = readFileSync(path.join(here, 'probe-tail.nsi'), 'utf8');
for (const [label, [sha, mode]] of Object.entries(variants)) {
  const dir = path.join(lab, `templates-${label}`);
  await fs.mkdir(dir, { recursive: true });
  for (const file of git('ls-tree', '--name-only', `${sha}:client/windows-electron`).split('\n')) await fs.writeFile(path.join(dir, file), gitBytes('show', `${sha}:client/windows-electron/${file}`));
  const nsi = nsiAt(sha);
  const at = nsi.indexOf('\nVar PassiveMode\n');
  if (at < 0) throw new Error(`${label}: no Var PassiveMode line`);
  await fs.writeFile(path.join(dir, 'probe.nsi'), `${nsi.slice(0, at + 1)}\n${tail}`);
  exe[label] = path.join(lab, `probe-${label}.exe`);
  const r = compile('probe.nsi', exe[label], {
    TB_VERSION: version, TB_MAIN_BINARY: 'unused', TB_HELPER: fakes.helper, TB_OUT_FILE: 'unused', TB_PLUGINS_DIR: plugins, TB_INSTALLER_ICON: '', TB_UNINSTALLER_SIGN: '', TB_ESTIMATED_SIZE: '1',
    PROBE_OUT: exe[label], PROBE_KEY: LAB_KEY, PROBE_LANG: mode,
  }, dir);
  check(`compile probe-${label} from ${sha.slice(0, 7)}'s installer.nsi (no -DVERSION)`, r.ok, r.ok ? `${r.unknown.length} unknown variable/constant warnings` : r.log.trim().split('\n').slice(-4).join(' | '));
  if (label === 'candidate') check('S3 candidate: makensis reports no unknown variable/constant', r.ok && r.unknown.length === 0, r.unknown.join(' | '));
  else record(`S3 ${label}: makensis unknown variable/constant warnings`, `${r.unknown.length}: ${[...new Set(r.unknown)].join(' | ')}`);
}
if (compileOnly) await finish();

// --- Windows state.
const reg = (...args) => spawnSync('reg', args, { encoding: 'utf8' });
const keyExists = key => reg('query', key).status === 0;
const saved = () => { const out = reg('query', REG_KEY, '/v', VALUE); return out.status === 0 ? (out.stdout.match(/Installer Language\s+REG_SZ\s?(.*)$/m)?.[1]?.trim() ?? '') : null; };
const setSaved = value => {
  if (value === null) { if (keyExists(REG_KEY)) reg('delete', REG_KEY, '/v', VALUE, '/f'); }
  else if (reg('add', REG_KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', value, '/f').status !== 0) throw new Error('reg add failed');
  if (saved() !== value) throw new Error(`lab language is ${saved()}, wanted ${value}`);
};
const pwsh = script => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).stdout.trim();
const windowTitle = pid => pwsh(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`);
const notesDir = path.join(process.env.LOCALAPPDATA, 'TaroBird Setup Notes'), notesFile = path.join(notesDir, 'setup-notes.txt');
const lastNote = () => existsSync(notesFile) ? readFileSync(notesFile).toString('utf16le').replace(/^﻿/, '').split('\r\n').filter(Boolean).pop() ?? '' : '';
if (keyExists(REG_KEY)) refuse(`${REG_KEY} already exists: not a fresh runner`);
if (existsSync(notesDir)) refuse('a TaroBird Setup Notes folder already exists: not a fresh runner');
const productKeyBefore = keyExists(PRODUCT_KEY);
record('product key before (never written by this probe)', `${PRODUCT_KEY}: ${productKeyBefore ? 'present' : 'absent'}`);
const ui = Number(pwsh(`Add-Type -Namespace Probe -Name Lang -MemberDefinition '[DllImport("kernel32.dll")] public static extern ushort GetUserDefaultUILanguage();'; [Probe.Lang]::GetUserDefaultUILanguage()`));
const expectFor = (id, savedValue = '') => ['2052', '1033'].includes(savedValue) ? savedValue : ((id & 0x3ff) === 4 ? '2052' : '1033');
const sys = expectFor(ui);
record('REAL layer: Windows display language (GetUserDefaultUILanguage via PowerShell)', `${ui}; expected /P language without a saved one: ${sys}`);

let labCount = 0;
const freshDir = async name => { const dir = path.join(lab, `${String(++labCount).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`); await fs.mkdir(dir, { recursive: true }); return dir; };
const text = file => existsSync(file) ? readFileSync(file).toString('utf16le').replace(/^﻿/, '').trim() : '';
const ran = name => existsSync(path.join(marks, `${name}.ran`)) ? readFileSync(path.join(marks, `${name}.ran`), 'utf8').trim() : '';
const clearMarks = async () => { for (const file of await fs.readdir(marks)) await fs.rm(path.join(marks, file), { force: true }); };

async function runSetup(file, tail, limit = 25000) {
  const started = Date.now();
  const child = spawn(file, [tail], { windowsVerbatimArguments: true, stdio: 'ignore' });
  let status, title = '';
  child.on('exit', code => { status = code; });
  while (status === undefined && Date.now() - started < limit) {
    await sleep(500);
    if (status === undefined && Date.now() - started > 1500) { title = windowTitle(child.pid) || title; if (title === 'Installer Language') break; }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  if (status !== undefined) return { exited: true, status, seconds, title };
  title = windowTitle(child.pid) || title;
  child.kill();
  for (let i = 0; i < 20 && status === undefined; i++) await sleep(250);
  return { exited: false, status: null, seconds, title };
}
const describe = r => r.exited ? `exit ${r.status} in ${r.seconds} s` : `still open after ${r.seconds} s, window "${r.title}", closed by the probe`;

// Stand-in self check: the Electron stand-in really exits 64.
{
  await clearMarks();
  const r = spawnSync(fakes.app, ['--stop-desktop-host'], { encoding: 'utf8' });
  check('stand-in for the Electron program exits 64 on --stop-desktop-host', r.status === 64 && ran('app').includes('--stop-desktop-host'), `exit ${r.status}`);
  await clearMarks();
}

const uninstallers = {};
for (const label of ['candidate', 'baseline', 'language-baseline']) {
  const dir = await freshDir(`${label}-makeun`);
  setSaved(null);
  const r = await runSetup(exe[label], `/S /CASE=makeun /D=${dir}`);
  check(`${label}: silent install writes the probe uninstaller`, r.exited && r.status === 0 && existsSync(path.join(dir, 'probe-uninstall.exe')), describe(r));
  uninstallers[label] = path.join(dir, 'probe-uninstall.exe');
}

// ===== S3: the note line carries the real version.
for (const label of ['candidate', 'language-baseline', 'baseline']) {
  const dir = await freshDir(`s3-${label}`);
  setSaved(null);
  const r = await runSetup(exe[label], `/S /D=${dir}`);
  const line = lastNote();
  if (label === 'candidate') check(`S3 ${label}: finished install note ends with "TaroBird ${version}"`, r.exited && r.status === 0 && line.endsWith(` · TaroBird ${version}`), `${describe(r)}; line "${line}"`);
  else check(`S3 ${label}: finished install note ends with the literal \${VERSION} (bug reproduced)`, r.exited && r.status === 0 && line.endsWith(' · TaroBird ${VERSION}'), `${describe(r)}; line "${line}"`);
}
{
  const dir = await freshDir('s3-candidate-uninstall');
  const r = await runSetup(uninstallers.candidate, `/S _?=${dir}`);
  const line = lastNote();
  check(`S3 candidate: finished uninstall note ends with "TaroBird ${version}"`, r.exited && r.status === 0 && line.endsWith(` · TaroBird ${version}`), `${describe(r)}; line "${line}"`);
}

// ===== S1 real layer: the runner's own display language.
async function language(label, name, { kind, flags, savedValue, expect, wanted, after, sequence = false }) {
  const dir = await freshDir(`s1-${label}-${name}`);
  // A sequence case runs on what the previous case left; it must be the stated state.
  if (sequence) { if (saved() !== savedValue) throw new Error(`${name}: saved language is ${saved()}, not ${savedValue}`); } else setSaved(savedValue);
  const file = kind === 'install' ? exe[label] : uninstallers[label];
  const r = await runSetup(file, `${flags}${flags ? ' ' : ''}${kind === 'install' ? `/D=${dir}` : `_?=${dir}`}`);
  const used = text(path.join(dir, kind === 'install' ? 'install-language.txt' : 'uninstall-language.txt'));
  const left = saved();
  const title = `S1 ${label}: ${kind} ${flags || '(interactive)'} with ${savedValue === null ? 'nothing saved' : `saved "${savedValue}"`}`;
  if (expect === 'dialog') check(`${title} — asks for the language`, !r.exited && r.title === 'Installer Language', describe(r));
  else if (expect === 'blocked') check(`${title} — stops at the language dialog (bug reproduced)`, !r.exited && r.title === 'Installer Language', describe(r));
  else check(`${title} — finishes without a dialog in ${wanted}`, r.exited && r.status === 0 && used.split(' ')[0] === wanted, `${describe(r)}; used "${used}"`);
  if (after !== undefined) check(`${title} — saved language afterwards ${after === null ? 'still absent' : `"${after}"`}`, left === after, `after: ${left === null ? 'absent' : `"${left}"`}`);
  else record(`${title} — saved language afterwards`, left === null ? 'absent' : `"${left}"`);
}
await language('baseline', 'passive', { kind: 'install', flags: '/P', savedValue: null, expect: 'blocked' });
// 8a86382: no dialog, but the unchosen language is saved and an unknown value overwritten.
await language('language-baseline', 'passive', { kind: 'install', flags: '/P', savedValue: null, expect: 'finish', wanted: sys, after: sys });
await language('language-baseline', 'passive-1041', { kind: 'install', flags: '/P', savedValue: '1041', expect: 'finish', wanted: sys, after: sys });
// Candidate.
await language('candidate', 'passive', { kind: 'install', flags: '/P', savedValue: null, expect: 'finish', wanted: sys, after: null });
await language('candidate', 'gui-after-passive', { kind: 'install', flags: '', savedValue: null, expect: 'dialog', after: null, sequence: true });
await language('candidate', 'updater', { kind: 'install', flags: '/P /UPDATE /R', savedValue: null, expect: 'finish', wanted: sys, after: null });
await language('candidate', 'passive-2052', { kind: 'install', flags: '/P', savedValue: '2052', expect: 'finish', wanted: '2052', after: '2052' });
await language('candidate', 'passive-1033', { kind: 'install', flags: '/P', savedValue: '1033', expect: 'finish', wanted: '1033', after: '1033' });
await language('candidate', 'updater-2052', { kind: 'install', flags: '/P /UPDATE /R', savedValue: '2052', expect: 'finish', wanted: '2052', after: '2052' });
await language('candidate', 'passive-1041', { kind: 'install', flags: '/P', savedValue: '1041', expect: 'finish', wanted: sys, after: '1041' });
await language('candidate', 'passive-x', { kind: 'install', flags: '/P', savedValue: 'x', expect: 'finish', wanted: sys, after: 'x' });
await language('candidate', 'un-passive', { kind: 'uninstall', flags: '/P', savedValue: null, expect: 'finish', wanted: sys, after: null });
await language('candidate', 'un-passive-2052', { kind: 'uninstall', flags: '/P', savedValue: '2052', expect: 'finish', wanted: '2052', after: '2052' });
await language('candidate', 'un-passive-1041', { kind: 'uninstall', flags: '/P', savedValue: '1041', expect: 'finish', wanted: sys, after: '1041' });
await language('candidate', 'gui', { kind: 'install', flags: '', savedValue: null, expect: 'dialog' });
await language('candidate', 'gui-2052', { kind: 'install', flags: '', savedValue: '2052', expect: 'finish', wanted: '2052', after: '2052' });
await language('candidate', 'un-gui', { kind: 'uninstall', flags: '', savedValue: null, expect: 'dialog', after: null });
await language('candidate', 'un-gui-2052', { kind: 'uninstall', flags: '', savedValue: '2052', expect: 'finish', wanted: '2052', after: '2052' });
await language('candidate', 'silent', { kind: 'install', flags: '/S', savedValue: null, expect: 'finish', wanted: sys, after: null });

// ===== S1 driven layer: the product's BirdPassiveLanguagePick with ids the runner cannot have.
const driven = [
  [2052, ''], [1028, ''], [3076, ''], [4100, ''], [5124, ''], [1033, ''], [2057, ''], [1041, ''], [1031, ''], [1036, ''], [1042, ''], [1049, ''], [3082, ''], [0, ''],
  [1041, '2052'], [2052, '1033'], [1031, '1033'], [1028, '1041'], [1041, 'x'], [1033, '2052'],
];
for (const [id, savedValue] of driven) {
  const dir = await freshDir(`s1-pick-${id}-${savedValue || 'none'}`);
  const r = await runSetup(exe.candidate, `/PICK=${id}${savedValue ? ` /SAVED=${savedValue}` : ''} /D=${dir}`, 15000);
  const got = text(path.join(dir, 'pick.txt')), want = expectFor(id, savedValue);
  check(`S1 DRIVEN pick: display language ${id}, saved ${savedValue ? `"${savedValue}"` : 'none'} -> ${want}`, r.exited && got === want, `${describe(r)}; picked "${got}"`);
}

// ===== S2: which program stops the Host.
async function layout(name, { app, helper, tauri }) {
  const dir = await freshDir(`s2-${name}`);
  await clearMarks();
  if (tauri) {
    await fs.copyFile(fakes.tauriapp, path.join(dir, 'tarocub-client.exe'));
  } else {
    await fs.copyFile(fakes.app, path.join(dir, 'tarocub-client.exe'));
    await fs.mkdir(path.join(dir, 'resources', 'host'), { recursive: true });
    await fs.writeFile(path.join(dir, 'resources', 'app.asar'), 'asar');
    await fs.writeFile(path.join(dir, 'resources', 'host', 'node.exe'), 'MZ');
    if (helper) await fs.copyFile(fakes.helperinst, path.join(dir, 'tarobot-installer-helper.exe'));
  }
  if (app?.leftover || tauri) { await fs.mkdir(path.join(dir, 'host'), { recursive: true }); await fs.writeFile(path.join(dir, 'host', 'node.exe'), 'MZ'); }
  // The shape read on a real Win11 machine upgraded from Tauri: host\ holds only node-runtime.exe.
  if (app?.runtimeOnly) { await fs.mkdir(path.join(dir, 'host'), { recursive: true }); await fs.writeFile(path.join(dir, 'host', 'node-runtime.exe'), 'MZ'); }
  return dir;
}
async function stopCase(label, kind, name, shape, verify) {
  const dir = await layout(`${label}-${kind}-${name}`, shape);
  setSaved(null);
  const r = await runSetup(kind === 'install' ? exe[label] : uninstallers[label], `/S /CASE=stop ${kind === 'install' ? `/D=${dir}` : `_?=${dir}`}`);
  const state = { r, line: lastNote(), app: ran('app'), tauri: ran('tauriapp'), helper: ran('helper'), installed: ran('helperinst'), confirmed: existsSync(path.join(dir, 'stop-confirmed.txt')) };
  const detail = `${describe(r)}; note "${state.line}"; ran: app=${state.app ? `"${state.app.split(' ').slice(1).join(' ')}"` : 'no'} tauri=${state.tauri ? 'yes' : 'no'} staged-helper=${state.helper ? `"${state.helper.split(' ').slice(1).join(' ')}"` : 'no'} installed-helper=${state.installed ? 'yes' : 'no'}; went on: ${state.confirmed}`;
  check(`S2 ${label}: ${kind}, ${name} — ${verify.label}`, verify.ok(state), detail);
}
const leftover = { app: { leftover: true } };
await stopCase('baseline', 'uninstall', 'Electron + Tauri host\\ left over, no helper', leftover, { label: 'runs the Electron program and reports TB-HOST-UNCONFIRMED (bug reproduced)',
  ok: s => s.r.exited && s.r.status === 2 && s.app.includes('--stop-desktop-host') && s.line.includes('TB-HOST-UNCONFIRMED') && !s.confirmed });
await stopCase('candidate', 'uninstall', 'Electron + Tauri host\\ left over, no helper', leftover, { label: 'TB-HOST-NO-STOPPER before any change, Electron program never run',
  ok: s => s.r.exited && s.r.status === 2 && !s.app && s.line.includes('TB-HOST-NO-STOPPER') && s.line.endsWith(` · TaroBird ${version}`) && !s.confirmed });
await stopCase('baseline', 'install', 'Electron + Tauri host\\ left over, no helper', leftover, { label: 'Electron program run (64), then staged helper confirms',
  ok: s => s.r.exited && s.r.status === 0 && s.app.includes('--stop-desktop-host') && s.helper.includes('--confirm-host-stopped-v2') && s.confirmed });
await stopCase('candidate', 'install', 'Electron + Tauri host\\ left over, no helper', leftover, { label: 'staged helper confirms read-only, Electron program never run',
  ok: s => s.r.exited && s.r.status === 0 && !s.app && s.helper.includes('--confirm-host-stopped-v2') && s.confirmed });
await stopCase('candidate', 'uninstall', 'Electron, no helper, no host\\', {}, { label: 'TB-HOST-NO-STOPPER (unchanged rule)',
  ok: s => s.r.exited && s.r.status === 2 && !s.app && s.line.includes('TB-HOST-NO-STOPPER') && !s.confirmed });
await stopCase('candidate', 'uninstall', 'Electron with its helper and a Tauri host\\ left over', { helper: true, app: { leftover: true } }, { label: 'its helper stops the Host',
  ok: s => s.r.exited && s.r.status === 0 && !s.app && s.installed.includes('--stop-desktop-host') && s.confirmed });
await stopCase('candidate', 'uninstall', 'real Tauri layout (host\\, no resources\\)', { tauri: true }, { label: 'the Tauri program still stops the Host',
  ok: s => s.r.exited && s.r.status === 0 && s.tauri.includes('--stop-desktop-host') && s.confirmed });

// Both left-over Tauri host\ shapes: only node-runtime.exe (real machine), with and without the helper.
const runtimeOnly = { app: { runtimeOnly: true } };
await stopCase('baseline', 'uninstall', 'Electron + host\\ with only node-runtime.exe, no helper', runtimeOnly, { label: 'TB-HOST-NO-STOPPER already before the fix (this shape was never mistaken for Tauri)',
  ok: s => s.r.exited && s.r.status === 2 && !s.app && s.line.includes('TB-HOST-NO-STOPPER') && !s.confirmed });
await stopCase('candidate', 'uninstall', 'Electron + host\\ with only node-runtime.exe, no helper', runtimeOnly, { label: 'TB-HOST-NO-STOPPER before any change, Electron program never run',
  ok: s => s.r.exited && s.r.status === 2 && !s.app && s.line.includes('TB-HOST-NO-STOPPER') && s.line.endsWith(` · TaroBird ${version}`) && !s.confirmed });
await stopCase('candidate', 'install', 'Electron + host\\ with only node-runtime.exe, no helper', runtimeOnly, { label: 'staged helper confirms read-only, Electron program never run',
  ok: s => s.r.exited && s.r.status === 0 && !s.app && s.helper.includes('--confirm-host-stopped-v2') && s.confirmed });
const realMachine = { helper: true, app: { runtimeOnly: true } };
for (const label of ['baseline', 'candidate']) {
  await stopCase(label, 'uninstall', 'real upgraded machine (helper, resources\\, host\\ with only node-runtime.exe)', realMachine, { label: 'its helper stops the Host',
    ok: s => s.r.exited && s.r.status === 0 && !s.app && s.installed.includes('--stop-desktop-host') && s.confirmed });
}
await stopCase('candidate', 'install', 'real upgraded machine (helper, resources\\, host\\ with only node-runtime.exe)', realMachine, { label: 'its helper stops the Host, no fallback needed',
  ok: s => s.r.exited && s.r.status === 0 && !s.app && s.installed.includes('--stop-desktop-host') && !s.helper && s.confirmed });

// --- Cleanup.
reg('delete', REG_KEY, '/f');
check('lab key removed', !keyExists(REG_KEY));
check('product key unchanged', keyExists(PRODUCT_KEY) === productKeyBefore, `${PRODUCT_KEY}: ${keyExists(PRODUCT_KEY) ? 'present' : 'absent'}`);
await fs.rm(notesDir, { recursive: true, force: true });
check('setup notes folder removed', !existsSync(notesDir));
await finish();
