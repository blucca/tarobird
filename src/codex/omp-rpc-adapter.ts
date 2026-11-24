import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  withFailedTurnUsage,
  type AdapterUsage, type AppPlatformTools, type CodexAdapter, type CodexAdapterResponse,
  type CodexSessionHandle, type CodexThreadGoal, type CodexThreadGoalResponse, type CodexUserMessageInput,
  type EngineContextUsage, type EngineQuotaReadResult, type EngineSideSession, type EngineStreamEvent,
  type EngineTask, type EngineTaskControlResult, type EngineTaskSnapshot, type ExternalSessionInfo,
  type NativeHistoryAnchor, type NativeHistoryRejection, type NativeHistoryResult, type NativeHistoryState,
  type SideCapability,
} from "./adapter.js";
import type { SteeringApplication } from "../client-protocol/steering-outcome.js";
import type { Locale } from "../runtime/locale.js";
import { decodePiModel } from "./pi-models.js";
import { prependPrivateTurnInstructions } from "./turn-instructions.js";
import { readValidatedConfigFile, type EngineOverride } from "../state/instance-config.js";
import { OmpRpcClient, type OmpLaunchSpec, type OmpSpawn } from "./omp-rpc-client.js";
import type {
  OmpBtwRecord, OmpExtensionUiRequest, OmpGoalRecord, OmpGoalUpdatedFrame,
  OmpHostToolCallFrame, OmpHostToolCancelFrame, OmpPromptResultFrame, OmpSessionEntry,
  OmpSessionEvent, OmpSessionState, OmpSlashCommand, OmpSubagentEventFrame,
  OmpSubagentLifecycleFrame, OmpSubagentProgressFrame,
} from "./omp-rpc-protocol.js";
import type { PiImageContent } from "./pi-rpc-protocol.js";
import type { RunScope } from "../client-protocol/run.js";

export interface OmpRpcAdapterOptions {
  launch: OmpLaunchSpec;
  workspacePath: string;
  stateDir: string;
  childEnv: NodeJS.ProcessEnv;
  configPath?: string;
  spawnFn?: OmpSpawn;
  killProcessTreeFn?: (pid: number | undefined) => void | Promise<void>;
  startupTimeoutMs?: number;
  cancelGraceMs?: number;
}

interface SubagentRecord {
  subagentId: string;
  scope: RunScope;
  label: string;
  status: "running" | "done" | "error" | "stopped";
  startedAt: number;
  updatedAt: number;
  progress?: string;
}

interface GoalWatcher {
  abortSignal?: AbortSignal;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: CodexUserMessageInput["onApprovalRequest"];
  resolve: (response: CodexThreadGoalResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface OmpWorker {
  readonly sessionKey: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly client: OmpRpcClient;
  state: OmpSessionState;
  readonly subagents: Map<string, SubagentRecord>;
  readonly activeBtw: Map<string, { resolve: (rec: OmpBtwRecord) => void; reject: (err: Error) => void; onDelta?: (delta: string) => void }>;
  readonly completedBtw: Map<string, OmpBtwRecord>;
  readonly hostToolCalls: Map<string, AbortController>;
  registeredHostToolsKey?: string;
  activeAppTools?: AppPlatformTools;
  activeTurn?: ActiveOmpTurn;
  goalWatcher?: GoalWatcher;
  lastGoal?: OmpGoalRecord | null;
}

interface ActiveOmpTurn {
  promptId?: string;
  input: CodexUserMessageInput;
  textChunks: string[];
  finalText?: string;
  thinkingChunks: string[];
  commandOutputs: string[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; hasData: boolean };
  settled: boolean;
  promptResult?: OmpPromptResultFrame;
  resolve: (response: CodexAdapterResponse) => void;
  reject: (error: Error) => void;
  aborting: boolean;
}

const DEFAULT_CANCEL_GRACE_MS = 5_000;
const OMP_EMPTY_HISTORY_HEAD = "omp:empty";
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map(block => block.text)
    .join("");
}

function extractMessageUsage(message: unknown): AdapterUsage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = typeof usage.input === "number" ? usage.input : typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
  const outputTokens = typeof usage.output === "number" ? usage.output : typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
  const cachedTokens = typeof usage.cacheRead === "number" ? usage.cacheRead : typeof usage.cachedTokens === "number" ? usage.cachedTokens : 0;
  const costObj = usage.cost && typeof usage.cost === "object" ? usage.cost as { total?: unknown } : undefined;
  const costUsd = typeof costObj?.total === "number" ? costObj.total : typeof usage.costUsd === "number" ? usage.costUsd : 0;
  if (inputTokens === 0 && outputTokens === 0 && cachedTokens === 0 && costUsd === 0) return undefined;
  return { inputTokens, outputTokens, ...(cachedTokens > 0 ? { cachedTokens } : {}), ...(costUsd > 0 ? { costUsd } : {}) };
}

function sanitizeDirSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "default";
}

function mapGoalStatus(raw?: string): CodexThreadGoal["status"] {
  switch (raw) {
    case "active":
    case "running":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
    case "usage_limited":
      return "usageLimited";
    case "budgetLimited":
    case "budget_limited":
      return "budgetLimited";
    case "complete":
    case "completed":
    case "done":
      return "complete";
    default:
      return "active";
  }
}

function toCodexThreadGoal(threadId: string, record: OmpGoalRecord | null | undefined, state?: { status?: string; tokensUsed?: number; timeUsedSeconds?: number } | null): CodexThreadGoal | null {
  if (!record || typeof record.objective !== "string" || !record.objective.trim()) return null;
  const now = Date.now();
  return {
    threadId,
    objective: record.objective,
    status: mapGoalStatus(state?.status ?? record.status),
    tokenBudget: record.tokenBudget ?? record.token_budget ?? null,
    tokensUsed: state?.tokensUsed ?? record.tokensUsed ?? record.tokens_used ?? 0,
    timeUsedSeconds: state?.timeUsedSeconds ?? record.timeUsedSeconds ?? record.time_used_seconds ?? 0,
    createdAt: record.createdAt ?? record.created_at ?? now,
    updatedAt: record.updatedAt ?? record.updated_at ?? now,
  };
}

function activeEntryBranch(entries: OmpSessionEntry[], leafId: string | null): OmpSessionEntry[] {
  if (!leafId || entries.length === 0) return [];
  const byId = new Map<string, OmpSessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const pathEntries: OmpSessionEntry[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = leafId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const entry = byId.get(cur);
    if (!entry) break;
    pathEntries.push(entry);
    cur = entry.parentId ?? null;
  }
  pathEntries.reverse();
  return pathEntries;
}

function isUserMessageEntry(entry: OmpSessionEntry): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

async function prepareAttachments(files: string[]): Promise<{ images: PiImageContent[]; extraFiles: string[] }> {
  const images: PiImageContent[] = [];
  const extraFiles: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const mimeType = IMAGE_MIME_BY_EXT[ext];
    if (mimeType) {
      try {
        const st = await stat(file);
        if (st.isFile() && st.size <= MAX_INLINE_IMAGE_BYTES) {
          const data = (await readFile(file)).toString("base64");
          images.push({ type: "image", data, mimeType });
          continue;
        }
      } catch {
        // Fall back to path reference if file could not be read.
      }
    }
    extraFiles.push(file);
  }
  return { images, extraFiles };
}

