import { resolvePiExecutable } from "../runtime/pi-executable.js";
import { ENGINE_SETTINGS_REPAIR_HINT, hostEngineSchema, type EngineDiscoveryRule } from "../client-protocol/engine-settings.js";
import path from "node:path";
import { ENGINE_COMMANDS, ENGINE_ENV_KEYS, hostEngineEnvironment, readHostEngineSettings } from "../runtime/host-engine-settings.js";
import { readHubConfig } from "../hub/config.js";
import { inspectHubService } from "../hub/service.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { deepseekExecutableOverride, resolveDeepSeekExecutable } from "../runtime/deepseek-executable.js";
import {
  diagnoseExecutableCandidates,
  discoverEngineDirectories,
  lookupEnvCaseInsensitive,
  mergeTaggedDirectories,
  probeExecutableVersion,
  runEnvironmentDiscovery,
  type DanglingLinkInfo,
  type TaggedDirectory,
} from "./engine-discovery.js";
import { HubDatabase } from "../hub/database.js";
import { exists, resolveDesktopHostDirectory } from "./paths.js";
import { readHostProfile } from "./setup.js";
import { managedServiceStatus, managedServiceEnvironmentDifferences, type ManagedServiceStatus } from "./service-manager.js";
import { buildHostEnvironment, HOST_ENGINE_EXECUTABLE_KEYS, HOST_PRESERVED_ENVIRONMENT_KEYS } from "./environment.js";
import { LocalHostClient } from "./client.js";
import { HostDirectoryError } from "./windows-state-admission.js";
import { HostManagement } from "./management.js";

export type InspectedEngine = {
  engine: "codex" | "claude" | "pi" | "antigravity" | "kimi" | "deepseek";
  installed: boolean;
  executable?: string;
  version?: string | null;
  rule?: EngineDiscoveryRule | null;
  danglingLinks?: DanglingLinkInfo[];
  terminalExecutable?: string | null;
  searchedDirectories?: string[];
  authentication: "unverified";
};

export function inspectEngines(env: NodeJS.ProcessEnv = process.env): InspectedEngine[] {
  const windows = process.platform === "win32", sep = windows ? ";" : ":";
  const pathDirs = (lookupEnvCaseInsensitive(env, "PATH") ?? "").split(sep).filter(Boolean);
  const taggedDirs: TaggedDirectory[] = pathDirs.map((dir) => ({ dir, rule: "path" }));
  return ([
    ["codex", env.CODEX_EXECUTABLE || "codex"], ["claude", env.CLAUDE_EXECUTABLE || "claude"],
    ["pi", resolvePiExecutable(env)],
    ["antigravity", env.ANTIGRAVITY_EXECUTABLE || "agy"], ["kimi", env.KIMI_EXECUTABLE || "kimi"],
    ["deepseek", resolveDeepSeekExecutable(env)],
  ] as const).map(([engine, command]) => {
    const diagnosed = diagnoseExecutableCandidates(command, taggedDirs, env);
    const executable = diagnosed.executable ?? resolveEngineExecutable(command, env);
    const rule: EngineDiscoveryRule | null = executable
      ? (lookupEnvCaseInsensitive(env, ENGINE_ENV_KEYS[engine]) ? "environment" : diagnosed.rule ?? "path")
      : null;
    return {
      engine,
      installed: !!executable,
      ...(executable ? { executable } : {}),
      rule,
      ...(diagnosed.danglingLinks.length ? { danglingLinks: diagnosed.danglingLinks } : {}),
      ...(!executable ? { searchedDirectories: pathDirs } : {}),
      authentication: "unverified" as const,
    };
  });
}

