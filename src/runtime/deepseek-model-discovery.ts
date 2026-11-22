import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDeepSeekHome } from "../config.js";
import { parseDeepSeekModelCatalog, type DeepSeekModelCatalog } from "../codex/deepseek-models.js";
import { DEEPSEEK_HARNESS_PROFILE, prepareDeepSeekHarnessPrivateProfile, syncDeepSeekHarnessProfileRootFiles } from "../codex/deepseek-harness-profile.js";
import { withFileMutex } from "../state/file-mutex.js";
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
export type DeepSeekDiscoveryTiming = {
  deadlineMs?: number; refreshDeadlineMs?: number; reclaimWaitMs?: number;
  /** A persistent private home for catalog reads, shared by every process of one Host and used one read at a
   * time. Its profile mirror is kept between reads, so an unchanged shared profile is not copied again.
   * Without it each read copies the profile into a new temporary home, as before. */
  catalogHome?: string;
};
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
    const key = createHash("sha256").update(JSON.stringify([executable, home, env, cwd, signatures, timing.catalogHome])).digest("hex");
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
      return await readCatalog(executable, home, env, cwd, deadline, reclaim, timing.catalogHome);
    })().catch(() => { reclaim(); return unavailable(); }).then(result => {
      entry.answered = true; entry.status = result.status; entry.expires = Date.now() + (result.status === "ready" ? 30_000 : 1000);
      return result;
    });
    cache.set(key, entry);
    return await entry.promise;
  } catch { return unavailable(); }
}

const CONFIG_FILES = ["cordis.patch.yml", "settings.yaml", ".credentials.yaml"] as const;
/** Written last, removed as soon as the read's child has exited. */
const CREDENTIALS = ".credentials.yaml";
const MIRROR_MARK = ".tarobird-catalog-mirror.json";
const TEMPORARY_PREFIX = "tarobird-dsh-catalog-";
/** A temporary home this old is no read's any more: the longest read ends within seconds. */
const ABANDONED_TEMPORARY_MS = 60 * 60_000;

async function readCatalog(executable: string, sharedHome: string, env: NodeJS.ProcessEnv, cwd: string | undefined, deadline: number, closed: () => void, catalogHome?: string): Promise<DeepSeekModelCatalog> {
  const abort = new AbortController();
  let child: DeepSeekHarnessChildProcess | undefined, protocol: DeepSeekHarnessProtocolClient | undefined;
  let finished: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => finished ??= (async () => { await protocol?.close().catch(() => {}); if (child) await stopChild(child, 300); })();
  // The answer is returned as soon as it is read. Stopping the child and
  // cleaning up continue afterwards, and only then is this read reclaimed.
  let deliver!: (catalog: DeepSeekModelCatalog) => void;
  const delivered = new Promise<DeepSeekModelCatalog>(resolve => { deliver = resolve; });
  const query = async (home: string, workspace: string) => {
    if (abort.signal.aborted) throw new Error("catalog_timeout");
    child = spawnEngine(executable, ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"], {
      cwd: workspace, env: deepseekParentGuardEnvironment({ ...env, DSH_HOME: home }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }) as unknown as DeepSeekHarnessChildProcess;
    // No tokens, raw config, failure text or startup output reach callers/logs.
    const url = await waitForStartupUrl(child, Math.max(1, deadline - Date.now()));
    child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
    if (abort.signal.aborted) throw new Error("catalog_timeout");
    protocol = new DeepSeekHarnessProtocolClient(url, { requestTimeoutMs: Math.max(1, deadline - Date.now()) });
    const catalog = parseDeepSeekModelCatalog(await protocol.request("session/modelCatalog", {}, abort.signal));
    clearTimeout(timer); deliver(catalog);
  };
  // Cleanup waits for preparation too; a timed-out profile copy must never
  // recreate files after its home has already been cleaned.
  const work = (catalogHome ? persistentRead(catalogHome, sharedHome, cwd, deadline, abort.signal, query, stop) : temporaryRead(sharedHome, cwd, abort.signal, query, stop))
    .finally(() => { clearTimeout(timer); closed(); });
  const timeout = new Promise<DeepSeekModelCatalog>(resolve => { timer = setTimeout(() => { abort.abort(); if (child) void stop(); resolve(unavailable()); }, Math.max(1, deadline - Date.now())); });
  return await Promise.race([delivered, work.then(unavailable, unavailable), timeout]);
}

