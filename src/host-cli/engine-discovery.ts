import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type DiscoveryRule =
  | "setting"
  | "environment"
  | "auto-discovered"
  | "login-shell"
  | "package-manager"
  | "windows-registry"
  | "path"
  | "known-directory";

export type TaggedDirectory = {
  dir: string;
  rule: Exclude<DiscoveryRule, "setting" | "environment" | "auto-discovered">;
};

export type DanglingLinkInfo = {
  linkPath: string;
  targetPath: string;
};

export type ShellProbeResult = {
  ok: boolean;
  timedOut?: boolean;
  status: "ok" | "timeout" | "failed" | "skipped";
  pathDirs: string[];
  resolvedCommands: Record<string, string>;
};

export type CommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export const SHELL_ENV_PROBE_FLAG = "TAROBIRD_SHELL_ENV_PROBE";

const defaultRunner: CommandRunner = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: options.timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: options.env,
    windowsHide: options.windowsHide ?? true,
    encoding: "utf8",
  });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
};

const directoryExists = (directory: string) => { try { return statSync(directory).isDirectory(); } catch { return false; } };
function smallAlias(file: string): string | undefined {
  try { const info = statSync(file); if (info.isFile() && info.size <= 4096) return readFileSync(file, "utf8").trim(); } catch { /* Not configured. */ }
}

export function lookupEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env[key] !== undefined) return env[key];
  if (platform !== "win32") return undefined;
  const upper = key.toUpperCase();
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

/** Read nvm's selected default only. Never add every installed Node version,
 * execute shell profiles, or guess a version when an alias cannot be resolved. */
function nvmDefault(root: string): string | undefined {
  let alias = "default";
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(alias)) return; seen.add(alias);
    if (/^v?\d+(?:\.\d+){0,2}$/.test(alias) || alias === "node" || alias === "stable") {
      try {
        const names = readdirSync(path.join(root, "versions/node"));
        if (names.length > 1024) return;
        // nvm documents `stable` as an alias for `node`: the newest installed version.
        const prefix = alias.replace(/^v/, ""), any = alias === "node" || alias === "stable";
        const selected = names.filter(name => /^v\d+\.\d+\.\d+$/.test(name))
          .filter(name => any || name.slice(1) === prefix || name.slice(1).startsWith(`${prefix}.`))
          .sort((a, b) => { const aa = a.slice(1).split(".").map(Number), bb = b.slice(1).split(".").map(Number); return bb[0]! - aa[0]! || bb[1]! - aa[1]! || bb[2]! - aa[2]!; })[0];
        return selected ? path.join(root, "versions/node", selected, "bin") : undefined;
      } catch { return; }
    }
    if (!/^(?:[a-zA-Z0-9_-]+|lts\/(?:[a-zA-Z0-9_-]+|\*))$/.test(alias)) return;
    const next = smallAlias(path.join(root, "alias", alias)); if (!next) return; alias = next;
  }
}

/** fnm uses the first existing base directory: XDG data (also on macOS), then
 * the legacy ~/.fnm, then macOS Application Support. Mirror that order instead
 * of searching a directory fnm itself would not use. */
function fnmDirectory(home: string, data: string, platform: NodeJS.Platform): string {
  const candidates = [path.join(data, "fnm"), path.join(home, ".fnm"), ...(platform === "darwin" ? [path.join(home, "Library/Application Support/fnm")] : [])];
  return candidates.find(directoryExists) ?? candidates[0]!;
}

