import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDeepSeekHome } from "../config.js";
import { parseDeepSeekModelCatalog, type DeepSeekModelCatalog } from "../codex/deepseek-models.js";
import { prepareDeepSeekHarnessPrivateProfile } from "../codex/deepseek-harness-profile.js";
import { DeepSeekHarnessProtocolClient } from "../codex/deepseek-harness-protocol.js";
import { stopChild, waitForStartupUrl, type DeepSeekHarnessChildProcess } from "../codex/deepseek-harness-host.js";
import { deepseekParentGuardEnvironment } from "../codex/deepseek-parent-guard.js";
import { spawnEngine } from "./engine-process.js";
import { resolveDeepSeekExecutable } from "./deepseek-executable.js";
import { modelDiscoveryEnabled } from "./cli-model-discovery.js";

// Each read copies a private home and cold-starts `dsh web`. A passive read keeps the original budget,
// inside the 10 s Bot RPC. An explicit refresh, or any read after a failed one, gets a longer budget
// (REFRESH_DEADLINE_MS, chosen from measured cold starts; see docs/client/deepseek-model-settings.md).
const PASSIVE_DEADLINE_MS = 7000;
export const DEEPSEEK_CATALOG_REFRESH_DEADLINE_MS = 12_000;
const REFRESH_DEADLINE_MS = DEEPSEEK_CATALOG_REFRESH_DEADLINE_MS;
// A replacing read first waits this long for the previous child to exit and its private home to go.
const RECLAIM_WAIT_MS = 3000;
const unavailable = (): DeepSeekModelCatalog => ({ status: "unavailable", models: [] });
type Entry = {
  promise: Promise<DeepSeekModelCatalog>; answered: boolean; status?: DeepSeekModelCatalog["status"]; expires: number;
  reclaimed: boolean; whenReclaimed: Promise<void>;
};
const cache = new Map<string, Entry>();
export type DeepSeekDiscoveryTiming = { deadlineMs?: number; refreshDeadlineMs?: number; reclaimWaitMs?: number };
const settledWithin = (promise: Promise<void>, ms: number) => new Promise<boolean>(resolve => {
  const timer = setTimeout(() => resolve(false), Math.max(0, ms)); timer.unref?.();
  void promise.then(() => { clearTimeout(timer); resolve(true); });
});

/** A file can grow after stat; cap the actual read and reject a changing copy. */
export async function readDeepSeekCatalogConfig(file: string): Promise<Buffer> {
  const limit = 2 * 1024 * 1024, handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error("catalog_config_unavailable");
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset > limit || offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("catalog_config_unavailable");
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Catalog reads use the same selected CLI, web profile and environment as
 * native turns, but a disposable private home. No session/create, prompt,
 * model selection or settings write is sent. Shared credentials are copied,
 * never linked, because even CLI boot/migration must not write through them. */
export async function discoverDeepSeekModels(env: NodeJS.ProcessEnv = process.env, cwd?: string, fresh = false, timing: DeepSeekDiscoveryTiming = {}): Promise<DeepSeekModelCatalog> {
  if (!modelDiscoveryEnabled(env)) return unavailable();
  try {
    const home = resolveDeepSeekHome(env), executable = resolveDeepSeekExecutable(env);
    const signatures = await Promise.all(["cordis.patch.yml", "settings.yaml", ".credentials.yaml", "profiles/web/cordis.patch.yml", "profiles/web/package.json"].map(async name => {
      try { const info = await stat(path.join(home, name)); return [name, info.size, info.mtimeMs, info.ino]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, null]; throw error; }
    }));
    const key = createHash("sha256").update(JSON.stringify([executable, home, env, cwd, signatures])).digest("hex");
    const current = cache.get(key);
    // One read per configuration at a time: a read that has not answered yet is joined, refreshes included.
    if (current && !current.answered) return current.promise;
    // A passive read may reuse a recent answer. An explicit refresh never does, and a failure is never
    // reused: the next read (typically the user's "reload") is a real, new read.
    const failed = current?.status === "unavailable";
    if (current && !fresh && !failed && current.expires > Date.now()) return current.promise;
    if (!current && cache.size >= 16) {
      const reclaimed = [...cache].find(([, entry]) => entry.answered && entry.reclaimed);
      if (reclaimed) cache.delete(reclaimed[0]); else return unavailable();
    }
    const deadline = Date.now() + (fresh || failed ? timing.refreshDeadlineMs ?? REFRESH_DEADLINE_MS : timing.deadlineMs ?? PASSIVE_DEADLINE_MS);
    let reclaim!: () => void;
    const entry: Entry = { promise: Promise.resolve(unavailable()), answered: false, expires: 0, reclaimed: false,
      whenReclaimed: new Promise<void>(resolve => { reclaim = () => { entry.reclaimed = true; resolve(); }; }) };
    entry.promise = (async () => {
      // Never overlap a replaced read's child or private home. If it does not finish exiting within the
      // bounded wait, answer unavailable without starting another; this entry is reclaimed with it.
      if (current && !current.reclaimed && !await settledWithin(current.whenReclaimed, Math.min(timing.reclaimWaitMs ?? RECLAIM_WAIT_MS, deadline - Date.now()))) {
        void current.whenReclaimed.then(reclaim); return unavailable();
      }
      return await readCatalog(executable, home, env, cwd, deadline, reclaim);
    })().catch(() => { reclaim(); return unavailable(); }).then(result => {
      entry.answered = true; entry.status = result.status; entry.expires = Date.now() + (result.status === "ready" ? 30_000 : 1000);
      return result;
    });
    cache.set(key, entry);
    return await entry.promise;
  } catch { return unavailable(); }
}

