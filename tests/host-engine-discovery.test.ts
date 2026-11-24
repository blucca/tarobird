import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostProcessEnvironment } from "../src/host-cli/environment.js";
import { resolveEngineExecutable } from "../src/runtime/engine-process.js";
import {
  clearDiscoveryCaches,
  diagnoseExecutableCandidates,
  discoverWindowsEngineDirectories,
  lookupEnvCaseInsensitive,
  parseWindowsRegistryPathOutput,
  probeLoginShellEnvironment,
  probePackageManagerBinDirectories,
  readWindowsRegistryPath,
  SHELL_ENV_PROBE_FLAG,
  type CommandRunner,
} from "../src/host-cli/engine-discovery.js";
import { HubEngineSettings } from "../src/hub/engine-settings.js";
import { engineSettingsFile, hostEngineEnvironment } from "../src/runtime/host-engine-settings.js";

const roots: string[] = [];
afterEach(async () => { clearDiscoveryCaches(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const home = await mkdtemp(path.join(os.tmpdir(), "cli-discovery-")); roots.push(home); return home; }
async function file(home: string, relative: string, text = "#!/bin/sh\nexit 0\n") {
  const target = path.join(home, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); await chmod(target, 0o700); return target;
}
it.runIf(process.platform !== "win32").each([".volta/bin", ".bun/bin", ".asdf/shims", ".local/share/mise/shims"])("discovers %s with a minimal GUI PATH", async directory => {
  const home = await fixture(), cli = await file(home, `${directory}/discovery-cli`);
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } }))).toBe(cli);
});
it.runIf(process.platform !== "win32")("selects only nvm's default version and keeps the inherited PATH ahead of fallbacks", async () => {
  const home = await fixture();
  const chosen = await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/versions/node/v24.1.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "lts/example\n"); await file(home, ".nvm/alias/lts/example", "v22.12.0\n");
  const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(chosen);
  expect(env.PATH).not.toContain("v24.1.0");
  const inherited = await file(home, "selected/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: path.dirname(inherited) } }))).toBe(inherited);
  expect(hostProcessEnvironment({ home, env }).PATH).toBe(env.PATH);
});
it.runIf(process.platform !== "win32")("bounds nvm alias traversal and never executes a profile or guesses an unselected version", async () => {
  const home = await fixture(); await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "loop\n"); await file(home, ".nvm/alias/loop", "default\n");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
  await file(home, ".nvm/alias/default", "../../outside\n");
  expect(hostProcessEnvironment({ home, env: {} }).PATH).not.toContain("versions/node");
});
it.runIf(process.platform !== "win32")("honors an explicit nvm root instead of silently choosing the home-directory installation", async () => {
  const home = await fixture();
  await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "22\n");
  const configured = path.join(home, "configured-nvm");
  const chosen = await file(configured, "versions/node/v24.1.0/bin/discovery-cli");
  await file(configured, "alias/default", "24\n");
  const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin", NVM_DIR: configured } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(chosen);
  expect(env.PATH).not.toContain(path.join(home, ".nvm/versions/node"));
});
it.runIf(process.platform !== "win32")("follows fnm's default alias including a macOS path containing spaces", async () => {
  const home = await fixture(), root = path.join(home, "Library/Application Support/fnm");
  const cli = await file(home, "Library/Application Support/fnm/node-versions/v22.12.0/installation/bin/discovery-cli");
  await mkdir(path.join(root, "aliases"), { recursive: true });
  await symlink(path.dirname(path.dirname(cli)), path.join(root, "aliases/default"));
  const env = hostProcessEnvironment({ home, platform: "darwin", env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(path.join(root, "aliases/default/bin/discovery-cli"));
});
it.runIf(process.platform !== "win32")("resolves nvm's stable alias like node instead of preferring an even major", async () => {
  const home = await fixture();
  await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  const latest = await file(home, ".nvm/versions/node/v23.5.0/bin/discovery-cli");
  for (const alias of ["stable", "node"]) {
    await file(home, ".nvm/alias/default", `${alias}\n`);
    const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } });
    expect(resolveEngineExecutable("discovery-cli", env)).toBe(latest);
    expect(env.PATH).not.toContain("v22.12.0");
  }
});
// fnm uses the first existing base directory: XDG data, then ~/.fnm, then (macOS)
// Application Support. A directory fnm itself would not use is never searched.
it.runIf(process.platform !== "win32").each([
  { name: "XDG data on macOS", platform: "darwin" as const, installed: [".local/share/fnm"], chosen: ".local/share/fnm" },
  { name: "the legacy home directory on macOS", platform: "darwin" as const, installed: [".fnm"], chosen: ".fnm" },
  { name: "the legacy home directory on Linux", platform: "linux" as const, installed: [".fnm"], chosen: ".fnm" },
  { name: "XDG data ahead of Application Support", platform: "darwin" as const, installed: [".local/share/fnm", "Library/Application Support/fnm"], chosen: ".local/share/fnm" },
  { name: "the legacy home directory ahead of Application Support", platform: "darwin" as const, installed: [".fnm", "Library/Application Support/fnm"], chosen: ".fnm" },
  { name: "XDG data ahead of the legacy home directory", platform: "linux" as const, installed: [".local/share/fnm", ".fnm"], chosen: ".local/share/fnm" },
])("follows fnm's base directory order: $name", async ({ platform, installed, chosen }) => {
  const home = await fixture();
  for (const root of installed) await file(home, `${root}/aliases/default/bin/discovery-cli`);
  const env = hostProcessEnvironment({ home, platform, env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(path.join(home, chosen, "aliases/default/bin/discovery-cli"));
  for (const root of installed.filter(root => root !== chosen)) expect(env.PATH).not.toContain(path.join(home, root));
});
it.runIf(process.platform !== "win32")("does not search an fnm directory that fnm itself would not use", async () => {
  const home = await fixture();
  // fnm selects the existing XDG directory even though it has no default alias.
  await mkdir(path.join(home, ".local/share/fnm"), { recursive: true });
  await file(home, ".fnm/aliases/default/bin/discovery-cli");
  await file(home, "Library/Application Support/fnm/aliases/default/bin/discovery-cli");
  for (const platform of ["darwin", "linux"] as const) expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, platform, env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
  // An explicit root still wins over every default location.
  const configured = path.join(home, "configured-fnm"), chosen = await file(configured, "aliases/default/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, platform: "darwin", env: { PATH: "/usr/bin:/bin", FNM_DIR: configured } }))).toBe(chosen);
  // Application Support is a macOS location only.
  const linuxHome = await fixture(); await file(linuxHome, "Library/Application Support/fnm/aliases/default/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home: linuxHome, platform: "linux", env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
});

it.runIf(process.platform !== "win32")("recovers from a dangling symlink on PATH when the real binary lives in a manual Node directory found via login shell", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { recursive: true });
  const localBin = path.join(root, ".local/bin"); await mkdir(localBin, { recursive: true });
  const deletedTarget = path.join(root, "deleted-tool/node/bin/dsh");
  const danglingLink = path.join(localBin, "dsh");
  await symlink(deletedTarget, danglingLink);

  const manualNodeBin = path.join(root, ".local/share/node/node-v24.0.0-darwin-arm64/bin");
  const realDsh = await file(root, ".local/share/node/node-v24.0.0-darwin-arm64/bin/dsh", "#!/bin/sh\necho 'dsh 0.9.4'\n");

  // Without login shell discovery, diagnosing Host PATH sees the dangling symlink and fails to find dsh.
  const baseline = diagnoseExecutableCandidates("dsh", [{ dir: localBin, rule: "path" }], { PATH: localBin });
  expect(baseline.executable).toBeNull();
  expect(baseline.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);

  // Login shell probe passes TAROBIRD_SHELL_ENV_PROBE=1 and returns the terminal PATH + `command -v dsh`.
  let sawProbeFlag = false;
  const runner: CommandRunner = async (cmd, args, opts) => {
    if (args[0] === "-ilc") {
      sawProbeFlag = opts.env?.[SHELL_ENV_PROBE_FLAG] === "1";
      return {
        stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${localBin}:${manualNodeBin}:/usr/bin\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${realDsh}\n`,
        stderr: "",
      };
    }
    if (cmd === realDsh && args[0] === "--version") return { stdout: "dsh 0.9.4\n", stderr: "" };
    throw new Error(`unexpected command: ${cmd}`);
  };

  const baseEnv = { HOME: root, PATH: localBin, SHELL: "/bin/zsh" };
  const settings = new HubEngineSettings(stateDir, () => baseEnv);
  const status = await settings.statusAsync(undefined, { forceRefresh: true, runner });
  expect(sawProbeFlag).toBe(true);
  expect(status.shellProbeStatus).toBe("ok");

  const dshRow = status.engines.find(e => e.id === "deepseek")!;
  expect(dshRow.available).toBe(true);
  expect(dshRow.executable).toBe(realDsh);
  expect(dshRow.rule).toBe("login-shell");
  expect(dshRow.version).toBe("dsh 0.9.4");
  expect(dshRow.danglingLinks).toEqual([{ linkPath: danglingLink, targetPath: deletedTarget }]);
  expect(dshRow.terminalExecutable).toBe(realDsh);
  expect(dshRow.override).toBeNull();

  // Auto-discovered path is persisted without becoming a manual override.
  const savedJson = JSON.parse(await readFile(engineSettingsFile(stateDir), "utf8"));
  expect(savedJson.paths).toEqual({});
  expect(savedJson.discoveredPaths?.deepseek).toBe(realDsh);
  expect(hostEngineEnvironment(stateDir, baseEnv).DSH_EXECUTABLE).toBe(realDsh);

  // When the remembered auto-discovered binary becomes invalid, Host stops reusing it and searches again.
  await rm(realDsh);
  expect(hostEngineEnvironment(stateDir, baseEnv).DSH_EXECUTABLE).toBeUndefined();
  const movedDsh = await file(root, ".local/share/node/node-v24.1.0-darwin-arm64/bin/dsh", "#!/bin/sh\necho 'dsh 0.9.5'\n");
  const movedBin = path.dirname(movedDsh);
  const runner2: CommandRunner = async (cmd, args) => {
    if (args[0] === "-ilc") {
      return {
        stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${localBin}:${movedBin}:/usr/bin\n__TAROBIRD_SHELL_PATH_END__\n__TAROBIRD_CMD__:dsh=${movedDsh}\n`,
        stderr: "",
      };
    }
    if (cmd === movedDsh && args[0] === "--version") return { stdout: "dsh 0.9.5\n", stderr: "" };
    throw new Error(`unexpected command: ${cmd}`);
  };
  const rechecked = await settings.statusAsync(undefined, { forceRefresh: true, runner: runner2 });
  expect(rechecked.engines.find(e => e.id === "deepseek")?.executable).toBe(movedDsh);
  expect(rechecked.engines.find(e => e.id === "deepseek")?.version).toBe("dsh 0.9.5");
});

it.runIf(process.platform !== "win32")("queries custom npm prefix -g and other package managers for global bin directories", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { recursive: true });
  const customPrefix = path.join(root, "custom-npm-prefix");
  const customBin = path.join(customPrefix, "bin");
  const dsh = await file(root, "custom-npm-prefix/bin/dsh", "#!/bin/sh\necho 'dsh 1.0.0'\n");
  const npmDir = path.join(root, "tool-bin");
  const fakeNpm = await file(root, "tool-bin/npm", "#!/bin/sh\nexit 0\n");

  const pmDirs = await probePackageManagerBinDirectories({
    searchDirs: [npmDir],
    platform: "darwin",
    runner: async (cmd, args) => {
      if (cmd === fakeNpm && args.join(" ") === "prefix -g") return { stdout: `${customPrefix}\n`, stderr: "" };
      throw new Error("not installed");
    },
  });
  expect(pmDirs).toEqual([customBin]);

  const settings = new HubEngineSettings(stateDir, () => ({ HOME: root, PATH: npmDir, SHELL: "/bin/zsh" }));
  const status = await settings.statusAsync(undefined, {
    forceRefresh: true,
    runner: async (cmd, args) => {
      if (args[0] === "-ilc") return { stdout: `__TAROBIRD_SHELL_PATH_BEGIN__\n${npmDir}\n__TAROBIRD_SHELL_PATH_END__\n`, stderr: "" };
      if (cmd === fakeNpm && args.join(" ") === "prefix -g") return { stdout: `${customPrefix}\n`, stderr: "" };
      if (cmd === dsh && args[0] === "--version") return { stdout: "dsh 1.0.0\n", stderr: "" };
      throw new Error("missing");
    },
  });
  const row = status.engines.find(e => e.id === "deepseek")!;
  expect(row.available).toBe(true);
  expect(row.executable).toBe(dsh);
  expect(row.rule).toBe("package-manager");
  expect(row.version).toBe("dsh 1.0.0");
});

