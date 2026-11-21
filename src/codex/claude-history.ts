import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { NativeHistoryAnchor, NativeHistoryRejection, NativeHistoryResult, NativeHistoryState } from "./adapter.js";

/**
 * Claude's native history, through the session helper.
 *
 * The helper is a separate program built from Anthropic's own SDK
 * (`getSessionMessages`, `forkSession`). It is run once per request, with the
 * Bot's Claude environment, and answers one JSON record. This module is its
 * client: it never reads or writes a transcript itself.
 *
 * A fork copies messages into a new session file and gives every message a new
 * uuid. No model is involved. There is no rewind here: the SDK cuts context
 * only as part of the next query (`resumeSessionAt`), and `rewindFiles`
 * restores files, not context.
 */

export interface ClaudeHistoryRequest {
  v: 1;
  operation: "inspect" | "fork";
  sessionId: string;
  workspace: string;
  /** Fork only: the last message to keep, inclusive. */
  upToMessageId?: string;
  /** Fork only: the helper refuses, before writing, when the session's head is not this. */
  expectedHead?: string;
}

/** One transcript message on the session's chain. The helper also lists system messages (compaction boundaries, notices). */
export interface ClaudeHistoryMessage { uuid: string; type: "user" | "assistant" | "system" }

export type ClaudeHistoryReply =
  | { v: 1; ok: true; sessionId: string; messages?: ClaudeHistoryMessage[]; head?: string }
  | { v: 1; ok: false; phase: "validate" | "inspect" | "fork"; error: { code: string; message: string } };

/** What running the helper once came to. */
export type ClaudeHistoryHelperOutcome =
  | { kind: "reply"; reply: ClaudeHistoryReply }
  /** It could not be started: nothing was read and nothing was written. */
  | { kind: "not-started"; detail: string }
  /** It was started and gave no usable answer. Whatever it was asked to do may have happened. */
  | { kind: "lost"; detail: string };

export type ClaudeHistoryHelper = (request: ClaudeHistoryRequest, context: { env: NodeJS.ProcessEnv; signal?: AbortSignal }) => Promise<ClaudeHistoryHelperOutcome>;

/** The helper's limit: a longer session is refused there, never cut short. */
const MAX_MESSAGES = 10_000;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 60_000;
/** How long a killed helper is waited for before its caller is released without it. */
const HELPER_KILL_WAIT_MS = 10_000;

/** The built helper next to this module, when the build produced one. */
export function resolveClaudeHistoryHelperPath(): string | undefined {
  const compiled = fileURLToPath(new URL("./claude-history-native-helper.js", import.meta.url));
  return existsSync(compiled) ? compiled : undefined;
}

/** A strict reading of the helper's one record; anything else is not an answer. */
export function parseClaudeHistoryReply(text: string): ClaudeHistoryReply | undefined {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (record.ok === false) {
    const error = record.error as { code?: unknown; message?: unknown } | undefined;
    if (record.phase !== "validate" && record.phase !== "inspect" && record.phase !== "fork") return undefined;
    if (!error || typeof error.code !== "string" || typeof error.message !== "string") return undefined;
    return { v: 1, ok: false, phase: record.phase, error: { code: error.code, message: error.message } };
  }
  if (record.ok !== true || typeof record.sessionId !== "string" || !record.sessionId) return undefined;
  const reply: ClaudeHistoryReply = { v: 1, ok: true, sessionId: record.sessionId };
  if (record.messages !== undefined) {
    if (!Array.isArray(record.messages) || record.messages.length > MAX_MESSAGES) return undefined;
    const messages: ClaudeHistoryMessage[] = [];
    for (const item of record.messages as Array<{ uuid?: unknown; type?: unknown } | null>) {
      if (typeof item?.uuid !== "string" || !item.uuid || (item.type !== "user" && item.type !== "assistant" && item.type !== "system")) return undefined;
      messages.push({ uuid: item.uuid, type: item.type });
    }
    reply.messages = messages;
  }
  if (record.head !== undefined) {
    if (typeof record.head !== "string" || !record.head) return undefined;
    reply.head = record.head;
  }
  return reply;
}

