// #50 extension acceptance on a DISPOSABLE GitHub-hosted Windows runner
// (issue #50 checklist items the main package does not cover). Acceptance only:
// it installs, upgrades and uninstalls for the runner user, writes synthetic
// data, and never signs, uploads or publishes anything.
//
//   A  custom install directory with spaces and CJK (/D=), the quoted
//      InstallLocation and the in-place `$EXEPATH` comparison (review N2)
//   B  upgrade from published releases (pinned URL, size and SHA-256), then
//      uninstall and reinstall: /P /UPDATE /R, same-version /P (runs the
//      installed 1.5.1 uninstaller in place, review N6), GUI default upgrade
//   C  Tauri 1.0.119 -> candidate through windows-acceptance.mjs's existing
//      --legacy-installer path; needs read access to the private release
//   D  the diagnostic dialog's text as UTF-16 code units (English and, with
//      Installer Language=2052 for display only, Simplified Chinese): is the
//      version/code separator really U+00B7 on screen?
//
//   set TAROBOT_WINDOWS_ACCEPTANCE=disposable
//   node scripts/windows-acceptance-extension.mjs --confirm-disposable-windows \
//     --installer <TaroBird_x.y.z_x64-setup.exe> --version x.y.z --report <dir with .noindex> [--groups C,A,B]
//
// pass/fail/skip per check; skip (blocked, not induced, UI not drivable) is
// never a pass; info is evidence, never judged.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appProcesses, credentialTargets, EXE, LOCATION_KEY, PROTOCOL_KEY, RUN_KEY, runAcceptance, UNINSTALL_KEY, windowsSystem } from './windows-acceptance.mjs';
import { makeContext } from './windows-uninstall-recovery-acceptance.mjs';

const W = path.win32;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = 'tarobot-installer-helper.exe';
const AUMID = 'com.tarobot.client';
const LOCK_TARGET = W.join('resources', 'native', 'tarobot-migration-exporter.exe');
const FINGERPRINT = [EXE, HELPER, 'uninstall.exe', W.join('resources', 'app.asar')];
const LAYOUT = [EXE, HELPER, 'uninstall.exe', W.join('resources', 'app.asar'), W.join('resources', 'host', 'node.exe'), W.join('resources', 'host', 'dist', 'src', 'index.js'),
  LOCK_TARGET, W.join('resources', 'native', 'tarobot-desktop-native.node'), 'tarocub-notification-shortcut.json'];
export const GROUPS = ['C', 'A', 'D', 'B'];
/** Spaces and CJK, under the runner's temp disk (issue #50 checklist). */
export const CUSTOM_PARENT = 'TB 验收 目录';
/** Published installers, pinned from the release API digest and the release's
 * own SHA256SUMS (both checked 2026-11-21). A size or hash mismatch aborts. */
export const RELEASES = Object.freeze({
  '1.5.1': { url: 'https://github.com/cloveric/tarobird/releases/download/windows-tarobot-v1.5.1/TaroBird_1.5.1_x64-setup.exe', size: 262663159,
    sha256: 'ccc3f6b65ed8abd40103ba1c719193fd7aa045f24481dbe6a5e2e0df0b1d0a77' },
  '1.5.0': { url: 'https://github.com/cloveric/tarobird/releases/download/windows-tarobot-v1.5.0/TaroBird_1.5.0_x64-setup.exe', size: 262755192,
    sha256: 'deb9382a818647fbe34b9faa62ceb310e42505b60b0cc22edd2cb03813c4a419' },
});
/** The last published Tauri Windows build (1.0.130's notes: 1.0.120–1.0.129
 * switched to Electron). The release is in the private, archived cloveric/tarobot;
 * anonymous download is 404, so it needs a read token supplied by the owner. */
export const LEGACY = Object.freeze({ version: '1.0.119', repository: 'cloveric/tarobot',
  url: 'https://api.github.com/repos/cloveric/tarobot/releases/assets/686391312', name: 'TaroBot-1.0.119-windows-x64-setup.exe', size: 105042980,
  sha256: '67dc626fbf9513d33b56662b5eeb3fe4bc6dd12913eae3c11025d54c184db821' });
const SYNTHETIC = 'tarobird-acceptance-synthetic.txt';
// Matches credentialTargets()'s /com\.taro(bot|cub)\.client/ filter; never a real key.
const SYNTHETIC_CREDENTIAL = 'tarobird-acceptance-synthetic.com.tarobot.client.device';