export function discoverWindowsEngineDirectories(
  home: string,
  env: NodeJS.ProcessEnv,
  existsCheck: (dir: string) => boolean = directoryExists,
): string[] {
  const p = path.win32;
  const get = (key: string) => lookupEnvCaseInsensitive(env, key, "win32")?.trim();
  const safeAbs = (value: string | undefined) => value && p.isAbsolute(value) && !/[\x00-\x1f\x7f;]/.test(value) ? value : undefined;

  const appData = safeAbs(get("APPDATA"));
  const localAppData = safeAbs(get("LOCALAPPDATA"));
  const pnpmHome = safeAbs(get("PNPM_HOME"));
  const voltaHome = safeAbs(get("VOLTA_HOME"));
  const scoop = safeAbs(get("SCOOP"));
  const nvmSymlink = safeAbs(get("NVM_SYMLINK"));
  const programFiles = safeAbs(get("ProgramFiles")) ?? "C:\\Program Files";
  const systemRoot = safeAbs(get("SystemRoot")) ?? "C:\\Windows";

  const raw: Array<string | undefined> = [
    appData ? p.join(appData, "npm") : undefined,
    pnpmHome,
    voltaHome ? p.join(voltaHome, "bin") : undefined,
    localAppData ? p.join(localAppData, "Volta", "bin") : undefined,
    scoop ? p.join(scoop, "shims") : undefined,
    home ? p.join(home, "scoop", "shims") : undefined,
    nvmSymlink,
    localAppData ? p.join(localAppData, "Microsoft", "WinGet", "Links") : undefined,
    p.join(programFiles, "Git", "cmd"),
    p.join(programFiles, "Git", "usr", "bin"),
    localAppData ? p.join(localAppData, "Programs", "Git", "cmd") : undefined,
    p.join(systemRoot, "System32"),
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of raw) {
    if (!dir || /[\x00-\x1f\x7f;]/.test(dir)) continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    if (!existsCheck(dir)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** Fallbacks follow the inherited PATH, preserving the operator's selection.
 * fnm's alias is a symlink to its installation; asdf/mise/Volta use stable shims. */
export function discoverEngineDirectories(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  existsCheck: (dir: string) => boolean = directoryExists,
): string[] {
  if (platform === "win32") return discoverWindowsEngineDirectories(home, env, existsCheck);
  const root = (key: string, fallback: string) => env[key] && path.posix.isAbsolute(env[key]!) && !/[\x00-\x1f\x7f:]/.test(env[key]!) ? env[key]! : fallback;
  const data = root("XDG_DATA_HOME", path.join(home, ".local/share"));
  const fnm = root("FNM_DIR", fnmDirectory(home, data, platform));
  const candidates = [
    path.join(root("VOLTA_HOME", path.join(home, ".volta")), "bin"),
    path.join(root("BUN_INSTALL", path.join(home, ".bun")), "bin"),
    path.join(root("ASDF_DATA_DIR", path.join(home, ".asdf")), "shims"),
    path.join(root("MISE_DATA_DIR", path.join(data, "mise")), "shims"),
    path.join(fnm, "aliases/default/bin"),
    nvmDefault(root("NVM_DIR", path.join(home, ".nvm"))),
  ];
  return candidates.filter((directory): directory is string => !!directory && !/[\x00-\x1f\x7f:]/.test(directory) && existsCheck(directory));
}

/** Parse `reg.exe query <key> /v Path` output into individual PATH entries. */
export function parseWindowsRegistryPathOutput(stdout: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    const expanded = raw.replace(/%([^%]+)%/g, (full, varName: string) => {
      const value = lookupEnvCaseInsensitive(env, varName, "win32");
      return value !== undefined ? value : full;
    });
    return expanded
      .split(";")
      .map(entry => entry.trim().replace(/^"(.*)"$/, "$1"))
      .filter(entry => !!entry && !/[\x00-\x1f\x7f]/.test(entry));
  }
  return [];
}

/** Read latest user and system PATH directly from Windows Registry (HKCU + HKLM). */
export async function readWindowsRegistryPath(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: CommandRunner;
} = {}): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return [];
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const timeout = options.timeoutMs ?? 2500;
  const keys = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  const results = await Promise.all(keys.map(async (key) => {
    try {
      const { stdout } = await runner("reg.exe", ["query", key, "/v", "Path"], { timeout, env, windowsHide: true });
      return parseWindowsRegistryPathOutput(stdout, env);
    } catch {
      return [];
    }
  }));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of results) {
    for (const dir of list) {
      const norm = dir.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(dir);
    }
  }
  return out;
}

const SHELL_PATH_BEGIN = "__TAROBIRD_SHELL_PATH_BEGIN__";
const SHELL_PATH_END = "__TAROBIRD_SHELL_PATH_END__";
const SHELL_CMD_PREFIX = "__TAROBIRD_CMD__:";

function safeShellPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const candidate = env.SHELL?.trim();
  if (candidate && path.posix.isAbsolute(candidate) && !/[\x00-\x1f\x7f\s]/.test(candidate)) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* fall through */ }
  }
  if (env === process.env) {
    try {
      const userShell = os.userInfo().shell?.trim();
      if (userShell && path.posix.isAbsolute(userShell) && !/[\x00-\x1f\x7f\s]/.test(userShell)) {
        accessSync(userShell, constants.X_OK);
        if (statSync(userShell).isFile()) return userShell;
      }
    } catch { /* fall through */ }
  }
  return platform === "darwin" ? "/bin/zsh" : "/bin/sh";
}

