import { blocksText, type ClientFrame, type Message } from "../../src/client-protocol/index.js";

export const SEND_TIMING_STORAGE_KEY = "tarobird.debug.sendTiming";
const MAX_RECORDS = 200;
const MAX_PENDING_AGE_MS = 30_000;

export type SendTimingRoute = "queue" | "steer" | "native_message" | "discussion_start" | "discussion_note" | "side";
export type SendTimingStage =
  | "workbenchDoneAt"
  | "steeringPreflightDoneAt"
  | "steeringStateDoneAt"
  | "historySettledDoneAt"
  | "enqueueDoneAt"
  | "outboxFlushSentAt"
  | "outboxReloadDoneAt"
  | "historyReadDoneAt"
  | "bubbleVisibleAt"
  | "composerClearedAt";

export interface SendTimingRecord {
  id: number;
  conversationId: string;
  clientMsgId?: string;
  messageId?: string;
  engine?: string;
  kind: "direct" | "group" | "side";
  route?: SendTimingRoute;
  messageLength: number;
  historyCount?: number;
  enterAt: number;
  workbenchDoneAt?: number;
  steeringPreflightDoneAt?: number;
  steeringStateDoneAt?: number;
  historySettledDoneAt?: number;
  enqueueDoneAt?: number;
  outboxFlushSentAt?: number;
  outboxReloadDoneAt?: number;
  historyReadGapWaitMs?: number;
  historyReadCostMs?: number;
  historyReadDoneAt?: number;
  bubbleVisibleAt?: number;
  composerClearedAt?: number;
  error?: string;
}

export interface SendTimingDebugApi {
  readonly records: SendTimingRecord[];
  clear(): void;
  latest(): SendTimingRecord | undefined;
}

interface ActiveTrace {
  record: SendTimingRecord;
  matchText?: string;
  createdEpochMs: number;
  expectComposerClear: boolean;
  retired: boolean;
}

export interface SendTimingTrace {
  readonly id: number;
  mark(stage: SendTimingStage, at?: number): void;
  setRoute(route: SendTimingRoute): void;
  setClientMsgId(clientMsgId?: string, messageId?: string): void;
  setHistoryCount(count: number): void;
  expectComposerClear(): void;
  skipComposerClear(): void;
  fail(reason: unknown): void;
}

let nextId = 1;
let testHookEnabled = false;
const records: SendTimingRecord[] = [];
const pending: ActiveTrace[] = [];

export function setSendTimingTestHook(enabled: boolean): void {
  testHookEnabled = enabled;
  if (enabled) ensureGlobalApi();
}

export function isSendTimingEnabled(): boolean {
  if (testHookEnabled) return true;
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(SEND_TIMING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function hasActiveSendTiming(): boolean {
  return pending.length > 0;
}

export function hasPendingBubbleTiming(conversationId: string): boolean {
  if (!pending.length || !conversationId) return false;
  return pending.some(item => !item.retired && item.record.conversationId === conversationId && item.record.bubbleVisibleAt === undefined);
}

export function hasPendingComposerTiming(conversationId: string): boolean {
  if (!pending.length || !conversationId) return false;
  return pending.some(item => !item.retired && item.record.conversationId === conversationId && item.expectComposerClear && item.record.composerClearedAt === undefined);
}

function ensureGlobalApi(): void {
  const host = globalThis as { __tarobirdSendTiming?: SendTimingDebugApi };
  if (host.__tarobirdSendTiming) return;
  host.__tarobirdSendTiming = {
    records,
    clear() {
      records.length = 0;
      pending.length = 0;
    },
    latest() {
      return records.at(-1);
    },
  };
}

function prunePending(now: number): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const item = pending[i]!;
    const done = item.retired
      || (item.record.bubbleVisibleAt !== undefined && (!item.expectComposerClear || item.record.composerClearedAt !== undefined))
      || now - item.record.enterAt > MAX_PENDING_AGE_MS;
    if (done) pending.splice(i, 1);
  }
}

function findByFrame(frame: ClientFrame): ActiveTrace | undefined {
  const id = "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : undefined;
  if (!id) return undefined;
  for (let i = pending.length - 1; i >= 0; i--) {
    const item = pending[i]!;
    if (!item.retired && item.record.clientMsgId === id) return item;
  }
  return undefined;
}

function matchesDiscussionMessage(item: ActiveTrace, message: Message): boolean {
  if (item.record.kind !== "group" || !item.matchText || message.authorType !== "user") return false;
  if (!message.clientMsgId?.startsWith("gdtopic_") && !message.clientMsgId?.startsWith("gdnote_")) return false;
  if (message.createdAt < item.createdEpochMs - 5000) return false;
  return blocksText(message.blocks) === item.matchText;
}

function matchesTraceMessage(item: ActiveTrace, message: Message): boolean {
  if (item.record.messageId && message.id === item.record.messageId) return true;
  if (item.record.clientMsgId && message.clientMsgId === item.record.clientMsgId) return true;
  return matchesDiscussionMessage(item, message);
}

/** Start a release-safe opt-in timing trace. Returns undefined with zero
 *  allocations or clock calls when `tarobird.debug.sendTiming !== "1"`. */