class Receipt {
  checks = [];
  add(phase, id, status, detail = '') {
    const check = { phase, id, status, detail: String(detail).slice(0, 4000) };
    this.checks.push(check);
    console.log(`[${new Date().toISOString()}] ${status.toUpperCase()} ${phase}/${id} — ${check.detail.replaceAll('\n', ' ').slice(0, 700)}`);
    return status === 'pass';
  }
  expect(phase, id, ok, detail) { return this.add(phase, id, ok ? 'pass' : 'fail', detail); }
  info(phase, id, detail) { this.add(phase, id, 'info', detail); }
  get outcome() { return this.checks.some(c => c.status === 'fail') ? 'fail' : this.checks.some(c => c.status === 'skip') ? 'incomplete' : 'pass'; }
  markdown(meta) {
    const label = { pass: '✅ pass', fail: '❌ fail', skip: '⏭ skip', info: 'ℹ info (not judged)' };
    const rows = this.checks.map(c => `| ${c.phase} | ${c.id} | ${label[c.status]} | ${c.detail.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ')} |`);
    return `# #50 Windows extension acceptance (${meta.startedAt})\n\nOutcome: **${this.outcome}**. Groups: ${meta.groups.join(', ')}. Skips are not passes.\n\n| scenario | check | status | detail |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  }
}

const unquote = value => value?.trim().replace(/^"(.*)"$/, '$1');
const ps = s => s.replaceAll("'", "''");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const stamp = () => `[${new Date().toISOString()}]`;

/** NSIS takes `/D=` and `_?=` only as the last, UNQUOTED parameter, even with
 * spaces; Node would quote such an argument. So the command line is passed to
 * `cmd /d /s /c "<line>"` verbatim. Returns exit code, timeout and seconds. */
export function lineRunner(sys) {
  if (sys.runLine) return sys.runLine;
  return (line, { timeout = 300_000 } = {}) => new Promise(resolve => {
    const started = Date.now();
    let settled = false, timedOut = false;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore' });
    const finish = code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code: timedOut ? -1 : code ?? 1, timedOut, seconds: Math.round((Date.now() - started) / 1000) }); };
    const timer = setTimeout(() => {
      timedOut = true;
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () => {});
      setTimeout(() => finish(-1), 10_000);
    }, timeout);
    child.once('error', () => finish(1));
    child.once('exit', code => finish(code));
  });
}

/** Streams a pinned download to `file`, checking size and SHA-256. */
export async function download(sys, { url, size, sha256 }, file, headers = {}) {
  if (sys.download) return sys.download({ url, size, sha256 }, file, headers);
  const started = Date.now();
  const response = await fetch(url, { headers: { 'User-Agent': 'tarobird-acceptance', ...headers }, redirect: 'follow' });
  if (!response.ok || !response.body) return { ok: false, detail: `HTTP ${response.status} for ${url}` };
  const hash = createHash('sha256');
  let bytes = 0;
  await mkdir(path.dirname(file), { recursive: true });
  const counted = Readable.fromWeb(response.body);
  counted.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
  await pipeline(counted, createWriteStream(file));
  const digest = hash.digest('hex');
  const ok = bytes === size && digest === sha256;
  return { ok, detail: `${url}: ${bytes} bytes (pinned ${size}), sha256 ${digest}${digest === sha256 ? ' = pinned' : ` ≠ pinned ${sha256}`} in ${Math.round((Date.now() - started) / 1000)} s` };
}

export function makeExtension(sys, options) {
  const ctx = makeContext(sys, options);
  const runLine = lineRunner(sys);
  const outcome = result => `exit ${result.code}${result.timedOut ? ' (TIMED OUT, tree killed)' : ''} in ${result.seconds} s`;
  const tmp = options.temp;
  let counter = 0;
  const hashFile = async file => { try { return createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16); } catch { return 'absent'; } };
  const fingerprint = async directory => Object.fromEntries(await Promise.all(FINGERPRINT.map(async file => [file, await hashFile(W.join(directory, file))])));
  const sameFingerprint = (a, b, files = FINGERPRINT) => files.every(file => a[file] !== 'absent' && a[file] === b[file]);
  const values = async key => (await ctx.reg(key));
  const shortcutOf = () => W.join(sys.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TaroBird.lnk');
  const shortcutTarget = async link => existsSync(link) ? (await sys.powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut('${ps(link)}').TargetPath`)).stdout.trim() : '';
  const shortcutAppId = async link => existsSync(link) ? (await sys.powershell(`$i = (New-Object -ComObject Shell.Application).Namespace('${ps(W.dirname(link))}').ParseName('${ps(W.basename(link))}'); [string]$i.ExtendedProperty('System.AppUserModel.ID')`)).stdout.trim() : '';
  /** Installs with the given switches and, last, an unquoted /D=. */
  const install = async (receipt, phase, installer, { dir, args = ['/S'], id } = {}) => {
    const line = `"${installer}" ${args.join(' ')}${dir ? ` /D=${dir}` : ''}`;
    const result = await runLine(line, { timeout: 300_000 });
    const location = await values(LOCATION_KEY), key = await values(UNINSTALL_KEY);
    const directory = location.values?.['(Default)'] ?? unquote(key.values?.InstallLocation);
    const ok = result.code === 0 && !!directory && existsSync(W.join(directory, EXE));
    receipt.expect(phase, id ?? `install ${W.basename(installer)} ${args.join(' ')}${dir ? ' /D=<custom>' : ''}`, ok, `${outcome(result)}; ${directory ?? 'no location'}; version ${key.values?.DisplayVersion}`);
    return ok ? directory : undefined;
  };
  const snapshot = async directory => {
    const files = [EXE, LOCK_TARGET, HELPER, 'uninstall.exe'].map(file => `${file}=${existsSync(W.join(directory, file)) ? 'present' : 'absent'}`);
    const { uninstall, link } = await ctx.state();
    return `${files.join(', ')}; dir ${existsSync(directory) ? 'present' : 'absent'}; uninstall key ${uninstall.state}; deep link ${link.state}`;
  };
  /** A temp copy run against the directory, as NSIS re-launches itself, verbatim. */
  const uninstallCopy = async directory => {
    const folder = W.join(tmp, `uninstaller-${++counter}`);
    await mkdir(folder, { recursive: true });
    const copy = W.join(folder, 'Un.exe');
    await copyFile(W.join(directory, 'uninstall.exe'), copy);
    const result = await runLine(`"${copy}" /S _?=${directory}`, { timeout: 300_000 });
    console.log(`${stamp()} uninstaller copy /S _?=<dir>: ${outcome(result)}`);
    await rm(copy, { force: true }).catch(() => {});
    return result;
  };
  /** The registered entry (quoted UninstallString), silently. */
  const uninstallRegistered = async (receipt, phase, id = 'registered-uninstall-completes') => {
    const key = await values(UNINSTALL_KEY);
    const uninstaller = unquote(key.values?.UninstallString);
    if (!uninstaller || !existsSync(uninstaller)) return receipt.expect(phase, id, false, `UninstallString ${key.values?.UninstallString ?? 'missing'} is not runnable (${key.state})`);
    const directory = W.dirname(uninstaller);
    const result = await uninstallCopy(directory);
    const now = (await values(UNINSTALL_KEY)).state;
    const left = [EXE, 'uninstall.exe', HELPER, LOCK_TARGET].filter(file => existsSync(W.join(directory, file)));
    receipt.expect(phase, id, result.code === 0 && now === 'absent' && !left.length, `${outcome(result)}; ${await snapshot(directory)}`);
    return { ok: result.code === 0 && now === 'absent' && !left.length, directory };
  };
  /** Only processes started from `directory` (this run's installation). */
  const stopOwn = async directory => (await sys.powershell(`$d = '${ps(directory)}\\*'; @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like $d }) | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "$($_.ProcessId) $($_.Name)" }`)).stdout.trim();
  /** Every group starts with no installation and no remembered location (the
   * uninstaller keeps HKCU\Software\tarocub\TaroBot, so a later plain install
   * would return to an earlier custom directory). */
  const cleanSlate = async (receipt, phase) => {
    await sys.powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*\\~nsu*' -or $_.ExecutablePath -like '${ps(tmp)}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    const key = await values(UNINSTALL_KEY);
    if (key.state === 'present') {
      const directory = W.dirname(unquote(key.values?.UninstallString) ?? '');
      if (directory) await stopOwn(directory);
      const done = await uninstallRegistered(receipt, phase, 'clean-slate-uninstall');
      if (!done.ok && options.installer) { await install(receipt, phase, options.installer, { id: 'clean-slate-repair' }); await uninstallRegistered(receipt, phase, 'clean-slate-uninstall-after-repair'); }
    }
    const location = await values(LOCATION_KEY);
    if (location.state === 'present' && (await values(UNINSTALL_KEY)).state === 'absent') {
      receipt.info(phase, 'remembered-location-cleared', `${LOCATION_KEY} kept by the uninstaller: ${JSON.stringify(location.values)}; removed for isolation`);
      await sys.run('reg.exe', ['delete', LOCATION_KEY, '/f']);
    }
  };
  const launchFrom = async (receipt, phase, directory) => {
    const marker = W.join(sys.env.LOCALAPPDATA, 'com.tarobot.client', 'electron-profile', 'tarobot-desktop-profile-v1.json');
    sys.launch(W.join(directory, EXE));
    let mine = [], found;
    for (let waited = 0; waited < 90_000; waited += 3000) {
      await sys.sleep(3000);
      mine = (await appProcesses(sys, EXE) ?? []).filter(item => item.path && same(W.dirname(item.path), directory));
      try { found = JSON.parse(await readFile(marker, 'utf8')); } catch { found = undefined; }
      if (mine.length && found) break;
    }
    receipt.expect(phase, 'first-launch-from-custom-dir', mine.length > 0 && found?.version === 1,
      `${mine.length ? `${mine.map(item => item.pid).join(', ')} running from ${directory}` : 'no App process from the custom directory'}; ${marker}: ${found ? JSON.stringify(found) : 'absent'}`);
    receipt.info(phase, 'stopped-own-processes', (await stopOwn(directory)) || 'none');
  };
  return { ...ctx, ctx, runLine, outcome, fingerprint, sameFingerprint, install, snapshot, uninstallCopy, uninstallRegistered, stopOwn, cleanSlate, launchFrom, shortcutOf, shortcutTarget, shortcutAppId };
}