function extractAskResponseSelections(updatedInput: unknown): {
  answers: Record<string, string>;
  selections?: Record<string, { selectedOptions: string[]; customInput?: string }>;
} {
  if (!updatedInput || typeof updatedInput !== "object") return { answers: {} };
  const record = updatedInput as {
    answers?: Record<string, unknown>;
    selections?: Record<string, { selectedOptions?: unknown; customInput?: unknown }>;
  };
  const answers: Record<string, string> = {};
  if (record.answers && typeof record.answers === "object") {
    for (const [k, v] of Object.entries(record.answers)) {
      if (typeof v === "string") answers[k] = v;
    }
  }
  let selections: Record<string, { selectedOptions: string[]; customInput?: string }> | undefined;
  if (record.selections && typeof record.selections === "object") {
    selections = {};
    for (const [k, v] of Object.entries(record.selections)) {
      if (!v || typeof v !== "object") continue;
      selections[k] = {
        selectedOptions: Array.isArray(v.selectedOptions) ? v.selectedOptions.filter((x): x is string => typeof x === "string") : [],
        ...(typeof v.customInput === "string" && v.customInput.trim() ? { customInput: v.customInput.trim() } : {}),
      };
    }
  }
  return { answers, selections };
}

/**
 * oh-my-pi (`omp --mode rpc-ui`) engine adapter aligned with Codex & Claude Code.
 * Supports every capability OMP natively exposes:
 * - v1/v2 protocol negotiation & lossless `rpc_chunk` reassembly (strict version check)
 * - Per-prompt `prompt_result` + `session_settled` turn boundary
 * - In-flight steering (`inFlightSendBehavior = "steer"`, `steerActiveTurn`) + `follow_up` + `/btw` side conversations
 * - Host-owned `appPlatformTools` via `set_host_tools` + `host_tool_call` / `host_tool_result` / `host_tool_cancel`
 * - Native history `getHistoryState`, non-destructive `forkHistory`, and `rewindHistory` (`navigate_tree`)
 * - Native autonomous `goal` (`getThreadGoal` / `setThreadGoal` / `updateThreadGoal` / `watchThreadGoal` / `clearThreadGoal`)
 * - Native subagents (`set_subagent_subscription("events")`, `listTasks`, `stopTask` via `cancel_subagent`)
 * - Native `rpc-ui` dialogs (`confirm`, `ask`, `select`, explicit cancel for raw `form`)
 * - Native image attachments (`prompt.images`), usage/cost tracking, retry visibility, advertised commands, and session resume
 */
export class OmpRpcAdapter implements CodexAdapter {
  readonly inFlightSendBehavior = "steer" as const;
  private readonly workers = new Map<string, OmpWorker>();
  private readonly starting = new Map<string, Promise<OmpWorker>>();
  private readonly sessionPaths = new Map<string, string>();
  private cachedCommands: Array<{ name: string; description: string }> = [];
  private destroyed = false;

  constructor(private readonly options: OmpRpcAdapterOptions) {}

  async createSession(_chatId?: number): Promise<CodexSessionHandle> {
    return { sessionId: `omp_${randomUUID()}` };
  }

  supportsSessionSteering(sessionId: string): boolean {
    const worker = this.workers.get(sessionId);
    return !!worker && worker.client.alive && !!worker.activeTurn && !worker.activeTurn.settled;
  }

  hasPendingNativeWork(): boolean {
    for (const worker of this.workers.values()) {
      if (worker.activeTurn && !worker.activeTurn.settled) return true;
      if (worker.goalWatcher && !worker.goalWatcher.settled) return true;
      for (const sub of worker.subagents.values()) {
        if (sub.status === "running") return true;
      }
    }
    return false;
  }

  advertisedCommands(): Array<{ name: string; description: string }> {
    return this.cachedCommands;
  }

  private updateAdvertisedCommands(commands: OmpSlashCommand[] | undefined): void {
    if (!Array.isArray(commands)) return;
    this.cachedCommands = commands
      .filter((c): c is OmpSlashCommand => !!c && typeof c.name === "string" && c.name.trim().length > 0)
      .map(c => ({ name: c.name.trim(), description: c.description?.trim() || c.source || "" }));
  }

  private async getOrStartWorker(sessionKey: string, workspaceOverride?: string, signal?: AbortSignal): Promise<OmpWorker> {
    if (this.destroyed) throw new Error("omp adapter is destroyed");
    const existing = this.workers.get(sessionKey);
    if (existing && existing.client.alive) return existing;
    const inflight = this.starting.get(sessionKey);
    if (inflight) return inflight;

    const work = (async (): Promise<OmpWorker> => {
      const cwd = workspaceOverride || this.options.workspacePath;
      const sessionDir = path.join(this.options.stateDir, "omp", "sessions", sanitizeDirSegment(sessionKey));
      await mkdir(sessionDir, { recursive: true });

      const client = await OmpRpcClient.start({
        launch: this.options.launch,
        cwd,
        env: this.options.childEnv,
        mode: "rpc-ui",
        startupTimeoutMs: this.options.startupTimeoutMs,
        signal,
        ...(this.options.spawnFn ? { spawnFn: this.options.spawnFn } : {}),
        ...(this.options.killProcessTreeFn ? { killProcessTreeFn: this.options.killProcessTreeFn } : {}),
      });

      const worker: OmpWorker = {
        sessionKey,
        sessionDir,
        cwd,
        client,
        state: await client.getState(),
        subagents: new Map(),
        activeBtw: new Map(),
        completedBtw: new Map(),
        hostToolCalls: new Map(),
      };

      // Subscribe to native OMP subagents and enable structured ask dialogs.
      await client.setSubagentSubscription("events").catch(() => undefined);
      await client.setAskDialog(true).catch(() => undefined);
      // Discover slash commands asynchronously so startup never blocks on older builds.
      void client.getAvailableCommands().then(res => this.updateAdvertisedCommands(res.commands)).catch(() => undefined);

      // Bind persistent session file (if forked/resumed) or conversation directory.
      const boundPath = this.sessionPaths.get(sessionKey);
      if (boundPath) {
        await client.switchSession(boundPath).catch(() => client.openSession(sessionDir).catch(() => undefined));
      } else {
        const opened = await client.openSession(sessionDir).catch(() => undefined);
        if (opened?.sessionFile) this.sessionPaths.set(sessionKey, opened.sessionFile);
      }
      worker.state = await client.getState().catch(() => worker.state);
      if (worker.state.sessionFile) this.sessionPaths.set(sessionKey, worker.state.sessionFile);
      if (worker.state.goal !== undefined) worker.lastGoal = worker.state.goal;

      client.onEvent((event) => this.handleEvent(worker, event));
      client.onPromptResult((frame) => this.handlePromptResult(worker, frame));
      client.onSessionSettled(() => this.handleSessionSettled(worker));
      client.onSubagentLifecycle((frame) => this.handleSubagentLifecycle(worker, frame));
      client.onSubagentProgress((frame) => this.handleSubagentProgress(worker, frame));
      client.onSubagentEvent((frame) => this.handleSubagentEvent(worker, frame));
      client.onBtwRecord((frame) => this.handleBtwRecord(worker, frame.record));
      client.onBtwDelta((frame) => { worker.activeBtw.get(frame.recordId)?.onDelta?.(frame.delta); });
      client.onExtensionUi((request) => { void this.handleExtensionUi(worker, request); });
      client.onCommandsUpdate((frame) => this.updateAdvertisedCommands(frame.commands));
      client.onHostToolCall((frame) => { void this.handleHostToolCall(worker, frame); });
      client.onHostToolCancel((frame) => this.handleHostToolCancel(worker, frame));
      client.onGoalUpdated((frame) => this.handleGoalUpdated(worker, frame));

      void client.exited.then(() => {
        if (this.workers.get(sessionKey) === worker) this.workers.delete(sessionKey);
        for (const [, ac] of worker.hostToolCalls) ac.abort();
        worker.hostToolCalls.clear();
        if (worker.activeTurn && !worker.activeTurn.settled) {
          const turn = worker.activeTurn;
          turn.settled = true;
          worker.activeTurn = undefined;
          const err = new Error("omp process exited unexpectedly before turn settled");
          turn.reject(withFailedTurnUsage(err, this.turnUsage(turn)));
        }
        if (worker.goalWatcher && !worker.goalWatcher.settled) {
          const watcher = worker.goalWatcher;
          watcher.settled = true;
          worker.goalWatcher = undefined;
          watcher.reject(new Error("omp process exited while watching goal"));
        }
        for (const [id, waiter] of worker.activeBtw) {
          worker.activeBtw.delete(id);
          waiter.reject(new Error("omp process exited during side question"));
        }
      });

      this.workers.set(sessionKey, worker);
      return worker;
    })();

    this.starting.set(sessionKey, work);
    try {
      return await work;
    } finally {
      if (this.starting.get(sessionKey) === work) this.starting.delete(sessionKey);
    }
  }

