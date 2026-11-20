// #50 acceptance on a DISPOSABLE GitHub-hosted Windows runner: data-keeping
// uninstall, recoverable uninstall failures (retry / reinstall-to-repair), the
// installer's in-place `_?=` uninstall, the native backup/reset helper with its
// rollback and diagnostic exit codes, and the interactive diagnostic and
// backup-consent dialogs. It installs and uninstalls for the runner user and
// writes only synthetic data, so it refuses anything but a GitHub-hosted runner.
//
//   set TAROBOT_WINDOWS_ACCEPTANCE=disposable
//   node scripts/windows-uninstall-recovery-acceptance.mjs --confirm-disposable-windows \
//     --installer <TaroBird_x.y.z_x64-setup.exe> --version x.y.z --report <dir containing .noindex>
//     [--cases silent-locked,silent-repair,inplace,helper,gui-locked,gui-consent]
//
// pass/fail/skip per check; a skip (e.g. the cause could not be induced or the
// UI could not be driven) is never a pass. `info` is evidence, never judged.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appProcesses, EXE, LOCATION_KEY, PROTOCOL_KEY, registryScript, UNINSTALL_KEY, windowsSystem } from './windows-acceptance.mjs';

const W = path.win32;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = 'tarobot-installer-helper.exe';
const APP_IDS = ['com.tarobot.client', 'com.tarocub.client'];
// A program file the uninstaller deletes but that `--clear-notification-history`
// (run before file removal) does not load; locking app.asar would stop earlier.
const LOCK_TARGET = ['resources', 'native', 'tarobot-migration-exporter.exe'];
const ALL_CASES = ['silent-locked', 'silent-repair', 'inplace', 'gui-rerun-after-partial', 'helper', 'gui-locked', 'gui-consent'];
const SYNTHETIC = 'tarobird-acceptance-synthetic.txt';