it("parses Windows registry PATH (HKCU + HKLM), expands variables, handles Path casing and discovers Scoop/WinGet/nvm-windows/APPDATA/Git Bash/WSL", async () => {
  const winEnv: NodeJS.ProcessEnv = {
    Path: "C:\\Windows\\System32",
    APPDATA: "C:\\Users\\example\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
    PNPM_HOME: "C:\\Users\\example\\AppData\\Local\\pnpm",
    VOLTA_HOME: "C:\\Users\\example\\AppData\\Local\\Volta",
    SCOOP: "C:\\Users\\example\\scoop",
    NVM_SYMLINK: "C:\\Program Files\\nodejs",
    ProgramFiles: "C:\\Program Files",
    SystemRoot: "C:\\Windows",
  };
  expect(lookupEnvCaseInsensitive(winEnv, "PATH", "win32")).toBe("C:\\Windows\\System32");

  const parsed = parseWindowsRegistryPathOutput(
    "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %APPDATA%\\npm;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links;C:\\Tools\\Custom\r\n",
    winEnv,
  );
  expect(parsed).toEqual([
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Tools\\Custom",
  ]);

  const regPaths = await readWindowsRegistryPath({
    env: winEnv,
    platform: "win32",
    runner: async (_cmd, args) => {
      if (args[1] === "HKCU\\Environment") {
        return { stdout: "    Path    REG_EXPAND_SZ    %APPDATA%\\npm;C:\\Users\\example\\scoop\\shims\r\n", stderr: "" };
      }
      return { stdout: "    PATH    REG_EXPAND_SZ    %NVM_SYMLINK%;C:\\Users\\example\\scoop\\shims\r\n", stderr: "" };
    },
  });
  expect(regPaths).toEqual([
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\scoop\\shims",
    "C:\\Program Files\\nodejs",
  ]);

  const existing = new Set([
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\AppData\\Local\\pnpm",
    "C:\\Users\\example\\AppData\\Local\\Volta\\bin",
    "C:\\Users\\example\\scoop\\shims",
    "C:\\Program Files\\nodejs",
    "C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Windows\\System32",
  ]);
  const discovered = discoverWindowsEngineDirectories("C:\\Users\\example", winEnv, dir => existing.has(dir));
  expect(discovered).toEqual([
    "C:\\Users\\example\\AppData\\Roaming\\npm",
    "C:\\Users\\example\\AppData\\Local\\pnpm",
    "C:\\Users\\example\\AppData\\Local\\Volta\\bin",
    "C:\\Users\\example\\scoop\\shims",
    "C:\\Program Files\\nodejs",
    "C:\\Users\\example\\AppData\\Local\\Microsoft\\WinGet\\Links",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Windows\\System32",
  ]);
});

