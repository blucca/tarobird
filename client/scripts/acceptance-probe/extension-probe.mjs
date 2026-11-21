// Acceptance-only seconds-level pre-check for windows-acceptance-extension.mjs
// on a disposable GitHub-hosted runner: the pinned downloads, the verbatim
// command lines on a CJK/space /D= directory with the N2 fixture, and the
// PowerShell drivers' syntax. Builds and installs no TaroBird package.
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryScript, windowsSystem } from '../windows-acceptance.mjs';
import { CUSTOM_PARENT, download, lineRunner, RELEASES } from '../windows-acceptance-extension.mjs';

const W = path.win32;
const HERE = path.dirname(fileURLToPath(import.meta.url));
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('disposable GitHub-hosted runner only');
const sys = windowsSystem(), runLine = lineRunner(sys);
const out = (kind, data) => console.log(JSON.stringify({ kind, data }));
const reg = async key => { try { return JSON.parse((await sys.powershell(registryScript(key))).stdout.trim()); } catch { return { state: 'error' }; } };
const KEY = 'HKCU\\Software\\TaroBirdAcceptanceN2Fixture', RESULT = 'HKCU\\Software\\TaroBirdAcceptanceN2Result';

// 1. Pinned downloads (size and SHA-256), exactly as group B does them.
for (const [version, pin] of Object.entries(RELEASES)) {
  const file = W.join(process.env.RUNNER_TEMP, 'pin-check', `TaroBird_${version}_x64-setup.exe`);
  const got = await download(sys, pin, file);
  out('download', { version, ok: got.ok, detail: got.detail });
  const tampered = await download(sys, { ...pin, sha256: '0'.repeat(64) }, `${file}.neg`);
  out('download-negative-control', { version, rejected: !tampered.ok });
  await rm(`${file}.neg`, { force: true });
}

// 2. N2 fixture on the CJK/space directory through lineRunner.
const fixture = process.argv[2];
const dir = W.join(process.env.RUNNER_TEMP, CUSTOM_PARENT, 'N2Fixture');
const install = async () => {
  const run = await runLine(`"${fixture}" /S /D=${dir}`, { timeout: 120_000 });
  const key = await reg(KEY);
  out('install', { run, dir, exists: existsSync(W.join(dir, 'uninstall.exe')), values: key.values,
    defaultIsDir: key.values?.['(Default)'] === dir, installLocationQuoted: key.values?.InstallLocation === `"${dir}"`, uninstallStringQuoted: key.values?.UninstallString === `"${dir}\\uninstall.exe"` });
};
const result = async label => { const r = await reg(RESULT); out(label, { last: r.values?.last, reinstExit: r.values?.reinstExit, reinstCommand: r.values?.reinstCommand, dirLeft: existsSync(dir), uninstallerLeft: existsSync(W.join(dir, 'uninstall.exe')) }); await sys.run('reg.exe', ['delete', RESULT, '/f']); };
await install();
let run = await runLine(`"${dir}\\uninstall.exe" /S _?=${dir}`, { timeout: 120_000 });
out('inplace-run', run); await result('inplace-result (expect self-kept-branch)');
await install();
run = await runLine(`"${fixture}" /REINST`, { timeout: 120_000 });
out('reinst-run', run); await result('reinst-result (installer.nsi reinst_uninstall shape; expect self-kept-branch)');
await install();
const copyDir = W.join(process.env.RUNNER_TEMP, 'n2-copy'); await mkdir(copyDir, { recursive: true });
await copyFile(W.join(dir, 'uninstall.exe'), W.join(copyDir, 'Un.exe'));
run = await runLine(`"${W.join(copyDir, 'Un.exe')}" /S _?=${dir}`, { timeout: 120_000 });
out('temp-copy-run', run); await result('temp-copy-result (expect delete-branch)');
for (const [label, arg] of [['trailing-backslash', `${dir}\\`], ['upper-case', dir.toUpperCase()]]) {
  await install();
  run = await runLine(`"${dir}\\uninstall.exe" /S _?=${arg}`, { timeout: 120_000 });
  out(`variant-${label}-run`, run); await result(`variant-${label}-result (recorded, not judged)`);
  if (existsSync(W.join(dir, 'uninstall.exe'))) await runLine(`"${W.join(copyDir, 'Un.exe')}" /S _?=${dir}`, { timeout: 120_000 });
}

// 3. Driver syntax under Windows PowerShell 5.1.
for (const name of ['windows-install-ui-driver.ps1', 'windows-uninstall-ui-driver.ps1']) {
  const file = path.join(HERE, '..', name);
  const parsed = await sys.powershell(`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'", "''")}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" } } else { 'OK' }`);
  out('driver-parse', { name, result: parsed.stdout.trim() });
}