class Receipt {
  checks = [];
  add(phase, id, status, detail = '') {
    const check = { phase, id, status, detail: String(detail).slice(0, 4000) };
    this.checks.push(check);
    // Stream each check so a hung step still leaves evidence in the job log.
    console.log(`[${new Date().toISOString()}] ${status.toUpperCase()} ${phase}/${id} — ${check.detail.replaceAll('\n', ' ').slice(0, 600)}`);
    return status === 'pass';
  }
  expect(phase, id, ok, detail) { return this.add(phase, id, ok ? 'pass' : 'fail', detail); }
  info(phase, id, detail) { this.add(phase, id, 'info', detail); }
  get outcome() { return this.checks.some(c => c.status === 'fail') ? 'fail' : this.checks.some(c => c.status === 'skip') ? 'incomplete' : 'pass'; }
  markdown(meta) {
    const label = { pass: '✅ pass', fail: '❌ fail', skip: '⏭ skip', info: 'ℹ info (not judged)' };
    const rows = this.checks.map(c => `| ${c.phase} | ${c.id} | ${label[c.status]} | ${c.detail.replaceAll('|', '\\|').replaceAll('\r', '').replaceAll('\n', ' ')} |`);
    return `# #50 Windows uninstall recovery acceptance (${meta.startedAt})\n\nOutcome: **${this.outcome}**. Cases: ${meta.cases.join(', ')}. Skips are not passes.\n\n| case | check | status | detail |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  }
}

const unquote = value => value?.trim().replace(/^"(.*)"$/, '$1');
const ps = s => s.replaceAll("'", "''");

const stamp = () => `[${new Date().toISOString()}]`;
const PROCESS_SNAPSHOT = `Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(tarocub-client|Un|Un_A|Au_|tarobot-installer-helper|tarobot-desktop-updater|node|.*setup)\\.exe$' } | ForEach-Object { "$($_.ProcessId) <- $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }
Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "window $($_.Id) $($_.ProcessName): $($_.MainWindowTitle)" }`;

/** Exit-code runner that never waits on inherited pipes (an NSIS child such as
 * an Electron helper can keep them open) and, on timeout, records what was
 * still running and which windows were open, then ends the whole tree. */
export function timedRunner(sys) {
  if (sys.runTimed) return sys.runTimed;
  return (file, args, { timeout, capture = false } = {}) => new Promise(resolve => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const child = spawn(file, args, { windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore' });
    if (capture) { child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); }
    const finish = code => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code ?? 1, timedOut, seconds: Math.round((Date.now() - started) / 1000), stdout, stderr });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      const snapshot = (await sys.powershell(PROCESS_SNAPSHOT)).stdout.trim();
      console.log(`${stamp()} TIMEOUT ${W.basename(file)} ${args.join(' ')} after ${Math.round(timeout / 1000)} s; still running / open windows:\n${snapshot}`);
      spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('error', () => {});
      setTimeout(() => finish(-1), 10_000);
    }, timeout);
    child.once('error', error => { stderr += String(error); finish(1); });
    child.once('exit', code => finish(code));
  });
}

export function makeContext(sys, options) {
  const tmp = options.temp;
  const exec = timedRunner(sys);
  const outcome = result => `exit ${result.code}${result.timedOut ? ' (TIMED OUT, tree killed)' : ''} in ${result.seconds} s`;
  const env = sys.env;
  const bases = [env.APPDATA, env.LOCALAPPDATA];
  const roots = bases.flatMap(base => APP_IDS.map(id => W.join(base, id)));
  const reg = async key => {
    const result = await sys.powershell(registryScript(key));
    try { const value = JSON.parse(result.stdout.trim()); if (['absent', 'present', 'error'].includes(value.state)) return value; } catch { /* below */ }
    return { state: 'error' };
  };
  const state = async () => {
    const uninstall = await reg(UNINSTALL_KEY), link = await reg(PROTOCOL_KEY), location = await reg(LOCATION_KEY);
    return { uninstall, link, location };
  };
  const backups = async () => {
    const found = [];
    for (const base of bases) {
      let names = [];
      try { names = await readdir(base); } catch { /* none */ }
      for (const name of names) if (name.startsWith('TaroBot-backup-')) found.push(W.join(base, name));
    }
    return found.sort();
  };
  const presentRoots = () => roots.filter(root => existsSync(root));
  let counter = 0;
  /** Holds `file` open with FileShare.None in a separate process until released. */
  const lock = async file => {
    const ready = W.join(tmp, `lock-${++counter}.ready`);
    const script = `$ErrorActionPreference = 'Stop'; $f = [System.IO.File]::Open('${ps(file)}', 'Open', 'Read', 'None'); Set-Content -LiteralPath '${ps(ready)}' -Value 'locked'; Start-Sleep -Seconds 1800; $f.Close()`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '', done = false; child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => { child.once('exit', () => { done = true; resolve(); }); child.once('error', error => { done = true; stderr += String(error); resolve(); }); });
    for (let waited = 0; waited < 30_000 && !existsSync(ready) && !done; waited += 250) await sys.sleep(250);
    const held = existsSync(ready) && !done;
    return {
      held, detail: held ? `holding ${file} (FileShare.None, pid ${child.pid})` : `could not lock ${file}: ${stderr.trim().slice(0, 500)}`,
      release: async () => { if (!done) { child.kill(); await Promise.race([exited, sys.sleep(15_000)]); } },
    };
  };
  const install = async (receipt, phase, args = ['/S']) => {
    const result = await exec(options.installer, args, { timeout: 300_000 });
    const location = await reg(LOCATION_KEY), key = await reg(UNINSTALL_KEY);
    const directory = unquote(location.values?.['(Default)']) ?? unquote(key.values?.InstallLocation);
    const ok = result.code === 0 && !!directory && existsSync(W.join(directory, EXE));
    receipt.expect(phase, `install ${args.join(' ')}`, ok, `${outcome(result)}; ${directory ?? 'no location'}; version ${key.values?.DisplayVersion}`);
    // What the installer left running (e.g. a child that keeps inherited handles).
    receipt.info(phase, `after install ${args.join(' ')}: processes/windows`, (await sys.powershell(PROCESS_SNAPSHOT)).stdout.trim() || 'none');
    return ok ? directory : undefined;
  };
  /** Which owned files and keys are left: locates the step a failed run stopped at. */
  const snapshot = async directory => {
    const files = [EXE, W.join(...LOCK_TARGET), 'resources\\app.asar', HELPER, 'uninstall.exe'].map(file => `${file}=${existsSync(W.join(directory, file)) ? 'present' : 'absent'}`);
    const { uninstall, link } = await state();
    return `${files.join(', ')}; uninstall key ${uninstall.state}; deep link ${link.state}`;
  };
  /** Runs the uninstaller from a temp copy against its directory, exactly as
   * NSIS re-launches itself, so the real exit code is observed synchronously. */
  const uninstallSync = async (directory, args = ['/S']) => {
    const folder = W.join(tmp, `uninstaller-${++counter}`);
    await mkdir(folder, { recursive: true });
    const copy = W.join(folder, 'Un.exe');
    await copyFile(W.join(directory, 'uninstall.exe'), copy);
    const result = await exec(copy, [...args, `_?=${directory}`], { timeout: 300_000 });
    console.log(`${stamp()} uninstaller copy ${args.join(' ')} _?=<dir>: ${outcome(result)}`);
    await rm(copy, { force: true }).catch(() => {});
    return result.timedOut ? -1 : result.code;
  };
  /** The registered entry, as Settings → Apps would run it, silently. */
  const uninstallRegistered = async (receipt, phase, id = 'registered-uninstall') => {
    const key = await reg(UNINSTALL_KEY);
    const uninstaller = unquote(key.values?.UninstallString);
    if (!uninstaller || !existsSync(uninstaller)) return receipt.expect(phase, id, false, `UninstallString ${uninstaller ?? 'missing'} is not runnable (${key.state})`);
    const directory = W.dirname(uninstaller);
    const code = await uninstallSync(directory);
    const now = (await reg(UNINSTALL_KEY)).state;
    const left = [EXE, 'uninstall.exe', HELPER, W.join(...LOCK_TARGET)].filter(file => existsSync(W.join(directory, file)));
    return receipt.expect(phase, id, code === 0 && now === 'absent' && !left.length, `exit ${code}; ${await snapshot(directory)}`);
  };
  /** After a partial uninstall: re-run the registered entry (what a user does
   * first); if that cannot finish, the dialog's documented repair: reinstall
   * this version, then uninstall. */
  const recover = async (receipt, phase) => {
    if (await uninstallRegistered(receipt, phase, 'rerun-registered-uninstall-completes')) return;
    const repaired = await install(receipt, phase);
    if (repaired) receipt.info(phase, 'repair-reinstall-state', await snapshot(repaired));
    await uninstallRegistered(receipt, phase, 'uninstall-after-repair-reinstall-completes');
  };
  const ensureUninstalled = async (receipt, phase) => {
    // Only this run's uninstaller copies (NSIS GUI self-copies live in %TEMP%\~nsu*).
    await sys.powershell(`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*\\~nsu*' -or $_.ExecutablePath -like '${ps(tmp)}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    if ((await reg(UNINSTALL_KEY)).state === 'present' && !(await uninstallRegistered(receipt, phase, 'cleanup-uninstall'))) {
      if (await install(receipt, phase)) await uninstallRegistered(receipt, phase, 'cleanup-uninstall-after-repair');
    }
    const running = await appProcesses(sys, EXE);
    if (running?.length) receipt.info(phase, 'cleanup-processes', `still running: ${running.map(p => p.pid).join(', ')}`);
  };
  const seed = async (root, extra = {}) => {
    await mkdir(root, { recursive: true });
    const body = `synthetic #50 acceptance data for ${W.basename(root)}`;
    await writeFile(W.join(root, SYNTHETIC), body);
    for (const [name, value] of Object.entries(extra)) { await mkdir(W.dirname(W.join(root, name)), { recursive: true }); await writeFile(W.join(root, name), value); }
    return body;
  };
  const helper = async (directory, flag) => {
    const result = await exec(W.join(directory, HELPER), [flag], { timeout: 120_000, capture: true });
    return { code: result.code, stderr: `${result.timedOut ? 'TIMED OUT ' : ''}${result.stderr.trim().slice(0, 300)}` };
  };
  return { sys, exec, outcome, options, tmp, bases, roots, reg, state, backups, presentRoots, lock, install, snapshot, uninstallRegistered, uninstallSync, recover, ensureUninstalled, seed, helper };
}

