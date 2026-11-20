import path from "node:path";
import { resolveEngineExecutable } from "./engine-process.js";

/** Shared by launch, Doctor, settings and availability. Prefer the user's
 * selection; only inspect known installer paths, never execute candidates. */
export function resolvePiExecutable(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const windows = platform === "win32", p = windows ? path.win32 : path.posix;
  const value = (key: string) => env[key] ?? (windows ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const explicit = value("PI_EXECUTABLE");
  if (explicit !== undefined && explicit !== "") return explicit.trim().replace(/^"(.*)"$/, "$1");
  if (resolveEngineExecutable("pi", env, platform)) return "pi";
  const absolute = (candidate: string | undefined) => candidate && !/[\x00-\x1f\x7f]/.test(candidate)
    && (windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(candidate) : p.isAbsolute(candidate)) ? candidate : undefined;
  const home = absolute(value(windows ? "USERPROFILE" : "HOME"));
  const roaming = absolute(value("APPDATA")) ?? (home && p.join(home, "AppData", "Roaming"));
  const agent = absolute(value("PI_CODING_AGENT_DIR")) ?? (home && p.join(home, ".pi", "agent"));
  const candidates = [
    ...(windows && roaming ? [p.join(roaming, "npm", "pi.cmd")] : []),
    ...(agent ? [p.join(agent, "bin", windows ? "pi.cmd" : "pi")] : []),
  ];
  return candidates.find(file => resolveEngineExecutable(file, env, platform)) ?? "pi";
}
