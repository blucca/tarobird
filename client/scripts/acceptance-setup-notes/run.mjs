// ACCEPTANCE-ONLY (#50 local setup notes). Never merge into main.
// Compiles probe.nsi against the product templates (candidate) and against the
// baseline commit's templates, runs it silently on a disposable GitHub-hosted
// Windows runner, and checks what remains readable after setup closes.
// It writes the runner user's real %LOCALAPPDATA%\TaroBird Setup Notes, so it
// refuses anything but a disposable runner, and removes that folder at the end.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { privacyFindings } from '../../../scripts/check-upload-privacy.mjs';

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
const version = JSON.parse(readFileSync(path.join(repo, 'client', 'package.json'), 'utf8')).version;
const local = process.env.LOCALAPPDATA;
const notes = path.join(local, 'TaroBird Setup Notes');
const current = path.join(notes, 'setup-notes.txt'), previous = path.join(notes, 'setup-notes.previous.txt');
if (existsSync(notes)) refuse('a TaroBird Setup Notes folder already exists: not a fresh runner');
const lab = path.resolve(options.report);
await fs.mkdir(lab, { recursive: true });
if (/\s/.test(lab)) refuse('the lab folder must not contain spaces (NSIS /D=)');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const record = (name, detail) => { results.push({ name, ok: null, detail: String(detail) }); console.log(`INFO ${name} — ${detail}`); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const utf16 = file => existsSync(file) ? readFileSync(file) : null;
const text = bytes => bytes ? bytes.toString('utf16le').replace(/^\uFEFF/, '') : '';
const lines = file => text(utf16(file)).split('\r\n').filter(Boolean);
const bomOnce = file => { const bytes = utf16(file); return bytes && bytes[0] === 0xff && bytes[1] === 0xfe && bytes.toString('utf16le').split('\uFEFF').length === 2; };
const removeNotes = async () => { if (existsSync(notes)) { spawnSync('icacls', [notes, '/remove:d', whoami], { stdio: 'ignore' }); await fs.rm(notes, { recursive: true, force: true }); } };
const whoami = execFileSync('whoami', { encoding: 'utf8' }).trim();

// --- Source binding: the probe uses exactly the product commit's templates.
const product = ['installer-diagnostics.nsh', 'installer-notes.nsh', 'English.nsh', 'SimpChinese.nsh', 'installer.nsi', 'installer-hooks.nsh', 'utils.nsh'];
for (const file of product) {
  const blob = `client/windows-electron/${file}`;
  check(`candidate ${file} is the product commit's`, git('rev-parse', `HEAD:${blob}`) === git('rev-parse', `${options.product}:${blob}`));
}
check('product commit is an ancestor of the tested HEAD', spawnSync('git', ['merge-base', '--is-ancestor', options.product, 'HEAD'], { cwd: repo }).status === 0);
const baseTemplates = path.join(lab, 'baseline-templates');
await fs.mkdir(baseTemplates, { recursive: true });
for (const file of ['installer-diagnostics.nsh', 'English.nsh', 'SimpChinese.nsh']) {
  await fs.writeFile(path.join(baseTemplates, file), execFileSync('git', ['show', `${options.baseline}:client/windows-electron/${file}`], { cwd: repo }));
}
check('baseline has no setup notes', !readFileSync(path.join(baseTemplates, 'installer-diagnostics.nsh'), 'utf8').includes('installer-notes'));

// --- Is there already a persistent record? Standard NSIS has no install log.
const hdr = execFileSync('makensis', ['-HDRINFO'], { encoding: 'utf8' });
record('makensis', execFileSync('makensis', ['-VERSION'], { encoding: 'utf8' }).trim());
check('standard NSIS build has no built-in install log (NSIS_CONFIG_LOG absent)', !/\bNSIS_CONFIG_LOG\b/.test(hdr));

function compile(templates, out, extra = []) {
  const result = spawnSync('makensis', ['-V2', '-INPUTCHARSET', 'UTF8', `-DTEMPLATE=${templates}`, `-DOUT=${out}`, `-DVERSION=${version}`, ...extra, probeSource], { encoding: 'utf8' });
  check(`compile ${path.basename(out)}`, result.status === 0 && !/warning/i.test(result.stdout + result.stderr), (result.stdout + result.stderr).trim().split('\n').slice(-3).join(' | '));
  return out;
}
const probeBase = compile(baseTemplates, path.join(lab, 'probe-base.exe'));
const probeNew = compile(template, path.join(lab, 'probe-new.exe'));

// Command lines are verbatim: NSIS wants /D= and _?= last and unquoted.
function run(exe, flags, dir, { uninstall = false } = {}) {
  const tail = uninstall ? `_?=${dir}` : `/D=${dir}`;
  const started = Date.now();
  const result = spawnSync(exe, [`/S ${flags.join(' ')} ${tail}`], { windowsVerbatimArguments: true, timeout: 60000 });
  return { status: result.status, ms: Date.now() - started };
}
let labCount = 0;
const freshDir = async name => { const dir = path.join(lab, `${String(++labCount).padStart(2, '0')}-${name}`); await fs.mkdir(dir, { recursive: true }); return dir; };
const message = dir => text(utf16(path.join(dir, 'probe-message.txt')));

// Strings the candidate may write: parsed from its own language files.
const strings = {};
for (const [file, lang] of [['English.nsh', 'LANG_ENGLISH'], ['SimpChinese.nsh', 'LANG_SIMPCHINESE']]) {
  const source = readFileSync(path.join(template, file), 'utf8').replace(/^\uFEFF/, '');
  strings[lang] = new Map([...source.matchAll(new RegExp(`^LangString (bird\\w+) \\$\\{${lang}\\} "([^"]*)"$`, 'gm'))].map(match => [match[1], match[2]]));
}
const pick = (...keys) => new Set(Object.values(strings).flatMap(map => keys.map(key => map.get(key))));
const operations = pick('birdInstall', 'birdUninstall');
const stages = pick('birdHostStage', 'birdAppStage', 'birdInstallBackup', 'birdUninstallBackup', 'birdNoticeStage', 'birdNoticeRegStage', 'birdFilesStage');
const backups = pick('birdNotRequested', 'birdNotStarted', 'birdCompleted', 'birdNoData', 'birdRolledBack', 'birdPartial', 'birdNotFinal', 'birdUnknownState');
const noticesSet = pick('birdNoticeCleared', 'birdNoticeClearedEarlier');
const done = pick('birdNoteDone');
const codes = /^TB-(?:FILES-REMOVE|NOTICE-CLEAR|NOTICE-MISSING|NOTICE-REGISTER|APP-CHECK|APP-CLOSE|HOST-UNCONFIRMED|HOST-NO-STOPPER|BACKUP-LAUNCH|B-UNKNOWN|B60|H(?:4\d|5[0-8])|B(?:4\d|5[0-8]|14\d|15[0-8]|24\d|25[0-8]))$/;
function parseLine(line) {
  const fields = line.split(' · ');
  const time = fields.shift();
  if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(time)) return { ok: false, why: 'time' };
  const head = fields.shift() ?? '', split = head.indexOf(' — ');
  const operation = head.slice(0, split), stage = head.slice(split + 3);
  if (split < 0 || !operations.has(operation)) return { ok: false, why: 'operation' };
  let code = '';
  if (!done.has(stage)) {
    if (!stages.has(stage)) return { ok: false, why: 'stage' };
    code = fields.shift() ?? '';
    if (!codes.test(code)) return { ok: false, why: 'code' };
  }
  if (fields.pop() !== `TaroBird ${version}`) return { ok: false, why: 'version' };
  if (!backups.has(fields.shift())) return { ok: false, why: 'backup' };
  if (fields.length > 1 || (fields.length === 1 && !noticesSet.has(fields[0]))) return { ok: false, why: 'notice' };
  return { ok: true, operation, stage, code, notice: fields[0] ?? '' };
}
const allNotes = [];
const take = () => { for (const file of [current, previous]) allNotes.push(...lines(file)); };
const kept = dir => message(dir).startsWith('kept=1');
const hint = { en: strings.LANG_ENGLISH.get('birdNoteKept'), zh: strings.LANG_SIMPCHINESE.get('birdNoteKept') };