/** A failed silent uninstall must keep the recovery entry and data; a retry of
 * the registered entry then completes. */
async function silentLocked(ctx, receipt, phase) {
  const directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const rootsBefore = ctx.presentRoots();
  const target = W.join(directory, ...LOCK_TARGET);
  const held = await ctx.lock(target);
  if (!held.held) { receipt.add(phase, 'induce-locked-file', 'skip', held.detail); await held.release(); return; }
  receipt.info(phase, 'induce-locked-file', held.detail);
  const code = await ctx.uninstallSync(directory);
  const after = await ctx.state();
  receipt.expect(phase, 'locked-uninstall-refused', code !== 0, `uninstaller exit ${code} (NSIS 2 = aborted by script)`);
  receipt.expect(phase, 'recovery-entry-kept', after.uninstall.state === 'present' && existsSync(W.join(directory, 'uninstall.exe')),
    `uninstall key ${after.uninstall.state}; uninstall.exe ${existsSync(W.join(directory, 'uninstall.exe')) ? 'present' : 'missing'}`);
  receipt.expect(phase, 'deep-link-kept-until-files-removed', after.link.state === 'present', `${PROTOCOL_KEY}: ${after.link.state}`);
  receipt.expect(phase, 'locked-file-kept', existsSync(target), target);
  receipt.info(phase, 'partial-state', await ctx.snapshot(directory));
  receipt.expect(phase, 'data-untouched', JSON.stringify(ctx.presentRoots()) === JSON.stringify(rootsBefore), `roots before ${rootsBefore.length}, after ${ctx.presentRoots().length}`);
  await held.release();
  await ctx.recover(receipt, phase);
  const link = await ctx.reg(PROTOCOL_KEY);
  receipt.expect(phase, 'deep-link-removed-after-recovery', link.state === 'absent' || link.values?.['(Default)'] === undefined, `${PROTOCOL_KEY}: ${link.state}`);
  receipt.expect(phase, 'data-retained-after-recovery', JSON.stringify(ctx.presentRoots()) === JSON.stringify(rootsBefore), `roots ${ctx.presentRoots().join(', ') || 'none'}`);
}

