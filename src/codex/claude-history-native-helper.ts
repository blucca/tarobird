// This entry is bundled at build time. The installed host does not require the
// SDK, its peer dependencies, or another Claude executable.
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { forkSession, getSessionInfo, getSessionMessages, importSessionToStore, type SessionStore } from "@anthropic-ai/claude-agent-sdk";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 10_000;
const MAX_REQUEST_BYTES = 64 * 1024;
/** Stored records read when the SDK has no summary for a session; more is refused, never cut short. */
const MAX_STORED_ENTRIES = 500_000;
type Phase = "validate" | "inspect" | "fork";
type Request = { v: 1; operation: "inspect" | "fork"; sessionId: string; workspace: string; upToMessageId?: string; expectedHead?: string };
type SessionSdk = Pick<typeof import("@anthropic-ai/claude-agent-sdk"), "forkSession" | "getSessionInfo" | "getSessionMessages" | "importSessionToStore">;
const nativeSdk: SessionSdk = { forkSession, getSessionInfo, getSessionMessages, importSessionToStore };

class HistoryFailure extends Error {
  constructor(readonly code: string, readonly phase: Phase = "validate") { super(code); }
}
function request(value: unknown): Request {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryFailure("invalid_request");
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || !["inspect", "fork"].includes(String(r.operation)) || typeof r.sessionId !== "string" || !UUID.test(r.sessionId)
    || typeof r.workspace !== "string" || !path.isAbsolute(r.workspace) || r.workspace.includes("\0")
    || Object.keys(r).some(key => !["v", "operation", "sessionId", "workspace", "upToMessageId", "expectedHead"].includes(key))
    || r.upToMessageId !== undefined && (typeof r.upToMessageId !== "string" || !UUID.test(r.upToMessageId))
    || r.expectedHead !== undefined && (typeof r.expectedHead !== "string" || !/^[a-f0-9]{64}$/.test(r.expectedHead))
    || r.operation === "inspect" && (r.upToMessageId !== undefined || r.expectedHead !== undefined)) throw new HistoryFailure("invalid_request");
  return r as Request;
}
async function physicalWorkspace(directory: string): Promise<string> {
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory()) throw new HistoryFailure("workspace_unavailable");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** What a session's records say about where it belongs, and a stamp that changes whenever they change. */
type SessionFacts = { cwd: string; stamp: string };

/**
 * The session's own stored records, read through the SDK's exported
 * `importSessionToStore`: the same file lookup the SDK uses for
 * `getSessionMessages` and `forkSession`, into a store that only digests.
 *
 * `getSessionInfo` answers undefined for a session it cannot title (no custom
 * or AI title, no `lastPrompt`, and a first prompt that begins with a tag).
 * Claude Code in `-p` stream-json mode writes no `lastPrompt`, and every
 * TaroBird prompt begins with an instruction tag, so App-created sessions are
 * of that kind. They are still ordinary sessions: their messages read and fork
 * normally. Only the facts `getSessionInfo` would have given are taken here.
 */
async function storedFacts(sessionId: string, workspace: string, sdk: SessionSdk): Promise<SessionFacts> {
  const digest = createHash("sha256");
  let entries = 0, foreign = false, sidechain = false, cwd: string | undefined, relocated: string | undefined;
  const store: SessionStore = {
    async append(key, batch) {
      if (key.sessionId !== sessionId || key.subpath !== undefined) { foreign = true; return; }
      for (const entry of batch) {
        if (++entries > MAX_STORED_ENTRIES) throw new HistoryFailure("history_too_large", "inspect");
        digest.update(JSON.stringify(entry)).update("\n");
        const record = entry as Record<string, unknown>;
        // The SDK's own rule: a file whose first record is a sidechain is not a session.
        if (entries === 1 && record.isSidechain === true) sidechain = true;
        if (typeof record.sessionId === "string" && record.sessionId !== sessionId) foreign = true;
        // Same order as the SDK's session metadata: a relocation wins over the recorded cwd.
        if (record.type === "relocated" && typeof record.relocatedCwd === "string") relocated = record.relocatedCwd;
        if (cwd === undefined && typeof record.cwd === "string") cwd = record.cwd;
      }
    },
    async load() { return null; },
  };
  try { await sdk.importSessionToStore(sessionId, store, { dir: workspace, includeSubagents: false }); }
  catch (error) { throw error instanceof HistoryFailure ? error : new HistoryFailure("session_unreadable", "inspect"); }
  const located = relocated ?? cwd;
  if (!entries || foreign || sidechain || !located) throw new HistoryFailure("session_unreadable", "inspect");
  return { cwd: located, stamp: `records:${entries}:${digest.digest("hex")}` };
}