type Query = (home: string, workspace: string) => Promise<void>;

/** The original layout: a new temporary home per read, removed afterwards. */
async function temporaryRead(sharedHome: string, cwd: string | undefined, signal: AbortSignal, query: Query, stop: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), TEMPORARY_PREFIX));
  const home = path.join(root, "home"), workspace = cwd ?? path.join(root, "workspace");
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    if (!cwd) await mkdir(workspace, { mode: 0o700 });
    const profiles = await stat(path.join(sharedHome, "profiles")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
    });
    if (profiles) await prepareDeepSeekHarnessPrivateProfile({ sharedHome, privateHome: home });
    else await mkdir(path.join(home, "profiles", "web"), { recursive: true, mode: 0o700 });
    await copyConfigFiles(sharedHome, home);
    if (signal.aborted) throw new Error("catalog_timeout");
    await query(home, workspace);
  } finally {
    await stop();
    await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
  }
}

/**
 * One persistent private home for every catalog read of this Host, one read
 * at a time across processes. The profile mirror is incremental, and skipped
 * entirely while the shared profile's packages are unchanged: then only its
 * few root files are compared and copied, a fixed amount of work however large
 * the shared packages are. A copy that outlives its read's deadline keeps
 * going, so the next read finds it done. Credentials are copied for the read
 * and removed as soon as its child has exited; a read interrupted by the Host
 * exiting leaves them only in this owner-only directory, replaced next time.
 */
async function persistentRead(catalogHome: string, sharedHome: string, cwd: string | undefined, deadline: number, signal: AbortSignal, query: Query, stop: () => Promise<void>): Promise<void> {
  sweepAbandonedTemporaryHomes();
  await mkdir(catalogHome, { recursive: true, mode: 0o700 });
  await withFileMutex(path.join(catalogHome, "catalog"), async () => {
    const home = path.join(catalogHome, "home"), workspace = cwd ?? path.join(catalogHome, "workspace");
    try {
      await ensureDirectory(home);
      // What an interrupted read left goes before this one starts.
      await scrubCatalogHome(home);
      if (!cwd) await ensureDirectory(workspace);
      await mirrorProfile(sharedHome, home);
      await copyConfigFiles(sharedHome, home);
      if (signal.aborted) throw new Error("catalog_timeout");
      await query(home, workspace);
    } finally {
      await stop();
      await scrubCatalogHome(home).catch(() => {});
    }
  }, { waitTimeoutMs: Math.max(1, deadline - Date.now()) });
}

/** Keep only the package mirror between reads: credentials, configuration,
 * native state dsh wrote (imported settings, storages) and the profile's root
 * files are removed; the next read copies what it needs again. A directory
 * linked into the profile's root is part of the mirror: only a full mirror
 * recreates it, and a Windows junction may refuse a plain unlink. */