/** The dialog's other recovery: reinstall this version, then uninstall. */
async function silentRepair(ctx, receipt, phase) {
  const directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const held = await ctx.lock(W.join(directory, ...LOCK_TARGET));
  if (!held.held) { receipt.add(phase, 'induce-locked-file', 'skip', held.detail); await held.release(); return; }
  const code = await ctx.uninstallSync(directory);
  receipt.expect(phase, 'locked-uninstall-refused', code !== 0, `uninstaller exit ${code}; ${await ctx.snapshot(directory)}`);
  await held.release();
  const repaired = await ctx.install(receipt, phase);
  if (repaired) {
    const files = [EXE, 'uninstall.exe', HELPER, W.join(...LOCK_TARGET)].filter(file => !existsSync(W.join(repaired, file)));
    receipt.expect(phase, 'reinstall-restores-files', !files.length && repaired.toLowerCase() === directory.toLowerCase(), files.length ? `missing ${files.join(', ')}` : repaired);
  }
  await ctx.uninstallRegistered(receipt, phase, 'uninstall-after-repair-completes');
}

/** The installer's own "uninstall before installing" runs `uninstall.exe _?=<dir>`
 * in place, so the running uninstaller cannot delete itself. Before #50 that
 * Delete failed silently; this records whether it now aborts. */
async function inPlace(ctx, receipt, phase) {
  let directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const inplace = await ctx.exec(W.join(directory, 'uninstall.exe'), ['/S', `_?=${directory}`], { timeout: 300_000 });
  const code = inplace.timedOut ? -1 : inplace.code;
  const after = await ctx.state();
  const left = [EXE, HELPER, W.join(...LOCK_TARGET), 'uninstall.exe'].filter(file => existsSync(W.join(directory, file)));
  receipt.expect(phase, 'inplace-uninstall-completes', code === 0 && after.uninstall.state === 'absent',
    `uninstall.exe /S _?=<dir> ${ctx.outcome(inplace)}; uninstall key ${after.uninstall.state}; left ${left.join(', ') || 'none'}`);
  receipt.info(phase, 'inplace-state', await ctx.snapshot(directory));
  if (after.uninstall.state === 'present') await ctx.recover(receipt, phase);
  else if (existsSync(W.join(directory, 'uninstall.exe'))) receipt.info(phase, 'inplace-self-left', 'uninstall.exe left behind (expected: a running image cannot delete itself)');
  await ctx.ensureUninstalled(receipt, phase);
  // Same-version passive reinstall: PageLeaveReinstall takes reinst_uninstall.
  directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const passive = await ctx.exec(ctx.options.installer, ['/P'], { timeout: 300_000 });
  const key = await ctx.reg(UNINSTALL_KEY);
  const missing = [EXE, 'uninstall.exe', HELPER, W.join(...LOCK_TARGET)].filter(file => !existsSync(W.join(directory, file)));
  receipt.expect(phase, 'passive-same-version-reinstall', passive.code === 0 && key.state === 'present' && !missing.length,
    `setup /P ${ctx.outcome(passive)}; key ${key.state} ${key.values?.DisplayVersion ?? ''}; missing ${missing.join(', ') || 'none'}`);
  if (passive.code !== 0 || missing.length) {
    const repair = await ctx.install(receipt, phase);
    if (repair) receipt.info(phase, 'repair-after-passive', 'silent reinstall restored the installation');
  }
  await ctx.uninstallRegistered(receipt, phase, 'uninstall-after-passive');
}

/** Native backup/reset helper: diagnostic exit codes, no-data, refusal before any
 * move, not-started and rolled-back failures, retry, and key removal. */