/** Probe the user's login interactive shell once (macOS / Linux) to read PATH
 * and `command -v` for each engine command. Times out safely without failing startup. */
export async function probeLoginShellEnvironment(options: {
  commands?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  shell?: string;
  runner?: CommandRunner;
} = {}): Promise<ShellProbeResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };

  const env = options.env ?? process.env;
  if (env[SHELL_ENV_PROBE_FLAG] === "0") return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };
  if (!options.shell && !options.runner && !env.SHELL && env !== process.env) {
    return { ok: false, status: "skipped", pathDirs: [], resolvedCommands: {} };
  }
  const runner = options.runner ?? defaultRunner;
  const timeout = options.timeoutMs ?? 6000;
  const shell = options.shell ?? safeShellPath(env, platform);
  const commands = (options.commands ?? []).filter(cmd => /^[A-Za-z0-9._-]+$/.test(cmd));

  const cmdChecks = commands.map(cmd => `p=$(command -v ${cmd} 2>/dev/null || true); [ -n "$p" ] && printf '%s%s=%s\\n' '${SHELL_CMD_PREFIX}' '${cmd}' "$p"`).join("; ");
  const script = `printf '%s\\n%s\\n%s\\n' '${SHELL_PATH_BEGIN}' "$PATH" '${SHELL_PATH_END}'; ${cmdChecks}`;
  const probeEnv: NodeJS.ProcessEnv = {
    ...env,
    [SHELL_ENV_PROBE_FLAG]: "1",
    TERM: "dumb",
    DISABLE_AUTO_UPDATE: "true",
    ZSH_TMUX_AUTOSTART: "false",
  };

  try {
    const { stdout } = await runner(shell, ["-ilc", script], { timeout, env: probeEnv });
    const startIdx = stdout.indexOf(SHELL_PATH_BEGIN);
    const endIdx = stdout.indexOf(SHELL_PATH_END, startIdx >= 0 ? startIdx + SHELL_PATH_BEGIN.length : 0);
    if (startIdx < 0 || endIdx < 0) {
      return { ok: false, status: "failed", pathDirs: [], resolvedCommands: {} };
    }
    const rawPath = stdout.slice(startIdx + SHELL_PATH_BEGIN.length, endIdx).trim();
    const pathDirs = rawPath
      .split(":")
      .map(dir => dir.trim())
      .filter(dir => !!dir && path.posix.isAbsolute(dir) && !/[\x00-\x1f\x7f]/.test(dir));

    const resolvedCommands: Record<string, string> = {};
    const afterPath = stdout.slice(endIdx + SHELL_PATH_END.length);
    for (const line of afterPath.split(/\r?\n/)) {
      if (!line.startsWith(SHELL_CMD_PREFIX)) continue;
      const body = line.slice(SHELL_CMD_PREFIX.length);
      const eq = body.indexOf("=");
      if (eq <= 0) continue;
      const cmd = body.slice(0, eq).trim();
      const target = body.slice(eq + 1).trim();
      if (cmd && target && path.posix.isAbsolute(target) && !/[\x00-\x1f\x7f]/.test(target)) {
        resolvedCommands[cmd] = target;
      }
    }
    return { ok: true, status: "ok", pathDirs, resolvedCommands };
  } catch (error) {
    const timedOut = !!(error && typeof error === "object" && ("killed" in error && (error as { killed?: boolean }).killed || "signal" in error && (error as { signal?: string }).signal === "SIGTERM" || "code" in error && (error as { code?: string }).code === "ETIMEDOUT"));
    return { ok: false, timedOut, status: timedOut ? "timeout" : "failed", pathDirs: [], resolvedCommands: {} };
  }
}

function findCommandInDirs(command: string, dirs: readonly string[], platform: NodeJS.Platform): string | undefined {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const exts = windows ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, command + ext);
      try {
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch { /* continue */ }
    }
  }
  return undefined;
}

/** Query available package managers (`npm`, `pnpm`, `bun`, `yarn`) for their
 * global binary directories, covering manually installed Node & custom prefixes. */
