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

const DEADLINE_MS = 7000;
const unavailable = (): DeepSeekModelCatalog => ({ status: "unavailable", models: [] });
const cache = new Map<string, { expires: number; promise: Promise<DeepSeekModelCatalog> }>();

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
export async function discoverDeepSeekModels(env: NodeJS.ProcessEnv = process.env, cwd?: string, fresh = false): Promise<DeepSeekModelCatalog> {
  if (!modelDiscoveryEnabled(env)) return unavailable();
  try {
    const home = resolveDeepSeekHome(env), executable = resolveDeepSeekExecutable(env);
    const signatures = await Promise.all(["cordis.patch.yml", "settings.yaml", ".credentials.yaml", "profiles/web/cordis.patch.yml", "profiles/web/package.json"].map(async name => {
      try { const info = await stat(path.join(home, name)); return [name, info.size, info.mtimeMs, info.ino]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [name, null]; throw error; }
    }));
    const key = createHash("sha256").update(JSON.stringify([executable, home, env, cwd, signatures])).digest("hex");
    const current = cache.get(key);
    // A normal result is published after cleanup. A timed-out preparation
    // stays coalesced until cleanup finishes, so retries cannot pile up copies.
    if (current && (current.expires === Infinity || !fresh && current.expires > Date.now())) return current.promise;
    if (cache.size >= 16 && !cache.has(key)) {
      const completed = [...cache].find(([, entry]) => entry.expires !== Infinity);
      if (completed) cache.delete(completed[0]); else return unavailable();
    }
    const entry = { expires: Infinity, promise: Promise.resolve(unavailable()) };
    let status: DeepSeekModelCatalog["status"] = "unavailable";
    entry.promise = readCatalog(executable, home, env, cwd, () => { entry.expires = Date.now() + (status === "ready" ? 30_000 : 1000); })
      .then(result => { status = result.status; if (entry.expires !== Infinity) entry.expires = Date.now() + (status === "ready" ? 30_000 : 1000); return result; }, () => { entry.expires = Date.now() + 1000; return unavailable(); });
    cache.set(key, entry);
    return await entry.promise;
  } catch { return unavailable(); }
}

async function readCatalog(executable: string, sharedHome: string, env: NodeJS.ProcessEnv, cwd: string | undefined, closed: () => void): Promise<DeepSeekModelCatalog> {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-dsh-catalog-"));
  const home = path.join(root, "home"), workspace = cwd ?? path.join(root, "workspace");
  const abort = new AbortController(), deadline = Date.now() + DEADLINE_MS;
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
  const timeout = new Promise<DeepSeekModelCatalog>(resolve => { timer = setTimeout(() => { abort.abort(); if (child) void stop(); resolve(unavailable()); }, DEADLINE_MS); });
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