async function helperCase(ctx, receipt, phase) {
  const directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const [roaming, local] = ctx.bases;
  const r = id => W.join(roaming, id), l = id => W.join(local, id);
  const real = ctx.presentRoots();
  receipt.info(phase, 'pre-existing-roots', real.join(', ') || 'none (first-launch profile not retained or not created)');
  let res = await ctx.helper(directory, '--confirm-host-stopped-v2');
  receipt.expect(phase, 'host-stopped-clean', res.code === 0, `exit ${res.code} ${res.stderr}`);

  // Live Host owner → 41 from both commands; nothing moved. Keep any real lock.
  const realLock = W.join(l('com.tarobot.client'), 'host', 'instance.lock.json');
  const saved = existsSync(realLock) ? await readFile(realLock) : undefined;
  if (saved) receipt.info(phase, 'pre-existing-host-lock', saved.toString('utf8').slice(0, 300));
  await ctx.seed(l('com.tarobot.client'), { 'host\\instance.lock.json': JSON.stringify({ pid: process.pid }) });
  let before = ctx.presentRoots(), backups = await ctx.backups();
  res = await ctx.helper(directory, '--confirm-host-stopped-v2');
  receipt.expect(phase, 'host-running-confirm-41', res.code === 41, `exit ${res.code} (41 = HostRunning)`);
  res = await ctx.helper(directory, '--prepare-fresh-install-v2');
  receipt.expect(phase, 'host-running-backup-41-nothing-moved', res.code === 41 && JSON.stringify(ctx.presentRoots()) === JSON.stringify(before) && JSON.stringify(await ctx.backups()) === JSON.stringify(backups), `exit ${res.code} ${res.stderr}`);
  if (saved) await writeFile(realLock, saved); else await rm(realLock);
  // Shared CLI service → 40.
  await writeFile(W.join(l('com.tarobot.client'), 'host', 'host-service.json'), '{}');
  res = await ctx.helper(directory, '--prepare-fresh-install-v2');
  receipt.expect(phase, 'shared-service-40-nothing-moved', res.code === 40 && JSON.stringify(ctx.presentRoots()) === JSON.stringify(before), `exit ${res.code} ${res.stderr}`);
  await rm(W.join(l('com.tarobot.client'), 'host', 'host-service.json'));

  // Not started: the first root (roaming) cannot move → 52/53, nothing moved, retry works.
  await ctx.seed(r('com.tarobot.client'));
  before = ctx.presentRoots(); backups = await ctx.backups();
  let held = await ctx.lock(W.join(r('com.tarobot.client'), SYNTHETIC));
  if (held.held) {
    res = await ctx.helper(directory, '--prepare-fresh-install-v2');
    if (res.code === 0) receipt.add(phase, 'first-move-denied-not-started', 'skip', 'a locked file did not block the directory move on this Windows; not induced');
    else receipt.expect(phase, 'first-move-denied-not-started', [52, 53].includes(res.code) && JSON.stringify(ctx.presentRoots()) === JSON.stringify(before) && JSON.stringify(await ctx.backups()) === JSON.stringify(backups),
      `exit ${res.code} ${res.stderr}; roots ${ctx.presentRoots().length}/${before.length}; new backups ${(await ctx.backups()).length - backups.length}`);
  } else receipt.add(phase, 'first-move-denied-not-started', 'skip', held.detail);
  await held.release();

  // Rolled back: roaming moves, then local cannot → 152/153, roaming returned.
  await ctx.seed(r('com.tarobot.client'));
  await ctx.seed(l('com.tarobot.client'));
  before = ctx.presentRoots(); backups = await ctx.backups();
  held = await ctx.lock(W.join(l('com.tarobot.client'), SYNTHETIC));
  if (held.held) {
    res = await ctx.helper(directory, '--prepare-fresh-install-v2');
    if (res.code === 0) receipt.add(phase, 'second-move-denied-rolled-back', 'skip', 'a locked file did not block the directory move on this Windows; not induced');
    else {
      const back = existsSync(W.join(r('com.tarobot.client'), SYNTHETIC));
      receipt.expect(phase, 'second-move-denied-rolled-back', [152, 153].includes(res.code) && back && JSON.stringify(ctx.presentRoots()) === JSON.stringify(before) && JSON.stringify(await ctx.backups()) === JSON.stringify(backups),
        `exit ${res.code} ${res.stderr}; roaming data back ${back}; roots ${ctx.presentRoots().length}/${before.length}; new backups ${(await ctx.backups()).length - backups.length}`);
    }
  } else receipt.add(phase, 'second-move-denied-rolled-back', 'skip', held.detail);
  await held.release();

  const realProfile = existsSync(W.join(l('com.tarobot.client'), 'electron-profile'));
  // Completed: every root (real retained profile + synthetic, incl. legacy id) moves; key removed from backup.
  await ctx.seed(l('com.tarobot.client'), { 'tarobot-client-installation-v1': 'synthetic-installation-key' });
  await ctx.seed(l('com.tarocub.client'));
  await ctx.seed(r('com.tarobot.client'));
  before = ctx.presentRoots(); backups = await ctx.backups();
  res = await ctx.helper(directory, '--prepare-fresh-install-v2');
  const created = (await ctx.backups()).filter(item => !backups.includes(item));
  const moved = before.every(root => {
    const folder = created.find(item => W.dirname(item).toLowerCase() === W.dirname(root).toLowerCase());
    return folder && existsSync(W.join(folder, W.basename(root), SYNTHETIC));
  });
  const keyGone = created.every(folder => !existsSync(W.join(folder, 'com.tarobot.client', 'tarobot-client-installation-v1')));
  const suffixes = new Set(created.map(item => W.basename(item)));
  receipt.expect(phase, 'backup-completed', res.code === 0 && !ctx.presentRoots().length && moved && keyGone && suffixes.size === 1,
    `exit ${res.code}; roots left ${ctx.presentRoots().length}; moved ${moved}; installation key removed ${keyGone}; ${created.length} new backup folder(s) sharing ${suffixes.size} name(s)`);
  if (realProfile) {
    const folder = created.find(item => W.dirname(item).toLowerCase() === local.toLowerCase());
    receipt.expect(phase, 'real-profile-moved', !!folder && existsSync(W.join(folder, 'com.tarobot.client', 'electron-profile')), folder ?? 'no local backup folder');
  } else receipt.add(phase, 'real-profile-moved', 'skip', 'no retained first-launch profile in this run');
  // No data now → 10; earlier backups untouched.
  backups = await ctx.backups();
  res = await ctx.helper(directory, '--prepare-fresh-install-v2');
  receipt.expect(phase, 'no-data-10-backups-kept', res.code === 10 && JSON.stringify(await ctx.backups()) === JSON.stringify(backups), `exit ${res.code}; backups ${backups.length}`);
  await ctx.uninstallRegistered(receipt, phase, 'uninstall-after-helper');
}

