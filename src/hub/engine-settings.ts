import { resolvePiExecutable } from "../runtime/pi-executable.js";
import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutex } from "../state/file-mutex.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { deepseekExecutableOverride, resolveDeepSeekExecutable } from "../runtime/deepseek-executable.js";
import {
  EngineSettingsReadError,
  ENGINE_COMMANDS,
  ENGINE_ENV_KEYS,
  engineSettingsFile,
  hostEngineEnvironment,
  readHostEngineSettings,
  type StoredEngineSettings,
} from "../runtime/host-engine-settings.js";
import {
  engineSettingsUpdateSchema,
  hostEngineSchema,
  type EngineDiscoveryRule,
  type EngineSettingsState,
  type EngineSettingsUpdate,
  type HostEngine,
} from "../client-protocol/engine-settings.js";
import {
  diagnoseExecutableCandidates,
  discoverEngineDirectories,
  lookupEnvCaseInsensitive,
  mergeTaggedDirectories,
  probeExecutableVersion,
  runEnvironmentDiscovery,
  type CommandRunner,
  type TaggedDirectory,
} from "../host-cli/engine-discovery.js";
import { HubError } from "./store.js";

export type EngineDiscoveryOptions = {
  forceRefresh?: boolean;
  probeShell?: boolean;
  probeVersions?: boolean;
  runner?: CommandRunner;
  timeoutMs?: number;
};

export class HubEngineSettings {
  constructor(readonly directory: string, readonly base: () => NodeJS.ProcessEnv) {}
  private read(): StoredEngineSettings {
    try { return readHostEngineSettings(this.directory); }
    catch (error) { if (error instanceof EngineSettingsReadError) throw new HubError(error.message, 503); throw error; }
  }

