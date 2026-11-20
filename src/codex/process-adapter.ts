import { isLogicalSessionId } from "../runtime/logical-session.js";
import { spawnEngine } from "../runtime/engine-process.js";
import { spawn } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { EngineHistoryBusyError } from "./adapter.js";
import type {
  CodexAdapter,
  CodexAdapterResponse,
  CodexSessionHandle,
  CodexThreadGoalResponse,
  NativeHistoryAnchor,
  NativeHistoryResult,
  NativeHistoryState,
  CodexUserMessageInput,
  EngineStreamEvent,
} from "./adapter.js";
import { CodexAppServerAdapter, extractCodexToolItem, type AppServerSpawnCodex } from "./app-server-adapter.js";
import { appendUniqueSendImageTag, extractGeneratedImagePath, sendImageTag } from "./generated-files.js";
import { killProcessTree } from "./process-tree.js";
import { mergeAllowedTurnExtraEnv } from "./turn-env.js";
import { codexManagedSearchCliOverrides, collectCodexSearchMcpEntries, searchMcpBlocksManaged, type NativeSearchMcpPlanner } from "../runtime/native-search-mcp.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode, type ApprovalMode } from "../state/approval-mode.js";
import { readValidatedConfigFile, resolveEngineOverride } from "../state/instance-config.js";

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

type ProcessStreamLike = {
  on(event: "data", listener: (chunk: Buffer | { toString(): string } | string) => void): void;
};

type ProcessChildLike = {
  pid?: number;
  stdin?: {
    end(chunk?: string): void;
    on?(event: "error", listener: (error: Error) => void): void;
  };
  stdout?: ProcessStreamLike;
  stderr?: ProcessStreamLike;
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null) => void): void;
};

type SpawnCodex = (command: string, args: string[], options: SpawnOptions) => ProcessChildLike;
const MAX_INSTRUCTIONS_CHARS = 16_000;
const MAX_OUTPUT_LINE_BUFFER_BYTES = 1024 * 1024;
const MAX_STRUCTURED_OUTPUT_LINE_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_DIAGNOSTIC_BYTES = 4 * 1024;
const MAX_CODEX_ROLLOUT_SCAN_DEPTH = 16;
export const CODEX_PROCESS_TURN_TIMEOUT_MS = 60 * 60_000;
export const CODEX_PROCESS_INACTIVITY_TIMEOUT_MS = 30 * 60_000;

function decodeProcessChunk(
  decoder: StringDecoder,
  chunk: Buffer | { toString(): string } | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk.toString();
}

type CodexJsonEvent =
  | {
      type: "thread.started";
      thread_id: string;
    }
  | {
      type: "item.completed";
      item?: {
        type?: string;
        text?: string;
      };
    }
  | {
      type: "error";
      message?: string;
    }
  | {
      type: "turn.failed";
      error?: {
        message?: string;
      };
    }
  | {
      type: "turn.completed";
      usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      };
    };

type CodexTurnState = {
  threadId: string | null;
  lastAgentMessage: string | null;
  generatedImagePaths: string[];
  lastTurnFailureMessage: string | null;
  lastErrorMessage: string | null;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
};

type EmitEngineEvent = (event: EngineStreamEvent) => void;

function createTurnState(): CodexTurnState {
  return {
    threadId: null,
    lastAgentMessage: null,
    generatedImagePaths: [],
    lastTurnFailureMessage: null,
    lastErrorMessage: null,
    usage: null,
  };
}

function appendGeneratedImagePaths(text: string, imagePaths: string[]): string {
  let next = text;
  for (const imagePath of imagePaths) {
    next = appendUniqueSendImageTag(next, imagePath);
  }
  return next;
}