async function driveUi(ctx, mode, { release } = {}) {
  const releaseFile = W.join(ctx.tmp, `ui-release-${Date.now()}.flag`), releasedFile = `${releaseFile}.done`;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'windows-uninstall-ui-driver.ps1'), '-Mode', mode, '-TimeoutSec', '180'];
  if (release) args.push('-ReleaseFile', releaseFile, '-ReleasedFile', releasedFile);
  const child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  let done = false;
  const exited = new Promise(resolve => { child.once('exit', () => { done = true; resolve(); }); child.once('error', error => { done = true; stderr += String(error); resolve(); }); });
  let released = false;
  // The driver has its own 180 s budget; never wait for it much longer.
  const deadline = Date.now() + 240_000;
  while (!done && Date.now() < deadline) {
    if (release && !released && existsSync(releaseFile)) { await release(); await writeFile(releasedFile, 'done'); released = true; }
    await Promise.race([exited, ctx.sys.sleep(500)]);
  }
  if (!done) child.kill();
  try { return { ...JSON.parse(stdout.trim().split(/\r?\n/).pop()), released }; } catch { return { error: `${stdout.slice(-1000)} ${stderr.slice(-1000)}`, events: [], released }; }
}
const describe = ui => ui.error ? `driver error: ${ui.error}` : `seen ${ui.seen}, closed ${ui.closed}, ${ui.seconds}s; events: ${(ui.events ?? []).map(e => `${e.kind}${e.kind === 'answer' || e.kind === 'confirm-page' ? `=${e.detail}` : ''}`).join(' → ')}; left ${JSON.stringify(ui.left ?? [])}`;

async function launchGui(ctx, directory) {
  // Like Settings → Apps: the registered uninstaller with its normal GUI.
  ctx.sys.launch(W.join(directory, 'uninstall.exe'));
}

/** Interactive diagnostic dialog for a locked program file, then Retry. */
async function guiLocked(ctx, receipt, phase) {
  const directory = await ctx.install(receipt, phase);
  if (!directory) return;
  await ctx.seed(W.join(ctx.bases[1], 'com.tarobot.client'));
  const rootsBefore = ctx.presentRoots();
  const held = await ctx.lock(W.join(directory, ...LOCK_TARGET));
  if (!held.held) { receipt.add(phase, 'induce-locked-file', 'skip', held.detail); await held.release(); return; }
  await launchGui(ctx, directory);
  const ui = await driveUi(ctx, 'keep', { release: held.release });
  await held.release();
  receipt.info(phase, 'ui-events', describe(ui));
  if (ui.error || !ui.seen) { receipt.add(phase, 'diagnostic-dialog', 'skip', `the uninstaller UI could not be driven: ${describe(ui)}`); return; }
  const problem = (ui.events ?? []).find(e => e.kind === 'problem')?.detail ?? '';
  receipt.info(phase, 'diagnostic-text', problem || 'none');
  receipt.expect(phase, 'diagnostic-dialog', /TB-FILES-REMOVE/.test(problem) && /Removing program files/.test(problem) && problem.includes(`TaroBird ${ctx.options.version}`),
    problem ? 'stage, code and version shown' : 'no diagnostic dialog appeared');
  receipt.expect(phase, 'retry-offered-and-used', ui.released && (ui.events ?? []).some(e => e.kind === 'answer' && e.detail === 'Retry'), describe(ui));
  for (let waited = 0; waited < 60_000 && (await ctx.reg(UNINSTALL_KEY)).state !== 'absent'; waited += 2000) await ctx.sys.sleep(2000);
  const key = (await ctx.reg(UNINSTALL_KEY)).state;
  const left = [EXE, 'uninstall.exe', W.join(...LOCK_TARGET)].filter(file => existsSync(W.join(directory, file)));
  receipt.expect(phase, 'retry-completes-uninstall', key === 'absent' && !left.length, `uninstall key ${key}; left ${left.join(', ') || 'none'}`);
  receipt.expect(phase, 'data-retained', JSON.stringify(ctx.presentRoots()) === JSON.stringify(rootsBefore), `roots ${ctx.presentRoots().join(', ') || 'none'}`);
}