  private async syncConfigToWorker(worker: OmpWorker, engineOverride?: EngineOverride): Promise<void> {
    let model = engineOverride?.model;
    let effort = engineOverride?.effort;
    if (!model && !effort && this.options.configPath) {
      try {
        const cfg = await readValidatedConfigFile(this.options.configPath, { forExecution: true });
        model = cfg.model;
        effort = cfg.effort;
      } catch {
        // Keep current model/effort if config is absent in test setups.
      }
    }
    try {
      if (model) {
        const decoded = decodePiModel(model);
        if (decoded && (worker.state.model?.provider !== decoded.provider || worker.state.model?.id !== decoded.modelId)) {
          worker.state.model = await worker.client.setModel(decoded.provider, decoded.modelId, effort && effort !== "ultra" ? effort : undefined);
        }
      }
      if (effort && effort !== "ultra" && worker.state.thinkingLevel !== effort) {
        await worker.client.setThinkingLevel(effort);
        worker.state.thinkingLevel = effort;
      }
    } catch {
      // Preserve live worker configuration if override cannot be applied in tests.
    }
  }

  private async syncHostTools(worker: OmpWorker, sessionId: string, tools: AppPlatformTools | undefined): Promise<boolean> {
    if (!tools || tools.definitions.length === 0) {
      worker.activeAppTools = undefined;
      return false;
    }
    const resolvedTools = (await tools.forSession?.(sessionId)) ?? tools;
    const key = JSON.stringify(resolvedTools.definitions.map(d => [d.name, d.description, d.inputSchema]));
    worker.activeAppTools = resolvedTools;
    if (worker.registeredHostToolsKey !== key) {
      try {
        await worker.client.setHostTools(resolvedTools.definitions.map(def => ({
          name: def.name,
          label: def.name,
          description: def.description,
          parameters: def.inputSchema,
          loadMode: "essential",
        })));
        worker.registeredHostToolsKey = key;
      } catch {
        // Older omp runtime without set_host_tools: gracefully skip host-tool registration.
        worker.activeAppTools = undefined;
        return false;
      }
    }
    if (!await resolvedTools.isRegistered(sessionId).catch(() => false)) {
      await resolvedTools.register(sessionId).catch(() => undefined);
    }
    return true;
  }

  private async handleHostToolCall(worker: OmpWorker, frame: OmpHostToolCallFrame): Promise<void> {
    const tools = worker.activeAppTools ?? worker.activeTurn?.input.appPlatformTools;
    if (!tools) {
      worker.client.sendHostToolResult({
        type: "host_tool_result",
        id: frame.id,
        isError: true,
        result: { content: [{ type: "text", text: `Host tool "${frame.toolName}" is not available in this turn.` }] },
      });
      return;
    }
    const controller = new AbortController();
    worker.hostToolCalls.set(frame.id, controller);
    try {
      const outcome = await tools.call({
        name: frame.toolName,
        arguments: frame.arguments ?? {},
        callId: frame.toolCallId || frame.id,
        sessionId: worker.sessionKey,
        abortSignal: controller.signal,
      });
      worker.client.sendHostToolResult({
        type: "host_tool_result",
        id: frame.id,
        ...(outcome.isError ? { isError: true } : {}),
        result: { content: [{ type: "text", text: outcome.text }] },
      });
    } catch (error) {
      worker.client.sendHostToolResult({
        type: "host_tool_result",
        id: frame.id,
        isError: true,
        result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
      });
    } finally {
      worker.hostToolCalls.delete(frame.id);
    }
  }

  private handleHostToolCancel(worker: OmpWorker, frame: OmpHostToolCancelFrame): void {
    const ac = worker.hostToolCalls.get(frame.targetId);
    if (ac) {
      ac.abort();
      worker.hostToolCalls.delete(frame.targetId);
    }
  }

  private turnUsage(turn: ActiveOmpTurn): AdapterUsage | undefined {
    if (!turn.usage.hasData) return undefined;
    return {
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      ...(turn.usage.cachedTokens > 0 ? { cachedTokens: turn.usage.cachedTokens } : {}),
      ...(turn.usage.costUsd > 0 ? { costUsd: turn.usage.costUsd } : {}),
    };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride, input.abortSignal);
    await this.syncConfigToWorker(worker, input.engineOverride);
    const hostToolsRegistered = await this.syncHostTools(worker, sessionId, input.appPlatformTools);

    const { images, extraFiles } = await prepareAttachments(input.files ?? []);
    const baseText = extraFiles.length > 0
      ? `${input.text}\n\nAttached files:\n${extraFiles.map(f => `- ${f}`).join("\n")}`
      : input.text;
    const combinedInstructions = [
      hostToolsRegistered ? input.appPlatformTools?.instructions : input.instructions,
      hostToolsRegistered ? input.appPlatformTools?.turnInstructions : undefined,
      input.turnInstructions,
    ].filter((part): part is string => !!part && part.trim().length > 0).join("\n\n");
    const promptText = prependPrivateTurnInstructions(baseText, combinedInstructions || undefined);