/** A: custom directory with spaces and CJK. */
async function groupA(x, receipt) {
  const P = 'A-custom-dir';
  const dir = W.join(x.options.customRoot, CUSTOM_PARENT, 'TaroBird');
  await x.cleanSlate(receipt, P);
  receipt.info(P, 'custom-directory', dir);
  let directory = await x.install(receipt, P, x.options.installer, { dir, id: 'A1-silent-install-custom' });
  if (!directory) return;
  receipt.expect(P, 'A1-location-is-custom', directory === dir, `${LOCATION_KEY} = ${directory}`);
  const key = await x.reg(UNINSTALL_KEY);
  // Real machines store InstallLocation quoted (win-opus-realmachine.md); so must this one.
  receipt.expect(P, 'A1-uninstall-entry-quoted', key.values?.InstallLocation === `"${dir}"` && key.values?.UninstallString === `"${dir}\\uninstall.exe"` && key.values?.DisplayIcon === `"${dir}\\${EXE}"`,
    `InstallLocation=${key.values?.InstallLocation}; UninstallString=${key.values?.UninstallString}; DisplayIcon=${key.values?.DisplayIcon}`);
  const missing = LAYOUT.filter(file => !existsSync(W.join(dir, file)));
  receipt.expect(P, 'A1-layout-complete', !missing.length, missing.length ? `missing ${missing.join(', ')}` : `${LAYOUT.length} files present`);
  const link = await x.reg(PROTOCOL_KEY);
  receipt.expect(P, 'A1-deep-link', link.values?.['(Default)'] === `"${dir}\\${EXE}" "%1"`, `${link.values?.['(Default)'] ?? link.state}`);
  const shortcut = x.shortcutOf(), target = await x.shortcutTarget(shortcut), appId = await x.shortcutAppId(shortcut);
  receipt.expect(P, 'A1-start-menu-shortcut', same(target, W.join(dir, EXE)) && appId === AUMID, `${shortcut} → ${target || 'missing'}; System.AppUserModel.ID=${appId || 'none'}`);
  let receiptPath; try { receiptPath = JSON.parse(await readFile(W.join(dir, 'tarocub-notification-shortcut.json'), 'utf8')); } catch { /* below */ }
  receipt.expect(P, 'A1-notification-receipt', same(receiptPath, shortcut), `${receiptPath ?? 'missing'}`);
  await x.launchFrom(receipt, P, dir);

  // A2: locked program file → partial uninstall → re-run the registered entry.
  const seeded = await x.seedData();
  const before = x.presentRoots();
  const held = await x.lock(W.join(dir, LOCK_TARGET));
  if (held.held) {
    const partial = await x.uninstallCopy(dir);
    const state = await x.state();
    receipt.expect(P, 'A2-locked-uninstall-refused-entry-kept', partial.code !== 0 && state.uninstall.state === 'present' && existsSync(W.join(dir, 'uninstall.exe')),
      `${x.outcome(partial)}; ${await x.snapshot(dir)}`);
    await held.release();
    await x.uninstallRegistered(receipt, P, 'A2-rerun-registered-uninstall-completes');
    receipt.expect(P, 'A2-directory-removed', !existsSync(dir), `${dir}: ${existsSync(dir) ? 'present' : 'absent'}; parent ${existsSync(W.dirname(dir)) ? 'present' : 'absent'}`);
    const data = await x.kept(before, seeded);
    receipt.expect(P, 'A2-data-retained', data.ok, data.detail);
  } else { receipt.add(P, 'A2-induce-locked-file', 'skip', held.detail); await held.release(); }

  // A3: in-place `_?=` on the CJK/space path: $EXEPATH must equal $INSTDIR\uninstall.exe (N2).
  directory = await x.install(receipt, P, x.options.installer, { dir, id: 'A3-reinstall-custom' });
  if (directory) {
    const inplace = await x.runLine(`"${dir}\\uninstall.exe" /S _?=${dir}`, { timeout: 300_000 });
    const left = [EXE, HELPER, LOCK_TARGET, 'uninstall.exe'].filter(file => existsSync(W.join(dir, file)));
    const state = await x.state();
    receipt.expect(P, 'A3-inplace-uninstall-completes-N2', inplace.code === 0 && state.uninstall.state === 'absent' && left.length === 1 && left[0] === 'uninstall.exe',
      `"<dir>\\uninstall.exe" /S _?=<dir> ${x.outcome(inplace)}; uninstall key ${state.uninstall.state}; left ${left.join(', ') || 'none'} (only the running uninstaller may stay)`);
    if (state.uninstall.state === 'present') await x.cleanSlate(receipt, P);
  }
  // N2 hardening variants the product itself never produces: recorded, not judged.
  for (const [label, arg] of [['trailing-backslash', `${dir}\\`], ['upper-case', dir.toUpperCase()]]) {
    if (!(await x.install(receipt, P, x.options.installer, { dir, id: `A3-variant-${label}-install` }))) continue;
    const run = await x.runLine(`"${dir}\\uninstall.exe" /S _?=${arg}`, { timeout: 300_000 });
    receipt.info(P, `A3-variant-${label}`, `_?=${label}: ${x.outcome(run)}; ${await x.snapshot(dir)}`);
    await x.cleanSlate(receipt, P);
  }

  // A4: same-version /P without /D= returns to the remembered custom directory
  // and takes the installer's reinst_uninstall (`UninstallString /P _?=$4`).
  directory = await x.install(receipt, P, x.options.installer, { dir, id: 'A4-install-custom' });
  if (directory) {
    const seededA4 = await x.seedData();
    const beforeA4 = x.presentRoots();
    const passive = await x.execWatchingLanguage(x.options.installer, ['/P'], { timeout: 300_000 });
    const location = (await x.reg(LOCATION_KEY)).values?.['(Default)'];
    const missingA4 = [EXE, 'uninstall.exe', HELPER, LOCK_TARGET].filter(file => !existsSync(W.join(dir, file)));
    const defaultDir = W.join(x.sys.env.LOCALAPPDATA, 'TaroBird');
    receipt.expect(P, 'A4-passive-reinstall-in-custom-dir', passive.code === 0 && !passive.dialog && location === dir && !missingA4.length && !existsSync(W.join(defaultDir, EXE)),
      `setup /P exit ${passive.code}${passive.dialog ? ` (language chooser: ${passive.dialog})` : passive.timedOut ? ' (TIMED OUT)' : ''} in ${passive.seconds} s; location ${location}; missing ${missingA4.join(', ') || 'none'}; default dir ${existsSync(W.join(defaultDir, EXE)) ? 'HAS an install' : 'untouched'}`);
    // A5: final uninstall: directory, uninstall entry, deep link and shortcut gone; data kept.
    await x.uninstallRegistered(receipt, P, 'A5-uninstall-completes');
    const link5 = await x.reg(PROTOCOL_KEY), shortcut5 = x.shortcutOf();
    receipt.expect(P, 'A5-cleanup', !existsSync(dir) && (await x.reg(UNINSTALL_KEY)).state === 'absent' && (link5.state === 'absent' || link5.values?.['(Default)'] === undefined) && !existsSync(shortcut5),
      `dir ${existsSync(dir) ? 'present' : 'absent'}; uninstall key ${(await x.reg(UNINSTALL_KEY)).state}; deep link ${link5.state}; shortcut ${existsSync(shortcut5) ? 'present' : 'absent'}; parent ${existsSync(W.dirname(dir)) ? 'present (not created by the product)' : 'absent'}`);
    const data = await x.kept(beforeA4, seededA4);
    receipt.expect(P, 'A5-data-retained', data.ok, data.detail);
    const remembered = await x.reg(LOCATION_KEY);
    receipt.info(P, 'A5-remembered-location', `${LOCATION_KEY} after uninstall: ${remembered.state} ${JSON.stringify(remembered.values ?? {})}`);
  }
  await x.cleanSlate(receipt, P);
}