async function sessionFacts(r: Pick<Request, "sessionId" | "workspace">, sdk: SessionSdk): Promise<SessionFacts> {
  const info = await sdk.getSessionInfo(r.sessionId, { dir: r.workspace });
  if (!info) return storedFacts(r.sessionId, r.workspace, sdk);
  if (info.sessionId !== r.sessionId || !info.cwd || !Number.isFinite(info.lastModified)) throw new HistoryFailure("session_unreadable", "inspect");
  return { cwd: info.cwd, stamp: `info:${info.lastModified}:${info.fileSize ?? ""}` };
}

async function inspect(r: Pick<Request, "sessionId" | "workspace">, sdk: SessionSdk) {
  const workspace = await physicalWorkspace(r.workspace);
  const before = await sessionFacts(r, sdk);
  // The SDK may search sibling worktrees. Native cwd is required to prove that
  // a found session belongs to this request, instead of trusting dir as a fence.
  if (await physicalWorkspace(before.cwd) !== workspace) throw new HistoryFailure("workspace_mismatch");
  // Request one extra entry to detect truncation, rather than digesting a page.
  const entries = await sdk.getSessionMessages(r.sessionId, { dir: r.workspace, limit: MAX_MESSAGES + 1, includeSystemMessages: true });
  if (entries.length > MAX_MESSAGES) throw new HistoryFailure("history_too_large", "inspect");
  if (!entries.length) throw new HistoryFailure("session_unreadable", "inspect");
  const seen = new Set<string>();
  const messages = entries.map(entry => {
    if (!UUID.test(entry.uuid) || seen.has(entry.uuid) || entry.session_id !== r.sessionId || !["user", "assistant", "system"].includes(entry.type)) throw new HistoryFailure("session_unreadable", "inspect");
    seen.add(entry.uuid);
    return { uuid: entry.uuid, type: entry.type };
  });
  const after = await sessionFacts(r, sdk);
  if (after.cwd !== before.cwd || after.stamp !== before.stamp) throw new HistoryFailure("source_changed");
  // The head is the session's message chain, nothing else. Everything that
  // changes what the conversation holds (a turn, a compaction, resuming from
  // an earlier message) changes this chain. Records outside it (cost-state,
  // last-prompt, mode, titles, tags) do not, and Claude appends some of them
  // when a process ends or resumes without a turn.
  const head = createHash("sha256").update(JSON.stringify({ sessionId: r.sessionId, messages })).digest("hex");
  return { v: 1 as const, ok: true as const, sessionId: r.sessionId, head, messages };
}

/** The caller owns source locking. External CLI writes are not an atomic CAS. */
export async function handleClaudeHistoryRequest(value: unknown, sdk: SessionSdk = nativeSdk) {
  let phase: Phase = "validate";
  try {
    const r = request(value);
    phase = "inspect";
    const source = await inspect(r, sdk);
    if (r.operation === "inspect") return source;
    if (r.expectedHead !== undefined && r.expectedHead !== source.head) throw new HistoryFailure("source_changed");
    if (r.upToMessageId !== undefined && !source.messages.some(message => message.uuid === r.upToMessageId)) throw new HistoryFailure("anchor_missing");
    phase = "fork";
    const result = await sdk.forkSession(r.sessionId, { dir: r.workspace, ...(r.upToMessageId ? { upToMessageId: r.upToMessageId } : {}) });
    if (!UUID.test(result.sessionId) || result.sessionId === r.sessionId) throw new HistoryFailure("fork_unconfirmed", "fork");
    // Do not inspect here: a later read failure must not hide a successful write.
    return { v: 1 as const, ok: true as const, sessionId: result.sessionId };
  } catch (error) {
    const code = error instanceof HistoryFailure ? error.code : phase === "fork" ? "fork_unconfirmed" : "session_unreadable";
    return { v: 1 as const, ok: false as const, phase: error instanceof HistoryFailure ? error.phase : phase,
      error: { code, message: "Native session history operation could not be confirmed." } };
  }
}

async function main(): Promise<void> {
  let value: unknown;
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
      chunks.push(bytes);
    }
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { value = undefined; }
  const response = await handleClaudeHistoryRequest(value);
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(response) + "\n", error => error ? reject(error) : resolve()));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}