    return new Promise<CodexAdapterResponse>((resolve, reject) => {
      const promptId = worker.client.nextId("prompt");
      const turn: ActiveOmpTurn = {
        promptId,
        input,
        textChunks: [],
        thinkingChunks: [],
        commandOutputs: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, hasData: false },
        settled: false,
        resolve,
        reject,
        aborting: false,
      };
      worker.activeTurn = turn;

      const onAbort = () => {
        if (turn.settled || turn.aborting) return;
        turn.aborting = true;
        void worker.client.abort().catch(() => undefined);
        const grace = this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
        const timer = setTimeout(() => {
          if (!turn.settled) {
            turn.settled = true;
            worker.activeTurn = undefined;
            worker.client.terminate();
            reject(withFailedTurnUsage(new Error("Turn aborted"), this.turnUsage(turn)));
          }
        }, grace);
        timer.unref?.();
      };
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });

      const cleanupAbort = () => input.abortSignal?.removeEventListener("abort", onAbort);
      const origResolve = turn.resolve;
      const origReject = turn.reject;
      turn.resolve = (res) => { cleanupAbort(); origResolve(res); };
      turn.reject = (err) => { cleanupAbort(); origReject(err); };

      void worker.client.prompt(promptText, images.length > 0 ? images : undefined, undefined, promptId).then(
        ({ data }) => {
          // Synchronous local slash command completed without invoking agent.
          if (data?.agentInvoked === false && !turn.settled) {
            turn.settled = true;
            worker.activeTurn = undefined;
            const text = turn.commandOutputs.join("\n").trim() || "";
            turn.resolve({ sessionId, text });
            return;
          }
          // If prompt_result arrived before our promise microtask resumed, finalize now.
          if (turn.promptResult) this.maybeCompleteTurn(worker, turn);
        },
        (error) => {
          if (!turn.settled) {
            turn.settled = true;
            worker.activeTurn = undefined;
            const err = error instanceof Error ? error : new Error(String(error));
            turn.reject(withFailedTurnUsage(err, this.turnUsage(turn)));
          }
        },
      );
    });
  }

  /** Native CodexAdapter mid-turn steering (aligned with Codex & Claude). */
  async steerActiveTurn(
    sessionId: string,
    input: { text: string; throwOnError?: boolean; onOutcome?: (outcome: SteeringApplication) => void },
  ): Promise<boolean> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive || !worker.activeTurn || worker.activeTurn.settled) {
      return false;
    }
    try {
      await worker.client.steer(input.text);
      input.onOutcome?.({ status: "applied", via: "fold" });
      return true;
    } catch (error) {
      if (input.throwOnError) throw error;
      input.onOutcome?.({ status: "dropped", reason: "turn_failed" });
      return false;
    }
  }

  /** Queue 1: Steer an active OMP turn natively. */
  async steerSession(sessionId: string, message: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) throw new Error("omp session is not active");
    await worker.client.steer(message);
  }

  /** Queue 2: Enqueue a follow-up message natively into OMP's follow-up queue. */
  async followUpSession(sessionId: string, message: string): Promise<void> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) throw new Error("omp session is not active");
    await worker.client.followUp(message);
  }

  /** Queue 3: Ask an ephemeral side question (`aside` via OMP's native `/btw` command). */
  async askAside(sessionId: string, question: string, options: { recordId?: string; onDelta?: (delta: string) => void; signal?: AbortSignal } = {}): Promise<OmpBtwRecord> {
    const worker = await this.getOrStartWorker(sessionId, undefined, options.signal);
    const { record } = await worker.client.btw(question, options.recordId);
    const settled = worker.completedBtw.get(record.id) ?? record;
    const latest = settled.followUps?.at(-1) ?? settled;
    if (latest.status === "complete") { worker.completedBtw.delete(record.id); return settled; }
    if (latest.status === "cancelled") { worker.completedBtw.delete(record.id); throw new Error("Side question cancelled"); }
    if (latest.status === "error") { worker.completedBtw.delete(record.id); throw new Error(latest.error || "Side question failed"); }

    return new Promise<OmpBtwRecord>((resolve, reject) => {
      const onAbort = () => {
        void worker.client.btwCancel(record.id).catch(() => undefined);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      worker.activeBtw.set(record.id, {
        onDelta: options.onDelta,
        resolve: (done) => { options.signal?.removeEventListener("abort", onAbort); resolve(done); },
        reject: (err) => { options.signal?.removeEventListener("abort", onAbort); reject(err); },
      });
    });
  }

  sideCapability(): SideCapability {
    return { context: "native", concurrent: true, seesInProgressTurn: true, readOnly: "no-tools", residue: "none" };
  }

  async openSideSession(input: {
    sourceSessionId: string;
    tools?: "inherited";
    workspaceOverride?: string;
    locale?: Locale;
    abortSignal?: AbortSignal;
  }): Promise<EngineSideSession> {
    const sessionKey = input.sourceSessionId;
    let recordId: string | undefined;
    const nativeId = `omp_btw_${randomUUID()}`;
    return {
      nativeId,
      send: async (req) => {
        const record = await this.askAside(sessionKey, req.text, {
          recordId,
          signal: req.abortSignal,
          onDelta: (delta) => { void req.onEngineEvent({ type: "assistant_text", text: delta, delta: true }); },
        });
        recordId = record.id;
        const latestTurn = record.followUps?.at(-1) ?? record;
        return { text: latestTurn.answer };
      },
      dispose: async () => {
        const worker = this.workers.get(sessionKey);
        if (recordId && worker?.client.alive) await worker.client.btwCancel(recordId).catch(() => undefined);
      },
    };
  }

  /** Native history state (aligned with Codex & Claude). */
  async getHistoryState(sessionId: string, input: { workspaceOverride?: string; signal?: AbortSignal } = {}): Promise<NativeHistoryState> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) {
      return { head: null, blocked: "not_ready" };
    }
    if (worker.activeTurn && !worker.activeTurn.settled) {
      return { head: null, blocked: "busy" };
    }
    if (worker.goalWatcher && !worker.goalWatcher.settled) {
      return { head: null, blocked: "goal_active" };
    }
    try {
      const [state, entriesRes] = await Promise.all([worker.client.getState(), worker.client.getEntries()]);
      worker.state = state;
      const busy = Boolean(state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0);
      const goalActive = state.goal && mapGoalStatus(state.goal.status) === "active";
      const hasHistory = entriesRes.leafId !== null;
      return {
        fork: { whole: hasHistory, anchored: hasHistory },
        rewind: hasHistory,
        head: entriesRes.leafId ?? OMP_EMPTY_HISTORY_HEAD,
        ...(busy ? { blocked: "busy" as const } : goalActive ? { blocked: "goal_active" as const } : {}),
      };
    } catch {
      return { head: null, blocked: "not_ready" };
    }
  }

  /**
   * Non-destructive native fork using OMP's `fork` command.
   * Preserves the source worker's session file and active branch untouched by switching the
   * source worker back to its original session file immediately after reading the forked file,
   * then binding the forked file to a fresh session ID.
   */
  async forkHistory(sessionId: string, input: {
    anchor?: NativeHistoryAnchor;
    expectedHead?: string | null;
    workspaceOverride?: string;
    signal?: AbortSignal;
  } = {}): Promise<NativeHistoryResult> {
    const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
    if (input.signal?.aborted) return rejected("cancelled");
    const anchor = input.anchor;
    if (anchor && !anchor.fork) return rejected("anchor_unavailable", "Anchor does not support fork");
    if (anchor && anchor.sessionId !== sessionId) return rejected("anchor_unavailable", "Anchor belongs to another session");

    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) return rejected("not_ready", "No live omp session to fork");
    if (worker.activeTurn && !worker.activeTurn.settled) return rejected("busy");

    try {
      const [stateBefore, entriesRes] = await Promise.all([worker.client.getState(), worker.client.getEntries()]);
      if (stateBefore.isStreaming || stateBefore.isCompacting) return rejected("busy");
      const currentHead = entriesRes.leafId ?? OMP_EMPTY_HISTORY_HEAD;
      if (input.expectedHead !== undefined && input.expectedHead !== currentHead) return rejected("source_changed");
      if (entriesRes.leafId === null) return rejected("not_ready", "Session has no history yet");
      if (anchor) {
        const branch = activeEntryBranch(entriesRes.entries, entriesRes.leafId);
        if (!branch.some(entry => entry.id === anchor.inputId)) {
          return rejected("anchor_unavailable", "Anchor is not on the active branch");
        }
      }
      if (input.signal?.aborted) return rejected("cancelled");

      const originalSessionFile = stateBefore.sessionFile;
      const forkResult = await worker.client.fork(anchor?.inputId);
      if (forkResult.cancelled) return rejected("cancelled", "omp cancelled the fork");

      const forkedState = await worker.client.getState();
      const forkedEntries = await worker.client.getEntries();
      const newSessionId = `omp_${randomUUID()}`;
      if (forkedState.sessionFile) {
        this.sessionPaths.set(newSessionId, forkedState.sessionFile);
      }
      // Restore the source worker to its original session file so the source conversation is untouched!
      if (originalSessionFile && originalSessionFile !== forkedState.sessionFile) {
        await worker.client.switchSession(originalSessionFile).catch(() => undefined);
        worker.state = await worker.client.getState().catch(() => stateBefore);
      }
      return {
        outcome: "applied",
        sessionId: newSessionId,
        head: forkedEntries.leafId,
        boundary: anchor ? (anchor.forkBoundary ?? "after-turn") : "whole",
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "session_busy") return rejected("busy");
      return rejected("not_ready", error instanceof Error ? error.message : String(error));
    }
  }

  /** Native in-place rewind via OMP's `navigate_tree` (aligned with Codex rewind). */
  async rewindHistory(sessionId: string, input: {
    anchor: NativeHistoryAnchor;
    expectedHead?: string | null;
    workspaceOverride?: string;
    signal?: AbortSignal;
  }): Promise<NativeHistoryResult> {
    const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
    if (input.signal?.aborted) return rejected("cancelled");
    if (!input.anchor.rewind || input.anchor.sessionId !== sessionId) return rejected("anchor_unavailable");

    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) return rejected("not_ready", "No live omp session to rewind");
    if (worker.activeTurn && !worker.activeTurn.settled) return rejected("busy");

    try {
      const entriesBefore = await worker.client.getEntries();
      const currentHead = entriesBefore.leafId ?? OMP_EMPTY_HISTORY_HEAD;
      if (input.expectedHead !== undefined && input.expectedHead !== currentHead) return rejected("source_changed");
      const branch = activeEntryBranch(entriesBefore.entries, entriesBefore.leafId);
      const anchorIndex = branch.findIndex(entry => entry.id === input.anchor.inputId);
      if (anchorIndex < 0) return rejected("anchor_unavailable", "Anchor is not on the active branch");
      if (input.signal?.aborted) return rejected("cancelled");

      const nav = await worker.client.navigateTree(input.anchor.inputId);
      if (nav.cancelled) return rejected("cancelled", "omp cancelled navigate_tree");

      const entriesAfter = await worker.client.getEntries();
      const excludedInputIds = branch.slice(anchorIndex).filter(isUserMessageEntry).map(entry => entry.id);
      return {
        outcome: "applied",
        sessionId,
        head: entriesAfter.leafId,
        boundary: "before-input",
        excludedInputIds,
      };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === "session_busy") return rejected("busy");
      if (code === "entry_not_found") return rejected("anchor_unavailable");
      return rejected("not_ready", error instanceof Error ? error.message : String(error));
    }
  }

  /** Native OMP Goal Mode (aligned with Codex thread goals). */
  async getThreadGoal(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<CodexThreadGoalResponse> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) return { goal: null };
    const res = await worker.client.goal("get");
    worker.lastGoal = res.goal;
    return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
  }

  async setThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride);
    const res = await worker.client.goal("create", {
      objective: input.objective,
      ...(typeof input.tokenBudget === "number" && input.tokenBudget > 0 ? { token_budget: Math.round(input.tokenBudget) } : {}),
    });
    worker.lastGoal = res.goal;
    return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
  }

  async updateThreadGoal(sessionId: string, input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    status?: CodexThreadGoal["status"];
    objective?: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride);
    if (input.isCurrentSession && !await input.isCurrentSession()) {
      throw new Error("Session changed before goal update");
    }
    const op = input.status === "paused" ? "pause" : input.status === "active" ? "resume" : "get";
    const res = await worker.client.goal(op);
    worker.lastGoal = res.goal;
    return { goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId };
  }

  async watchThreadGoal(sessionId: string, input: {
    isCurrentSession?: () => boolean | Promise<boolean>;
    mode?: "replace" | "resume" | "observe";
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: CodexUserMessageInput["onApprovalRequest"];
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse> {
    const worker = await this.getOrStartWorker(sessionId, input.workspaceOverride, input.abortSignal);
    if (input.mode === "replace") {
      await worker.client.goal("drop").catch(() => undefined);
      await worker.client.goal("create", {
        objective: input.objective,
        ...(typeof input.tokenBudget === "number" && input.tokenBudget > 0 ? { token_budget: Math.round(input.tokenBudget) } : {}),
      });
    } else if (input.mode === "resume") {
      await worker.client.goal("resume");
    }

    const current = await worker.client.goal("get");
    const mapped = toCodexThreadGoal(sessionId, current.goal, current.state);
    if (!mapped || mapped.status !== "active") {
      return { goal: mapped, sessionId };
    }

    return new Promise<CodexThreadGoalResponse>((resolve, reject) => {
      const watcher: GoalWatcher = {
        abortSignal: input.abortSignal,
        onEngineEvent: input.onEngineEvent,
        onApprovalRequest: input.onApprovalRequest,
        resolve,
        reject,
        settled: false,
      };
      worker.goalWatcher = watcher;
      const onAbort = () => {
        if (watcher.settled) return;
        watcher.settled = true;
        if (worker.goalWatcher === watcher) worker.goalWatcher = undefined;
        void worker.client.abort().catch(() => undefined);
        void worker.client.goal("pause").then(
          res => resolve({ goal: toCodexThreadGoal(sessionId, res.goal, res.state), sessionId }),
          () => resolve({ goal: { ...mapped, status: "paused" }, sessionId }),
        );
      };
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const origResolve = watcher.resolve;
      const origReject = watcher.reject;
      watcher.resolve = (res) => { input.abortSignal?.removeEventListener("abort", onAbort); origResolve(res); };
      watcher.reject = (err) => { input.abortSignal?.removeEventListener("abort", onAbort); origReject(err); };
    });
  }

  async clearThreadGoal(sessionId: string, input: { workspaceOverride?: string; isCurrentSession?: () => boolean | Promise<boolean> } = {}): Promise<{ cleared: boolean; sessionId?: string }> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) return { cleared: false, sessionId };
    if (input.isCurrentSession && !await input.isCurrentSession()) return { cleared: false, sessionId };
    await worker.client.goal("drop");
    worker.lastGoal = null;
    if (worker.goalWatcher && !worker.goalWatcher.settled) {
      const watcher = worker.goalWatcher;
      watcher.settled = true;
      worker.goalWatcher = undefined;
      watcher.resolve({ goal: null, sessionId });
    }
    return { cleared: true, sessionId };
  }

  private handleGoalUpdated(worker: OmpWorker, frame: OmpGoalUpdatedFrame): void {
    worker.lastGoal = frame.goal ?? null;
    const watcher = worker.goalWatcher;
    if (!watcher || watcher.settled) return;
    const mapped = toCodexThreadGoal(worker.sessionKey, frame.goal, frame.state);
    if (!mapped || mapped.status !== "active") {
      watcher.settled = true;
      worker.goalWatcher = undefined;
      watcher.resolve({ goal: mapped, sessionId: worker.sessionKey });
    }
  }

  /** External session scanning & validation (aligned with Claude/Pi/DeepSeek). */
  async listExternalSessions(input: { cwd?: string; limit?: number } = {}): Promise<ExternalSessionInfo[]> {
    const root = path.join(this.options.stateDir, "omp", "sessions");
    const limit = input.limit ?? 20;
    const results: Array<ExternalSessionInfo & { mtimeMs: number }> = [];
    try {
      const dirs = await readdir(root, { withFileTypes: true });
      for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(root, entry.name);
        const files = await readdir(dirPath).catch(() => [] as string[]);
        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const full = path.join(dirPath, file);
          const st = await stat(full).catch(() => null);
          if (!st || !st.isFile()) continue;
          const id = path.basename(file, ".jsonl");
          this.sessionPaths.set(id, full);
          results.push({
            sessionId: id,
            cwd: input.cwd || this.options.workspacePath,
            title: entry.name,
            updatedAt: st.mtime.toISOString(),
            mtimeMs: st.mtimeMs,
          });
        }
      }
    } catch {
      return [];
    }
    return results
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map(({ mtimeMs: _m, ...rest }) => rest);
  }

  async validateExternalSession(sessionId: string, input: { workspaceOverride?: string } = {}): Promise<ExternalSessionInfo | void> {
    const existing = this.sessionPaths.get(sessionId);
    if (existing) {
      const st = await stat(existing).catch(() => null);
      if (st?.isFile()) {
        return { sessionId, cwd: input.workspaceOverride || this.options.workspacePath, updatedAt: st.mtime.toISOString() };
      }
    }
    const listed = await this.listExternalSessions({ cwd: input.workspaceOverride, limit: 100 });
    const match = listed.find(s => s.sessionId === sessionId);
    if (!match) throw new Error(`omp session not found: ${sessionId}`);
    return match;
  }

  async listTasks(sessionId: string): Promise<EngineTaskSnapshot> {
    const worker = this.workers.get(sessionId);
    if (!worker) return { supported: true, tasks: [] };
    if (worker.client.alive && worker.subagents.size === 0) {
      const snap = await worker.client.command<{ subagents?: Array<{ subagentId: string; status: string; label?: string; task?: string }> }>({ type: "get_subagents" }, 1500)
        .then(r => r.data ?? {})
        .catch(() => ({ subagents: undefined }));
      for (const item of snap.subagents ?? []) {
        const rec = this.ensureSubagent(worker, item.subagentId, item.label || item.task);
        rec.status = item.status === "completed" ? "done" : item.status === "failed" ? "error" : item.status === "aborted" ? "stopped" : "running";
      }
    }
    const tasks: EngineTask[] = [...worker.subagents.values()].map((sub) => ({
      id: sub.subagentId,
      label: sub.label,
      kind: "subagent",
      mode: "background",
      status: sub.status,
      canStop: sub.status === "running",
      startedAt: sub.startedAt,
      updatedAt: sub.updatedAt,
      ...(sub.progress ? { progress: sub.progress } : {}),
    }));
    return { supported: true, tasks };
  }

  async stopTask(sessionId: string, input: { taskId: string }): Promise<EngineTaskControlResult> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) return { outcome: "rejected", reason: "not_ready" };
    const res = await worker.client.cancelSubagent(input.taskId);
    return res?.cancelled ? { outcome: "accepted" } : { outcome: "rejected", reason: "stale" };
  }

  async getContextUsage(sessionId: string, input: { workspaceOverride?: string; passive?: boolean } = {}): Promise<EngineContextUsage | null> {
    const worker = this.workers.get(sessionId);
    if (!worker || !worker.client.alive) return null;
    if (input.passive) {
      const cached = worker.state.contextUsage;
      if (!cached || cached.tokens === null || !cached.contextWindow) return null;
      return { pressureTokens: cached.tokens, contextWindow: cached.contextWindow };
    }
    try {
      const stats = await worker.client.command<{ contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } }>({ type: "get_session_stats" });
      const ctx = stats.data?.contextUsage;
      if (ctx) worker.state.contextUsage = ctx;
      if (!ctx || ctx.tokens === null || !ctx.contextWindow) return null;
      return { pressureTokens: ctx.tokens, contextWindow: ctx.contextWindow };
    } catch {
      return null;
    }
  }

  /** OMP supports multiple BYOK/OAuth providers and does not expose a native quota RPC command. */
  async getAccountQuota(): Promise<EngineQuotaReadResult> {
    return {
      revision: "omp-unsupported",
      snapshot: {
        authMode: "unknown",
        capability: { mode: "unsupported", reason: "not_adapted" },
        state: "unsupported",
        reason: "not_adapted",
        availability: "unknown",
        pools: [],
        constraints: [],
      },
    };
  }

  private currentEventEmitter(worker: OmpWorker): ((event: EngineStreamEvent) => void | Promise<void>) | undefined {
    if (worker.activeTurn && !worker.activeTurn.settled) return worker.activeTurn.input.onEngineEvent;
    if (worker.goalWatcher && !worker.goalWatcher.settled) return worker.goalWatcher.onEngineEvent;
    return undefined;
  }

  private handleEvent(worker: OmpWorker, event: OmpSessionEvent): void {
    const turn = worker.activeTurn && !worker.activeTurn.settled ? worker.activeTurn : undefined;
    const emit = this.currentEventEmitter(worker);
    if (!emit && !turn) return;

    if (event.type === "message_update" && event.assistantMessageEvent && typeof event.assistantMessageEvent === "object") {
      const sub = event.assistantMessageEvent as { type?: unknown; delta?: unknown };
      if (sub.type === "text_delta" && typeof sub.delta === "string") {
        turn?.textChunks.push(sub.delta);
        void emit?.({ type: "assistant_text", text: sub.delta, delta: true });
      } else if (sub.type === "thinking_delta" && typeof sub.delta === "string") {
        turn?.thinkingChunks.push(sub.delta);
        void emit?.({ type: "thinking", text: sub.delta, delta: true });
      }
      return;
    }
    if (event.type === "message_end" && event.message && (event.message as { role?: unknown }).role === "assistant") {
      const text = extractAssistantText(event.message);
      if (turn && text) turn.finalText = text;
      const usage = extractMessageUsage(event.message);
      if (turn && usage) {
        turn.usage.hasData = true;
        turn.usage.inputTokens += usage.inputTokens;
        turn.usage.outputTokens += usage.outputTokens;
        turn.usage.cachedTokens += usage.cachedTokens ?? 0;
        turn.usage.costUsd += usage.costUsd ?? 0;
      }
      return;
    }
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
      void emit?.({
        type: "tool_use",
        toolName: event.toolName,
        toolInput: event.args,
        ...(typeof event.toolCallId === "string" ? { toolUseId: event.toolCallId } : {}),
      });
      return;
    }
    if (event.type === "tool_stream_update" && typeof event.toolCallId === "string" && typeof event.delta === "string") {
      void emit?.({ type: "tool_progress", toolUseId: event.toolCallId, text: event.delta, delta: true });
      return;
    }
    if (event.type === "tool_execution_end") {
      const output = typeof event.result === "string" ? event.result : event.result ? JSON.stringify(event.result).slice(0, 4000) : undefined;
      void emit?.({
        type: "tool_result",
        ...(typeof event.toolCallId === "string" ? { toolUseId: event.toolCallId } : {}),
        ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        ...(output !== undefined ? { output } : {}),
        isError: event.isError === true,
      });
      return;
    }
    if (event.type === "command_output") {
      const out = (typeof event.text === "string" ? event.text : typeof event.output === "string" ? event.output : "").trim();
      if (out) {
        turn?.commandOutputs.push(out);
        void emit?.({ type: "assistant_text", text: out, delta: false });
      }
      return;
    }
    if (event.type === "manual_compaction_start" || event.type === "auto_compaction_start") {
      void emit?.({ type: "context_compaction", id: randomUUID(), status: "started" });
      return;
    }
    if (event.type === "manual_compaction_end" || event.type === "auto_compaction_end") {
      void emit?.({ type: "context_compaction", id: randomUUID(), status: event.aborted ? "failed" : "completed" });
      return;
    }
    if (event.type === "auto_retry_start") {
      const msg = String(event.errorMessage ?? "").toLowerCase();
      const reason = msg.includes("429") || msg.includes("rate") ? "rate-limit" : msg.includes("503") || msg.includes("overload") ? "capacity" : "connection";
      void emit?.({
        type: "engine_retry",
        status: "waiting",
        attempt: typeof event.attempt === "number" ? event.attempt : 1,
        reason,
        delayMs: typeof event.delayMs === "number" ? event.delayMs : 1000,
      });
      return;
    }
    if (event.type === "auto_retry_end") {
      void emit?.({
        type: "engine_retry",
        status: event.success ? "resumed" : "failed",
        attempt: typeof event.attempt === "number" ? event.attempt : 1,
        reason: "connection",
        delayMs: 0,
      });
    }
  }

  private handlePromptResult(worker: OmpWorker, frame: OmpPromptResultFrame): void {
    const turn = worker.activeTurn;
    if (!turn || turn.settled) return;
    // Ignore prompt_result frames for other prompt IDs (eliminates Pi's M1 cross-turn bug).
    if (turn.promptId && frame.id && frame.id !== turn.promptId) return;
    turn.promptResult = frame;
    this.maybeCompleteTurn(worker, turn);
  }

  private handleSessionSettled(worker: OmpWorker): void {
    const turn = worker.activeTurn;
    if (!turn || turn.settled) return;
    if (turn.promptResult) {
      this.finalizeTurn(worker, turn, turn.promptResult);
    }
  }

  private maybeCompleteTurn(worker: OmpWorker, turn: ActiveOmpTurn): void {
    const res = turn.promptResult;
    if (!res || turn.settled) return;
    if (res.sessionSettled || res.status === "aborted" || res.status === "error") {
      this.finalizeTurn(worker, turn, res);
    }
  }

  private finalizeTurn(worker: OmpWorker, turn: ActiveOmpTurn, res: OmpPromptResultFrame): void {
    if (turn.settled) return;
    turn.settled = true;
    worker.activeTurn = undefined;
    const usage = this.turnUsage(turn);
    if (res.status === "aborted") {
      turn.reject(withFailedTurnUsage(new Error("Turn aborted"), usage));
      return;
    }
    if (res.status === "error") {
      const code = res.error?.code ? ` (${res.error.code})` : "";
      turn.reject(withFailedTurnUsage(new Error(`${res.error?.message || "omp turn failed"}${code}`), usage));
      return;
    }
    const text = (turn.finalText ?? turn.textChunks.join("") ?? turn.commandOutputs.join("\n")).trim();

    // Best-effort refresh of durable history anchor and cached context usage after turn settles.
    const finalizeAsync = async () => {
      try {
        if (worker.client.alive) {
          const [state, entriesRes] = await Promise.all([
            worker.client.command<OmpSessionState>({ type: "get_state" }, 1500).then(r => r.data).catch(() => worker.state),
            worker.client.command<{ entries: OmpSessionEntry[]; leafId: string | null }>({ type: "get_entries" }, 1500).then(r => r.data).catch(() => null),
          ]);
          worker.state = state;
          if (state.sessionFile) this.sessionPaths.set(worker.sessionKey, state.sessionFile);
          if (entriesRes?.leafId && turn.input.onEngineEvent) {
            const branch = activeEntryBranch(entriesRes.entries, entriesRes.leafId);
            const lastUser = [...branch].reverse().find(isUserMessageEntry);
            if (lastUser) {
              await turn.input.onEngineEvent({
                type: "history_anchor",
                anchor: {
                  sessionId: worker.sessionKey,
                  inputId: lastUser.id,
                  rewind: true,
                  fork: true,
                  forkBoundary: "after-turn",
                },
              });
            }
          }
        }
      } catch {
        // Non-fatal metadata refresh.
      }
      turn.resolve({ sessionId: worker.sessionKey, text, ...(usage ? { usage } : {}) });
    };
    void finalizeAsync();
  }

  private ensureSubagent(worker: OmpWorker, subagentId: string, label?: string): SubagentRecord {
    let rec = worker.subagents.get(subagentId);
    if (!rec) {
      const now = Date.now();
      rec = {
        subagentId,
        scope: { id: `omp_sub_${subagentId}`, kind: "subagent", label: label || subagentId },
        label: label || subagentId,
        status: "running",
        startedAt: now,
        updatedAt: now,
      };
      worker.subagents.set(subagentId, rec);
    } else if (label && rec.label === subagentId) {
      rec.label = label;
      rec.scope = { ...rec.scope, label };
    }
    return rec;
  }

  private handleSubagentLifecycle(worker: OmpWorker, frame: OmpSubagentLifecycleFrame): void {
    const rec = this.ensureSubagent(worker, frame.subagentId, frame.label || frame.task);
    rec.updatedAt = Date.now();
    rec.status = frame.status === "completed" ? "done" : frame.status === "failed" ? "error" : frame.status === "aborted" ? "stopped" : "running";
    const emit = this.currentEventEmitter(worker);
    if (emit) {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "scope_status", status: rec.status },
      });
    }
  }

  private handleSubagentProgress(worker: OmpWorker, frame: OmpSubagentProgressFrame): void {
    const rec = this.ensureSubagent(worker, frame.subagentId, frame.label);
    rec.updatedAt = Date.now();
    const detail = frame.text || frame.progress || (frame.toolName ? `Running ${frame.toolName}` : undefined);
    if (detail) rec.progress = detail;
    const emit = this.currentEventEmitter(worker);
    if (emit && detail) {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "assistant_text", text: detail, delta: false },
      });
    }
  }

  private handleSubagentEvent(worker: OmpWorker, frame: OmpSubagentEventFrame): void {
    const rec = this.ensureSubagent(worker, frame.subagentId);
    rec.updatedAt = Date.now();
    const emit = this.currentEventEmitter(worker);
    if (!emit) return;
    const ev = frame.event;
    if (ev.type === "tool_execution_start" && typeof ev.toolName === "string") {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "tool_use", toolName: ev.toolName, toolInput: ev.args, ...(typeof ev.toolCallId === "string" ? { toolUseId: ev.toolCallId } : {}) },
      });
    } else if (ev.type === "tool_execution_end") {
      void emit({
        type: "scoped",
        scope: rec.scope,
        origin: "bound",
        taskId: rec.subagentId,
        event: { type: "tool_result", ...(typeof ev.toolCallId === "string" ? { toolUseId: ev.toolCallId } : {}), isError: ev.isError === true },
      });
    }
  }

  private handleBtwRecord(worker: OmpWorker, record: OmpBtwRecord): void {
    const latest = record.followUps?.at(-1) ?? record;
    if (latest.status !== "running") {
      worker.completedBtw.set(record.id, record);
      if (worker.completedBtw.size > 32) worker.completedBtw.delete(worker.completedBtw.keys().next().value!);
    }
    const waiter = worker.activeBtw.get(record.id);
    if (!waiter) return;
    if (latest.status === "complete") {
      worker.activeBtw.delete(record.id);
      worker.completedBtw.delete(record.id);
      waiter.resolve(record);
    } else if (latest.status === "cancelled" || latest.status === "error" || latest.status === "interrupted") {
      worker.activeBtw.delete(record.id);
      worker.completedBtw.delete(record.id);
      waiter.reject(new Error(latest.error || `Side question ${latest.status}`));
    }
  }

  private async handleExtensionUi(worker: OmpWorker, req: OmpExtensionUiRequest): Promise<void> {
    // Fire-and-forget presentation frames need no response.
    if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url", "cancel"].includes(req.method)) {
      return;
    }
    const onApproval = worker.activeTurn && !worker.activeTurn.settled
      ? worker.activeTurn.input.onApprovalRequest
      : worker.goalWatcher && !worker.goalWatcher.settled
        ? worker.goalWatcher.onApprovalRequest
        : undefined;
    if (!onApproval) {
      worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
      return;
    }
    if (req.method === "confirm") {
      try {
        const decision = await onApproval({
          engine: "omp",
          toolName: req.title || "omp_confirm",
          toolInput: { message: req.message || "" },
          sessionId: worker.sessionKey,
        });
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, confirmed: decision.behavior === "allow" });
        return;
      } catch {
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
        return;
      }
    }
    if (req.method === "ask" && Array.isArray(req.questions) && req.questions.length > 0) {
      try {
        const mappedQuestions = req.questions.map((q) => ({
          header: q.header || q.id,
          question: q.question,
          multiSelect: Boolean(q.multi),
          options: q.options.map(opt => ({ label: opt.label, ...(opt.description ? { description: opt.description } : {}) })),
        }));
        const decision = await onApproval({
          engine: "omp",
          toolName: "AskUserQuestion",
          toolInput: { questions: mappedQuestions },
          sessionId: worker.sessionKey,
        });
        if (decision.behavior !== "allow") {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
          return;
        }
        const { answers, selections } = extractAskResponseSelections(decision.updatedInput);
        const wireAnswers = req.questions.map((q) => {
          const sel = selections?.[q.question];
          if (sel) {
            return { id: q.id, selectedOptions: sel.selectedOptions, ...(sel.customInput ? { customInput: sel.customInput } : {}) };
          }
          const raw = (answers[q.question] ?? "").trim();
          const optionLabels = new Set(q.options.map(o => o.label));
          if (q.multi && raw) {
            const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
            const selectedOptions = parts.filter(p => optionLabels.has(p));
            const custom = parts.filter(p => !optionLabels.has(p)).join(", ");
            return { id: q.id, selectedOptions, ...(custom ? { customInput: custom } : {}) };
          }
          if (raw && optionLabels.has(raw)) {
            return { id: q.id, selectedOptions: [raw] };
          }
          return { id: q.id, selectedOptions: [], ...(raw ? { customInput: raw } : {}) };
        });
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, answers: wireAnswers });
        return;
      } catch {
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
        return;
      }
    }
    if (req.method === "select" && Array.isArray(req.options) && req.options.length > 0) {
      try {
        const question = req.title || req.message || "Choose an option";
        const decision = await onApproval({
          engine: "omp",
          toolName: "AskUserQuestion",
          toolInput: {
            questions: [{
              header: req.title || "Select",
              question,
              multiSelect: false,
              options: req.options.map((label, idx) => ({
                label,
                ...(req.optionDetails?.[idx]?.description ? { description: req.optionDetails[idx].description } : {}),
              })),
            }],
          },
          sessionId: worker.sessionKey,
        });
        if (decision.behavior !== "allow") {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
          return;
        }
        const { answers } = extractAskResponseSelections(decision.updatedInput);
        const chosen = answers[question]?.trim();
        if (chosen) {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, value: chosen });
        } else {
          worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
        }
        return;
      } catch {
        worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
        return;
      }
    }
    // Unsupported raw HTML form or unattached interactive dialog: cancel explicitly so omp never hangs.
    worker.client.sendExtensionUiResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map(w => w.client.close().catch(() => undefined)));
  }
}