/** Runs the built helper as its own process: one request on stdin, one record on stdout. */
export function spawnClaudeHistoryHelper(helperPath: string, options: { timeoutMs?: number; spawnFn?: typeof spawn } = {}): ClaudeHistoryHelper {
  return (request, context) => new Promise(resolve => {
    if (context.signal?.aborted) { resolve({ kind: "not-started", detail: "cancelled" }); return; }
    let child: ChildProcess;
    try {
      child = (options.spawnFn ?? spawn)(process.execPath, [helperPath], { env: context.env, cwd: request.workspace, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ kind: "not-started", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    let started = false, settled = false, stdout = "", bytes = 0;
    /** Why the process was killed. Once set, its answer no longer counts and the outcome waits for it to be gone. */
    let stopped: string | undefined;
    let lastResort: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ClaudeHistoryHelperOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (lastResort) clearTimeout(lastResort);
      context.signal?.removeEventListener("abort", abort);
      resolve(outcome);
    };
    // Killing is asked for here; the process is gone only when `close` says so, and the outcome is given then.
    const stop = (detail: string) => {
      if (stopped !== undefined || settled) return;
      stopped = detail;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      // A process that cannot even be killed must not hold its caller for ever. Nothing is claimed about it.
      lastResort = setTimeout(() => finish({ kind: "lost", detail: `${detail}; the helper process did not end` }), HELPER_KILL_WAIT_MS);
      lastResort.unref?.();
    };
    const abort = () => stop("cancelled while the helper was running");
    const timer = setTimeout(() => stop(`Claude history helper gave no answer within ${Math.round((options.timeoutMs ?? HELPER_TIMEOUT_MS) / 1000)} seconds`), options.timeoutMs ?? HELPER_TIMEOUT_MS);
    timer.unref?.();
    context.signal?.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => { started = true; });
    // Before it ran, an error means it never did anything. After that, nothing is known.
    child.once("error", error => { if (!started) finish({ kind: "not-started", detail: error.message }); else if (stopped === undefined) stop(error.message); });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REPLY_BYTES) { stop("Claude history helper answered with more than it may"); return; }
      if (stopped === undefined) stdout += chunk;
    });
    child.stderr?.resume();
    child.once("close", code => {
      if (stopped !== undefined) { finish({ kind: "lost", detail: stopped }); return; }
      const reply = parseClaudeHistoryReply(stdout);
      finish(reply ? { kind: "reply", reply } : { kind: "lost", detail: `Claude history helper ended with code ${code ?? "none"} and no usable answer` });
    });
    child.stdin?.on("error", () => { /* The close handler reports what the helper said, if anything. */ });
    child.stdin?.end(`${JSON.stringify(request)}\n`);
  });
}

/**
 * The helper's refusal codes that have a meaning of their own; any other
 * refusal is "not now". `session_unreadable` is deliberately among the others:
 * the helper uses it both for a session that is not there and for one it could
 * not read, and only the first is "missing".
 */
function refusal(code: string): NativeHistoryRejection {
  switch (code) {
    case "session_missing": case "source_missing": return "source_missing";
    case "source_changed": return "source_changed";
    case "anchor_missing": case "anchor_unavailable": return "anchor_unavailable";
    case "unsupported": return "unsupported";
    default: return "not_ready";
  }
}

/** Messages of the conversation itself. A fork is checked by these: system entries are not all copied. */
function conversationLength(messages: ClaudeHistoryMessage[]): number {
  return messages.filter(message => message.type !== "system").length;
}

/**
 * The Bot log (Gateway stderr) is the only place a helper failure is seen:
 * the App and its receipts get a reason, never the helper's code. Opaque
 * values only; no message text or titles.
 */
function logHelper(operation: "inspect" | "fork", sessionId: string, outcome: ClaudeHistoryHelperOutcome): void {
  let what: string;
  if (outcome.kind === "not-started") what = `could not start (${outcome.detail})`;
  else if (outcome.kind === "lost") what = `gave no answer (${outcome.detail})`;
  else if (!outcome.reply.ok) what = `refused at ${outcome.reply.phase}: ${outcome.reply.error.code}`;
  else return;
  console.warn(`[${new Date().toISOString()}] Claude history helper ${operation} of session ${sessionId.slice(0, 8)} ${what}`);
}

type Blocked = NonNullable<NativeHistoryState["blocked"]>;
type Inspected = { messages: ClaudeHistoryMessage[]; head: string } | { rejected: NativeHistoryRejection; detail: string } | { lost: string };

async function inspect(helper: ClaudeHistoryHelper, env: NodeJS.ProcessEnv, sessionId: string, workspace: string, signal?: AbortSignal): Promise<Inspected> {
  const outcome = await helper({ v: 1, operation: "inspect", sessionId, workspace }, { env, ...(signal ? { signal } : {}) });
  logHelper("inspect", sessionId, outcome);
  if (outcome.kind === "not-started") return { rejected: "not_ready", detail: outcome.detail };
  if (outcome.kind === "lost") return { lost: outcome.detail };
  const reply = outcome.reply;
  // An inspection writes nothing, so any refusal of it is a refusal.
  if (!reply.ok) return { rejected: refusal(reply.error.code), detail: reply.error.message };
  if (reply.sessionId !== sessionId || !reply.messages || !reply.head) return { lost: "Claude history helper answered an inspection without the session's messages" };
  return { messages: reply.messages, head: reply.head };
}

/** One signal that fires when either does. */
function either(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  return first && second ? AbortSignal.any([first, second]) : first ?? second;
}

/** What the session can do now. Reads only; ends when its caller gives up or its owner ends. */
export async function claudeHistoryState(input: {
  helper: ClaudeHistoryHelper; env: NodeJS.ProcessEnv; sessionId: string; workspace: string; blocked: () => Blocked | undefined;
  signal?: AbortSignal; lifetime?: AbortSignal;
}): Promise<NativeHistoryState> {
  const seen = await inspect(input.helper, input.env, input.sessionId, input.workspace, either(input.signal, input.lifetime));
  if ("lost" in seen) return { head: null, blocked: "not_ready" };
  if ("rejected" in seen) return seen.rejected === "unsupported" ? { head: null } : { head: null, blocked: seen.rejected === "source_missing" ? "source_missing" : "not_ready" };
  const blocked = input.blocked();
  return { fork: { whole: conversationLength(seen.messages) > 0, anchored: true }, head: seen.head, ...(blocked ? { blocked } : {}) };
}

