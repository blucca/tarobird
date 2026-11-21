// ACCEPTANCE-ONLY (#50: a released uninstaller run in place by the new
// installer). Never merge into main.
// The "old uninstaller" is built from tag windows-tarobot-v1.5.1's own text:
// its un.onInit (MUI_UNGETLANGUAGE before /P), SetContext and language order.
// The "new installer" is each variant's installer.nsi up to `Var PassiveMode`
// plus new-tail.nsi with that variant's own PageLeaveReinstall pasted in. It
// runs the old uninstaller in place exactly as the reinstall page does. Lab
// HKCU keys only, removed at the end. `--compile-only` compiles anywhere.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  'confirm-disposable-windows': { type: 'boolean' }, 'compile-only': { type: 'boolean' }, report: { type: 'string' },
  product: { type: 'string' }, baseline: { type: 'string' }, release: { type: 'string' }, makensis: { type: 'string' },
} });
const refuse = reason => { console.error(`Refusing: ${reason}`); process.exit(3); };
const compileOnly = Boolean(options['compile-only']);
if (!compileOnly) {
  if (process.platform !== 'win32') refuse('Windows only');
  if (process.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable' || !options['confirm-disposable-windows']) refuse('set TAROBOT_WINDOWS_ACCEPTANCE=disposable and pass --confirm-disposable-windows');
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') refuse('only on a disposable GitHub-hosted runner');
}
if (!options.report?.includes('.noindex')) refuse('--report must lie under a .noindex folder');
for (const key of ['product', 'baseline', 'release']) if (!/^[0-9a-f]{40}$/.test(options[key] ?? '')) refuse(`--${key} needs a full commit SHA`);

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
const makensis = options.makensis ?? 'makensis';
const LAB_KEY = 'Software\\TaroBirdReinstallProbe';
const PRODUCT_REG = `HKCU\\${LAB_KEY}\\Product`, UNINSTALL_REG = `HKCU\\${LAB_KEY}\\Uninstall`, VALUE = 'Installer Language';
const REAL_PRODUCT_KEY = 'HKCU\\Software\\tarocub\\TaroBot';
const lab = path.resolve(options.report);
await fs.mkdir(lab, { recursive: true });
if (/\s/.test(lab)) refuse('the lab folder must not contain spaces (NSIS /D= and _?=)');
const version = JSON.parse(readFileSync(path.join(repo, 'client', 'package.json'), 'utf8')).version;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const record = (name, detail) => { results.push({ name, ok: null, detail: String(detail) }); console.log(`INFO ${name} — ${detail}`); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const finish = async () => {
  const failed = results.filter(result => result.ok === false);
  await fs.writeFile(path.join(lab, 'old-uninstaller-language.json'), JSON.stringify({ product: options.product, baseline: options.baseline, release: options.release, head: git('rev-parse', 'HEAD'), image: process.env.ImageVersion, results }, null, 2));
  console.log(`\n${results.filter(result => result.ok).length} passed, ${failed.length} failed, ${results.filter(result => result.ok === null).length} info`);
  process.exit(failed.length ? 1 : 0);
};
const show = (sha, file) => git('show', `${sha}:${file}`).replace(/\r\n/g, '\n');
const block = (source, start, end, label) => {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`${label}: no ${start}`);
  const to = source.indexOf(end, from);
  if (to < 0) throw new Error(`${label}: no ${end}`);
  return source.slice(from, to + end.length);
};

// --- Source binding.
check('product commit is an ancestor of the tested HEAD', spawnSync('git', ['merge-base', '--is-ancestor', options.product, 'HEAD'], { cwd: repo }).status === 0);
for (const file of git('ls-tree', '--name-only', `${options.product}:client/windows-electron`).split('\n')) {
  check(`candidate ${file} is the product commit's`, git('rev-parse', `HEAD:client/windows-electron/${file}`) === git('rev-parse', `${options.product}:client/windows-electron/${file}`));
}
const tagCommit = spawnSync('git', ['rev-parse', 'windows-tarobot-v1.5.1^{commit}'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
check('release is tag windows-tarobot-v1.5.1', tagCommit === options.release, `tag -> ${tagCommit || 'missing'}`);
const releaseNsi = show(options.release, 'client/windows-electron/installer.nsi');
const releaseUnInit = block(releaseNsi, 'Function un.onInit\n', 'FunctionEnd', 'release');
const releaseSetContext = block(show(options.release, 'client/windows-electron/utils.nsh'), '!macro SetContext\n', '!macroend', 'release utils');
const releaseLanguages = releaseNsi.match(/^!insertmacro MUI_LANGUAGE "\w+"$/gm);
check('release uninstaller reads the language before /P (MUI_UNGETLANGUAGE first)', releaseUnInit.indexOf('!insertmacro MUI_UNGETLANGUAGE') > 0 && releaseUnInit.indexOf('!insertmacro MUI_UNGETLANGUAGE') < releaseUnInit.indexOf('"/P"'));
check('release language key is HKCU ${MANUPRODUCTKEY} "Installer Language"', /^!define MUI_LANGDLL_REGISTRY_KEY "\$\{MANUPRODUCTKEY\}"$/m.test(releaseNsi) && /^!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"$/m.test(releaseNsi) && /^!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"$/m.test(releaseNsi));
const productLeave = block(show(options.product, 'client/windows-electron/installer.nsi'), 'Function PageLeaveReinstall\n', 'FunctionEnd', 'product');
const baselineLeave = block(show(options.baseline, 'client/windows-electron/installer.nsi'), 'Function PageLeaveReinstall\n', 'FunctionEnd', 'baseline');
check('candidate lends around the in-place uninstaller', /!insertmacro BirdLendLanguage\n\s*ExecWait '\$R1' \$0\n\s*!insertmacro BirdReturnLanguage/.test(productLeave));
check('baseline is main without the lend', !baselineLeave.includes('BirdLendLanguage') && /StrCpy \$R1 "\$R1 _\?=\$4"[^\n]*\n\s*ExecWait '\$R1' \$0/.test(baselineLeave));

function compile(source, out, defines, cwd) {
  const result = spawnSync(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([key, value]) => `-D${key}=${value}`), source], { encoding: 'utf8', cwd, env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' } });
  const log = result.stdout + result.stderr;
  return { ok: result.status === 0, log, unknown: log.match(/unknown variable\/constant[^\n]*/g) ?? [] };
}
record('makensis', execFileSync(makensis, ['-VERSION'], { encoding: 'utf8' }).trim());

// --- The released uninstaller's language reading, from the tag's own text.
const oldDir = path.join(lab, 'old-template');
await fs.mkdir(oldDir, { recursive: true });
const oldScript = `Unicode true
!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include LogicLib.nsh
!define INSTALLMODE "currentUser"
!define ARCH "x64"
Name "TaroBird 1.5.1 uninstaller language stand-in"
OutFile "\${PROBE_OUT}"
InstallDir "$TEMP\\tarobird-old-probe-unused"
RequestExecutionLevel user
ShowUninstDetails show
Var PassiveMode
Var UpdateMode
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "\${PROBE_KEY}\\Product"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"
; verbatim from windows-tarobot-v1.5.1 utils.nsh
${releaseSetContext}
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
; language order verbatim from windows-tarobot-v1.5.1 installer.nsi
${releaseLanguages.join('\n')}
!insertmacro MUI_RESERVEFILE_LANGDLL
LangString probeLanguage \${LANG_SIMPCHINESE} "zh"
LangString probeLanguage \${LANG_ENGLISH} "en"
Section
  SetOutPath $INSTDIR
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
; verbatim from windows-tarobot-v1.5.1 installer.nsi
${releaseUnInit}
Section Uninstall
  FileOpen $9 "$INSTDIR\\old-uninstall.txt" w
  FileWriteUTF16LE /BOM $9 "$LANGUAGE $(probeLanguage) passive=$PassiveMode update=$UpdateMode"
  FileClose $9
  StrCpy $8 0
  ClearErrors
  FileOpen $9 "$INSTDIR\\old-exit.txt" r
  \${IfNot} \${Errors}
    FileRead $9 $8
    FileClose $9
  \${EndIf}
  \${If} \${FileExists} "$INSTDIR\\old-reset.txt"
    DeleteRegValue HKCU "\${PROBE_KEY}\\Product" "Installer Language"
  \${EndIf}
  SetErrorLevel $8
  SetAutoClose true
SectionEnd
`;
await fs.writeFile(path.join(oldDir, 'old-setup.nsi'), oldScript);
const oldSetup = path.join(lab, 'old-setup-1.5.1.exe');
{
  const r = compile('old-setup.nsi', oldSetup, { PROBE_OUT: oldSetup, PROBE_KEY: LAB_KEY }, oldDir);
  check('compile the 1.5.1-style uninstaller from the tag text', r.ok && r.unknown.length === 0, r.ok ? `${r.unknown.length} unknown variable warnings` : r.log.trim().split('\n').slice(-4).join(' | '));
}

// --- New installers from each variant's own installer.nsi and reinstall page.
const tail = readFileSync(path.join(here, 'new-tail.nsi'), 'utf8');
const emptyPlugins = path.join(lab, 'plugins');
await fs.mkdir(emptyPlugins, { recursive: true });
const exe = {};
for (const [label, sha, leave] of [['candidate', options.product, productLeave], ['baseline', options.baseline, baselineLeave]]) {
  const dir = path.join(lab, `templates-${label}`);
  await fs.mkdir(dir, { recursive: true });
  for (const file of git('ls-tree', '--name-only', `${sha}:client/windows-electron`).split('\n')) await fs.writeFile(path.join(dir, file), execFileSync('git', ['show', `${sha}:client/windows-electron/${file}`], { cwd: repo }));
  const nsi = show(sha, 'client/windows-electron/installer.nsi');
  const at = nsi.indexOf('\nVar PassiveMode\n');
  if (at < 0 || !tail.includes(';@@PAGELEAVEREINSTALL@@')) throw new Error(`${label}: cannot assemble the probe`);
  await fs.writeFile(path.join(dir, 'probe.nsi'), `${nsi.slice(0, at + 1)}\n${tail.replace(';@@PAGELEAVEREINSTALL@@', `; verbatim from ${sha.slice(0, 7)} installer.nsi\n${leave}`)}`);
  exe[label] = path.join(lab, `new-${label}.exe`);
  const r = compile('probe.nsi', exe[label], {
    TB_VERSION: version, TB_MAIN_BINARY: 'unused', TB_HELPER: 'unused', TB_OUT_FILE: 'unused', TB_PLUGINS_DIR: emptyPlugins, TB_INSTALLER_ICON: '', TB_UNINSTALLER_SIGN: '', TB_ESTIMATED_SIZE: '1',
    PROBE_OUT: exe[label], PROBE_KEY: LAB_KEY,
  }, dir);
  check(`compile new-${label} from ${sha.slice(0, 7)}'s installer.nsi and reinstall page`, r.ok && r.unknown.length === 0, r.ok ? `${r.unknown.length} unknown variable warnings` : r.log.trim().split('\n').slice(-4).join(' | '));
}
if (compileOnly) await finish();

// --- Windows state.
const reg = (...args) => spawnSync('reg', args, { encoding: 'utf8' });
const keyExists = key => reg('query', key).status === 0;
const saved = () => { const out = reg('query', PRODUCT_REG, '/v', VALUE); return out.status === 0 ? (out.stdout.match(/Installer Language\s+REG_SZ\s?(.*)$/m)?.[1]?.trim() ?? '') : null; };
const setSaved = value => {
  if (value === null) { if (keyExists(PRODUCT_REG)) reg('delete', PRODUCT_REG, '/v', VALUE, '/f'); }
  else if (reg('add', PRODUCT_REG, '/v', VALUE, '/t', 'REG_SZ', '/d', value, '/f').status !== 0) throw new Error('reg add failed');
  if (saved() !== value) throw new Error(`lab language is ${saved()}, wanted ${value}`);
};
const pwsh = script => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' }).stdout.trim();
const languageWindows = () => pwsh("Get-Process | Where-Object { $_.MainWindowTitle -eq 'Installer Language' } | ForEach-Object { \"$($_.Id) $($_.MainWindowHandle)\" }")
  .split(/\r?\n/).filter(Boolean).map(line => { const [pid, hwnd] = line.trim().split(' '); return { pid: Number(pid), hwnd }; });
const answer = hwnd => pwsh(`Add-Type -Namespace Probe -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'; [Probe.Win]::PostMessage([System.IntPtr]${hwnd}, 0x111, [System.IntPtr]1, [System.IntPtr]0)`);
const kill = pid => pwsh(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
if (keyExists(`HKCU\\${LAB_KEY}`)) refuse(`HKCU\\${LAB_KEY} already exists: not a fresh runner`);
const realBefore = keyExists(REAL_PRODUCT_KEY);
record('product key before (never written by this probe)', `${REAL_PRODUCT_KEY}: ${realBefore ? 'present' : 'absent'}`);
const ui = Number(pwsh(`Add-Type -Namespace Probe -Name Lang -MemberDefinition '[DllImport("kernel32.dll")] public static extern ushort GetUserDefaultUILanguage();'; [Probe.Lang]::GetUserDefaultUILanguage()`));
const sys = (ui & 0x3ff) === 4 ? '2052' : '1033';
record('Windows display language', `${ui}; a /P run without a saved language uses ${sys}`);

let count = 0;
const text = file => existsSync(file) ? readFileSync(file).toString('utf16le').replace(/^﻿/, '').trim() : '';
async function prepare(name) {
  const dir = path.join(lab, `${String(++count).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(oldUninstaller, path.join(dir, 'uninstall.exe'));
  reg('add', UNINSTALL_REG, '/v', 'UninstallString', '/t', 'REG_SZ', '/d', `"${dir}\\uninstall.exe"`, '/f');
  reg('add', PRODUCT_REG, '/ve', '/t', 'REG_SZ', '/d', dir, '/f');
  return dir;
}
// Runs the new installer. Its own language dialog is answered (OK) when asked
// to; any other "Installer Language" window is the old uninstaller's: it is
// recorded and the whole run is closed.
async function runNew(file, tail, { answerOwn = false, limit = 40000 } = {}) {
  const started = Date.now();
  const child = spawn(file, [tail], { windowsVerbatimArguments: true, stdio: 'ignore' });
  let status; const seen = [];
  child.on('exit', code => { status = code; });
  let answered = false;
  while (status === undefined && Date.now() - started < limit) {
    await sleep(400);
    if (status !== undefined) break;
    for (const window of languageWindows()) {
      if (window.pid === child.pid && answerOwn && !answered) { answer(window.hwnd); answered = true; seen.push('new installer asked (answered OK)'); }
      else if (window.pid !== child.pid) { seen.push(`OLD UNINSTALLER asked (pid ${window.pid})`); kill(window.pid); kill(child.pid); }
      else if (!answerOwn) { seen.push('new installer asked (unexpected)'); kill(child.pid); }
    }
  }
  if (status === undefined) { kill(child.pid); for (let i = 0; i < 20 && status === undefined; i++) await sleep(250); }
  return { status: status ?? null, seconds: Math.round((Date.now() - started) / 1000), seen: [...new Set(seen)] };
}

// Build the released-style uninstaller once.
const oldSource = path.join(lab, 'old-installed');
await fs.mkdir(oldSource, { recursive: true });
{
  const r = spawnSync(oldSetup, [`/S /D=${oldSource}`], { windowsVerbatimArguments: true, timeout: 60000 });
  check('the 1.5.1-style setup writes its uninstaller', r.status === 0 && existsSync(path.join(oldSource, 'uninstall.exe')), `exit ${r.status}`);
}
const oldUninstaller = path.join(oldSource, 'uninstall.exe');

async function scenario(label, name, { passive, update = false, savedValue, oldExit = 0, reset = false, expect }) {
  const dir = await prepare(`${label}-${name}`);
  setSaved(savedValue);
  await fs.writeFile(path.join(dir, 'old-exit.txt'), String(oldExit));
  if (reset) await fs.writeFile(path.join(dir, 'old-reset.txt'), '1');
  const flags = [passive ? '/P' : '', update ? '/UPDATE' : ''].filter(Boolean).join(' ');
  const r = await runNew(exe[label], `${flags}${flags ? ' ' : ''}/D=${dir}`, { answerOwn: !passive && savedValue === null });
  const old = text(path.join(dir, 'old-uninstall.txt')), newLanguage = text(path.join(dir, 'new-continued.txt')), after = saved();
  const title = `${label}: ${passive ? '/P' : 'interactive'}${update ? ' /UPDATE' : ''}, ${savedValue === null ? 'nothing saved' : `saved "${savedValue}"`}, old uninstaller ${reset ? 'resets and ' : ''}exits ${oldExit}`;
  const detail = `setup exit ${r.status} in ${r.seconds} s; dialogs: ${r.seen.join('; ') || 'none'}; old used "${old || '(not run)'}"; new went on: ${newLanguage || 'no'}; saved after: ${after === null ? 'absent' : `"${after}"`}`;
  check(`${title} — ${expect.label}`, expect.ok({ r, old, newLanguage, after, oldLanguage: old.split(' ')[0] }), detail);
}
const noSecond = s => !s.r.seen.some(entry => entry.startsWith('OLD UNINSTALLER'));
const asked = s => s.r.seen.some(entry => entry.startsWith('OLD UNINSTALLER'));

// Negative: main without the lend.
await scenario('baseline', 'passive', { passive: true, savedValue: null, expect: { label: 'the old uninstaller asks (B-2a reproduced)', ok: asked } });
await scenario('baseline', 'interactive', { passive: false, savedValue: null, expect: { label: 'the old uninstaller asks a second time (B-3 reproduced)', ok: s => s.r.seen.includes('new installer asked (answered OK)') && asked(s) } });
await scenario('baseline', 'passive-2052', { passive: true, savedValue: '2052', expect: { label: 'no dialog, both 2052, value kept (unaffected before)', ok: s => s.r.status === 0 && !s.r.seen.length && s.oldLanguage === '2052' && s.after === '2052' } });
// Candidate.
await scenario('candidate', 'passive', { passive: true, savedValue: null, expect: { label: 'no dialog anywhere, the old uninstaller uses this run\'s language, nothing saved afterwards',
  ok: s => s.r.status === 0 && !s.r.seen.length && s.oldLanguage === sys && s.newLanguage === sys && s.after === null } });
await scenario('candidate', 'interactive', { passive: false, savedValue: null, expect: { label: 'asked once by the new installer only; the old one uses that choice; MUI saves the choice',
  ok: s => s.r.status === 0 && s.r.seen.length === 1 && s.r.seen[0] === 'new installer asked (answered OK)' && s.oldLanguage === s.newLanguage && s.after === s.newLanguage } });
await scenario('candidate', 'passive-2052', { passive: true, savedValue: '2052', expect: { label: 'no dialog, both 2052, value kept',
  ok: s => s.r.status === 0 && !s.r.seen.length && s.oldLanguage === '2052' && s.newLanguage === '2052' && s.after === '2052' } });
await scenario('candidate', 'interactive-2052', { passive: false, savedValue: '2052', expect: { label: 'no dialog, both 2052, value kept',
  ok: s => s.r.status === 0 && !s.r.seen.length && s.oldLanguage === '2052' && s.after === '2052' } });
await scenario('candidate', 'passive-1033', { passive: true, savedValue: '1033', expect: { label: 'no dialog, both 1033, value kept',
  ok: s => s.r.status === 0 && !s.r.seen.length && s.oldLanguage === '1033' && s.after === '1033' } });
await scenario('candidate', 'passive-old-fails', { passive: true, savedValue: null, oldExit: 2, expect: { label: 'no dialog; setup stops; nothing saved afterwards',
  ok: s => s.r.status !== 0 && !s.r.seen.length && s.oldLanguage === sys && !s.newLanguage && s.after === null } });
await scenario('candidate', 'interactive-old-cancelled', { passive: false, savedValue: null, oldExit: 1, expect: { label: 'no second dialog; setup stops; the lent value is gone, MUI saved nothing',
  ok: s => s.r.status !== 0 && noSecond(s) && s.r.seen.includes('new installer asked (answered OK)') && !s.newLanguage && s.after === null } });
await scenario('candidate', 'passive-unknown', { passive: true, savedValue: '1041', expect: { label: 'no dialog; the old uninstaller uses this run\'s language; "1041" is back afterwards',
  ok: s => s.r.status === 0 && !s.r.seen.length && s.oldLanguage === sys && s.after === '1041' } });
await scenario('candidate', 'passive-unknown-old-resets-and-cancels', { passive: true, savedValue: '1041', oldExit: 1, reset: true, expect: { label: 'the uninstaller removed the value: it stays removed (not put back)',
  ok: s => s.r.status !== 0 && !s.r.seen.length && s.after === null } });
await scenario('candidate', 'updater', { passive: true, update: true, savedValue: null, expect: { label: 'the updater path skips the old uninstaller and saves nothing',
  ok: s => s.r.status === 0 && !s.r.seen.length && !s.old && s.after === null } });

// --- Cleanup.
reg('delete', `HKCU\\${LAB_KEY}`, '/f');
check('lab key removed', !keyExists(`HKCU\\${LAB_KEY}`));
check('product key unchanged', keyExists(REAL_PRODUCT_KEY) === realBefore, `${REAL_PRODUCT_KEY}: ${keyExists(REAL_PRODUCT_KEY) ? 'present' : 'absent'}`);
await finish();
