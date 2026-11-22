import { spawnEngine } from "../runtime/engine-process.js";

const VERSION_PROBE_TIMEOUT_MS = 3_000;

/**
 * Whether this version of `agy` can run a Bot through `agy acp`. The server exists since 1.5.0; the adapter
 * relies on two fixes of 1.5.10: what the agent does after a turn has ended reaches the client, and closing a
 * session ends its background work.
 */
export function antigravityVersionSupportsAcp(versionOutput: string): boolean {
  const match = versionOutput.trim().match(/\bv?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]*)?\b/);
  if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return false;
  return major > 1 || major === 1 && (minor > 5 || minor === 5 && patch >= 10);
}

/** Asks the installed CLI for its version. A missing CLI, an error or no answer in three seconds all mean no. */
export function antigravitySupportsAcp(executable: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false, output = "";
    const finish = (supported: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(supported); };
    let child: ReturnType<typeof spawnEngine>;
    try { child = spawnEngine(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"], shell: false, env, windowsHide: true }); }
    catch { resolve(false); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } finish(false); }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer | string) => { output = `${output}${String(chunk)}`.slice(-4_096); });
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0 && antigravityVersionSupportsAcp(output)));
  });
}
