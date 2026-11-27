import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { envLookupCaseInsensitive, mergeWindowsPathEntries, validWindowsDirectory } from "../runtime/windows-registry-path.js";

const directoryExists = (directory: string) => { try { return statSync(directory).isDirectory(); } catch { return false; } };
function smallAlias(file: string): string | undefined {
  try { const info = statSync(file); if (info.isFile() && info.size <= 4096) return readFileSync(file, "utf8").trim(); } catch { /* Not configured. */ }
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

/** Discover common Windows CLI installation directories dynamically so CLIs
 * installed after Host startup (e.g. `%LOCALAPPDATA%\agy\bin`, `%APPDATA%\npm`,
 * `%LOCALAPPDATA%\pnpm`, WinGet/Scoop/Cargo/local shims) are found without a restart. */
function discoverWindowsEngineDirectories(home: string, env: NodeJS.ProcessEnv): string[] {
  const strictRoot = (candidate: string | undefined): string | undefined => {
    if (!candidate || /["\x00-\x1f\x7f;]/.test(candidate)) return undefined;
    return validWindowsDirectory(candidate);
  };
  const validHome = strictRoot(home) ?? strictRoot(envLookupCaseInsensitive(env, "USERPROFILE")) ?? strictRoot(envLookupCaseInsensitive(env, "HOME"));
  const appDataRoot = (key: "LOCALAPPDATA" | "APPDATA", suffix: "Local" | "Roaming"): string | undefined => {
    const configured = envLookupCaseInsensitive(env, key);
    // An explicitly configured invalid root must fail closed instead of silently
    // falling back to USERPROFILE.
    if (configured !== undefined) return strictRoot(configured);
    return validHome ? path.win32.join(validHome, "AppData", suffix) : undefined;
  };
  const envRoot = (key: string, fallback: string | undefined): string | undefined => {
    const configured = envLookupCaseInsensitive(env, key);
    if (configured !== undefined) return strictRoot(configured);
    return fallback;
  };

  const local = appDataRoot("LOCALAPPDATA", "Local");
  const roaming = appDataRoot("APPDATA", "Roaming");
  const pnpm = envRoot("PNPM_HOME", local ? path.win32.join(local, "pnpm") : undefined);
  const volta = envRoot("VOLTA_HOME", validHome ? path.win32.join(validHome, ".volta") : undefined);
  const bun = envRoot("BUN_INSTALL", validHome ? path.win32.join(validHome, ".bun") : undefined);
  const nvmSymlink = envRoot("NVM_SYMLINK", undefined);
  const scoop = envRoot("SCOOP", validHome ? path.win32.join(validHome, "scoop") : undefined);
  const cargo = envRoot("CARGO_HOME", validHome ? path.win32.join(validHome, ".cargo") : undefined);
  const piAgent = envRoot("PI_CODING_AGENT_DIR", validHome ? path.win32.join(validHome, ".pi", "agent") : undefined);

  const candidates = [
    ...(local ? [
      path.win32.join(local, "agy", "bin"),
      path.win32.join(local, "Programs", "Antigravity", "bin"),
      path.win32.join(local, "Programs", "Antigravity"),
      path.win32.join(local, "Programs", "agy", "bin"),
      path.win32.join(local, "Programs", "agy"),
      path.win32.join(local, "Microsoft", "WinGet", "Links"),
      path.win32.join(local, "Programs"),
    ] : []),
    ...(roaming ? [path.win32.join(roaming, "npm")] : []),
    pnpm,
    ...(volta ? [path.win32.join(volta, "bin")] : []),
    ...(bun ? [path.win32.join(bun, "bin")] : []),
    nvmSymlink,
    ...(scoop ? [path.win32.join(scoop, "shims")] : []),
    ...(cargo ? [path.win32.join(cargo, "bin")] : []),
    ...(validHome ? [
      path.win32.join(validHome, ".local", "bin"),
      path.win32.join(validHome, ".npm-global", "bin"),
      path.win32.join(validHome, ".claude", "bin"),
      path.win32.join(validHome, ".claude", "local"),
      path.win32.join(validHome, ".kimi-code", "bin"),
      path.win32.join(validHome, ".kimi", "bin"),
      path.win32.join(validHome, ".dsh", "bin"),
    ] : []),
    ...(piAgent ? [path.win32.join(piAgent, "bin")] : []),
  ];

  const existing = candidates.filter((directory): directory is string => !!directory && !!validWindowsDirectory(directory) && directoryExists(directory));
  return mergeWindowsPathEntries([existing]);
}

/** Fallbacks follow the inherited PATH, preserving the operator's selection.
 * fnm's alias is a symlink to its installation; asdf/mise/Volta use stable shims. */
export function discoverEngineDirectories(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") return discoverWindowsEngineDirectories(home, env);
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
  return candidates.filter((directory): directory is string => !!directory && !/[\x00-\x1f\x7f:]/.test(directory) && directoryExists(directory));
}
