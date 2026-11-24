import path from "node:path";
import { executableCandidates, resolveEngineExecutable } from "./engine-process.js";

/**
 * Resolve the file an `omp` launch executes. A bare command name is resolved
 * strictly through absolute PATH directories (never relative to the workspace).
 * An explicit absolute path is returned unchanged.
 */
export function resolveOmpLaunchCommand(command: string, env: NodeJS.ProcessEnv, platform = process.platform): string | undefined {
  const windows = platform === "win32";
  const name = command.trim().replace(/^"(.*)"$/, "$1");
  if (!name) return undefined;
  if (windows ? /[\\/]/.test(name) : name.includes("/")) return command;
  const absolute = (file: string) => windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(file) : path.posix.isAbsolute(file);
  for (const file of executableCandidates(name, env, platform)) {
    const found = absolute(file) ? resolveEngineExecutable(file, env, platform) : undefined;
    if (found) return found;
  }
  return undefined;
}

/**
 * Shared by launch, Doctor, Host engine settings, and availability checks.
 * Covers oh-my-pi's official install paths: explicit OMP_EXECUTABLE override,
 * PATH, omp.sh (~/.local/bin, ~/.omp/bin), Homebrew (/opt/homebrew/bin,
 * /usr/local/bin), and bun global installs ($BUN_INSTALL/bin, ~/.bun/bin).
 */
export function resolveOmpExecutable(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const value = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const explicit = value("OMP_EXECUTABLE");
  if (explicit !== undefined && explicit !== "") return explicit.trim().replace(/^"(.*)"$/, "$1");
  if (resolveEngineExecutable("omp", env, platform)) return "omp";
  const absolute = (candidate: string | undefined) => candidate && !/[\x00-\x1f\x7f]/.test(candidate)
    && (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(candidate) : p.isAbsolute(candidate)) ? candidate : undefined;
  const home = absolute(value(windows ? "USERPROFILE" : "HOME"));
  const bunInstall = absolute(value("BUN_INSTALL"));
  const roaming = absolute(value("APPDATA")) ?? (home && p.join(home, "AppData", "Roaming"));
  const binNames = windows ? ["omp.exe", "omp.cmd"] : ["omp"];
  const dirs = [
    ...(bunInstall ? [p.join(bunInstall, "bin")] : []),
    ...(home ? [p.join(home, ".bun", "bin"), p.join(home, ".local", "bin"), p.join(home, ".omp", "bin")] : []),
    ...(!windows ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
    ...(windows && roaming ? [p.join(roaming, "npm")] : []),
  ];
  for (const dir of dirs) {
    for (const bin of binNames) {
      const candidate = p.join(dir, bin);
      if (resolveEngineExecutable(candidate, env, platform)) return candidate;
    }
  }
  return "omp";
}