export async function probePackageManagerBinDirectories(options: {
  searchDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: CommandRunner;
  existsCheck?: (dir: string) => boolean;
  findTool?: (name: string) => string | undefined;
} ): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const runner = options.runner ?? defaultRunner;
  const timeout = options.timeoutMs ?? 2500;
  const existsCheck = options.existsCheck ?? directoryExists;
  const findTool = options.findTool ?? ((name: string) => findCommandInDirs(name, options.searchDirs, platform));

  const queries: Array<{ tool: string; args: string[]; transform: (out: string) => string | undefined }> = [
    {
      tool: "npm",
      args: ["prefix", "-g"],
      transform: (out) => {
        const prefix = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        if (!prefix || !p.isAbsolute(prefix)) return undefined;
        return windows ? prefix : p.join(prefix, "bin");
      },
    },
    {
      tool: "pnpm",
      args: ["bin", "-g"],
      transform: (out) => {
        const dir = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        return dir && p.isAbsolute(dir) ? dir : undefined;
      },
    },
    {
      tool: "bun",
      args: ["pm", "bin", "-g"],
      transform: (out) => {
        const dir = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        return dir && p.isAbsolute(dir) ? dir : undefined;
      },
    },
    {
      tool: "yarn",
      args: ["global", "bin"],
      transform: (out) => {
        const dir = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
        return dir && p.isAbsolute(dir) ? dir : undefined;
      },
    },
  ];

  const found = await Promise.all(queries.map(async (q) => {
    const exe = findTool(q.tool);
    if (!exe) return undefined;
    try {
      const { stdout } = await runner(exe, q.args, { timeout, env, windowsHide: true });
      const dir = q.transform(stdout);
      if (dir && !/[\x00-\x1f\x7f]/.test(dir) && existsCheck(dir)) return dir;
    } catch { /* ignore unavailable/timed-out package manager */ }
    return undefined;
  }));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of found) {
    if (!dir) continue;
    const key = windows ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** Merge tagged search directories preserving first-occurrence priority (matching
 * terminal precedence) and deduplicating case-insensitively on Windows. */
export function mergeTaggedDirectories(lists: ReadonlyArray<readonly TaggedDirectory[]>, platform: NodeJS.Platform = process.platform): TaggedDirectory[] {
  const windows = platform === "win32";
  const seen = new Set<string>();
  const out: TaggedDirectory[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const dir = entry.dir.trim().replace(/^"(.*)"$/, "$1");
      if (!dir || /[\x00-\x1f\x7f]/.test(dir)) continue;
      const key = windows ? dir.toLowerCase() : dir;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ dir, rule: entry.rule });
    }
  }
  return out;
}

/** Inspect candidates for `command` across tagged search directories, recording
 * any dangling symlinks (`linkPath -> targetPath`) instead of silently hiding them. */