async function readCatalog(executable: string, sharedHome: string, env: NodeJS.ProcessEnv, cwd: string | undefined, deadline: number, closed: () => void): Promise<DeepSeekModelCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-dsh-catalog-"));
  const home = path.join(root, "home"), workspace = cwd ?? path.join(root, "workspace");
  const abort = new AbortController();
  let child: DeepSeekHarnessChildProcess | undefined, protocol: DeepSeekHarnessProtocolClient | undefined;
  let finished: Promise<void> | undefined;
  const stop = () => finished ??= (async () => { await protocol?.close().catch(() => {}); if (child) await stopChild(child, 300); })();
  const work = (async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (!cwd) await mkdir(workspace, { mode: 0o700 });
    const profiles = await stat(path.join(sharedHome, "profiles")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
    });
    if (profiles) await prepareDeepSeekHarnessPrivateProfile({ sharedHome, privateHome: home });
    else await mkdir(path.join(home, "profiles", "web"), { recursive: true, mode: 0o700 });
    for (const name of ["cordis.patch.yml", "settings.yaml", ".credentials.yaml"]) {
      try {
        await writeFile(path.join(home, name), await readDeepSeekCatalogConfig(path.join(sharedHome, name)), { mode: 0o600 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (abort.signal.aborted) throw new Error("catalog_timeout");
    child = spawnEngine(executable, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], {
      cwd: workspace, env: deepseekParentGuardEnvironment({ ...env, DSH_HOME: home }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }) as unknown as DeepSeekHarnessChildProcess;
    // No tokens, raw config, failure text or startup output reach callers/logs.
    const url = await waitForStartupUrl(child, Math.max(1, deadline - Date.now()));
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    if (abort.signal.aborted) throw new Error("catalog_timeout");
    protocol = new DeepSeekHarnessProtocolClient(url, { requestTimeoutMs: Math.max(1, deadline - Date.now()) });
    return parseDeepSeekModelCatalog(await protocol.request("session/modelCatalog", {}, abort.signal));
  })();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<DeepSeekModelCatalog>(resolve => { timer = setTimeout(() => { abort.abort(); if (child) void stop(); resolve(unavailable()); }, Math.max(1, deadline - Date.now())); });
  // Cleanup waits for preparation too; a timed-out profile copy must never
  // recreate files after its temporary directory has already been removed.
  const settled = work.finally(async () => {
    await stop();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
    clearTimeout(timer);
    closed();
  });
  return await Promise.race([settled.catch(unavailable), timeout]);
}

export function resetDeepSeekModelDiscoveryForTest(): void { cache.clear(); }
