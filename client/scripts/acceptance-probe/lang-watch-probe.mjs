// ACCEPTANCE-ONLY probe: the #50 suite's own passive-run watcher against the
// fixture. /P must be caught at the language chooser within seconds; /S must not.
import { makeContext } from '../windows-uninstall-recovery-acceptance.mjs';
import { windowsSystem } from '../windows-acceptance.mjs';
const [fixture, temp] = process.argv.slice(2);
const ctx = makeContext(windowsSystem(), { temp, installer: fixture });
const passive = await ctx.execWatchingLanguage(fixture, ['/P'], { timeout: 120_000, within: 30_000 });
const silent = await ctx.execWatchingLanguage(fixture, ['/S'], { timeout: 60_000, within: 30_000 });
console.log(JSON.stringify({ passive, silent }));
const ok = !!passive.dialog && passive.seconds <= 45 && !silent.dialog && !silent.timedOut;
console.log(ok ? 'PROBE PASS: /P stopped at the chooser was caught early; /S never asked' : 'PROBE FAIL');
process.exitCode = ok ? 0 : 1;