/** B: published release → candidate, then uninstall and reinstall. */
async function groupB(x, receipt) {
  const P = 'B-release-upgrade';
  const files = {};
  for (const [version, pin] of Object.entries(RELEASES)) {
    const file = W.join(x.tmp, 'releases', `TaroBird_${version}_x64-setup.exe`);
    const got = await download(x.sys, pin, file);
    receipt.expect(P, `B0-download-${version}-pinned`, got.ok, got.detail);
    if (got.ok) files[version] = file;
  }
  await electronToElectron(x, receipt, files['1.5.1']);
  await x.cleanSlate(receipt, P);
  const fresh = await x.install(receipt, P, x.options.installer, { id: 'B0-candidate-fresh-install' });
  if (!fresh) return;
  const candidate = await x.fingerprint(fresh);
  receipt.info(P, 'B0-candidate-fingerprint', JSON.stringify(candidate));
  await x.uninstallRegistered(receipt, P, 'B0-candidate-uninstall');
  await x.cleanSlate(receipt, P);

  const scenario = async (name, version, upgrade, { language, after: afterUninstall } = {}) => {
    const S = `B-${name}`;
    if (!files[version]) { receipt.add(S, 'old-installer', 'skip', `${version} download failed or did not match its pin`); return; }
    await x.cleanSlate(receipt, S);
    const old = await x.install(receipt, S, files[version], { id: `install-${version}-silent` });
    if (!old) return;
    const oldPrint = await x.fingerprint(old);
    receipt.expect(S, 'old-differs-from-candidate', !x.sameFingerprint(oldPrint, candidate, [W.join('resources', 'app.asar')]), `${version}: ${JSON.stringify(oldPrint)}`);
    const seeded = await x.seedData();
    const before = x.presentRoots();
    if (language) {
      // The state an interactive 1.5.x install leaves (it saves the chosen language).
      await x.sys.run('reg.exe', ['add', LOCATION_KEY, '/v', 'Installer Language', '/t', 'REG_SZ', '/d', language, '/f']);
      receipt.info(S, 'saved-language', `${LOCATION_KEY}\\Installer Language = ${language} (as an interactive install leaves it)`);
    } else receipt.info(S, 'saved-language', `${LOCATION_KEY}\\Installer Language = ${(await x.reg(LOCATION_KEY)).values?.['Installer Language'] ?? 'absent'} (silent ${version} install)`);
    const result = await upgrade(S, old);
    receipt.info(S, 'stopped-own-processes', (await x.stopOwn(old)) || 'none');
    const after = await x.fingerprint(old);
    const key = await x.reg(UNINSTALL_KEY);
    const upgraded = `${result.detail}; installed ${JSON.stringify(after)}; key ${key.state} ${key.values?.DisplayVersion ?? ''}`;
    if (result.skipped) receipt.add(S, 'upgrade-completes', 'skip', `not exercised: ${upgraded}`);
    else receipt.expect(S, 'upgrade-completes', result.ok && x.sameFingerprint(after, candidate) && key.state === 'present', upgraded);
    let data = await x.kept(before, seeded);
    receipt.expect(S, 'data-retained-after-upgrade', data.ok, data.detail);
    if (!x.sameFingerprint(after, candidate)) {
      // Recovery the user has: a silent install of the candidate over it.
      const repaired = await x.install(receipt, S, x.options.installer, { id: 'recovery-silent-install' });
      if (repaired) receipt.expect(S, 'recovered-by-silent-install', x.sameFingerprint(await x.fingerprint(repaired), candidate), JSON.stringify(await x.fingerprint(repaired)));
    }
    await x.uninstallRegistered(receipt, S, 'uninstall-after-upgrade-completes');
    if (afterUninstall) await afterUninstall(S);
    data = await x.kept(before, seeded);
    receipt.expect(S, 'data-retained-after-uninstall', data.ok, data.detail);
    const again = await x.install(receipt, S, x.options.installer, { id: 'reinstall-after-uninstall' });
    if (again) {
      receipt.expect(S, 'reinstall-is-candidate', x.sameFingerprint(await x.fingerprint(again), candidate), again);
      await x.uninstallRegistered(receipt, S, 'final-uninstall');
    }
    await x.cleanSlate(receipt, S);
  };
  const passive = async (S, args, old) => {
    const run = await x.execWatchingLanguage(x.options.installer, args, { timeout: 300_000 });
    let owner = '';
    if (run.dialog) {
      const pid = /^(\d+)/.exec(run.dialog)?.[1];
      owner = pid ? (await x.sys.powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`)).stdout.trim() : '';
      const n6 = owner && same(owner, W.join(old, 'uninstall.exe'));
      receipt.info(S, 'language-dialog-owner', `${run.dialog}; ${owner || 'owner exited'}${n6 ? ' = the installed old uninstaller running in place (review N6: not fixable in the new product)' : ''}`);
    }
    receipt.expect(S, 'never-stops-at-language', !run.dialog, run.dialog ? `stopped at ${run.dialog}` : `no language chooser in ${run.seconds} s`);
    return { ok: run.code === 0 && !run.dialog, detail: `setup ${args.join(' ')} exit ${run.code}${run.timedOut ? ' (TIMED OUT)' : ''} in ${run.seconds} s` };
  };
  // (1) The in-app updater hands the installer `/P /UPDATE /R` (windows_handoff.rs).
  await scenario('1-updater-handoff', '1.5.1', async (S, old) => {
    // The login item exactly as auto-launch 0.6.0 writes it for this installation
    // (`<exe> `), and a synthetic keyring entry under the App's service name: an
    // update must keep both; the later uninstall removes only the login item.
    const item = `${W.join(old, EXE)} `;
    await x.sys.run('reg.exe', ['add', RUN_KEY, '/v', 'TaroBot', '/t', 'REG_SZ', '/d', item, '/f']);
    await x.sys.run('cmdkey.exe', [`/generic:${SYNTHETIC_CREDENTIAL}`, '/user:tarobird-acceptance', '/pass:synthetic-not-a-secret']);
    const credentialsBefore = await credentialTargets(x.sys);
    const result = await passive(S, ['/P', '/UPDATE', '/R'], old);
    await x.sys.sleep(8000);
    const running = (await appProcesses(x.sys, EXE) ?? []).filter(item => item.path && same(W.dirname(item.path), old));
    receipt.info(S, 'relaunched-by-R', running.length ? `${running.map(item => item.pid).join(', ')} from ${old}` : 'no App process after /R');
    const kept = (await x.reg(RUN_KEY)).values?.TaroBot;
    receipt.expect(S, 'login-item-kept-by-update', kept === item, `${RUN_KEY}\\TaroBot = ${JSON.stringify(kept ?? null)} (seeded ${JSON.stringify(item)})`);
    const credentialsAfter = await credentialTargets(x.sys);
    receipt.expect(S, 'synthetic-keyring-entry-kept-by-update', !!credentialsBefore?.some(t => t.includes(SYNTHETIC_CREDENTIAL)) && !!credentialsAfter?.some(t => t.includes(SYNTHETIC_CREDENTIAL)),
      `proxy only (no paired device key exists on a runner): ${SYNTHETIC_CREDENTIAL} before ${credentialsBefore?.length ?? 'unreadable'}, after ${credentialsAfter?.length ?? 'unreadable'}`);
    return result;
  }, { after: async S => {
    const item = (await x.reg(RUN_KEY)).values?.TaroBot;
    receipt.expect(S, 'login-item-removed-by-uninstall', item === undefined, `${RUN_KEY}\\TaroBot = ${JSON.stringify(item ?? null)} (it named this installation)`);
    const credentials = await credentialTargets(x.sys);
    receipt.expect(S, 'synthetic-keyring-entry-kept-by-uninstall', !!credentials?.some(t => t.includes(SYNTHETIC_CREDENTIAL)), `data-keeping uninstall leaves keyring entries; ${credentials?.length ?? 'unreadable'} TaroBird targets`);
    await x.sys.run('cmdkey.exe', [`/delete:${SYNTHETIC_CREDENTIAL}`]);
    await x.sys.run('reg.exe', ['delete', RUN_KEY, '/v', 'TaroBot', '/f']);
  } });
  // (2) Same-version /P: reinst_uninstall runs the INSTALLED 1.5.1 uninstaller in place.
  await scenario('2a-passive-silent-1.5.1', '1.5.1', (S, old) => passive(S, ['/P'], old));
  await scenario('2b-passive-after-interactive-1.5.1', '1.5.1', (S, old) => passive(S, ['/P'], old), { language: '1033' });
  // (3) GUI default for an older install is "uninstall before installing"; 1.5.1 is the
  // candidate's own version, whose default is "add/reinstall", so 1.5.0 is used.
  await scenario('3-gui-default-from-1.5.0', '1.5.0', async (S) => {
    const ui = await driveInstaller(x);
    receipt.info(S, 'ui-events', describe(ui));
    if (ui.error || !ui.seen) { receipt.add(S, 'gui-driven', 'skip', `the installer UI could not be driven: ${describe(ui)}`); return { ok: false, skipped: true, detail: 'GUI not driven' }; }
    const pages = (ui.events ?? []).map(e => e.kind);
    receipt.expect(S, 'gui-took-uninstall-before-install', pages.includes('reinstall-page') && (ui.events ?? []).some(e => e.kind === 'old-uninstaller'), describe(ui));
    if (ui.stuck) receipt.add(S, 'gui-driven', 'skip', `stuck: ${(ui.events ?? []).find(e => e.kind === 'stuck')?.detail ?? ''}`);
    return { ok: ui.exit === 0 && !ui.stuck, skipped: ui.stuck, detail: `GUI setup exit ${ui.exit}${ui.stuck ? ' (stuck)' : ''} in ${ui.seconds} s` };
  });
}

/** Runs the candidate installer interactively while the install driver presses
 * through it; returns the driver's events and the installer's exit code. */
async function driveInstaller(x) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'windows-install-ui-driver.ps1'), '-TimeoutSec', '300'];
  const driver = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', driverDone = false;
  driver.stdout.on('data', chunk => { stdout += chunk; }); driver.stderr.on('data', chunk => { stderr += chunk; });
  const driverExit = new Promise(resolve => { driver.once('exit', () => { driverDone = true; resolve(); }); driver.once('error', error => { driverDone = true; stderr += String(error); resolve(); }); });
  const setup = spawn(x.options.installer, [], { windowsHide: false, stdio: 'ignore' });
  const exit = await Promise.race([new Promise(resolve => { setup.once('exit', code => resolve(code)); setup.once('error', () => resolve(1)); }), x.sys.sleep(330_000).then(() => 'timeout')]);
  if (exit === 'timeout') spawn('taskkill.exe', ['/PID', String(setup.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () => {});
  await Promise.race([driverExit, x.sys.sleep(30_000)]);
  if (!driverDone) driver.kill();
  try { return { ...JSON.parse(stdout.trim().split(/\r?\n/).pop()), exit: exit === 'timeout' ? -1 : exit }; } catch { return { error: `${stdout.slice(-800)} ${stderr.slice(-800)}`, events: [], exit }; }
}
const describe = ui => ui.error ? `driver error: ${ui.error}` : `seen ${ui.seen}, stuck ${ui.stuck}, ${ui.seconds}s, setup exit ${ui.exit}; events: ${(ui.events ?? []).map(e => `${e.kind}${e.detail ? `=${String(e.detail).slice(0, 160)}` : ''}`).join(' → ')}`;

/** windows-acceptance.mjs needs a pristine profile for its preflight: move any
 * earlier data aside (renamed, never deleted) and clear the remembered location. */
async function pristine(x, receipt, phase) {
  await x.cleanSlate(receipt, phase);
  let n = 0;
  for (const root of x.presentRoots()) {
    const aside = W.join(W.dirname(root), `TaroBird-acceptance-aside-${Date.now()}-${++n}`);
    await x.sys.run('cmd.exe', ['/d', '/c', 'move', root, aside]);
    receipt.info(phase, 'moved-aside', `${root} -> ${aside} (${existsSync(root) ? 'STILL PRESENT' : 'moved'})`);
  }
}

/** B-E: Electron 1.5.1 → candidate through windows-acceptance.mjs's own
 * --next-installer path (scope update). Its install/first-launch checks judge
 * the published 1.5.1 build, so they are recorded as evidence only; update,
 * update-launch and uninstall (the candidate's) are judged. */
async function electronToElectron(x, receipt, oldInstaller) {
  const P = 'B-E-electron-to-electron';
  if (!oldInstaller) { receipt.add(P, 'old-installer', 'skip', '1.5.1 download failed or did not match its pin'); return; }
  await pristine(x, receipt, P);
  const { report } = await runAcceptance({ installer: oldInstaller, nextInstaller: x.options.installer, version: '1.5.1', nextVersion: x.options.version, confirmed: true, scopes: ['update'] }, x.sys);
  const judged = new Set(['preflight', 'update', 'update-launch', 'uninstall']);
  for (const check of report.checks) {
    if (judged.has(check.phase) && check.status !== 'info') receipt.add(`${P}/${check.phase}`, check.id, check.status, check.detail);
    else receipt.info(`${P}/${check.phase}`, check.id, `[${check.status}${judged.has(check.phase) ? '' : ', published 1.5.1 baseline, not judged here'}] ${check.detail}`);
  }
  receipt.expect(P, 'update-scope-complete', report.missing.length === 0, `windows-acceptance.mjs outcome ${report.outcome}; missing ${report.missing.join(', ') || 'none'}`);
}

const codeUnits = hex => (hex ?? '').trim().split(/\s+/).filter(Boolean).map(unit => parseInt(unit, 16));
const unitsText = units => units.map(unit => `U+${unit.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
/** The three code units before "TB-" (expected U+0020 U+00B7 U+0020). */
const beforeCode = units => { for (let i = 3; i < units.length - 2; i++) if (units[i] === 0x54 && units[i + 1] === 0x42 && units[i + 2] === 0x2d) return units.slice(i - 3, i); return undefined; };
const SEPARATOR = [0x20, 0xb7, 0x20];

async function driveDialog(x, { release }) {
  const releaseFile = W.join(x.tmp, `dlg-release-${Date.now()}.flag`), releasedFile = `${releaseFile}.done`, outFile = `${releaseFile}.json`;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'windows-dialog-text-driver.ps1'), '-TimeoutSec', '240',
    '-ReleaseFile', releaseFile, '-ReleasedFile', releasedFile, '-OutFile', outFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '', done = false; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => { child.once('exit', () => { done = true; resolve(); }); child.once('error', error => { done = true; stderr += String(error); resolve(); }); });
  let released = false;
  const deadline = Date.now() + 300_000;
  while (!done && Date.now() < deadline) {
    if (!released && existsSync(releaseFile)) { await release(); await writeFile(releasedFile, 'done'); released = true; }
    await Promise.race([exited, x.sys.sleep(500)]);
  }
  if (!done) child.kill();
  try { return { ...JSON.parse((await readFile(outFile, 'utf8')).replace(/^\uFEFF/, '')), released }; } catch { return { error: stderr.slice(-800) || 'no driver output', events: [], released }; }
}

/** D: is the diagnostic dialog's separator really U+00B7 on screen? */
async function groupD(x, receipt) {
  const P = 'D-dialog-text';
  // What Windows PowerShell 5.1's default (redirected) console output makes of
  // U+00B7 and U+2014: explains a U+FFFD read from a driver's stdout.
  const probe = await new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([string][char]0xB7 + [string][char]0x2014); [Console]::Out.Write("|" + [Console]::OutputEncoding.WebName)'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('exit', () => resolve(Buffer.concat(chunks))); child.once('error', () => resolve(Buffer.alloc(0)));
  });
  const bar = probe.indexOf(0x7c), payload = bar >= 0 ? probe.subarray(0, bar) : probe;
  receipt.info(P, 'default-console-transport', `U+00B7 U+2014 written by powershell.exe to a pipe arrive as bytes ${payload.toString('hex') || '(none)'} (console encoding ${bar >= 0 ? probe.subarray(bar + 1).toString('latin1') : '?'}); read as UTF-8: ${JSON.stringify(payload.toString('utf8'))}`);
  for (const [label, language] of [['en', undefined], ['zh', '2052']]) {
    const S = `${P}-${label}`;
    await x.cleanSlate(receipt, S);
    const dir = await x.install(receipt, S, x.options.installer, { id: 'install' });
    if (!dir) continue;
    if (language) {
      // Display language only, to read the Chinese dialog; never used for a /P judgement.
      await x.sys.run('reg.exe', ['add', LOCATION_KEY, '/v', 'Installer Language', '/t', 'REG_SZ', '/d', language, '/f']);
      receipt.info(S, 'display-language', `${LOCATION_KEY}\\Installer Language = ${language} (for reading the Chinese dialog only)`);
    }
    const held = await x.lock(W.join(dir, LOCK_TARGET));
    if (!held.held) { receipt.add(S, 'induce-locked-file', 'skip', held.detail); await held.release(); continue; }
    x.sys.launch(W.join(dir, 'uninstall.exe'));
    const ui = await driveDialog(x, { release: held.release });
    await held.release();
    const ev = kind => (ui.events ?? []).find(e => e.kind === kind)?.detail;
    receipt.info(S, 'ui-events', ui.error ? `driver error: ${ui.error}` : (ui.events ?? []).map(e => e.kind).join(' → '));
    if (!ui.captured) { receipt.add(S, 'dialog-captured', 'skip', `no diagnostic dialog was read: ${ui.error ?? JSON.stringify(ui.left ?? [])}`); await x.cleanSlate(receipt, S); continue; }
    receipt.info(S, 'dialog-text-uia', ev('problem-uia'));
    receipt.info(S, 'dialog-text-win32', ev('problem-win32'));
    for (const [source, hex] of [['uia', ev('problem-uia-hex')], ['win32', ev('problem-win32-hex')]]) {
      const units = codeUnits(hex);
      const sep = beforeCode(units);
      receipt.expect(S, `separator-is-U+00B7-${source}`, !!sep && sep.every((unit, i) => unit === SEPARATOR[i]), `code units before "TB-": ${sep ? unitsText(sep) : 'TB- not found'}`);
      receipt.expect(S, `no-replacement-char-${source}`, units.length > 0 && !units.includes(0xfffd), `${units.length} code units; U+FFFD ${units.includes(0xfffd) ? 'PRESENT' : 'absent'}; U+2014 ${units.includes(0x2014) ? 'present' : 'absent'}${label === 'zh' ? `; CJK units ${units.filter(u => u >= 0x4e00 && u <= 0x9fff).length}` : ''}`);
      if (label === 'zh') receipt.expect(S, `chinese-text-${source}`, units.some(u => u >= 0x4e00 && u <= 0x9fff), `CJK units ${units.filter(u => u >= 0x4e00 && u <= 0x9fff).length}`);
    }
    const note = (await x.noteLines())?.findLast(line => line.includes('TB-FILES-REMOVE'));
    if (note) {
      const units = [...note].map(ch => ch.codePointAt(0));
      receipt.info(S, 'setup-note-separator', `setup notes: code units before "TB-": ${unitsText(beforeCode(units) ?? [])}; U+FFFD ${units.includes(0xfffd) ? 'present' : 'absent'}`);
    } else receipt.info(S, 'setup-note-separator', 'no TB-FILES-REMOVE line in setup notes');
    for (let waited = 0; waited < 60_000 && (await x.reg(UNINSTALL_KEY)).state !== 'absent'; waited += 2000) await x.sys.sleep(2000);
    receipt.expect(S, 'retry-completes-uninstall', ui.released && (await x.reg(UNINSTALL_KEY)).state === 'absent', `released ${ui.released}; uninstall key ${(await x.reg(UNINSTALL_KEY)).state}`);
    await x.cleanSlate(receipt, S);
  }
}

/** C: Tauri 1.0.119 → candidate via windows-acceptance.mjs (legacy scope). */
async function groupC(x, receipt) {
  const P = 'C-tauri-to-electron';
  const token = x.sys.env.TAROBOT_LEGACY_RELEASE_TOKEN;
  if (!token) {
    receipt.add(P, 'legacy-installer-available', 'skip', `blocked: ${LEGACY.name} (${LEGACY.version}, sha256 ${LEGACY.sha256}) is a release asset of the private, archived ${LEGACY.repository}; anonymous download is 404 and GITHUB_TOKEN only reads this repository. Needs an owner-provided read-only token (TAROBOT_LEGACY_RELEASE_TOKEN); not run`);
    return;
  }
  const file = W.join(x.tmp, 'releases', LEGACY.name);
  const got = await download(x.sys, LEGACY, file, { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' });
  receipt.expect(P, 'legacy-download-pinned', got.ok, got.detail.replace(token, '***'));
  if (!got.ok) return;
  // The existing path; its preflight needs a pristine profile (C runs first).
  await pristine(x, receipt, P);
  const { report } = await runAcceptance({ installer: x.options.installer, legacyInstaller: file, version: x.options.version, confirmed: true, scopes: ['install', 'upgrade'] }, x.sys);
  for (const check of report.checks) receipt.add(`${P}/${check.phase}`, check.id, check.status, check.detail);
  receipt.info(P, 'legacy-outcome', `windows-acceptance.mjs outcome ${report.outcome}; missing ${report.missing.join(', ') || 'none'}`);
  // Record what an updater-style upgrade leaves in the old <install>\host (the real
  // upgraded machine kept a host\ with only node-runtime.exe).
  await x.cleanSlate(receipt, P);
  const legacyDir = await x.install(receipt, P, file, { id: 'legacy-silent-install' });
  if (!legacyDir) return;
  const list = async dir => { try { return (await readdir(dir, { recursive: true })).join(', ') || '(empty)'; } catch { return '(absent)'; } };
  receipt.info(P, 'legacy-host-before', `${W.join(legacyDir, 'host')}: ${await list(W.join(legacyDir, 'host'))}`);
  const upgraded = await x.install(receipt, P, x.options.installer, { args: ['/P', '/UPDATE'], id: 'candidate-P-UPDATE-over-legacy' });
  if (upgraded) {
    const left = await list(W.join(upgraded, 'host'));
    receipt.expect(P, 'legacy-host-removed-after-update', left === '(absent)', `${W.join(upgraded, 'host')}: ${left}`);
  }
  await x.cleanSlate(receipt, P);
}

const RUNNERS = { A: groupA, B: groupB, C: groupC, D: groupD };

export async function run(options, sys = windowsSystem()) {
  const receipt = new Receipt();
  const meta = { startedAt: new Date().toISOString(), groups: options.groups, version: options.version, image: `${sys.env.ImageOS ?? ''} ${sys.env.ImageVersion ?? ''}`.trim() };
  const problems = [];
  if (sys.platform !== 'win32') problems.push('Windows is required');
  if (!options.confirmed || sys.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable') problems.push('set TAROBOT_WINDOWS_ACCEPTANCE=disposable and pass --confirm-disposable-windows');
  if (sys.env.RUNNER_ENVIRONMENT !== 'github-hosted') problems.push('only a disposable GitHub-hosted runner is allowed (RUNNER_ENVIRONMENT)');
  if (!sys.env.APPDATA || !sys.env.LOCALAPPDATA) problems.push('APPDATA/LOCALAPPDATA are unavailable');
  if (problems.length) { for (const problem of problems) receipt.add('preflight', 'disposable-runner', 'fail', problem); return { receipt, meta }; }
  receipt.add('preflight', 'disposable-runner', 'pass', `GitHub-hosted ${meta.image}`);
  await mkdir(options.temp, { recursive: true });
  const x = makeExtension(sys, options);
  const deadline = Date.now() + (options.budgetMinutes ?? 80) * 60_000;
  for (const group of options.groups) {
    if (Date.now() > deadline) { receipt.add(group, 'not-run', 'skip', 'the time budget was spent before this group'); continue; }
    console.log(`${stamp()} group ${group} starts`);
    try { await RUNNERS[group](x, receipt); }
    catch (error) { receipt.add(group, 'unexpected-error', 'fail', error instanceof Error ? error.stack ?? error.message : String(error)); }
  }
  return { receipt, meta };
}

async function main() {
  const { values } = parseArgs({ options: {
    installer: { type: 'string' }, version: { type: 'string' }, report: { type: 'string' }, groups: { type: 'string' }, 'budget-minutes': { type: 'string' },
    'custom-root': { type: 'string' }, 'confirm-disposable-windows': { type: 'boolean', default: false },
  } });
  if (!values.installer || !values.report || !values.version) throw new Error('--installer, --version and --report are required');
  const report = path.resolve(values.report);
  if (!report.split(/[\\/]/).some(part => part.endsWith('.noindex'))) throw new Error('--report must be inside a .noindex directory');
  const groups = values.groups ? values.groups.split(',').map(item => item.trim()) : GROUPS;
  for (const group of groups) if (!Object.hasOwn(RUNNERS, group)) throw new Error(`unknown group ${group} (${GROUPS.join(', ')})`);
  const { receipt, meta } = await run({ installer: path.resolve(values.installer), version: values.version, groups, confirmed: values['confirm-disposable-windows'],
    temp: path.join(report, 'work'), customRoot: values['custom-root'] ?? process.env.RUNNER_TEMP ?? path.join(report, 'custom'), budgetMinutes: Number(values['budget-minutes'] ?? 80) });
  await mkdir(report, { recursive: true });
  await writeFile(path.join(report, 'windows-extension.json'), `${JSON.stringify({ outcome: receipt.outcome, ...meta, finishedAt: new Date().toISOString(), checks: receipt.checks }, null, 2)}\n`);
  await writeFile(path.join(report, 'windows-extension.md'), receipt.markdown(meta));
  console.log(JSON.stringify({ outcome: receipt.outcome, failed: receipt.checks.filter(c => c.status === 'fail').map(c => `${c.phase}/${c.id}`), skipped: receipt.checks.filter(c => c.status === 'skip').map(c => `${c.phase}/${c.id}`) }));
  process.exitCode = receipt.outcome === 'pass' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
