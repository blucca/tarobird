import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PiModelSource } from "./pi-native-types.js";
import type { PiModelRef } from "./pi-rpc-protocol.js";

/**
 * Where Pi sessions of one Bot live, and the small amount of per-session state
 * the adapter keeps beside them.
 *
 * Bot sessions are native Pi session files in `<stateDir>/pi/sessions`
 * (`--session-dir`). Sessions the owner started in a terminal stay in Pi's own
 * directory and are opened in place, never copied. Only the first line (the
 * session header) and `session_info` entries are read from a session file.
 */

export interface PiSessionFile {
  sessionId: string;
  path: string;
  cwd: string;
  name?: string;
  createdAt?: string;
  updatedAt: string;
  parentSession?: string;
  /** bot: created by this Bot; native: Pi's own session directory for the workspace. */
  origin: "bot" | "native";
}

export interface PiSessionRecord {
  /** Fingerprint of the Bot-wide model/effort this session last had applied. */
  appliedBotDefault?: string;
  modelSource?: PiModelSource;
  /** Model put in place by the Bot default, so clearing the default can undo exactly that. */
  botDefaultModel?: PiModelRef;
  /** Thinking level put in place by the Bot default, and the level the session had before it. */
  botDefaultThinking?: string;
  thinkingBeforeBotDefault?: string;
  /** Absolute path of a session that lives outside the Bot's own directory. */
  externalPath?: string;
  touchedAt?: number;
}

export type PiTrustDecision = "yes" | "no";
interface PiStateFile {
  version: 1;
  sessions: Record<string, PiSessionRecord>;
  /** Keyed by a hash of the workspace path. */
  trust: Record<string, { decision: PiTrustDecision; decidedAt: number }>;
  /** This Bot's model scope in the Host's canonical model form (`encodePiModel`); decoded and passed to Pi with `--models`. */
  scopedModels?: string[];
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_NAME_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_RECORDS = 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Ids become file-name suffixes and CLI arguments; accept only what Pi itself generates or a UUID we chose. */
export function isSafePiSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value) && !value.includes("..");
}

/** Mirrors Pi 1.5.2 `getDefaultSessionDirPath` (session-manager.ts:590-595). */
export function piNativeSessionDir(cwd: string, agentDir: string): string {
  const safe = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(path.resolve(agentDir), "sessions", safe);
}

/**
 * Pi's `normalizePath` for a configured directory (utils/paths.ts:120-145): `~`, `~/…` (and `~\…` on
 * Windows) and `file://` URLs. Anything else, relative paths included, is left as written.
 */
export function expandPiPath(value: string, homeDir = os.homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return path.join(homeDir, value.slice(2));
  if (/^file:\/\//.test(value)) { try { return fileURLToPath(value); } catch { return value; } }
  return value;
}

/**
 * Pi's `getAgentDir` (config.ts:630-636): `PI_CODING_AGENT_DIR` with `~` expanded, or `~/.pi/agent`.
 * Pi resolves a relative value from its own working directory, which is the workspace it runs in, so pass
 * that as `cwd`; the Host's own directory is never the answer.
 */
export function piAgentDir(env: NodeJS.ProcessEnv, homeDir = os.homedir(), cwd?: string): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (!override) return path.join(homeDir, ".pi", "agent");
  const expanded = expandPiPath(override, homeDir);
  return cwd ? path.resolve(cwd, expanded) : path.resolve(expanded);
}

const SETTINGS_MAX_BYTES = 1024 * 1024;

/** One Pi settings file as Pi loads it: missing, oversized or unparsable is `{}` (settings-manager.ts:366-394). Only this file is read. */
async function readPiSettingsFile(file: string): Promise<Record<string, unknown>> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > SETTINGS_MAX_BYTES) return {};
    const parsed: unknown = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * Where Pi itself keeps the sessions it starts in `cwd` (main.ts:739-744, session-manager.ts:1766-1769):
 * `PI_CODING_AGENT_SESSION_DIR`, else `sessionDir` from the global settings overridden by the project's
 * `.pi/settings.json` (deep merge, project wins; the startup lookup reads the project file whether or not it
 * is trusted), else the per-workspace default. A configured directory is flat and shared by every
 * workspace; `~` is expanded and a relative path is taken from `cwd`, where Pi runs. No credential file is read.
 */