/** A user re-running the uninstaller (GUI) after a partial silent uninstall:
 * records the verbatim first diagnostic, then the documented repair. */
async function guiRerunAfterPartial(ctx, receipt, phase) {
  const directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const held = await ctx.lock(W.join(directory, ...LOCK_TARGET));
  if (!held.held) { receipt.add(phase, 'induce-locked-file', 'skip', held.detail); await held.release(); return; }
  const code = await ctx.uninstallSync(directory);
  await held.release();
  receipt.info(phase, 'partial-state', `exit ${code}; ${await ctx.snapshot(directory)}`);
  if (code === 0) { receipt.add(phase, 'rerun-gui-completes', 'skip', 'the partial uninstall was not induced'); return; }
  await launchGui(ctx, directory);
  const ui = await driveUi(ctx, 'keep');
  receipt.info(phase, 'ui-events', describe(ui));
  if (ui.error || !ui.seen) receipt.add(phase, 'rerun-gui-completes', 'skip', `the uninstaller UI could not be driven: ${describe(ui)}`);
  else {
    const problem = (ui.events ?? []).find(e => e.kind === 'problem')?.detail;
    receipt.info(phase, 'first-diagnostic-text', problem ?? 'none');
    for (let waited = 0; waited < 30_000 && (await ctx.reg(UNINSTALL_KEY)).state !== 'absent'; waited += 2000) await ctx.sys.sleep(2000);
    receipt.expect(phase, 'rerun-gui-completes', !problem && (await ctx.reg(UNINSTALL_KEY)).state === 'absent', `${problem ? `stopped: ${problem.slice(0, 400)}` : 'no diagnostic'}; ${await ctx.snapshot(directory)}`);
  }
  await ctx.ensureUninstalled(receipt, phase);
}

/** Interactive "Back up and reset local data" with consent. */
async function guiConsent(ctx, receipt, phase) {
  const directory = await ctx.install(receipt, phase);
  if (!directory) return;
  const [roaming, local] = ctx.bases;
  await ctx.seed(W.join(roaming, 'com.tarobot.client'));
  await ctx.seed(W.join(local, 'com.tarobot.client'), { 'tarobot-client-installation-v1': 'synthetic-installation-key' });
  const before = ctx.presentRoots(), backups = await ctx.backups();
  await launchGui(ctx, directory);
  const ui = await driveUi(ctx, 'consent');
  receipt.info(phase, 'ui-events', describe(ui));
  if (ui.error || !ui.seen) { receipt.add(phase, 'consent-flow', 'skip', `the uninstaller UI could not be driven: ${describe(ui)}`); return; }
  const events = ui.events ?? [];
  receipt.expect(phase, 'consent-asked-and-given', events.some(e => e.kind === 'confirm-page' && /checkbox=On/.test(e.detail)) && events.some(e => e.kind === 'question' && /Back up this computer/.test(e.detail)) && events.some(e => e.kind === 'answer' && e.detail === 'Yes'), describe(ui));
  const problem = events.find(e => e.kind === 'problem');
  receipt.expect(phase, 'no-diagnostic-dialog', !problem, problem?.detail ?? 'none');
  for (let waited = 0; waited < 60_000 && (await ctx.reg(UNINSTALL_KEY)).state !== 'absent'; waited += 2000) await ctx.sys.sleep(2000);
  const key = (await ctx.reg(UNINSTALL_KEY)).state;
  const created = (await ctx.backups()).filter(item => !backups.includes(item));
  const moved = before.every(root => created.some(folder => W.dirname(folder).toLowerCase() === W.dirname(root).toLowerCase() && existsSync(W.join(folder, W.basename(root), SYNTHETIC))));
  const keyGone = created.every(folder => !existsSync(W.join(folder, 'com.tarobot.client', 'tarobot-client-installation-v1')));
  receipt.expect(phase, 'consent-backup-then-uninstall', key === 'absent' && !existsSync(W.join(directory, EXE)) && !ctx.presentRoots().length && moved && keyGone,
    `uninstall key ${key}; roots left ${ctx.presentRoots().length}; data in ${created.length} new backup folder(s): ${moved}; installation key removed ${keyGone}`);
}

const CASES = { 'silent-locked': silentLocked, 'silent-repair': silentRepair, inplace: inPlace, 'gui-rerun-after-partial': guiRerunAfterPartial, helper: helperCase, 'gui-locked': guiLocked, 'gui-consent': guiConsent };