export async function inspectEnginesWithDiscovery(directory: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<InspectedEngine[]> {
  const settings = readHostEngineSettings(directory);
  const env = hostEngineEnvironment(directory, baseEnv, settings);
  const platform = process.platform, windows = platform === "win32", sep = windows ? ";" : ":";
  const home = windows
    ? lookupEnvCaseInsensitive(baseEnv, "USERPROFILE", "win32") ?? lookupEnvCaseInsensitive(baseEnv, "HOME", "win32") ?? ""
    : baseEnv.HOME ?? baseEnv.USERPROFILE ?? "";

  const probe = await runEnvironmentDiscovery({ baseEnv, commands: Object.values(ENGINE_COMMANDS), home: home || undefined, platform });
  const baseDirs = (lookupEnvCaseInsensitive(baseEnv, "PATH", platform) ?? "").split(sep).filter(Boolean).map((dir): TaggedDirectory => ({ dir, rule: "path" }));
  const knownDirs = home ? discoverEngineDirectories(home, baseEnv, platform).map((dir): TaggedDirectory => ({ dir, rule: "known-directory" })) : [];
  const hostTagged = mergeTaggedDirectories([baseDirs, knownDirs], platform);
  const merged = mergeTaggedDirectories([
    probe.shell.pathDirs.map((dir): TaggedDirectory => ({ dir, rule: "login-shell" })),
    probe.windowsRegistryDirs.map((dir): TaggedDirectory => ({ dir, rule: "windows-registry" })),
    probe.packageManagerDirs.map((dir): TaggedDirectory => ({ dir, rule: "package-manager" })),
    hostTagged,
  ], platform);
  const enhancedEnv: NodeJS.ProcessEnv = { ...env };
  if (windows) for (const key of Object.keys(enhancedEnv)) if (key.toUpperCase() === "PATH") delete enhancedEnv[key];
  enhancedEnv.PATH = merged.map(item => item.dir).join(sep);

  return Promise.all(hostEngineSchema.options.map(async (engine) => {
    const explicit = engine === "deepseek" ? deepseekExecutableOverride(baseEnv) !== undefined : !!lookupEnvCaseInsensitive(baseEnv, ENGINE_ENV_KEYS[engine], platform);
    const hasManual = !!settings.paths[engine];
    const defaultCmd = ENGINE_COMMANDS[engine];
    const command = hasManual
      ? settings.paths[engine]!
      : explicit
        ? (engine === "deepseek" ? resolveDeepSeekExecutable(env, platform) : lookupEnvCaseInsensitive(baseEnv, ENGINE_ENV_KEYS[engine], platform)!)
        : engine === "pi" ? resolvePiExecutable(enhancedEnv, platform)
          : engine === "deepseek" ? resolveDeepSeekExecutable(enhancedEnv, platform)
            : defaultCmd;
    const diagnosed = diagnoseExecutableCandidates(command, merged, enhancedEnv, platform);
    const executable = diagnosed.executable ?? resolveEngineExecutable(command, enhancedEnv, platform);
    const shellHit = probe.shell.resolvedCommands[defaultCmd];
    const terminalExecutable = shellHit && resolveEngineExecutable(shellHit, enhancedEnv, platform) ? shellHit : null;
    const hostBaseline = !hasManual && !explicit ? diagnoseExecutableCandidates(defaultCmd, hostTagged, env, platform) : undefined;
    const rule: EngineDiscoveryRule | null = executable
      ? (hasManual ? "setting" : explicit ? "environment" : settings.discoveredPaths?.[engine] === executable ? "auto-discovered" : diagnosed.rule ?? "path")
      : null;
    const version = executable ? await probeExecutableVersion(executable, enhancedEnv) : null;
    return {
      engine,
      installed: !!executable,
      ...(executable ? { executable } : {}),
      version,
      rule,
      ...(diagnosed.danglingLinks.length ? { danglingLinks: diagnosed.danglingLinks } : {}),
      ...(terminalExecutable && hostBaseline && hostBaseline.executable !== terminalExecutable ? { terminalExecutable } : {}),
      ...(!executable ? { searchedDirectories: merged.map(item => item.dir) } : {}),
      authentication: "unverified" as const,
    };
  }));
}

/** Read-only inspection. No new identity, DB migrations, engine execution or login. */
export async function inspectHost(directory: string, env: NodeJS.ProcessEnv = process.env, inspectLiveEngines = false) {
  const initialized = await exists(path.join(directory, "hub.sqlite"));
  const service = await inspectHubService(directory);
  const manager: Partial<ManagedServiceStatus> = await managedServiceStatus(directory).catch(error => ({ limitations: [], directory, error: error instanceof Error && ["host_service_owner_mismatch", "host_service_user_mismatch"].includes(error.message) ? error.message : "host_service_status_unavailable" }));
  let serviceEnvironmentDifferences: string[] = [], serviceEnvironmentCheck: string | undefined;
  try { serviceEnvironmentDifferences = await managedServiceEnvironmentDifferences(directory, env); }
  catch { serviceEnvironmentCheck = "host_service_environment_unavailable"; }
  let engines: InspectedEngine[], environmentCheck: { error: string; variables: string[]; hint?: string } | undefined;
  try {
    const hostEnv = buildHostEnvironment({ env });
    engines = inspectLiveEngines
      ? await inspectEnginesWithDiscovery(directory, hostEnv)
      : inspectEngines(hostEngineEnvironment(directory, hostEnv));
  }
  catch (error) {
    if (error instanceof Error && error.message === "engine_settings_unavailable") {
      engines = []; environmentCheck = { error: "engine_settings_unavailable", variables: [], hint: ENGINE_SETTINGS_REPAIR_HINT };
    } else {
    const candidate = error instanceof Error ? error.message.split(": ")[1] : undefined;
    const names = [...HOST_PRESERVED_ENVIRONMENT_KEYS, "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"] as string[];
    environmentCheck = { error: "host_environment_invalid", variables: candidate && names.includes(candidate) ? [candidate] : [] };
    // Engine presence can still be checked without adopting invalid service
    // config/proxy settings. Never expose rejected values in diagnostic JSON.
    const fallback: NodeJS.ProcessEnv = {};
    const lookup = (key: string) => env[key] ?? (process.platform === "win32" ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
    const search = lookup("PATH");
    if (search && !/[\x00-\x1f\x7f]/.test(search)) fallback.PATH = search;
    for (const key of HOST_ENGINE_EXECUTABLE_KEYS) {
      const raw = lookup(key);
      const value = process.platform === "win32" && key === "DSH_EXECUTABLE" ? deepseekExecutableOverride({ DSH_EXECUTABLE: raw }) : raw;
      if (raw && value && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(raw)) fallback[key] = value;
    }
    // The fallback still applies the Host's saved paths: reporting a different
    // program than the Host would start, or hiding a damaged file, is a silent fallback.
    try {
      const hostFallback = buildHostEnvironment({ env: fallback });
      engines = inspectLiveEngines
        ? await inspectEnginesWithDiscovery(directory, hostFallback)
        : inspectEngines(hostEngineEnvironment(directory, hostFallback));
    }
    catch (settingsError) {
      if (!(settingsError instanceof Error && settingsError.message === "engine_settings_unavailable")) throw settingsError;
      engines = []; environmentCheck = { ...environmentCheck, hint: ENGINE_SETTINGS_REPAIR_HINT };
    }
    }
  }
  let database: { schema?: number; bots?: number; pendingMessages?: number; network?: { id: string; name: string; hosts: number } } | undefined;
  if (initialized) {
    const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
    try {
      const schema = Number((await db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value);
      const network = await db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
      const membership = network ? JSON.parse(network.value)?.membership?.manifest : undefined;
      database = { schema, bots: (await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM bots${schema >= 14 ? " WHERE deleted_at IS NULL" : ""}`))?.count,
        pendingMessages: (await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM deliveries WHERE status='pending'"))?.count,
        ...(membership ? { network: { id: String(membership.id), name: String(membership.name), hosts: membership.hosts.filter((host: { revoked: boolean; state: string }) => !host.revoked && host.state === "active").length } } : {}) };
    } finally { await db.close(); }
  }
  const config = initialized ? await readHubConfig(directory) : undefined;
  let liveEngines: { id: string; available: boolean }[] | undefined, liveCheck: string | undefined;
  if (inspectLiveEngines && service.running && await exists(path.join(directory, "cli", "identity.json"))) {
    try { const client = await LocalHostClient.connect(directory); try { liveEngines = (await new HostManagement(client).catalog()).engines.map(({ id, available }) => ({ id, available })); } finally { client.close(); } }
    catch (error) { liveCheck = error instanceof Error ? error.message : "host_catalog_unavailable"; }
  }
  let desktopDirectory: string | undefined, desktopDirectoryIssue: string | undefined;
  try { desktopDirectory = await resolveDesktopHostDirectory({ env }); }
  catch (error) { desktopDirectoryIssue = error instanceof HostDirectoryError ? error.issue : "probe_failed"; }
  return { directory, desktopDirectory, desktopDirectoryIssue, initialized, profile: initialized ? await readHostProfile(directory) : undefined,
    service, manager, database, serviceEnvironmentDifferences, serviceEnvironmentCheck, environmentCheck, engines, liveEngines, liveCheck, listeners: config ? [{ host: config.host, port: config.port, tls: !!config.tls }, ...config.tlsListeners.map(listener => ({ host: listener.host, port: listener.port, tls: true }))] : [],
    notes: [...(initialized && "configured" in manager && !manager.configured ? ["尚未安装系统后台守护。桌面 App 打开时会尝试恢复本机主机；无人值守运行请先停止主机，再执行 tarobot service install。系统睡眠或登录前仍不能提供服务。"] : []), "CLI 存在不代表已经登录；请在运行主机、同一系统用户下完成所用引擎的登录。", "监听和中转在线状态不代表手机已经完成端到端连接。", "主机待执行消息保留在原主机；更新不会把 Bot 或手机转移到另一台主机。"] };
}