async function scrubCatalogHome(home: string): Promise<void> {
  await rm(path.join(home, CREDENTIALS), { force: true });
  for (const name of await readdir(home).catch(() => [] as string[])) {
    if (name === "profiles" || name === MIRROR_MARK) continue;
    await rm(path.join(home, name), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  }
  const profile = path.join(home, "profiles", DEEPSEEK_HARNESS_PROFILE);
  for (const name of await readdir(profile).catch(() => [] as string[])) {
    if (name === ".tarobird-profile-mirror.json") continue;
    const entry = path.join(profile, name), info = await lstat(entry).catch(() => undefined);
    if (info && !info.isDirectory() && !info.isSymbolicLink()) await rm(entry, { force: true });
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (info && !info.isDirectory()) await rm(directory, { force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

/** Mirror the shared profile into `home`, or only its root files when its packages have not changed since the last complete mirror. */
async function mirrorProfile(sharedHome: string, home: string): Promise<void> {
  const profiles = await stat(path.join(sharedHome, "profiles")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;
  });
  if (!profiles) {
    // A mirror of another DeepSeek home (DSH_HOME moved) would still load its plugins here. It is emptied
    // the way a full mirror removes what it made (recorded entries only, a link as a link), against an
    // empty profile; the mark goes once that is done.
    if (await stat(path.join(home, MIRROR_MARK)).then(() => true, () => false)) {
      const empty = path.join(path.dirname(home), "empty-home");
      await mkdir(path.join(empty, "profiles"), { recursive: true, mode: 0o700 });
      await prepareDeepSeekHarnessPrivateProfile({ sharedHome: empty, privateHome: home });
      await rm(path.join(home, MIRROR_MARK), { force: true });
    }
    await mkdir(path.join(home, "profiles", DEEPSEEK_HARNESS_PROFILE), { recursive: true, mode: 0o700 });
    return;
  }
  const mark = path.join(home, MIRROR_MARK), signature = await sharedPackagesSignature(sharedHome);
  const previous = await readFile(mark, "utf8").then(text => (JSON.parse(text) as { signature?: unknown }).signature, () => undefined);
  if (previous === signature) { await syncDeepSeekHarnessProfileRootFiles({ sharedHome, privateHome: home }); return; }
  await rm(mark, { force: true });
  await prepareDeepSeekHarnessPrivateProfile({ sharedHome, privateHome: home });
  // Signed before the mirror began: a change made meanwhile is mirrored next time.
  await writeFile(mark, JSON.stringify({ signature }), { mode: 0o600 });
}

/**
 * What changes when a package is added, removed, updated or relinked in the
 * shared profile: its root entry names, each root directory, each installed
 * package directory and its manifest, and the package managers' own records.
 * One stat per package, not per file. Root file contents are compared on every read instead.
 */
export async function sharedPackagesSignature(sharedHome: string): Promise<string> {
  const profile = path.join(sharedHome, "profiles", DEEPSEEK_HARNESS_PROFILE);
  const sign = async (file: string) => { try { const info = await stat(file); return [info.isDirectory() ? "d" : "f", info.size, info.mtimeMs, info.ctimeMs]; } catch { return null; } };
  const names = async (directory: string) => (await readdir(directory).catch(() => [] as string[])).sort();
  const parts: unknown[] = [];
  for (const name of await names(profile)) {
    const info = await sign(path.join(profile, name));
    // Root files are compared by content on every read; only the set of names matters here.
    parts.push([name, info?.[0] === "d" || /^(package(-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock)$/.test(name) ? info : info?.[0]]);
  }
  const modules = path.join(profile, "node_modules");
  for (const file of [".package-lock.json", ".modules.yaml", ".yarn-state.yml"]) parts.push([file, await sign(path.join(modules, file))]);
  for (const name of await names(modules)) {
    if (name.startsWith(".")) continue;
    const packages = name.startsWith("@") ? (await names(path.join(modules, name))).map(child => `${name}/${child}`) : [name];
    if (name.startsWith("@")) parts.push([name, await sign(path.join(modules, name))]);
    for (const pkg of packages) parts.push([pkg, await sign(path.join(modules, pkg)), await sign(path.join(modules, pkg, "package.json"))]);
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Shared configuration as of this read; a file the shared home no longer has is removed too. */
async function copyConfigFiles(sharedHome: string, home: string): Promise<void> {
  // Credentials last, so a failure before them leaves none behind.
  for (const name of CONFIG_FILES) {
    const target = path.join(home, name);
    let bytes: Buffer;
    try { bytes = await readDeepSeekCatalogConfig(path.join(sharedHome, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await rm(target, { force: true }); continue;
    }
    // Renamed over its target, so an existing entry is replaced, never written through.
    const staged = `${target}.${process.pid}.${Date.now()}.tmp`;
    try { await writeFile(staged, bytes, { mode: 0o600, flag: "wx" }); await rename(staged, target); }
    finally { await rm(staged, { force: true }).catch(() => {}); }
  }
}

let swept = false;
/** Earlier versions read in temporary homes and leave one, with a credentials copy, when their process is killed mid-read. */
function sweepAbandonedTemporaryHomes(): void {
  if (swept) return;
  swept = true;
  void (async () => {
    const directory = os.tmpdir();
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.startsWith(TEMPORARY_PREFIX)) continue;
      const entry = path.join(directory, name), info = await lstat(entry).catch(() => undefined);
      if (!info?.isDirectory() || Date.now() - info.mtimeMs < ABANDONED_TEMPORARY_MS) continue;
      if (process.platform !== "win32" && typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
      await rm(entry, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
    }
  })();
}

export function resetDeepSeekModelDiscoveryForTest(): void { cache.clear(); swept = false; }
