// ACCEPTANCE-ONLY PROBE: proves the final branch's own watchStarts (WMI
// process start trace) on a disposable runner. No TaroBird build or install.
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { makeContext } from '../windows-uninstall-recovery-acceptance.mjs';
import { windowsSystem } from '../windows-acceptance.mjs';

const sys = windowsSystem();
const temp = path.join(process.env.RUNNER_TEMP, 'startwatch.noindex');
await mkdir(temp, { recursive: true });
const ctx = makeContext(sys, { temp });
const fake = path.join(temp, 'tarocub-client.exe');
await copyFile('C:\\Windows\\System32\\whoami.exe', fake);
const hit = lines => lines.filter(line => line.toLowerCase().endsWith(' tarocub-client.exe'));
const results = {};
// 1. Nothing starts the program: the watcher must report no start.
let w = await ctx.watchStarts(['tarocub-client.exe']);
let seen = await w.stop();
results.idle = { proven: w.proven, detail: w.detail, starts: hit(seen) };
// 2. The program is started directly and exits at once.
w = await ctx.watchStarts(['tarocub-client.exe']);
const direct = await sys.run(fake, []);
seen = await w.stop();
results.direct = { proven: w.proven, detail: w.detail, exit: direct.code, starts: hit(seen) };
// 3. Started by a child process with an argument, as an uninstaller's ExecWait would.
w = await ctx.watchStarts(['tarocub-client.exe']);
// (Run 44845710472: node's quoting of a `cmd /c` argument made cmd exit 1 before starting it.)
const nested = await sys.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${fake}' -ArgumentList '/?' -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`]);
seen = await w.stop();
results.nested = { proven: w.proven, detail: w.detail, exit: nested.code, starts: hit(seen) };
for (const [name, value] of Object.entries(results)) console.log(`${name}: ${JSON.stringify(value)}`);
const ok = Object.values(results).every(r => r.proven) && !results.idle.starts.length && results.direct.starts.length === 1 && results.nested.starts.length === 1;
console.log(ok ? 'PROBE PASS: the watcher proves itself, sees direct and nested starts, and reports none when idle' : 'PROBE FAIL');
process.exitCode = ok ? 0 : 1;