export function diagnoseExecutableCandidates(
  command: string,
  taggedDirs: readonly TaggedDirectory[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { executable: string | null; rule: DiscoveryRule | null; danglingLinks: DanglingLinkInfo[] } {
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const name = command.trim().replace(/^"(.*)"$/, "$1");
  if (!name || /[\x00-\x1f\x7f]/.test(name)) return { executable: null, rule: null, danglingLinks: [] };

  const pathext = lookupEnvCaseInsensitive(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = windows && !p.extname(name) ? pathext.split(";").filter(ext => /^\.[a-z0-9]+$/i.test(ext)) : [""];

  const checkFile = (file: string): "ok" | { dangling: string } | "missing" => {
    try {
      accessSync(file, windows ? constants.F_OK : constants.X_OK);
      if (statSync(file).isFile()) return "ok";
      return "missing";
    } catch {
      try {
        const link = lstatSync(file);
        if (link.isSymbolicLink()) {
          const rawTarget = readlinkSync(file);
          const resolvedTarget = p.isAbsolute(rawTarget) ? rawTarget : p.resolve(p.dirname(file), rawTarget);
          return { dangling: resolvedTarget };
        }
      } catch { /* truly missing */ }
      return "missing";
    }
  };

  const danglingLinks: DanglingLinkInfo[] = [];
  if (p.isAbsolute(name)) {
    for (const ext of extensions) {
      const candidate = name + ext;
      const status = checkFile(candidate);
      if (status === "ok") return { executable: candidate, rule: "setting", danglingLinks };
      if (typeof status === "object") danglingLinks.push({ linkPath: candidate, targetPath: status.dangling });
    }
    return { executable: null, rule: null, danglingLinks };
  }

  for (const { dir, rule } of taggedDirs) {
    for (const ext of extensions) {
      const candidate = p.join(dir, name + ext);
      const status = checkFile(candidate);
      if (status === "ok") return { executable: candidate, rule, danglingLinks };
      if (typeof status === "object") danglingLinks.push({ linkPath: candidate, targetPath: status.dangling });
    }
  }
  return { executable: null, rule: null, danglingLinks };
}

// --- Cached probe coordinator + version cache ---

type CachedProbe = {
  at: number;
  shell: ShellProbeResult;
  packageManagerDirs: string[];
  windowsRegistryDirs: string[];
};

const PROBE_CACHE_TTL_MS = 60_000;
let probeCache: { key: string; value: CachedProbe } | undefined;
const versionCache = new Map<string, { mtimeMs: number; version: string | null }>();

export function clearDiscoveryCaches(): void {
  probeCache = undefined;
  versionCache.clear();
}

export async function runEnvironmentDiscovery(options: {
  baseEnv: NodeJS.ProcessEnv;
  commands: readonly string[];
  home?: string;
  platform?: NodeJS.Platform;
  forceRefresh?: boolean;
  timeoutMs?: number;
  runner?: CommandRunner;
}): Promise<CachedProbe> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const basePath = lookupEnvCaseInsensitive(options.baseEnv, "PATH", platform) ?? "";
  const cacheKey = `${platform}|${home}|${options.baseEnv.SHELL ?? ""}|${basePath}`;

  if (!options.forceRefresh && probeCache && probeCache.key === cacheKey && Date.now() - probeCache.value.at < PROBE_CACHE_TTL_MS) {
    return probeCache.value;
  }

  const [shell, windowsRegistryDirs] = await Promise.all([
    probeLoginShellEnvironment({
      commands: options.commands,
      env: options.baseEnv,
      platform,
      timeoutMs: options.timeoutMs ?? (platform === "win32" ? 10_000 : 6_000),
      runner: options.runner,
    }),
    readWindowsRegistryPath({ env: options.baseEnv, platform, runner: options.runner }),
  ]);

  const baseDirs = basePath.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const knownDirs = discoverEngineDirectories(home, options.baseEnv, platform);
  const combinedForPm = [...new Set([...shell.pathDirs, ...windowsRegistryDirs, ...baseDirs, ...knownDirs])];
  const packageManagerDirs = await probePackageManagerBinDirectories({
    searchDirs: combinedForPm,
    env: { ...options.baseEnv, PATH: combinedForPm.join(platform === "win32" ? ";" : ":") },
    platform,
    runner: options.runner,
  });

  const value: CachedProbe = { at: Date.now(), shell, packageManagerDirs, windowsRegistryDirs };
  probeCache = { key: cacheKey, value };
  return value;
}

function looksLikeUnixExecutable(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY);
    const buf = Buffer.alloc(4);
    const bytes = readSync(fd, buf, 0, 4, 0);
    if (bytes < 2) return false;
    // Shebang script (#!)
    if (buf[0] === 0x23 && buf[1] === 0x21) return true;
    if (bytes < 4) return false;
    // ELF (\x7fELF)
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // Mach-O 32/64/universal magics
    const magic = buf.readUInt32BE(0);
    return magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xcefaedfe || magic === 0xfeedface || magic === 0xcafebabe || magic === 0xbebafeca;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** Read an engine CLI's `--version` safely with a short timeout and mtime cache.
 * Never modifies HOME or runs interactive/login commands. */
export async function probeExecutableVersion(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultRunner,
): Promise<string | null> {
  let mtimeMs = 0;
  try { mtimeMs = statSync(executable).mtimeMs; } catch { return null; }
  const cached = versionCache.get(executable);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;

  if (runner === defaultRunner && process.platform !== "win32" && !looksLikeUnixExecutable(executable)) {
    versionCache.set(executable, { mtimeMs, version: null });
    return null;
  }

  try {
    const { stdout, stderr } = await runner(executable, ["--version"], { timeout: 2500, env, windowsHide: true });
    const raw = (stdout || stderr).split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
    const version = raw ? raw.slice(0, 80) : null;
    versionCache.set(executable, { mtimeMs, version });
    return version;
  } catch {
    versionCache.set(executable, { mtimeMs, version: null });
    return null;
  }
}