export async function piNativeSessionDirFor(cwd: string, env: NodeJS.ProcessEnv, homeDir = os.homedir()): Promise<string> {
  const resolvedCwd = path.resolve(cwd);
  const fromEnv = env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (fromEnv) return path.resolve(resolvedCwd, expandPiPath(fromEnv, homeDir));
  const agentDir = piAgentDir(env, homeDir, resolvedCwd);
  const [global, project] = await Promise.all([
    readPiSettingsFile(path.join(agentDir, "settings.json")),
    readPiSettingsFile(path.join(resolvedCwd, ".pi", "settings.json")),
  ]);
  // deepMergeObjects skips only undefined, which JSON cannot hold: any project value, null included, wins.
  const merged = Object.hasOwn(project, "sessionDir") ? project.sessionDir : global.sessionDir;
  // getSessionDir: an empty value means the default; a non-string would not start Pi at all, so it is not followed.
  if (typeof merged === "string" && merged) return path.resolve(resolvedCwd, expandPiPath(merged, homeDir));
  return piNativeSessionDir(resolvedCwd, agentDir);
}

export function piBotDefaultFingerprint(model: string | undefined, effort: string | undefined): string {
  return createHash("sha256").update(JSON.stringify([model ?? "", effort ?? ""])).digest("hex").slice(0, 32);
}

async function readFirstLine(file: string, limit = MAX_HEADER_BYTES): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = createReadStream(file, { start: 0, end: limit - 1 });
    stream.on("data", chunk => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) { chunks.push(buffer.subarray(0, newline)); stream.destroy(); resolve(Buffer.concat(chunks).toString("utf8")); return; }
      chunks.push(buffer); size += buffer.length;
    });
    stream.on("end", () => resolve(size ? Buffer.concat(chunks).toString("utf8") : undefined));
    stream.on("error", () => resolve(undefined));
  });
}

/** Latest `session_info` name. Scans at most the last 8 MiB so a huge transcript cannot stall a listing. */
async function readSessionName(file: string, size: number): Promise<string | undefined> {
  if (!size) return;
  const start = Math.max(0, size - MAX_NAME_SCAN_BYTES);
  return new Promise(resolve => {
    let name: string | undefined, rest = "", first = start > 0;
    const stream = createReadStream(file, { start, encoding: "utf8" });
    const scan = (line: string) => {
      if (!line.includes('"session_info"')) return;
      try {
        const entry = JSON.parse(line) as { type?: unknown; name?: unknown };
        if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 200) : undefined;
      } catch { /* a partial or foreign line is not a name */ }
    };
    stream.on("data", chunk => {
      rest += chunk;
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      if (first && lines.length) { lines.shift(); first = false; } // the first line of a tail read may be cut
      for (const line of lines) scan(line);
    });
    stream.on("end", () => { if (!first && rest) scan(rest); resolve(name); });
    stream.on("error", () => resolve(name));
  });
}