it.runIf(process.platform !== "win32")("falls back cleanly to existing rules when the login shell probe times out", async () => {
  const root = await fixture();
  const stateDir = path.join(root, "state"); await mkdir(stateDir, { recursive: true });
  const voltaCodex = await file(root, ".volta/bin/codex", "#!/bin/sh\necho 'codex 2.1.0'\n");

  const timedOutProbe = await probeLoginShellEnvironment({
    commands: ["codex"],
    env: { HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    runner: async () => {
      const err = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" });
      throw err;
    },
  });
  expect(timedOutProbe.ok).toBe(false);
  expect(timedOutProbe.status).toBe("timeout");

  const settings = new HubEngineSettings(stateDir, () => ({ HOME: root, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" }));
  const status = await settings.statusAsync(undefined, {
    forceRefresh: true,
    runner: async (cmd, args) => {
      if (args[0] === "-ilc") {
        throw Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
      }
      if (cmd === voltaCodex && args[0] === "--version") return { stdout: "codex 2.1.0\n", stderr: "" };
      throw new Error("not found");
    },
  });
  expect(status.shellProbeStatus).toBe("timeout");
  const codexRow = status.engines.find(e => e.id === "codex")!;
  expect(codexRow.available).toBe(true);
  expect(codexRow.executable).toBe(voltaCodex);
  expect(codexRow.rule).toBe("known-directory");
  expect(codexRow.version).toBe("codex 2.1.0");
});