// Baseline-only walk: which files under the user's profile appeared or changed
// during the baseline run and hold its diagnostic? Bounded; partial if capped.
async function filesHolding(code, since) {
  const needles = [Buffer.from(code, 'utf16le'), Buffer.from(code, 'utf8')];
  const candidates = [...new Set([process.env.LOCALAPPDATA, process.env.APPDATA, process.env.TEMP].filter(Boolean).map(root => path.resolve(root)))];
  const roots = candidates.filter(root => !candidates.some(other => other !== root && root.toLowerCase().startsWith(other.toLowerCase() + path.sep)));
  const found = [], deadline = Date.now() + 240000; let seen = 0, capped = false;
  const stack = [...roots];
  while (stack.length) {
    if (seen > 1500000 || Date.now() > deadline) { capped = true; break; }
    const dir = stack.pop();
    if (dir.startsWith(lab)) continue;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      try {
        const info = await fs.stat(full);
        if (info.mtimeMs < since || info.size > 4 * 1024 * 1024) continue;
        const bytes = await fs.readFile(full);
        if (needles.some(needle => bytes.includes(needle))) found.push(full);
      } catch {}
    }
  }
  return { found, seen, capped };
}

try {
  // 1. Baseline (4b5ed5f macros): the diagnostic exists only while setup runs.
  {
    const dir = await freshDir('baseline-files'), since = Date.now() - 2000;
    const result = run(probeBase, ['/CASE=files'], dir);
    check('baseline: a diagnosed stop exits 2', result.status === 2, `exit ${result.status}`);
    check('baseline: the dialog text existed (TB-FILES-REMOVE)', message(dir).includes('TB-FILES-REMOVE'));
    check('baseline: no notes folder', !existsSync(notes));
    const scan = await filesHolding('TB-FILES-REMOVE', since);
    check('baseline: nothing under the user profile keeps the diagnostic after setup closed', scan.found.length === 0 && !scan.capped,
      `${scan.found.length} file(s), ${scan.seen} entries walked${scan.capped ? ', walk capped (partial)' : ''}`);
  }

  // 2. Candidate: each diagnosed stop and finished run leaves one line.
  {
    const dir = await freshDir('files-en');
    const result = run(probeNew, ['/CASE=files'], dir);
    check('files: exit 2 as before', result.status === 2, `exit ${result.status}`);
    const all = lines(current), line = parseLine(all.at(-1) ?? '');
    check('files: one line with stage and TB-FILES-REMOVE', all.length === 1 && line.ok && line.code === 'TB-FILES-REMOVE' && line.stage === strings.LANG_ENGLISH.get('birdFilesStage') && line.notice === strings.LANG_ENGLISH.get('birdNoticeCleared'), all.at(-1));
    check('files: the dialog names the notes folder only because the line was written', kept(dir) && message(dir).includes(hint.en));
    check('files: UTF-16LE with a single BOM', bomOnce(current));
  }
  {
    const dir = await freshDir('host-zh');
    const result = run(probeNew, ['/ZH', '/CASE=host'], dir);
    const line = parseLine(lines(current).at(-1) ?? '');
    check('host (zh): exit 2, TB-H41 in Chinese', result.status === 2 && line.ok && line.code === 'TB-H41' && line.stage === strings.LANG_SIMPCHINESE.get('birdHostStage'), lines(current).at(-1));
    check('host (zh): hint in Chinese', kept(dir) && message(dir).includes(hint.zh));
  }
  {
    const dir = await freshDir('backup-en');
    const result = run(probeNew, ['/CASE=backup'], dir);
    const line = parseLine(lines(current).at(-1) ?? '');
    check('backup: exit 2, TB-B152 with the rolled-back state', result.status === 2 && line.ok && line.code === 'TB-B152' && lines(current).at(-1).includes(strings.LANG_ENGLISH.get('birdRolledBack')), lines(current).at(-1));
  }
  {
    const dir = await freshDir('ok-en');
    const result = run(probeNew, ['/CASE=ok'], dir);
    const line = parseLine(lines(current).at(-1) ?? '');
    check('finished install: exit 0 and a finished line', result.status === 0 && line.ok && line.code === '' && line.operation === strings.LANG_ENGLISH.get('birdInstall'), lines(current).at(-1));
    check('four runs, four lines, one BOM', lines(current).length === 4 && bomOnce(current));
  }
  {
    const dir = await freshDir('uninstaller');
    const made = run(probeNew, ['/CASE=uninstaller'], dir);
    const uninstaller = path.join(dir, 'probe-uninstall.exe');
    check('uninstaller written', made.status === 0 && existsSync(uninstaller));
    const failed = run(uninstaller, ['/CASE=files'], dir, { uninstall: true });
    const line = parseLine(lines(current).at(-1) ?? '');
    check('uninstall: exit 2, uninstall stage and TB-FILES-REMOVE', failed.status === 2 && line.ok && line.operation === strings.LANG_ENGLISH.get('birdUninstall') && line.code === 'TB-FILES-REMOVE', lines(current).at(-1));
    check('uninstall: hint only for the written line', kept(dir) && message(dir).includes(hint.en));
    const finished = run(uninstaller, ['/CASE=ok'], dir, { uninstall: true });
    const last = parseLine(lines(current).at(-1) ?? '');
    check('finished uninstall: exit 0 and a finished line', finished.status === 0 && last.ok && last.code === '' && last.operation === strings.LANG_ENGLISH.get('birdUninstall'), lines(current).at(-1));
  }
  // Retrieval: the copy's %LOCALAPPDATA% + folder name is where the file is.
  check('Win+R %LOCALAPPDATA% + "TaroBird Setup Notes" is the folder written', hint.en.includes('%LOCALAPPDATA%') && hint.en.includes('TaroBird Setup Notes')
    && existsSync(path.join(execFileSync('cmd', ['/d', '/c', 'echo %LOCALAPPDATA%'], { encoding: 'utf8' }).trim(), 'TaroBird Setup Notes', 'setup-notes.txt')));
  take();
  record('notes after the single-run cases', lines(current).join(' ‖ '));

  // 3. Bounded: 45 notes leave 5 current and 20 previous lines.
  await removeNotes();
  {
    const dir = await freshDir('repeat-45');
    const result = run(probeNew, ['/CASE=repeat', '/COUNT=44'], dir);
    check('45 notes written in one process', result.status === 45, `exit ${result.status}`);
    check('limit: 5 current + 20 previous lines, one BOM each', lines(current).length === 5 && lines(previous).length === 20 && bomOnce(current) && bomOnce(previous),
      `${lines(current).length} + ${lines(previous).length}`);
    check('limit: no other file in the notes folder', (await fs.readdir(notes)).sort().join() === 'setup-notes.previous.txt,setup-notes.txt');
    take();
  }

  // 4. Concurrent writers: 6 processes × 9 notes; every line intact, counts exact.
  async function concurrent(exe, label) {
    await removeNotes();
    const dirs = await Promise.all([...Array(6)].map((_, i) => freshDir(`${label}-${i}`)));
    const exits = await Promise.all(dirs.map(dir => new Promise(resolve => {
      const child = spawn(exe, [`/S /CASE=repeat /COUNT=8 /D=${dir}`], { windowsVerbatimArguments: true });
      child.once('exit', code => resolve(code));
    })));
    const written = exits.reduce((sum, code) => sum + (code ?? 0), 0);
    const now = lines(current), old = lines(previous);
    const intact = [...now, ...old].every(line => parseLine(line).ok);
    return { written, now: now.length, old: old.length, intact, all: [...now, ...old], files: (await fs.readdir(notes)).sort().join() };
  }
  {
    const result = await concurrent(probeNew, 'concurrent');
    const expected = ((result.written - 1) % 20) + 1;
    check('concurrent: all 54 notes written', result.written === 54, `written ${result.written}`);
    check('concurrent: counts match serial writes (14 current + 20 previous)', result.now === expected && result.old === 20, `${result.now} + ${result.old}`);
    check('concurrent: every line intact', result.intact);
    check('concurrent: only the two note files', result.files === 'setup-notes.previous.txt,setup-notes.txt', result.files);
    allNotes.push(...result.all);
  }
  // Record only: the same probe with the mutex wait removed, to show what the
  // concurrency check can detect. Not a gate.
  {
    const variant = path.join(lab, 'variant-no-lock');
    await fs.mkdir(variant, { recursive: true });
    for (const file of ['installer-diagnostics.nsh', 'English.nsh', 'SimpChinese.nsh']) await fs.copyFile(path.join(template, file), path.join(variant, file));
    const source = readFileSync(path.join(template, 'installer-notes.nsh'), 'utf8')
      .replace(/System::Call 'kernel32::WaitForSingleObject\(p r7, i \$\{BIRDNOTESWAIT\}\) i \.r6'/, 'StrCpy $6 0')
      .replace(/System::Call 'kernel32::CreateMutexW\(p 0, i 0, w "Local\\TaroBirdSetupNotes"\) p \.r7'/, 'StrCpy $7 1')
      .replace(/System::Call 'kernel32::ReleaseMutex\(p r7\)'/, '').replace(/System::Call 'kernel32::CloseHandle\(p r7\)'/, '');
    check('no-lock variant really drops the lock', !/CreateMutexW|WaitForSingleObject|ReleaseMutex/.test(source));
    await fs.writeFile(path.join(variant, 'installer-notes.nsh'), source);
    const exe = compile(variant, path.join(lab, 'probe-no-lock.exe'));
    const result = await concurrent(exe, 'no-lock');
    record('no-lock variant (record only)', `written ${result.written}, ${result.now} current + ${result.old} previous, intact ${result.intact}, files ${result.files}`);
  }

  // 5. Writing can fail without changing what setup does.
  const snapshot = () => { try { return existsSync(current) ? readFileSync(current) : null; } catch { return 'unreadable'; } };
  const holdWith = async script => {
    const ready = path.join(lab, `ready-${Date.now()}.txt`);
    const child = spawn('pwsh', ['-NoProfile', '-Command', script.replaceAll('READY', ready)], { stdio: 'ignore' });
    for (let i = 0; i < 300 && !existsSync(ready); i++) await sleep(100);
    if (!existsSync(ready)) throw new Error('holder did not start');
    return child;
  };
  const release = child => child ? new Promise(resolve => { child.once('exit', resolve); child.kill(); }) : undefined;
  async function unchanged(label, { setup, hold, cleanup } = {}) {
    await removeNotes();
    await setup?.();
    const before = snapshot();
    const holder = await hold?.();
    const dir = await freshDir(label);
    const failed = run(probeNew, ['/CASE=files'], dir);
    const ok = run(probeNew, ['/CASE=ok'], await freshDir(`${label}-ok`));
    await release(holder);
    const after = snapshot();
    check(`${label}: stop still exits 2 and success still 0`, failed.status === 2 && ok.status === 0, `exit ${failed.status}/${ok.status}, ${failed.ms}/${ok.ms} ms`);
    check(`${label}: no hint without a written line`, message(dir).startsWith('kept=0') && !message(dir).includes(hint.en));
    check(`${label}: notes unchanged`, before === null ? after === null : (Buffer.isBuffer(before) && Buffer.isBuffer(after) && before.equals(after)));
    await cleanup?.();
    return { failed, ok };
  }
  const lockFile = file => () => holdWith(`$f = [System.IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); Set-Content -Path 'READY' -Value held; Start-Sleep -Seconds 60`);

  await unchanged('notes path is a file', {
    setup: () => fs.writeFile(notes, 'not a folder'),
    cleanup: async () => { check('notes path is a file: the file is untouched', readFileSync(notes, 'utf8') === 'not a folder'); await fs.rm(notes, { force: true }); },
  });
  await unchanged('folder denies writing', {
    setup: async () => { await fs.mkdir(notes, { recursive: true }); execFileSync('icacls', [notes, '/deny', `${whoami}:(OI)(CI)(W)`], { stdio: 'ignore' }); },
    cleanup: async () => { execFileSync('icacls', [notes, '/remove:d', whoami], { stdio: 'ignore' }); },
  });
  {
    const { failed, ok } = await unchanged('another writer holds the turn', {
      hold: () => holdWith("$m = New-Object System.Threading.Mutex($false, 'Local\\TaroBirdSetupNotes'); [void]$m.WaitOne(); Set-Content -Path 'READY' -Value held; Start-Sleep -Seconds 60"),
    });
    check('another writer holds the turn: each run waits about 2 s, not longer', [failed, ok].every(result => result.ms >= 1500 && result.ms < 15000), `${failed.ms}/${ok.ms} ms`);
  }
  await unchanged('notes file locked', {
    setup: async () => { run(probeNew, ['/CASE=ok'], await freshDir('seed-lock')); },
    hold: lockFile(current),
  });
  await unchanged('full file whose rotation is blocked', {
    setup: async () => {
      run(probeNew, ['/CASE=repeat', '/COUNT=19'], await freshDir('seed-full'));
      run(probeNew, ['/CASE=ok'], await freshDir('seed-previous'));
      run(probeNew, ['/CASE=repeat', '/COUNT=18'], await freshDir('seed-full-again'));
      check('blocked rotation: seeded 20 current + 20 previous', lines(current).length === 20 && lines(previous).length === 20, `${lines(current).length} + ${lines(previous).length}`);
    },
    hold: lockFile(previous),
    cleanup: async () => { check('blocked rotation: still 20 + 20, nothing grew', lines(current).length === 20 && lines(previous).length === 20); },
  });
  {
    const target = path.join(lab, 'junction-target');
    await unchanged('notes folder is a junction', {
      setup: async () => { await fs.mkdir(target, { recursive: true }); execFileSync('cmd', ['/d', '/c', 'mklink', '/J', notes, target], { stdio: 'ignore' }); },
      cleanup: async () => {
        check('junction: nothing written through it', (await fs.readdir(target)).length === 0);
        execFileSync('cmd', ['/d', '/c', 'rmdir', notes], { stdio: 'ignore' });
      },
    });
  }
  {
    await removeNotes();
    await fs.mkdir(notes, { recursive: true });
    const result = run(probeNew, ['/CASE=files'], notes);
    check('install folder equal to the notes folder: still exits 2, no note there', result.status === 2 && !existsSync(current) && message(notes).startsWith('kept=0'));
  }

  // 6. Privacy: every line is allowlisted text; nothing names this machine or user.
  const body = allNotes.join('\n');
  check('every note line matches the allowlisted grammar', allNotes.length > 0 && allNotes.every(line => parseLine(line).ok), `${allNotes.length} lines`);
  check('existing upload privacy scan finds nothing', privacyFindings(body).length === 0, JSON.stringify(privacyFindings(body).map(finding => finding.kind)));
  const identities = [process.env.USERNAME, process.env.COMPUTERNAME, process.env.USERDOMAIN, process.env.USERPROFILE, local, lab, process.env.RUNNER_TEMP, whoami].filter(value => value && value.length >= 3);
  check('no account, machine or folder name and no path in the notes', identities.every(value => !body.toLowerCase().includes(value.toLowerCase())) && !/[A-Za-z]:\\|\\\\|\//.test(body));
} catch (error) {
  check('unexpected error', false, error.stack ?? error);
} finally {
  await removeNotes();
  check('notes folder removed after the run', !existsSync(notes));
}

const failed = results.filter(result => result.ok === false);
const summary = [`# #50 setup notes probe`, '', `HEAD ${git('rev-parse', 'HEAD')} · product ${options.product} · baseline ${options.baseline} · TaroBird ${version}`, '',
  ...results.map(result => `- ${result.ok === null ? 'INFO' : result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.detail ? ` — ${result.detail.replaceAll('\n', ' ')}` : ''}`), '',
  `**${failed.length ? 'fail' : 'pass'}**: ${results.filter(result => result.ok).length} passed, ${failed.length} failed`].join('\n');
await fs.writeFile(path.join(lab, 'setup-notes-acceptance.md'), summary);
await fs.writeFile(path.join(lab, 'setup-notes-acceptance.json'), JSON.stringify({ results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
console.log(summary);
process.exit(failed.length ? 1 : 0);