export class PiSessionStore {
  readonly rootDir: string;
  readonly sessionDir: string;
  private readonly statePath: string;
  private state: PiStateFile | undefined;
  private loading: Promise<PiStateFile> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: { stateDir: string; childEnv: NodeJS.ProcessEnv; homeDir?: string }) {
    this.rootDir = path.join(options.stateDir, "pi");
    this.sessionDir = path.join(this.rootDir, "sessions");
    this.statePath = path.join(this.rootDir, "state.json");
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  /** Pi's own session directory for a workspace, resolved as Pi resolves it (see `piNativeSessionDirFor`). */
  nativeSessionDir(cwd: string): Promise<string> {
    return piNativeSessionDirFor(cwd, this.options.childEnv, this.options.homeDir);
  }

  /** Read and validate a session header. Undefined when the file is not a Pi session. */
  async readHeader(file: string): Promise<{ id: string; cwd: string; version?: number; timestamp?: string; parentSession?: string } | undefined> {
    const line = await readFirstLine(file);
    if (!line) return;
    try {
      const header = JSON.parse(line) as Record<string, unknown>;
      if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || !header.id || !header.cwd) return;
      return {
        id: header.id, cwd: header.cwd,
        ...(typeof header.version === "number" ? { version: header.version } : {}),
        ...(typeof header.timestamp === "string" ? { timestamp: header.timestamp } : {}),
        ...(typeof header.parentSession === "string" ? { parentSession: header.parentSession } : {}),
      };
    } catch { return; }
  }

  private async describe(file: string, origin: PiSessionFile["origin"], withName: boolean): Promise<PiSessionFile | undefined> {
    let info;
    try { info = await stat(file); } catch { return; }
    if (!info.isFile()) return;
    const header = await this.readHeader(file);
    if (!header) return;
    const name = withName ? await readSessionName(file, info.size) : undefined;
    return {
      sessionId: header.id, path: file, cwd: header.cwd, origin, updatedAt: info.mtime.toISOString(),
      ...(name ? { name } : {}), ...(header.timestamp ? { createdAt: header.timestamp } : {}),
      ...(header.parentSession ? { parentSession: header.parentSession } : {}),
    };
  }

  private async sessionFilesIn(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => path.join(dir, entry.name));
    } catch { return []; }
  }

  /**
   * Locate a session by id: the Bot's directory, a remembered external path,
   * then Pi's own directory for `cwd`. The header id must match exactly; a
   * file name alone is never trusted.
   */
  async find(sessionId: string, cwd?: string): Promise<PiSessionFile | undefined> {
    if (!isSafePiSessionId(sessionId)) return;
    const suffix = `_${sessionId}.jsonl`;
    const check = async (file: string, origin: PiSessionFile["origin"]) => {
      const found = await this.describe(file, origin, true);
      return found?.sessionId === sessionId ? found : undefined;
    };
    for (const file of (await this.sessionFilesIn(this.sessionDir)).filter(name => name.endsWith(suffix))) {
      const found = await check(file, "bot");
      if (found) return found;
    }
    const remembered = (await this.record(sessionId)).externalPath;
    if (remembered) {
      const found = await check(remembered, "native");
      if (found) return found;
    }
    if (cwd) {
      for (const file of (await this.sessionFilesIn(await this.nativeSessionDir(cwd))).filter(name => name.endsWith(suffix))) {
        const found = await check(file, "native");
        if (found) return found;
      }
    }
    return;
  }

  /** Sessions that belong to `cwd`, newest first: the Bot's own and those started in Pi's terminal UI. */
  async list(input: { cwd: string; limit?: number }): Promise<PiSessionFile[]> {
    const cwd = path.resolve(input.cwd), limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const candidates: Array<{ file: string; origin: PiSessionFile["origin"]; mtime: number }> = [];
    for (const [dir, origin] of [[this.sessionDir, "bot"], [await this.nativeSessionDir(cwd), "native"]] as const) {
      for (const file of await this.sessionFilesIn(dir)) {
        try { candidates.push({ file, origin, mtime: (await stat(file)).mtimeMs }); } catch { /* removed meanwhile */ }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const sessions: PiSessionFile[] = [], seen = new Set<string>();
    for (const candidate of candidates) {
      if (sessions.length >= limit) break;
      const session = await this.describe(candidate.file, candidate.origin, true);
      if (!session || seen.has(session.sessionId) || path.resolve(session.cwd) !== cwd) continue;
      seen.add(session.sessionId);
      sessions.push(session);
    }
    return sessions;
  }

  /** Single flight: concurrent first uses must share one in-memory state, or the later load would drop the earlier update. */
  private load(): Promise<PiStateFile> {
    if (this.state) return Promise.resolve(this.state);
    this.loading ??= (async () => {
      let parsed: Partial<PiStateFile> | undefined;
      try { parsed = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<PiStateFile>; } catch { /* missing or unreadable: start empty */ }
      const object = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, never>;
      const scope = Array.isArray(parsed?.scopedModels) ? parsed.scopedModels.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 512).slice(0, 200) : [];
      this.state = { version: 1, sessions: { ...object(parsed?.sessions) }, trust: { ...object(parsed?.trust) }, ...(scope.length ? { scopedModels: scope } : {}) };
      return this.state;
    })();
    return this.loading;
  }

  private save(): Promise<void> {
    const next = this.writeChain.then(async () => {
      const state = await this.load();
      const ids = Object.keys(state.sessions);
      if (ids.length > MAX_SESSION_RECORDS) {
        ids.sort((a, b) => (state.sessions[a]?.touchedAt ?? 0) - (state.sessions[b]?.touchedAt ?? 0));
        for (const id of ids.slice(0, ids.length - MAX_SESSION_RECORDS)) delete state.sessions[id];
      }
      await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.statePath);
    });
    this.writeChain = next.catch(() => {});
    return next;
  }

  async record(sessionId: string): Promise<PiSessionRecord> {
    return { ...((await this.load()).sessions[sessionId] ?? {}) };
  }

  async updateRecord(sessionId: string, patch: Partial<PiSessionRecord>): Promise<PiSessionRecord> {
    const merged = this.merge(await this.load(), sessionId, patch);
    await this.save();
    return { ...merged };
  }

  /**
   * `updateRecord` for a fact that holds only while `stillTrue` does. It is
   * asked at the moment the record changes, after any wait for the file, so a
   * caller that lost its footing during that wait records nothing. Returns
   * whether the record was changed.
   */
  async updateRecordIf(sessionId: string, patch: Partial<PiSessionRecord>, stillTrue: () => boolean): Promise<boolean> {
    const state = await this.load();
    if (!stillTrue()) return false;
    this.merge(state, sessionId, patch);
    await this.save();
    return true;
  }

  private merge(state: PiStateFile, sessionId: string, patch: Partial<PiSessionRecord>): PiSessionRecord {
    const merged: PiSessionRecord = { ...(state.sessions[sessionId] ?? {}), ...patch, touchedAt: Date.now() };
    for (const key of Object.keys(merged) as Array<keyof PiSessionRecord>) if (merged[key] === undefined) delete merged[key];
    state.sessions[sessionId] = merged;
    return merged;
  }

  /** A fork or clone starts from its parent's applied defaults, so the next turn does not re-apply them. */
  async inheritRecord(fromSessionId: string, toSessionId: string): Promise<void> {
    const { externalPath: _external, ...inherited } = await this.record(fromSessionId);
    await this.updateRecord(toSessionId, inherited);
  }

  private trustKey(cwd: string): string {
    return createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 32);
  }

  /** The owner's answer, given in TaroBird, about loading this workspace's project-local Pi files. */
  async trustDecision(cwd: string): Promise<PiTrustDecision | undefined> {
    return (await this.load()).trust[this.trustKey(cwd)]?.decision;
  }

  async setTrustDecision(cwd: string, decision: PiTrustDecision): Promise<void> {
    (await this.load()).trust[this.trustKey(cwd)] = { decision, decidedAt: Date.now() };
    await this.save();
  }

  async scopedModels(): Promise<string[]> {
    return [...((await this.load()).scopedModels ?? [])];
  }

  async setScopedModels(references: string[]): Promise<void> {
    const state = await this.load();
    if (references.length) state.scopedModels = [...new Set(references)].slice(0, 200); else delete state.scopedModels;
    await this.save();
  }

  /**
   * Where an imported session file goes: the Bot's session directory, under
   * its own base name, with `-N` appended while that name is taken (as Pi's
   * own import does).
   */
  async importDestination(source: string): Promise<string> {
    const { name, ext } = path.parse(path.basename(source));
    let destination = path.join(this.sessionDir, `${name}${ext}`);
    for (let suffix = 1; suffix < 1000; suffix++) {
      try { await stat(destination); } catch { return destination; }
      destination = path.join(this.sessionDir, `${name}-${suffix}${ext}`);
    }
    throw new Error("No free file name for the imported session");
  }
}

/** Project-local files Pi 1.5.2 loads only from a trusted project (trust-manager.ts:30-39, 193-215). */
export const PI_TRUST_GATED_PATHS = Object.freeze([
  ".pi/settings.json", ".pi/mcp.json", ".pi/extensions", ".pi/skills", ".pi/prompts", ".pi/themes",
  ".pi/SYSTEM.md", ".pi/APPEND_SYSTEM.md", ".agents/skills",
]);

export async function hasPiTrustGatedFiles(cwd: string): Promise<boolean> {
  for (const relative of PI_TRUST_GATED_PATHS) {
    try { await stat(path.join(cwd, relative)); return true; } catch { /* absent */ }
  }
  return false;
}