/** The message a fork at this anchor ends with, when the anchor is one this module could have made. */
function anchorEnd(anchor: NativeHistoryAnchor): string | undefined {
  const end = anchor.data?.lastMessageId;
  return anchor.fork && anchor.forkBoundary === "after-turn" && typeof end === "string" && end ? end : undefined;
}

/**
 * Forks the whole session, or through the turn an anchor names. The source is
 * only read. `applied` is returned once the new session has been read back
 * with the number of messages it must have.
 */
export async function claudeForkHistory(input: {
  helper: ClaudeHistoryHelper; env: NodeJS.ProcessEnv; sessionId: string; workspace: string; blocked: () => Blocked | undefined;
  anchor?: NativeHistoryAnchor; expectedHead?: string | null;
  /** The caller's own cancellation. It counts only until the fork is asked for. */
  signal?: AbortSignal;
  /** Ends with whoever owns this call (the adapter). It stops every helper run, the fork included: a fork cut short is unknown, never repeated. */
  lifetime?: AbortSignal;
}): Promise<NativeHistoryResult> {
  const rejected = (reason: NativeHistoryRejection, detail?: string): NativeHistoryResult => ({ outcome: "rejected", reason, ...(detail ? { detail } : {}) });
  const { helper, env, sessionId, workspace, anchor } = input;
  if (input.signal?.aborted) return rejected("cancelled");
  const end = anchor ? anchorEnd(anchor) : undefined;
  if (anchor && !end) return rejected("anchor_unavailable", "The anchor does not allow this operation");
  if (anchor && anchor.sessionId !== sessionId) return rejected("anchor_unavailable", "The anchor belongs to another session");
  const busy = input.blocked();
  if (busy) return rejected(busy);

  const reading = either(input.signal, input.lifetime);
  const seen = await inspect(helper, env, sessionId, workspace, reading);
  // Nothing has been asked to change yet: a lost inspection is only "not now".
  if (input.signal?.aborted) return rejected("cancelled");
  if ("lost" in seen) return rejected("not_ready", seen.lost);
  if ("rejected" in seen) return rejected(seen.rejected, seen.detail);
  if (input.expectedHead !== undefined && input.expectedHead !== seen.head) return rejected("source_changed");
  let kept = conversationLength(seen.messages);
  if (anchor) {
    // Both ends of the turn must still be on the session's own chain, in order.
    const from = seen.messages.findIndex(message => message.uuid === anchor.inputId && message.type === "user");
    const to = seen.messages.findIndex(message => message.uuid === end && message.type === "assistant");
    if (from < 0 || to <= from) return rejected("anchor_unavailable", "The anchor is no longer in this session's history");
    kept = conversationLength(seen.messages.slice(0, to + 1));
  } else if (kept === 0) {
    return rejected("not_ready", "There is no history to fork yet");
  }
  if (input.signal?.aborted) return rejected("cancelled");
  const stillBusy = input.blocked();
  if (stillBusy) return rejected(stillBusy);

  // Never repeated and never cancelled once started: a fork that was asked for may exist.
  const outcome = await helper({ v: 1, operation: "fork", sessionId, workspace, expectedHead: seen.head, ...(end ? { upToMessageId: end } : {}) },
    { env, ...(input.lifetime ? { signal: input.lifetime } : {}) });
  logHelper("fork", sessionId, outcome);
  if (outcome.kind === "not-started") return rejected("not_ready", outcome.detail);
  if (outcome.kind === "lost") return { outcome: "unknown", detail: outcome.detail };
  const reply = outcome.reply;
  if (!reply.ok) {
    // The helper validates again before it calls the SDK. Only what it reports from there on may have written.
    return reply.phase === "fork" ? { outcome: "unknown", detail: reply.error.message } : rejected(refusal(reply.error.code), reply.error.message);
  }
  const forked = reply.sessionId;
  if (forked === sessionId) return { outcome: "unknown", detail: "Claude history helper did not return a distinct session for the fork" };

  // The fork exists. Read it back; a failure from here on never means "nothing happened".
  const copy = await inspect(helper, env, forked, workspace, input.lifetime);
  if ("lost" in copy) return { outcome: "unknown", detail: copy.lost, candidateSessionId: forked };
  if ("rejected" in copy) return { outcome: "unknown", detail: copy.detail, candidateSessionId: forked };
  if (conversationLength(copy.messages) !== kept) {
    return { outcome: "unknown", detail: `The fork holds ${conversationLength(copy.messages)} messages, not ${kept}`, candidateSessionId: forked };
  }
  return { outcome: "applied", sessionId: forked, head: copy.head, boundary: anchor ? "after-turn" : "whole" };
}