  private buildHostTaggedDirs(base: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, platform = process.platform): TaggedDirectory[] {
    const windows = platform === "win32", sep = windows ? ";" : ":";
    const home = windows
      ? lookupEnvCaseInsensitive(base, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(base, "HOME", "win32") ?? os.homedir()
      : base.HOME ?? base.USERPROFILE ?? os.homedir();
    const baseDirs = (lookupEnvCaseInsensitive(base, "PATH", platform) ?? "").split(sep).filter(Boolean).map((dir): TaggedDirectory => ({ dir, rule: "path" }));
    const knownDirs = discoverEngineDirectories(home, base, platform).map((dir): TaggedDirectory => ({ dir, rule: "known-directory" }));
    const envDirs = (lookupEnvCaseInsensitive(env, "PATH", platform) ?? "").split(sep).filter(Boolean).map((dir): TaggedDirectory => ({ dir, rule: "path" }));
    return mergeTaggedDirectories([baseDirs, knownDirs, envDirs], platform);
  }

  private async rememberDiscoveredPaths(discovered: Partial<Record<HostEngine, string>>): Promise<void> {
    const file = engineSettingsFile(this.directory);
    try {
      await withFileMutex(file, async () => {
        const before = this.read();
        const prev = before.discoveredPaths ?? {};
        const nextDiscovered: Partial<Record<HostEngine, string>> = {};
        for (const id of hostEngineSchema.options) {
          const val = discovered[id];
          if (val && path.isAbsolute(val) && val === val.trim()) nextDiscovered[id] = val;
        }
        if (JSON.stringify(prev) === JSON.stringify(nextDiscovered)) return;
        const next: StoredEngineSettings = {
          ...before,
          ...(Object.keys(nextDiscovered).length ? { discoveredPaths: nextDiscovered } : {}),
        };
        if (!Object.keys(nextDiscovered).length) delete next.discoveredPaths;
        const temporary = `${file}.${randomUUID()}.tmp`;
        let handle;
        try {
          handle = await open(temporary, "wx", 0o600);
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
          await handle.close();
          handle = undefined;
          await rename(temporary, file);
        } finally {
          await handle?.close();
          await unlink(temporary).catch(() => undefined);
        }
      }, { waitTimeoutMs: 3_000 });
    } catch {
      /* Auto-discovered cache is opportunistic and never fails a status read. */
    }
  }

  status(requestId?: string): EngineSettingsState {
    const settings = this.read(), base = this.base(), env = hostEngineEnvironment(this.directory, base, settings);
    const receipt = requestId ? settings.receipts.find(item => item.requestId === requestId) : settings.receipts.at(-1);
    const taggedDirs = this.buildHostTaggedDirs(base, env);
    return {
      revision: settings.revision,
      platform: process.platform,
      searchPaths: taggedDirs.map(item => item.dir),
      receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null,
      engines: hostEngineSchema.options.map(id => {
        const command = id === "pi" ? resolvePiExecutable(env) : id === "deepseek" ? resolveDeepSeekExecutable(env) : env[ENGINE_ENV_KEYS[id]] || ENGINE_COMMANDS[id];
        const explicit = id === "deepseek" ? deepseekExecutableOverride(base) !== undefined : !!lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id]);
        const remembered = !settings.paths[id] && !explicit ? settings.discoveredPaths?.[id] : undefined;
        const diagnosed = diagnoseExecutableCandidates(command, taggedDirs, env);
        const executable = diagnosed.executable ?? resolveEngineExecutable(command, env) ?? null;
        let rule: EngineDiscoveryRule | null = null;
        if (executable) {
          if (settings.paths[id]) rule = "setting";
          else if (explicit) rule = "environment";
          else if (remembered && executable === remembered) rule = "auto-discovered";
          else rule = diagnosed.rule ?? "path";
        }
        return {
          id,
          override: settings.paths[id] ?? null,
          source: settings.paths[id] ? "setting" : explicit ? "environment" : "auto",
          command,
          executable,
          available: !!executable,
          rule,
          ...(diagnosed.danglingLinks.length ? { danglingLinks: diagnosed.danglingLinks } : {}),
        };
      }),
    };
  }

  async statusAsync(requestId?: string, options: EngineDiscoveryOptions = {}): Promise<EngineSettingsState> {
    const settings = this.read(), base = this.base(), env = hostEngineEnvironment(this.directory, base, settings);
    const receipt = requestId ? settings.receipts.find(item => item.requestId === requestId) : settings.receipts.at(-1);
    const platform = process.platform, windows = platform === "win32", sep = windows ? ";" : ":";
    const home = windows
      ? lookupEnvCaseInsensitive(base, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(base, "HOME", "win32") ?? os.homedir()
      : base.HOME ?? base.USERPROFILE ?? os.homedir();

    const probeShell = options.probeShell !== false;
    const probe = probeShell
      ? await runEnvironmentDiscovery({
        baseEnv: base,
        commands: Object.values(ENGINE_COMMANDS),
        home,
        platform,
        forceRefresh: options.forceRefresh,
        timeoutMs: options.timeoutMs,
        runner: options.runner,
      })
      : { at: Date.now(), shell: { ok: false, status: "skipped" as const, pathDirs: [], resolvedCommands: {} }, packageManagerDirs: [], windowsRegistryDirs: [] };

    const hostTaggedDirs = this.buildHostTaggedDirs(base, env, platform);
    const mergedDirs = mergeTaggedDirectories([
      probe.shell.pathDirs.map((dir): TaggedDirectory => ({ dir, rule: "login-shell" })),
      probe.windowsRegistryDirs.map((dir): TaggedDirectory => ({ dir, rule: "windows-registry" })),
      probe.packageManagerDirs.map((dir): TaggedDirectory => ({ dir, rule: "package-manager" })),
      hostTaggedDirs,
    ], platform);

    const enhancedEnv: NodeJS.ProcessEnv = { ...env };
    if (windows) for (const key of Object.keys(enhancedEnv)) if (key.toUpperCase() === "PATH") delete enhancedEnv[key];
    enhancedEnv.PATH = mergedDirs.map(item => item.dir).join(sep);

    const discoveredToRemember: Partial<Record<HostEngine, string>> = {};
    const engineRows = await Promise.all(hostEngineSchema.options.map(async (id) => {
      const explicit = id === "deepseek" ? deepseekExecutableOverride(base) !== undefined : !!lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id], platform);
      const hasManual = !!settings.paths[id];
      const remembered = !hasManual && !explicit ? settings.discoveredPaths?.[id] : undefined;
      const defaultCmd = ENGINE_COMMANDS[id];

      // Check what the Host's own baseline PATH sees (before login-shell/pm discovery) to spot terminal-vs-host differences.
      const hostBaseline = !hasManual && !explicit
        ? diagnoseExecutableCandidates(defaultCmd, hostTaggedDirs, env, platform)
        : undefined;

      // Resolve via manual setting -> env override -> valid remembered path -> enhanced merged directories.
      const rememberedValid = remembered && resolveEngineExecutable(remembered, enhancedEnv, platform) ? remembered : undefined;
      const command = hasManual
        ? settings.paths[id]!
        : explicit
          ? (id === "deepseek" ? resolveDeepSeekExecutable(env, platform) : lookupEnvCaseInsensitive(base, ENGINE_ENV_KEYS[id], platform)!)
          : rememberedValid
            ? rememberedValid
            : id === "pi"
              ? resolvePiExecutable(enhancedEnv, platform)
              : id === "deepseek"
                ? resolveDeepSeekExecutable(enhancedEnv, platform)
                : defaultCmd;

      const diagnosed = diagnoseExecutableCandidates(command, mergedDirs, enhancedEnv, platform);
      let executable = diagnosed.executable ?? resolveEngineExecutable(command, enhancedEnv, platform) ?? null;
      let rule: EngineDiscoveryRule | null = null;
      if (executable) {
        if (hasManual) rule = "setting";
        else if (explicit) rule = "environment";
        else if (rememberedValid && executable === rememberedValid) rule = "auto-discovered";
        else rule = diagnosed.rule ?? "path";
      }

      // Check terminal (`command -v` from login shell) when available.
      const shellCmdHit = probe.shell.resolvedCommands[defaultCmd];
      const terminalExecutable = shellCmdHit && resolveEngineExecutable(shellCmdHit, enhancedEnv, platform)
        ? shellCmdHit
        : null;

      // If merged directories didn't find it but login-shell `command -v` did, record terminalExecutable so UI can offer one-click adopt.
      if (!executable && terminalExecutable && !hasManual && !explicit) {
        executable = terminalExecutable;
        rule = "login-shell";
      }

      if (!hasManual && !explicit && executable && path.isAbsolute(executable)) {
        discoveredToRemember[id] = executable;
      }

      const version = executable && options.probeVersions !== false
        ? await probeExecutableVersion(executable, enhancedEnv, options.runner)
        : null;

      // Surface terminalExecutable explicitly whenever the terminal finds a path that the Host's own baseline PATH missed or differs from.
      const showTerminalDiff = !hasManual && terminalExecutable && hostBaseline && hostBaseline.executable !== terminalExecutable
        ? terminalExecutable
        : null;

      return {
        id,
        override: settings.paths[id] ?? null,
        source: hasManual ? "setting" as const : explicit ? "environment" as const : "auto" as const,
        command,
        executable,
        available: !!executable,
        version,
        rule,
        ...(diagnosed.danglingLinks.length ? { danglingLinks: diagnosed.danglingLinks } : {}),
        ...(showTerminalDiff ? { terminalExecutable: showTerminalDiff } : {}),
      };
    }));

    await this.rememberDiscoveredPaths(discoveredToRemember);

    return {
      revision: settings.revision,
      platform,
      searchPaths: mergedDirs.map(item => item.dir),
      shellProbeStatus: probe.shell.status,
      receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null,
      engines: engineRows,
    };
  }

  async update(raw: EngineSettingsUpdate, commit: (apply: () => Promise<void>) => Promise<void>): Promise<EngineSettingsState> {
    const command = engineSettingsUpdateSchema.parse(raw), digest = createHash("sha256").update(JSON.stringify(command)).digest("hex"), file = engineSettingsFile(this.directory);
    if (command.path !== null && (command.path !== command.path.trim() || !path.isAbsolute(command.path))) throw new HubError("engine_path_absolute_required");
    return withFileMutex(file, async () => {
      const before = this.read(), receipt = before.receipts.find(item => item.requestId === command.requestId);
      if (receipt) { if (receipt.digest !== digest) throw new HubError("engine_request_conflict", 409); return this.status(command.requestId); }
      if (before.revision !== command.revision) throw new HubError("engine_revision_conflict", 409);
      // Presence check only: selecting a program never executes it as a probe.
      const check = () => { if (command.path !== null && !resolveEngineExecutable(command.path, this.base())) throw new HubError("engine_path_unavailable"); };
      check();
      const paths = { ...before.paths }; if (command.path === null) delete paths[command.engine]; else paths[command.engine] = command.path;
      const revision = randomUUID(), next: StoredEngineSettings = {
        format: 1,
        revision,
        paths,
        ...(before.discoveredPaths ? { discoveredPaths: before.discoveredPaths } : {}),
        receipts: [...before.receipts, { requestId: command.requestId, digest, revision }].slice(-32),
      };
      const temporary = `${file}.${randomUUID()}.tmp`; let handle;
      try {
        handle = await open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = undefined;
        await commit(async () => {
          if (this.read().revision !== before.revision) throw new HubError("engine_revision_conflict", 409);
          check(); await rename(temporary, file);
        });
      } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
      return this.status(command.requestId);
    }, { waitTimeoutMs: 10_000 });
  }
}