export function beginSendTiming(init: {
  conversationId: string;
  kind: "direct" | "group" | "side";
  engine?: string;
  route?: SendTimingRoute;
  messageLength: number;
  historyCount?: number;
  matchText?: string;
  clientMsgId?: string;
}): SendTimingTrace | undefined {
  if (!isSendTimingEnabled()) return undefined;
  ensureGlobalApi();
  const enterAt = performance.now();
  prunePending(enterAt);
  const record: SendTimingRecord = {
    id: nextId++,
    conversationId: init.conversationId,
    ...(init.clientMsgId ? { clientMsgId: init.clientMsgId } : {}),
    ...(init.engine ? { engine: init.engine } : {}),
    kind: init.kind,
    ...(init.route ? { route: init.route } : {}),
    messageLength: init.messageLength,
    ...(init.historyCount !== undefined ? { historyCount: init.historyCount } : {}),
    enterAt,
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.shift();
  const active: ActiveTrace = {
    record,
    matchText: init.matchText,
    createdEpochMs: Date.now(),
    expectComposerClear: init.messageLength > 0,
    retired: false,
  };
  pending.push(active);
  return {
    id: record.id,
    mark(stage, at = performance.now()) {
      if (active.retired || record[stage] !== undefined) return;
      record[stage] = at;
      if (stage === "bubbleVisibleAt" || stage === "composerClearedAt") prunePending(at);
    },
    setRoute(route) {
      if (!active.retired) record.route = route;
    },
    setClientMsgId(clientMsgId, messageId) {
      if (active.retired) return;
      if (clientMsgId) record.clientMsgId = clientMsgId;
      if (messageId) record.messageId = messageId;
    },
    setHistoryCount(count) {
      if (!active.retired) record.historyCount = count;
    },
    expectComposerClear() {
      if (!active.retired) active.expectComposerClear = true;
    },
    skipComposerClear() {
      if (active.retired) return;
      active.expectComposerClear = false;
      prunePending(performance.now());
    },
    fail(reason) {
      if (active.retired) return;
      active.retired = true;
      record.error = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "aborted";
      prunePending(performance.now());
    },
  };
}

export function markSendTimingByClientMsgId(frame: ClientFrame, stage: SendTimingStage): void {
  if (!pending.length) return;
  const active = findByFrame(frame);
  if (!active || active.record[stage] !== undefined) return;
  active.record[stage] = performance.now();
}

export function markSendTimingOutboxReload(
  conversationId: string,
  entries: ReadonlyArray<{ id: string }>,
  settledIds?: ReadonlyMap<string, unknown>,
): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId) continue;
    if (active.record.enqueueDoneAt === undefined || active.record.outboxReloadDoneAt !== undefined) continue;
    const id = active.record.clientMsgId;
    if (!id || entries.some(entry => entry.id === id) || settledIds?.has(id)) {
      active.record.outboxReloadDoneAt = now;
    }
  }
}

export function markSendTimingHistoryRead(
  conversationId: string,
  messages: readonly Message[],
  readEndAt: number,
  gapWaitMs: number,
  readCostMs: number,
): void {
  if (!pending.length) return;
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId) continue;
    if (active.record.historyReadDoneAt !== undefined) continue;
    if (!active.record.clientMsgId && !active.record.messageId && active.record.kind !== "group") continue;
    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j]!;
      if (matchesTraceMessage(active, message)) {
        active.record.messageId ??= message.id;
        active.record.clientMsgId ??= message.clientMsgId;
        active.record.historyReadGapWaitMs = gapWaitMs;
        active.record.historyReadCostMs = readCostMs;
        active.record.historyReadDoneAt = readEndAt;
        break;
      }
    }
  }
}

export function markSendTimingBubbleVisible(
  conversationId: string,
  displayedMessages: readonly Message[],
  hasElement: (messageId: string) => boolean,
): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId) continue;
    if (active.record.bubbleVisibleAt !== undefined) continue;
    for (let j = displayedMessages.length - 1; j >= 0; j--) {
      const message = displayedMessages[j]!;
      if (matchesTraceMessage(active, message) && hasElement(message.id)) {
        active.record.messageId ??= message.id;
        active.record.clientMsgId ??= message.clientMsgId;
        active.record.bubbleVisibleAt = now;
        break;
      }
    }
  }
  prunePending(now);
}

export function markSendTimingSideVisible(conversationId: string, questionText: string): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId || active.record.kind !== "side") continue;
    if (active.record.bubbleVisibleAt !== undefined) continue;
    if (active.matchText === undefined || active.matchText === questionText) {
      active.record.bubbleVisibleAt = now;
    }
  }
  prunePending(now);
}

export function markSendTimingComposerCleared(conversationId: string): void {
  if (!pending.length) return;
  const now = performance.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    const active = pending[i]!;
    if (active.retired || active.record.conversationId !== conversationId) continue;
    if (active.expectComposerClear && active.record.composerClearedAt === undefined) {
      active.record.composerClearedAt = now;
    }
  }
  prunePending(now);
}

export function getSendTimingRecords(): readonly SendTimingRecord[] {
  return records;
}

export function clearSendTimingRecords(): void {
  records.length = 0;
  pending.length = 0;
}

if (isSendTimingEnabled()) ensureGlobalApi();