function updateTurnStateFromLine(state: CodexTurnState, line: string, emitEngineEvent?: EmitEngineEvent): void {
  let parsed: unknown;
  let event: CodexJsonEvent;
  try {
    parsed = JSON.parse(line);
    event = parsed as CodexJsonEvent;
  } catch {
    return;
  }

  const generatedImagePath = extractGeneratedImagePath(parsed);
  if (generatedImagePath) {
    if (!state.generatedImagePaths.includes(generatedImagePath)) {
      state.generatedImagePaths.push(generatedImagePath);
      state.lastAgentMessage = appendGeneratedImagePaths(state.lastAgentMessage ?? "", state.generatedImagePaths);
      emitEngineEvent?.({
        type: "assistant_text",
        text: sendImageTag(generatedImagePath),
        sessionId: state.threadId ?? undefined,
      });
    }
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.threadId = event.thread_id;
    emitEngineEvent?.({ type: "session", sessionId: event.thread_id });
    return;
  }

  if (
    event.type === "item.completed" &&
    event.item?.type === "agent_message" &&
    typeof event.item.text === "string"
  ) {
    state.lastAgentMessage = appendGeneratedImagePaths(event.item.text, state.generatedImagePaths);
    emitEngineEvent?.({
      type: "assistant_text",
      text: event.item.text,
      sessionId: state.threadId ?? undefined,
    });
    return;
  }

  if (event.type === "item.completed" && event.item?.type === "reasoning") {
    const reasoning = (event.item as { text?: unknown }).text;
    if (typeof reasoning === "string" && reasoning.trim()) {
      emitEngineEvent?.({ type: "thinking", text: reasoning, sessionId: state.threadId ?? undefined });
    }
    return;
  }

  if (event.type === "item.completed" && event.item) {
    const toolEvent = extractCodexToolItem(event.item);
    if (toolEvent) {
      // Codex exec --json reports each completed tool as one item; emit the
      // tool_use + tool_result pair so the Lark run card renders a finished
      // tool panel with output, matching the Claude path.
      emitEngineEvent?.({
        type: "tool_use",
        toolName: toolEvent.toolName,
        ...(toolEvent.toolInput === undefined ? {} : { toolInput: toolEvent.toolInput }),
        ...(toolEvent.toolUseId ? { toolUseId: toolEvent.toolUseId } : {}),
        sessionId: state.threadId ?? undefined,
      });
      emitEngineEvent?.({
        type: "tool_result",
        ...(toolEvent.toolUseId ? { toolUseId: toolEvent.toolUseId } : {}),
        toolName: toolEvent.toolName,
        ...(toolEvent.output !== undefined ? { output: toolEvent.output } : {}),
        isError: toolEvent.isError,
        sessionId: state.threadId ?? undefined,
      });
    }
    return;
  }

  if (event.type === "turn.failed" && typeof event.error?.message === "string" && event.error.message.trim()) {
    state.lastTurnFailureMessage = event.error.message;
    return;
  }

  if (event.type === "turn.completed" && event.usage) {
    state.usage = {
      inputTokens: event.usage.input_tokens ?? 0,
      outputTokens: event.usage.output_tokens ?? 0,
      cachedTokens: event.usage.cached_input_tokens ?? 0,
    };
    return;
  }

  if (event.type === "error" && typeof event.message === "string" && event.message.trim()) {
    state.lastErrorMessage = event.message;
  }
}

function looksLikeStructuredCodexLine(value: string): boolean {
  return /^\s*\{\s*(?:"type"\s*:|"jsonrpc"\s*:|"id"\s*:|"method"\s*:)/.test(value);
}

function sliceUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function sliceUtf8Suffix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let start = Math.max(0, value.length - maxBytes);
  while (start < value.length && Buffer.byteLength(value.slice(start), "utf8") > maxBytes) {
    start += 1;
  }
  return value.slice(start);
}

function appendHeadTailDiagnostic(existing: string, chunk: string, maxBytes: number): string {
  const combined = existing + chunk;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) {
    return combined;
  }

  const head = sliceUtf8Prefix(combined, Math.floor(maxBytes / 2));
  const tail = sliceUtf8Suffix(combined, Math.floor(maxBytes / 2));
  const omittedBytes = Math.max(0, Buffer.byteLength(combined, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
  return `${head}\n[... ${omittedBytes} bytes elided ...]\n${tail}`;
}

function isNonBlockingCodexDiagnostic(stderr: string): boolean {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return false;
  }

  const hasKnownNonBlockingDiagnostic =
    trimmed.includes("failed to warm featured plugin ids cache") ||
    trimmed.includes("codex_core_plugins::manifest: ignoring") ||
    trimmed.includes("codex_core_skills::loader: ignoring") ||
    trimmed.includes("after_agent hook failed; continuing");
  if (!hasKnownNonBlockingDiagnostic) {
    return false;
  }

  if (/\b(?:ERROR|FATAL)\b|panicked at|thread '.+' panicked/.test(trimmed)) {
    return false;
  }

  return !/unexpected status 401|Unauthorized/i.test(trimmed);
}

function isLogicalTelegramSessionId(sessionId: string): boolean {
  return isLogicalSessionId(sessionId);
}

function normalizeExecutableCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function buildCommandInvocation(command: string, args: string[]): { command: string; args: string[]; shell?: boolean } {
  const normalizedCommand = normalizeExecutableCommand(command);
  if (process.platform === "win32") return { command: normalizedCommand, args, shell: false };

  if (/\.(cmd|bat)$/i.test(normalizedCommand)) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, ...args],
    };
  }

  if (/\.ps1$/i.test(normalizedCommand)) {
    return {
      command: "pwsh",
      args: ["-NoProfile", "-File", normalizedCommand, ...args],
    };
  }

  return { command: normalizedCommand, args, shell: false };
}

export type { ApprovalMode };

function combineInstructions(primary: string | null, secondary: string | null): string | null {
  const parts = [primary?.trim(), secondary?.trim()].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export class ProcessCodexAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "output-directory" as const;
  readonly supportsTurnScopedEnv = true;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnCodex: SpawnCodex;
  private readonly instructionsPath: string | undefined;
  private readonly configPath: string | undefined;
  private readonly turnTimeoutMs: number;
  private readonly inactivityTimeoutMs: number | null;
  private readonly nativeSearchMcp?: NativeSearchMcpPlanner;

  /**
   * First-pass adapter that runs Codex as a process.
   * The returned session id is a logical Telegram binding key for now, not
   * persisted Codex conversation continuity.
   *
   * If instructionsPath is provided, the file contents are prepended to every
   * prompt sent to Codex (loaded fresh on each call so edits take effect
   * without restarting the service).
   *
   * If configPath is provided, config.json is loaded on each call to pick up
   * approvalMode ("normal" | "full-auto" | "bypass") for YOLO mode.
   */
  constructor(
    private readonly codexExecutable: string,
    childEnvOrSpawn?: NodeJS.ProcessEnv | SpawnCodex,
    spawnCodexArg?: SpawnCodex,
    instructionsPath?: string,
    configPath?: string,
    engineHomePath?: string,
    private readonly workspacePath?: string,
    turnTimeoutMs: number = CODEX_PROCESS_TURN_TIMEOUT_MS,
    inactivityTimeoutMs: number | null = CODEX_PROCESS_INACTIVITY_TIMEOUT_MS,
    options: { nativeSearchMcp?: NativeSearchMcpPlanner } = {},
  ) {
    const buildChildEnv = () => {
      const env = { ...process.env };
      delete env.TELEGRAM_BOT_TOKEN;
      if (engineHomePath) {
        env.CODEX_HOME = engineHomePath;
      }
      // Otherwise inherit CODEX_HOME from the parent env so bots track the
      // same config dir the user's main Codex CLI uses. Unset → ~/.codex/.
      return env;
    };

    this.childEnv =
      typeof childEnvOrSpawn === "function"
        ? buildChildEnv()
        : childEnvOrSpawn ?? buildChildEnv();

    this.spawnCodex =
      typeof childEnvOrSpawn === "function"
        ? childEnvOrSpawn
        : spawnCodexArg ?? (spawnEngine as unknown as SpawnCodex);

    this.instructionsPath = instructionsPath;
    this.configPath = configPath;
    this.nativeSearchMcp = options.nativeSearchMcp;
    this.turnTimeoutMs = turnTimeoutMs;
    this.inactivityTimeoutMs = inactivityTimeoutMs;
  }

  async createSession(chatId: number): Promise<CodexSessionHandle> {
    return { sessionId: `tarobot-${chatId}` };
  }

  private createGoalAppServerAdapter(workspaceOverride?: string, spawnOverride?: AppServerSpawnCodex): CodexAppServerAdapter {
    const spawnForAppServer: AppServerSpawnCodex = spawnOverride ?? ((command, args, options) => (
      this.spawnCodex(command, args, options) as unknown as ReturnType<AppServerSpawnCodex>
    ));
    return new CodexAppServerAdapter(
      this.codexExecutable,
      workspaceOverride ?? this.workspacePath ?? process.cwd(),
      this.childEnv,
      spawnForAppServer,
      this.instructionsPath,
      undefined,
      this.configPath,
      undefined,
      undefined,
      undefined,
      this.nativeSearchMcp ? { nativeSearchMcp: this.nativeSearchMcp } : {},
    );
  }

  /** `-c` overrides adding the managed search MCP for one exec turn: paths and
   * variable names only. Existing or disabled search registrations win. */
  private async managedSearchOverrides(cwd: string | undefined): Promise<{ flags: string[]; env: Record<string, string> }> {
    let plan;
    try { plan = this.nativeSearchMcp?.() ?? null; } catch { plan = null; }
    if (!plan || !cwd) return { flags: [], env: {} };
    try {
      if (searchMcpBlocksManaged(await collectCodexSearchMcpEntries(this.childEnv, cwd))) return { flags: [], env: {} };
    } catch {
      console.error("[search] Codex configuration unreadable; not adding the managed Search MCP.");
      return { flags: [], env: {} };
    }
    return { flags: codexManagedSearchCliOverrides(plan), env: plan.processEnv };
  }

  async getThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<CodexThreadGoalResponse> {
    const appServer = this.createGoalAppServerAdapter(input.workspaceOverride);
    try {
      return await appServer.getThreadGoal(sessionId, input);
    } finally {
      appServer.destroy();
    }
  }

  async setThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const appServer = this.createGoalAppServerAdapter(input.workspaceOverride);
    try {
      return await appServer.setThreadGoal(sessionId, input);
    } finally {
      appServer.destroy();
    }
  }

  async clearThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<{ cleared: boolean; sessionId?: string }> {
    const appServer = this.createGoalAppServerAdapter(input.workspaceOverride);
    try {
      return await appServer.clearThreadGoal(sessionId, input);
    } finally {
      appServer.destroy();
    }
  }

  async watchThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse> {
    // Goals require the app-server protocol; delegate to a temp app-server like the
    // other goal methods. The await holds it open for the whole autonomous pursuit
    // (it streams events to onEngineEvent), then `finally` tears it down. Without
    // this, the process/antigravity Codex runtimes had no watchThreadGoal at all, so
    // /goal threw "Structured goal API is not available" before it could run.
    const appServer = this.createGoalAppServerAdapter(input.workspaceOverride);
    try {
      return await appServer.watchThreadGoal(sessionId, input);
    } finally {
      appServer.destroy();
    }
  }

  async validateExternalSession(sessionId: string): Promise<void> {
    const codexHome = this.resolveCodexHome();
    const sessionIndexPath = path.join(codexHome, "session_index.jsonl");
    let raw: string;
    try {
      raw = await readFile(sessionIndexPath, "utf8");
    } catch {
      if (await this.hasLocalRolloutFile(codexHome, sessionId)) {
        return;
      }
      throw new Error(`codex process could not resume thread ${sessionId}`);
    }

    for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (parsed.id === sessionId) {
          return;
        }
      } catch {
        // Ignore malformed index rows and keep scanning.
      }
    }

    if (await this.hasLocalRolloutFile(codexHome, sessionId)) {
      return;
    }

    throw new Error(`codex process could not resume thread ${sessionId}`);
  }

  private async hasLocalRolloutFile(codexHome: string, sessionId: string): Promise<boolean> {
    const pending = [
      { dir: path.join(codexHome, "sessions"), depth: 0 },
      { dir: path.join(codexHome, "archived_sessions"), depth: 0 },
    ];
    const visited = new Set<string>();

    while (pending.length > 0) {
      const { dir: current, depth } = pending.pop()!;
      let visitedKey = current;
      try {
        visitedKey = await realpath(current);
      } catch {
        // The following readdir will handle missing or unreadable paths.
      }
      if (visited.has(visitedKey)) {
        continue;
      }
      visited.add(visitedKey);

      try {
        const entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
        for (const entry of entries) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (depth < MAX_CODEX_ROLLOUT_SCAN_DEPTH) {
              pending.push({ dir: entryPath, depth: depth + 1 });
            }
            continue;
          }
          if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${sessionId}.jsonl`)) {
            return true;
          }
        }
      } catch {
        continue;
      }
    }

    return false;
  }

  private async loadEngineOptions(): Promise<{ approvalMode: ApprovalMode; effort?: string; model?: string; codexServiceTier?: "fast" }> {
    if (!this.configPath) return { approvalMode: "normal" };
    // Permissions and model settings must come from the same file snapshot.
    const parsed = await readValidatedConfigFile(this.configPath, { forExecution: true });
    return {
      approvalMode: normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE,
      effort: typeof parsed.effort === "string" ? parsed.effort : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      codexServiceTier: parsed.codexServiceTier === "fast" ? "fast" : undefined,
    };
  }

  private async loadInstructions(): Promise<string | null> {
    if (!this.instructionsPath) {
      return null;
    }

    try {
      const content = await readFile(this.instructionsPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        return null;
      }

      if (trimmed.length <= MAX_INSTRUCTIONS_CHARS) {
        return trimmed;
      }

      return `${trimmed.slice(0, MAX_INSTRUCTIONS_CHARS)}\n\n[Instructions truncated at ${MAX_INSTRUCTIONS_CHARS} characters]`;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      return null;
    }
  }

  // ---- Native history -------------------------------------------------------
  // `codex exec` has no history interface; the app-server has. A temporary
  // app-server on the same Codex home reads and forks the thread, as it does
  // for goals. This adapter never learns which turn an input became (exec does
  // not say), so it emits no anchors and offers only a fork of the whole thread.

  /** Turns this adapter has running in `codex exec`. The temporary app-server cannot see them. */
  private runningTurns = 0;
  private historyEpoch = 0;
  private readonly historyOperations = new Set<{ kind: "read" | "fork"; stop: () => void; finished: Promise<void> }>();

  hasPendingNativeWork(): boolean { return this.historyOperations.size > 0; }

  /** Each temporary app-server belongs to one operation, not to future turns.
   * Guard both spawn and writes: cancelling during asynchronous startup must
   * not let an app-server start later and submit a history change. */
  private async withHistoryAppServer<T>(kind: "read" | "fork", input: { workspaceOverride?: string; signal?: AbortSignal }, operation: (server: CodexAppServerAdapter, signal: AbortSignal) => Promise<T>): Promise<{
    value?: T; failed: boolean; cancelled: boolean; submitted: boolean; cleanupFailed: boolean;
  }> {
    const lifetime = new AbortController();
    const children: Promise<void>[] = [];
    let server: CodexAppServerAdapter | undefined, active = true, submitted = false;
    let finish!: () => void, fail!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    void finished.catch(() => undefined);
    const stop = () => { lifetime.abort(new Error("Codex history operation cancelled")); server?.destroy(); };
    const control = { kind, stop, finished };
    this.historyOperations.add(control);
    // Caller cancellation after a submitted mutation must not discard its
    // answer. Owner shutdown still stops the helper and reports uncertainty.
    const callerAbort = () => { if (!submitted) stop(); };
    input.signal?.addEventListener("abort", callerAbort, { once: true });
    if (input.signal?.aborted) callerAbort();
    const guard = () => {
      if (!active || lifetime.signal.aborted) throw new Error("Codex history operation cancelled");
    };
    const spawnHistory: AppServerSpawnCodex = (command, args, options) => {
      guard();
      const child = this.spawnCodex(command, args, options) as unknown as ReturnType<AppServerSpawnCodex>;
      children.push(new Promise<void>(resolve => { child.once("close", () => resolve()); }));
      const stdin = child.stdin;
      return {
        pid: child.pid, stdout: child.stdout, stderr: child.stderr,
        kill: child.kill?.bind(child), once: child.once.bind(child),
        ...(stdin ? { stdin: {
          on: stdin.on?.bind(stdin), end: stdin.end?.bind(stdin),
          write: (chunk: string, callback?: (error?: Error | null) => void) => {
            guard();
            for (const line of chunk.split("\n")) {
              try { if (JSON.parse(line).method === "thread/fork") submitted = true; } catch { /* not a request */ }
            }
            return stdin.write(chunk, callback);
          },
        } } : {}),
      };
    };
    let value: T | undefined, failed = false, cleanupFailed = false;
    try {
      guard();
      server = this.createGoalAppServerAdapter(input.workspaceOverride, spawnHistory);
      value = await operation(server, lifetime.signal);
    } catch {
      failed = true;
    } finally {
      active = false;
      server?.destroy();
      const closed = Promise.all(children);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([closed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Codex history helper did not exit")), 10_000);
          timer.unref?.();
        })]);
        this.historyOperations.delete(control); finish();
      } catch {
        cleanupFailed = true; fail(new Error("Codex history helper did not exit"));
        // Keep native work visible until actual exit, even after a bounded
        // cleanup error. No replacement helper or write is attempted.
        void closed.then(() => this.historyOperations.delete(control));
      } finally { if (timer) clearTimeout(timer); input.signal?.removeEventListener("abort", callerAbort); }
    }
    return { ...(value === undefined ? {} : { value }), failed, cancelled: lifetime.signal.aborted, submitted, cleanupFailed };
  }

  async getHistoryState(sessionId: string, input: { workspaceOverride?: string; signal?: AbortSignal } = {}): Promise<NativeHistoryState> {
    if (this.runningTurns > 0 || this.historyOperations.size > 0) return { head: null, blocked: "busy" };
    const result = await this.withHistoryAppServer("read", input, (server, signal) => server.getHistoryState(sessionId, { ...input, signal }));
    if (result.failed || result.cancelled || result.cleanupFailed || !result.value) return { head: null, blocked: "not_ready" };
    const state = result.value;
    return { head: state.head, ...(state.fork ? { fork: { whole: state.fork.whole, anchored: false } } : {}), ...(state.blocked ? { blocked: state.blocked } : {}) };
  }

  async forkHistory(sessionId: string, input: {
    anchor?: NativeHistoryAnchor; expectedHead?: string | null; workspaceOverride?: string; signal?: AbortSignal;
  } = {}): Promise<NativeHistoryResult> {
    if (input.anchor) return { outcome: "rejected", reason: "unsupported" };
    if (input.signal?.aborted) return { outcome: "rejected", reason: "cancelled" };
    if (this.runningTurns > 0 || this.historyOperations.size > 0) return { outcome: "rejected", reason: "busy" };
    const result = await this.withHistoryAppServer("fork", input, (server, signal) => server.forkHistory(sessionId, { ...input, signal }));
    if (result.failed || result.cancelled || result.cleanupFailed || !result.value) {
      const candidate = result.value?.outcome === "applied" ? result.value.sessionId : result.value?.outcome === "unknown" ? result.value.candidateSessionId : undefined;
      return result.submitted ? { outcome: "unknown", ...(candidate ? { candidateSessionId: candidate } : {}) }
        : { outcome: "rejected", reason: input.signal?.aborted ? "cancelled" : "not_ready" };
    }
    return result.value;
  }

  /** Stop only the currently owned history helpers. Ordinary process turns and
   * future operations keep their existing restartable lifecycle. */
  async destroy(): Promise<void> {
    this.historyEpoch++;
    const active = [...this.historyOperations];
    for (const control of active) control.stop();
    const results = await Promise.allSettled(active.map(control => control.finished));
    if (results.some(result => result.status === "rejected")) throw new Error("Codex history helper did not exit");
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const epoch = this.historyEpoch;
    while (this.historyOperations.size > 0) {
      const active = [...this.historyOperations];
      if (active.some(control => control.kind === "fork")) throw new EngineHistoryBusyError();
      input.abortSignal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { input.abortSignal?.removeEventListener("abort", abort); reject(input.abortSignal?.reason); };
        input.abortSignal?.addEventListener("abort", abort, { once: true });
        void Promise.all(active.map(control => control.finished)).then(() => { input.abortSignal?.removeEventListener("abort", abort); resolve(); }, error => { input.abortSignal?.removeEventListener("abort", abort); reject(new EngineHistoryBusyError()); });
        if (input.abortSignal?.aborted) abort();
      });
      if (epoch !== this.historyEpoch) throw new Error("Codex history operation cancelled");
    }
    this.runningTurns++;
    try {
      return await this.runUserMessage(sessionId, input);
    } finally {
      this.runningTurns--;
    }
  }

  private async runUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const instructions = combineInstructions(
      this.instructionsPath ? await this.loadInstructions() : null,
      input.instructions ?? null,
    );
    const parts: string[] = [];
    if (instructions) {
      parts.push(instructions);
      parts.push("---");
    }
    parts.push(prependPrivateTurnInstructions(input.text, input.turnInstructions));
    for (const file of input.files) {
      parts.push(`Attachment: ${file}`);
    }
    const prompt = parts.join("\n");
    const configured: Awaited<ReturnType<typeof this.loadEngineOptions>> = this.configPath ? await this.loadEngineOptions() : { approvalMode: "normal" };
    const engineOptions = resolveEngineOverride("codex", configured, input.engineOverride);
    const approvalMode = engineOptions.approvalMode;
    const approvalFlags: string[] =
      approvalMode === "bypass"
        ? ["--dangerously-bypass-approvals-and-sandbox"]
        : approvalMode === "full-auto"
          ? ["--sandbox", "workspace-write", "-c", 'approval_policy="never"']
          : [];
    if (approvalMode === "normal" && this.configPath && !input.onApprovalRequest) throw new Error("Codex normal mode requires a whole-turn approval handler");
    let effectiveApprovalFlags = approvalFlags;
    if (approvalMode === "normal" && input.onApprovalRequest) {
      const decision = await input.onApprovalRequest({
        engine: "codex",
        toolName: "Codex full-auto turn (grants the WHOLE turn, not one command)",
        approvalScopes: { once: "turn" },
        toolInput: { prompt },
        cwd: input.workspaceOverride ?? this.workspacePath,
        abortSignal: input.abortSignal,
      });
      if (decision.behavior === "deny") {
        throw new Error("Codex turn was denied from Telegram");
      }
      effectiveApprovalFlags = ["--sandbox", "workspace-write", "-c", 'approval_policy="never"'];
    }
    const engineFlags: string[] = [];
    if (engineOptions.effort) {
      engineFlags.push("-c", `model_reasoning_effort="${engineOptions.effort}"`);
    }
    if (engineOptions.model) {
      engineFlags.push("-m", engineOptions.model);
    }
    if (engineOptions.codexServiceTier === "fast") {
      engineFlags.push("--enable", "fast_mode", "-c", 'service_tier="fast"');
    }
    // No await without a planner: spawn timing stays unchanged for other callers.
    const search = this.nativeSearchMcp ? await this.managedSearchOverrides(input.workspaceOverride ?? this.workspacePath) : { flags: [], env: {} };
    engineFlags.push(...search.flags);
    const args = isLogicalTelegramSessionId(sessionId)
      ? ["exec", "--json", "--skip-git-repo-check", ...effectiveApprovalFlags, ...engineFlags, "-"]
      : ["exec", "resume", "--json", "--skip-git-repo-check", "--all", ...effectiveApprovalFlags, ...engineFlags, sessionId, "-"];
    const result = await this.runCodexJsonCommand(
      args,
      prompt,
      input.abortSignal,
      input.workspaceOverride,
      input.disableRuntimeTimeout ? null : this.turnTimeoutMs,
      input.disableRuntimeTimeout ? null : this.inactivityTimeoutMs,
      input.extraEnv,
      input.onEngineEvent,
      search.env,
    );

    if (result.state.lastTurnFailureMessage) {
      throw new Error(result.state.lastTurnFailureMessage);
    }

    if (result.exitCode !== 0) {
      const stderrMessage = result.stderrTail.trim();
      const text = result.state.lastAgentMessage?.trim();
      if (text && !result.state.lastErrorMessage && isNonBlockingCodexDiagnostic(stderrMessage)) {
        return {
          text,
          sessionId: result.state.threadId ?? undefined,
          usage: result.state.usage ?? undefined,
        };
      }
      throw new Error(
        result.state.lastErrorMessage ??
          (stderrMessage || `codex exited with code ${result.exitCode}`),
      );
    }

    return {
      text: result.state.lastAgentMessage?.trim() || `Session ${sessionId} completed.`,
      sessionId: result.state.threadId ?? undefined,
      usage: result.state.usage ?? undefined,
    };
  }

  private resolveCodexHome(): string {
    if (this.childEnv.CODEX_HOME) {
      return this.childEnv.CODEX_HOME;
    }

    const homeDir =
      process.platform === "win32"
        ? this.childEnv.USERPROFILE ?? this.childEnv.HOME ?? os.homedir()
        : this.childEnv.HOME ?? this.childEnv.USERPROFILE ?? os.homedir();

    return path.join(homeDir, ".codex");
  }

  private async runCodexJsonCommand(
    args: string[],
    prompt: string,
    abortSignal?: AbortSignal,
    cwdOverride?: string,
    timeoutMs: number | null = this.turnTimeoutMs,
    inactivityTimeoutMs: number | null = this.inactivityTimeoutMs,
    extraEnv?: Record<string, string>,
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>,
    searchEnv: Record<string, string> = {},
  ): Promise<{ state: CodexTurnState; stderrTail: string; exitCode: number | null }> {
    const invocation = buildCommandInvocation(this.codexExecutable, args);
    const child = this.spawnCodex(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: invocation.shell,
      env: { ...mergeAllowedTurnExtraEnv(this.childEnv, extraEnv), ...searchEnv },
      cwd: cwdOverride ?? this.workspacePath,
      windowsHide: true,
    });

    return await new Promise<{ state: CodexTurnState; stderrTail: string; exitCode: number | null }>((resolve, reject) => {
      let stdoutLineBuffer = "";
      let stderrTail = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let settled = false;
      const state = createTurnState();
      let totalTimeout: ReturnType<typeof setTimeout> | undefined;
      let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
      let abortCleanup: (() => void) | undefined;
      const emitEngineEvent: EmitEngineEvent = (event) => {
        if (!onEngineEvent) {
          return;
        }
        try {
          Promise.resolve(onEngineEvent(event)).catch(() => undefined);
        } catch {
          // Stream event observers are best-effort and must not fail the engine turn.
        }
      };

      const clearTimers = () => {
        totalTimeout && clearTimeout(totalTimeout);
        inactivityTimeout && clearTimeout(inactivityTimeout);
        totalTimeout = undefined;
        inactivityTimeout = undefined;
      };

      const clearAbortListener = () => {
        abortCleanup?.();
        abortCleanup = undefined;
      };

      const rejectAndKill = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimers();
        clearAbortListener();
        killProcessTree(child.pid);
        reject(error);
      };

      const resetInactivityTimeout = () => {
        inactivityTimeout && clearTimeout(inactivityTimeout);
        inactivityTimeout = undefined;
        if (inactivityTimeoutMs === null) {
          return;
        }

        inactivityTimeout = setTimeout(() => {
          rejectAndKill(
            new Error(
              `Codex process turn became inactive after ${Math.max(1, Math.round(inactivityTimeoutMs / 60_000))} minutes`,
            ),
          );
        }, inactivityTimeoutMs);
      };

      if (timeoutMs !== null) {
        totalTimeout = setTimeout(() => {
          rejectAndKill(
            new Error(`Codex process turn timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} minutes`),
          );
        }, timeoutMs);
      }

      resetInactivityTimeout();

      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimers();
          clearAbortListener();
          reject(error);
        }
      });
      child.once("close", (code) => {
        if (!settled) {
          settled = true;
          clearTimers();
          clearAbortListener();
          stdoutLineBuffer += stdoutDecoder.end();
          stderrTail = appendHeadTailDiagnostic(stderrTail, stderrDecoder.end(), MAX_STDERR_DIAGNOSTIC_BYTES);
          const trailingLine = stdoutLineBuffer.trim();
          if (trailingLine) {
            updateTurnStateFromLine(state, trailingLine, emitEngineEvent);
          }
          resolve({ state, stderrTail, exitCode: code });
        }
      });

      child.stdout?.on("data", (chunk) => {
        resetInactivityTimeout();
        stdoutLineBuffer += decodeProcessChunk(stdoutDecoder, chunk);

        const lines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = lines.pop() ?? "";
        for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
          if (line.length > MAX_OUTPUT_LINE_BUFFER_BYTES) {
            if (!looksLikeStructuredCodexLine(line)) {
              rejectAndKill(new Error("Engine output exceeded maximum buffer size"));
              return;
            }
            if (line.length > MAX_STRUCTURED_OUTPUT_LINE_BUFFER_BYTES) {
              rejectAndKill(new Error("Engine structured output exceeded maximum buffer size"));
              return;
            }
          }
          updateTurnStateFromLine(state, line, emitEngineEvent);
        }
        if (!settled && stdoutLineBuffer.length > MAX_OUTPUT_LINE_BUFFER_BYTES) {
          if (looksLikeStructuredCodexLine(stdoutLineBuffer)) {
            if (stdoutLineBuffer.length > MAX_STRUCTURED_OUTPUT_LINE_BUFFER_BYTES) {
              rejectAndKill(new Error("Engine structured output exceeded maximum buffer size"));
            }
            return;
          }
          rejectAndKill(new Error("Engine output exceeded maximum buffer size"));
        }
      });

      child.stderr?.on("data", (chunk) => {
        resetInactivityTimeout();
        stderrTail = appendHeadTailDiagnostic(stderrTail, decodeProcessChunk(stderrDecoder, chunk), MAX_STDERR_DIAGNOSTIC_BYTES);
      });

      child.stdin?.on?.("error", (error) => {
        rejectAndKill(error);
      });

      if (abortSignal) {
        const onAbort = () => {
          rejectAndKill(new Error("Task was stopped by user"));
        };
        abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
        abortSignal.addEventListener("abort", onAbort, { once: true });
        if (abortSignal.aborted) { onAbort(); return; }
      }

      try {
        child.stdin?.end(prompt);
      } catch (error) {
        rejectAndKill(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
