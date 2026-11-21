// Acceptance-only seconds-level pre-check of the four acceptance fixes (#50
// extension, round 2) on a disposable GitHub-hosted runner. Fixtures only; no
// TaroBird package is built or installed.
//   1 shortcut target in a CJK folder: Shell.Application GetLink.Path vs WScript
//   2 windows-uninstall-ui-driver.ps1 stdout now UTF-8 (U+00B7 survives)
//   3 windows-dialog-text-driver.ps1: NSIS-only buttons, helper exit status
//   4 windows-install-ui-driver.ps1: blocked setup window, old uninstaller's own
//     language chooser (asked / not asked), finish page
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryScript, windowsSystem } from '../windows-acceptance.mjs';
import { CUSTOM_PARENT, makeExtension, watchExits } from '../windows-acceptance-extension.mjs';

const W = path.win32, HERE = path.dirname(fileURLToPath(import.meta.url)), T = process.env.RUNNER_TEMP;
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('disposable GitHub-hosted runner only');
const sys = windowsSystem();
const x = makeExtension(sys, { temp: W.join(T, 'fixes-work'), installer: '' });
await mkdir(x.tmp, { recursive: true });
const out = (kind, data) => console.log(JSON.stringify({ kind, data }));
const fx = name => W.join(T, `${name}.exe`);
const whoami = `${process.env.SystemRoot}\\System32\\whoami.exe`;
const reg = async key => { try { return JSON.parse((await sys.powershell(registryScript(key))).stdout.trim()); } catch { return { state: 'error' }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The exit promise is attached at spawn time: a child that exits before anyone
// awaits it must still settle (the first probe run lost steps 2-4 to that).
const start = (file, args, opts) => { const child = spawn(file, args, opts); child.done = new Promise(resolve => { child.once('exit', code => resolve(code)); child.once('error', () => resolve(-1)); }); return child; };
const wait = child => child.done;

// 1
const lnkDir = W.join(T, CUSTOM_PARENT, 'LinkProbe');
await mkdir(lnkDir, { recursive: true });
await copyFile(fx('lnk-fixture'), W.join(lnkDir, 'lnk-fixture.exe'));
await copyFile(whoami, W.join(lnkDir, 'target.exe'));
const made = await x.runLine(`"${W.join(lnkDir, 'lnk-fixture.exe')}" /S`, { timeout: 60_000 });
const link = W.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TaroBird Link Probe.lnk');
const expected = W.join(lnkDir, 'target.exe');
const viaGetLink = await x.shortcutTarget(link);
const viaWsh = (await sys.powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut('${link.replaceAll("'", "''")}').TargetPath`)).stdout.trim();
out('1-shortcut', { fixtureExit: made.code, linkExists: existsSync(link), expected, viaGetLink, getLinkExact: viaGetLink === expected, viaWScript: viaWsh, wscriptExact: viaWsh === expected });

// 2
{
  const releaseFile = W.join(x.tmp, 'f-release.flag'), releasedFile = `${releaseFile}.done`;
  const drv = start('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, '..', 'windows-uninstall-ui-driver.ps1'), '-Mode', 'keep', '-TimeoutSec', '90', '-ReleaseFile', releaseFile, '-ReleasedFile', releasedFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = ''; drv.stdout.on('data', chunk => { stdout += chunk; });
  const done = drv.done;
  const setup = start(fx('dialog-fixture'), [], { stdio: 'ignore' });
  let finished = false; done.then(() => { finished = true; });
  for (let i = 0; i < 240 && !finished; i++) { if (existsSync(releaseFile) && !existsSync(releasedFile)) await (await import('node:fs/promises')).writeFile(releasedFile, 'done'); await sleep(500); }
  await Promise.race([wait(setup), sleep(30_000)]);
  let problem = ''; try { problem = (JSON.parse(stdout.trim().split(/\r?\n/).pop()).events ?? []).find(e => e.kind === 'problem')?.detail ?? ''; } catch (error) { problem = `unparsed: ${stdout.slice(-300)}`; }
  out('2-final-driver-utf8', { hasU00B7: problem.includes('·'), hasUFFFD: problem.includes('�'), hasU2014: problem.includes('—'), tail: problem.slice(-160) });
}

// 3
{
  await copyFile(whoami, W.join(T, 'tarobot-installer-helper.exe'));
  const exits = await watchExits(x, ['tarobot-installer-helper.exe']);
  const outFile = W.join(x.tmp, 'd.json');
  const drv = start('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, '..', 'windows-dialog-text-driver.ps1'), '-TimeoutSec', '90', '-OutFile', outFile], { stdio: 'ignore', windowsHide: true });
  const setup = start(fx('dialog-fixture'), ['/HELPER'], { stdio: 'ignore' });
  await wait(drv); await wait(setup);
  const seen = await exits.stop();
  let ev = []; try { ev = JSON.parse((await readFile(outFile, 'utf8')).replace(/^﻿/, '')).events ?? []; } catch { /* none */ }
  const kinds = ev.map(e => e.kind);
  out('3-dialog-driver', { watcher: exits.detail, helperExits: seen, order: kinds.join(' > '), problemBeforeFinished: kinds.indexOf('problem-uia') >= 0 && kinds.indexOf('problem-uia') < kinds.indexOf('finished'),
    pressed: ev.filter(e => e.kind === 'answer' || e.kind === 'finished').map(e => e.detail.slice(0, 120)) });
}

// 4
for (const [label, language] of [['no-stored-language', undefined], ['stored-language', '1033']]) {
  if (language) await sys.run('reg.exe', ['add', 'HKCU\\Software\\TaroBirdAcceptanceB3Lang', '/v', 'Installer Language', '/t', 'REG_SZ', '/d', language, '/f']);
  await x.runLine(`"${fx('b3-old')}" /S`, { timeout: 60_000 });
  const outFile = W.join(x.tmp, `b3-${label}.json`);
  const drv = start('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, '..', 'windows-install-ui-driver.ps1'), '-TimeoutSec', '150', '-SetupPath', fx('b3-new'), '-OutFile', outFile], { stdio: 'ignore', windowsHide: true });
  const setup = start(fx('b3-new'), [], { stdio: 'ignore' });
  const exit = await Promise.race([wait(setup), sleep(170_000).then(() => 'timeout')]);
  if (exit === 'timeout') spawn('taskkill.exe', ['/PID', String(setup.pid), '/T', '/F'], { stdio: 'ignore' });
  await Promise.race([wait(drv), sleep(30_000)]);
  let ui = {}; try { ui = JSON.parse((await readFile(outFile, 'utf8')).replace(/^﻿/, '')); } catch (error) { ui = { error: String(error) }; }
  const result = await reg('HKCU\\Software\\TaroBirdAcceptanceB3Result');
  out(`4-b3-${label}`, { setupExit: exit, stuck: ui.stuck, seconds: ui.seconds, error: ui.error, oldUninstallerExit: result.values?.oldUninstallerExit, runRequested: result.values?.runRequested ?? 'no',
    events: (ui.events ?? []).map(e => `${e.kind}${e.detail ? `=${String(e.detail).slice(0, 140)}` : ''}`) });
  await sys.run('reg.exe', ['delete', 'HKCU\\Software\\TaroBirdAcceptanceB3Result', '/f']);
}

// 5: what Win32_ProcessStartTrace / StopTrace report as ProcessName for the two
// long image names (a whoami.exe copy under each name). Decides whether a
// WHERE ProcessName = '<full name>' watcher can ever match them.
{
  const names = ['tarocub-client.exe', 'tarobot-installer-helper.exe'];
  for (const name of names) await copyFile(whoami, W.join(T, 'trace-names', name)).catch(async () => { await mkdir(W.join(T, 'trace-names'), { recursive: true }); await copyFile(whoami, W.join(T, 'trace-names', name)); });
  const log = W.join(x.tmp, 'trace-names.log'), ready = `${log}.ready`;
  const script = `$ErrorActionPreference = 'Stop'; Register-CimIndicationEvent -Query "SELECT * FROM Win32_ProcessStartTrace" -SourceIdentifier tbs | Out-Null; Register-CimIndicationEvent -Query "SELECT * FROM Win32_ProcessStopTrace" -SourceIdentifier tbe | Out-Null; Set-Content -LiteralPath '${ready.replaceAll("'", "''")}' -Value r; $end = (Get-Date).AddSeconds(25); while ((Get-Date) -lt $end) { foreach ($id in 'tbs', 'tbe') { $e = Wait-Event -SourceIdentifier $id -Timeout 1; if ($e) { $n = $e.SourceEventArgs.NewEvent; if ([string]$n.ProcessName -like 'taro*') { Add-Content -LiteralPath '${log.replaceAll("'", "''")}' -Value "$id $($n.ProcessName) len=$(([string]$n.ProcessName).Length)" }; Remove-Event -EventIdentifier $e.EventIdentifier } } }`;
  const watcher = start('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60 && !existsSync(ready); i++) await sleep(250);
  for (const name of names) await wait(start(W.join(T, 'trace-names', name), ['/user'], { stdio: 'ignore', windowsHide: true }));
  await Promise.race([wait(watcher), sleep(40_000)]);
  let seen = ''; try { seen = (await readFile(log, 'utf8')).trim(); } catch { seen = '(nothing logged)'; }
  out('5-trace-process-names', { ready: existsSync(ready), seen: seen.split(/\r?\n/) });
}
