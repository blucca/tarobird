import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { historyLedgerLineSchema, type HistoryLedgerLine } from "../client-protocol/history.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../state/state-permissions.js";

/**
 * #53 history ledger: which engine position each ordinary user-message run
 * occupies, so a Hub message id can be turned into a rewind or fork anchor.
 * Engine turn ids never leave the Bot process. One append-only file per
 * conversation; the last line of a run wins. A write failure never fails the
 * turn: that run is simply treated like an older run without a record.
 */
export const HISTORY_LEDGER_DIRECTORY = "history-ledger";
/** Start-line session of a run that had no engine session yet, i.e. one that
 * starts a new session. Never equal to a real session id. */
export const HISTORY_LEDGER_UNBOUND_SESSION = "unbound";

type LedgerEngine = HistoryLedgerLine["engine"];
export type HistoryLedgerOutcome = "ok" | `failed:${string}`;
export interface HistoryLedgerRunRecord {
  runId: string;
  /** First readable line of this run (its start line when it survived). */
  first: HistoryLedgerLine;
  /** Authoritative state: the last readable line of this run. */
  last: HistoryLedgerLine;
}

export function historyLedgerPath(stateDir: string, conversationKey: string): string {
  return path.join(stateDir, HISTORY_LEDGER_DIRECTORY, `${createHash("sha256").update(conversationKey).digest("hex")}.jsonl`);
}

/** Validates and appends one line; false instead of throwing. Each record is
 * written with a leading newline, so a torn final write (crash, full disk)
 * can only spoil its own line, never the next append. */
export async function appendHistoryLedgerLine(stateDir: string, conversationKey: string, line: HistoryLedgerLine): Promise<boolean> {
  const parsed = historyLedgerLineSchema.safeParse(line);
  if (!parsed.success) return false;
  try {
    const file = historyLedgerPath(stateDir, conversationKey);
    await mkdir(path.dirname(file), { recursive: true, mode: STATE_DIR_MODE });
    await appendFile(file, `\n${JSON.stringify(parsed.data)}`, { encoding: "utf8", mode: STATE_FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

/** Runs in first-appearance order. Unreadable or invalid lines (a truncated
 * tail after a crash) are skipped. A missing file is an empty ledger; any other
 * read error is thrown, so a caller never mistakes it for "no record". */
export async function readHistoryLedger(stateDir: string, conversationKey: string): Promise<HistoryLedgerRunRecord[]> {
  let text: string;
  try { text = await readFile(historyLedgerPath(stateDir, conversationKey), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const runs = new Map<string, HistoryLedgerRunRecord>();
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let value: unknown;
    try { value = JSON.parse(trimmed); } catch { continue; }
    const parsed = historyLedgerLineSchema.safeParse(value);
    if (!parsed.success) continue;
    const existing = runs.get(parsed.data.runId);
    if (existing) existing.last = parsed.data;
    else runs.set(parsed.data.runId, { runId: parsed.data.runId, first: parsed.data, last: parsed.data });
  }
  return [...runs.values()];
}

/** The latest run started by this Hub message. */
export function findHistoryLedgerRun(runs: readonly HistoryLedgerRunRecord[], sourceMessageId: string): HistoryLedgerRunRecord | undefined {
  for (let index = runs.length - 1; index >= 0; index--) if (runs[index]!.last.sourceMessageId === sourceMessageId) return runs[index];
  return undefined;
}

/** The message whose run created `sessionId` in this conversation, when the
 * ledger saw it; earlier messages belong to another engine session. Undefined
 * when unknown (session bound from elsewhere, or before the ledger existed). */
export function historyLedgerSinceMessageId(runs: readonly HistoryLedgerRunRecord[], sessionId: string): string | undefined {
  return runs.find(run => run.first.sessionId === HISTORY_LEDGER_UNBOUND_SESSION && run.last.sessionId === sessionId)?.last.sourceMessageId;
}

/**
 * Ledger lines of one run. A run can contain several engine turns (automatic
 * recovery continuations, delivery repairs): the first turn is the rewind
 * anchor, the last the fork anchor. Writes are serialized and never throw.
 */
export class HistoryLedgerRun {
  private line: HistoryLedgerLine | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private finished = false;
  readonly runId: string;
  constructor(private readonly options: { stateDir: string; conversationKey: string; sourceMessageId: string; engine: LedgerEngine; runId?: string; now?: () => number }) {
    this.runId = options.runId ?? randomUUID();
  }
  private now(): number { return Math.max(0, Math.floor((this.options.now ?? Date.now)())); }
  private write(): Promise<void> {
    const snapshot = this.line && { ...this.line, ...(this.line.anchor ? { anchor: { ...this.line.anchor } } : {}) };
    const task = this.chain.then(async () => { if (snapshot) await appendHistoryLedgerLine(this.options.stateDir, this.options.conversationKey, snapshot); });
    this.chain = task.catch(() => undefined);
    return this.chain.then(() => undefined);
  }
  /** `sessionId` is the bound engine session, if any. */
  start(sessionId: string | undefined): Promise<void> {
    if (this.line || this.finished) return this.chain.then(() => undefined);
    this.line = { v: 1, sourceMessageId: this.options.sourceMessageId, runId: this.runId, engine: this.options.engine,
      sessionId: sessionId || HISTORY_LEDGER_UNBOUND_SESSION, startedAt: this.now() };
    return this.write();
  }
  /** Each engine turn of the run. A turn in another session (a fresh thread
   * replaced a saturated one) restarts the anchor: one anchor, one session. */
  anchor(event: { sessionId: string; turnId?: string; endSeq?: number }): Promise<void> {
    if (this.finished || !event.sessionId) return this.chain.then(() => undefined);
    if (!this.line) this.start(undefined);
    const line = this.line!;
    const sameSession = line.sessionId === event.sessionId;
    const previous = sameSession ? line.anchor : undefined;
    if (sameSession && (event.turnId === undefined || previous?.lastTurnId === event.turnId) && (event.endSeq === undefined || previous?.endSeq === event.endSeq)) return this.chain.then(() => undefined);
    const firstTurnId = previous?.firstTurnId ?? event.turnId, lastTurnId = event.turnId ?? previous?.lastTurnId, endSeq = event.endSeq ?? previous?.endSeq;
    line.sessionId = event.sessionId;
    line.anchor = { ...(firstTurnId ? { firstTurnId } : {}), ...(lastTurnId ? { lastTurnId } : {}), ...(endSeq !== undefined ? { endSeq } : {}) };
    return this.write();
  }
  /** Once; waits for earlier lines. A run that never started writes nothing. */
  finish(outcome: HistoryLedgerOutcome): Promise<void> {
    if (this.finished || !this.line) { this.finished = true; return this.chain.then(() => undefined); }
    this.finished = true;
    this.line.endedAt = Math.max(this.line.startedAt, this.now());
    this.line.outcome = outcome;
    return this.write();
  }
}