export async function preflight(sys, options) {
  const problems = [];
  if (sys.platform !== 'win32') problems.push('Windows is required');
  if (!options.confirmed || sys.env.TAROBOT_WINDOWS_ACCEPTANCE !== 'disposable') problems.push('set TAROBOT_WINDOWS_ACCEPTANCE=disposable and pass --confirm-disposable-windows');
  if (sys.env.RUNNER_ENVIRONMENT !== 'github-hosted') problems.push('only a disposable GitHub-hosted runner is allowed (RUNNER_ENVIRONMENT)');
  if (!sys.env.APPDATA || !sys.env.LOCALAPPDATA) problems.push('APPDATA/LOCALAPPDATA are unavailable');
  return problems;
}

export async function run(options, sys = windowsSystem()) {
  const receipt = new Receipt();
  const meta = { startedAt: new Date().toISOString(), cases: options.cases, version: options.version, image: `${sys.env.ImageOS ?? ''} ${sys.env.ImageVersion ?? ''}`.trim() };
  const problems = await preflight(sys, options);
  if (problems.length) { for (const problem of problems) receipt.add('preflight', 'disposable-runner', 'fail', problem); return { receipt, meta }; }
  receipt.add('preflight', 'disposable-runner', 'pass', `GitHub-hosted ${meta.image}`);
  await mkdir(options.temp, { recursive: true });
  const ctx = makeContext(sys, options);
  // A disposable runner: an installation left by an earlier (failed or timed
  // out) step is removed first, and recorded; only an unremovable one stops us.
  const installed = await ctx.reg(UNINSTALL_KEY);
  if (installed.state !== 'absent') {
    receipt.info('preflight', 'earlier-installation', `uninstall key ${installed.state}; removing it before the cases`);
    await ctx.ensureUninstalled(receipt, 'preflight');
    const left = await ctx.reg(UNINSTALL_KEY);
    if (left.state !== 'absent') { receipt.add('preflight', 'no-installation', 'fail', `uninstall key ${left.state} after cleanup`); return { receipt, meta }; }
  }
  receipt.info('preflight', 'retained-roots', ctx.presentRoots().join(', ') || 'none');
  const deadline = Date.now() + (options.budgetMinutes ?? 50) * 60_000;
  for (const name of options.cases) {
    if (Date.now() > deadline) { receipt.add(name, 'not-run', 'skip', `the ${options.budgetMinutes ?? 50}-minute budget was spent before this case`); continue; }
    console.log(`${stamp()} case ${name} starts`);
    try { await CASES[name](ctx, receipt, name); }
    catch (error) { receipt.add(name, 'unexpected-error', 'fail', error instanceof Error ? error.stack ?? error.message : String(error)); }
    try { await ctx.ensureUninstalled(receipt, name); } catch (error) { receipt.add(name, 'cleanup', 'fail', String(error)); }
  }
  return { receipt, meta };
}

async function main() {
  const { values } = parseArgs({ options: {
    installer: { type: 'string' }, version: { type: 'string' }, report: { type: 'string' }, cases: { type: 'string' }, 'budget-minutes': { type: 'string' },
    'confirm-disposable-windows': { type: 'boolean', default: false },
  } });
  if (!values.installer || !values.report || !values.version) throw new Error('--installer, --version and --report are required');
  const report = path.resolve(values.report);
  if (!report.split(/[\\/]/).some(part => part.endsWith('.noindex'))) throw new Error('--report must be inside a .noindex directory');
  const cases = values.cases ? values.cases.split(',').map(item => item.trim()) : ALL_CASES;
  for (const name of cases) if (!Object.hasOwn(CASES, name)) throw new Error(`unknown case ${name} (${ALL_CASES.join(', ')})`);
  const { receipt, meta } = await run({ installer: path.resolve(values.installer), version: values.version, cases, confirmed: values['confirm-disposable-windows'], temp: path.join(report, 'work'), budgetMinutes: Number(values['budget-minutes'] ?? 50) });
  await mkdir(report, { recursive: true });
  await writeFile(path.join(report, 'windows-uninstall-recovery.json'), `${JSON.stringify({ outcome: receipt.outcome, ...meta, finishedAt: new Date().toISOString(), checks: receipt.checks }, null, 2)}\n`);
  await writeFile(path.join(report, 'windows-uninstall-recovery.md'), receipt.markdown(meta));
  console.log(JSON.stringify({ outcome: receipt.outcome, failed: receipt.checks.filter(c => c.status === 'fail').map(c => `${c.phase}/${c.id}`), skipped: receipt.checks.filter(c => c.status === 'skip').map(c => `${c.phase}/${c.id}`) }));
  process.exitCode = receipt.outcome === 'pass' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack ?? error.message); process.exitCode = 1; });
