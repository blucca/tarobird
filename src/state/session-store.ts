import { SessionHistoryPendingError } from "./session-history-error.js";
import { SessionStateSchema } from "./session-state-schema.js";
import { withFileMutex } from "./file-mutex.js";
import { JsonStore } from "./json-store.js";
import type { SessionRecord, SessionState } from "../types.js";
import { getConversationKey } from "../runtime/conversation-key.js";
import { createHash, randomUUID } from "node:crypto";

export interface SessionHistoryBinding { record: SessionRecord; shared: boolean }
export interface SessionHistoryFinalization { operationId: string; rewind?: boolean; destination?: SessionRecord }
function requireNoHistoryFence(records: SessionRecord[]): void {
  if (records.some(record => record.historyFence)) throw new SessionHistoryPendingError();
}

export const SESSION_STATE_UNREADABLE_WARNING = "session state unreadable";

export function createDefaultSessionState(): SessionState {
  return { chats: [] };
}

function recordConversationKey(record: Pick<SessionRecord, "telegramChatId" | "telegramThreadId" | "conversationKey">): string {
  return record.conversationKey ?? getConversationKey(record.telegramChatId, record.telegramThreadId);
}

function normalizeRecord(record: SessionRecord): SessionRecord {
  if (record.conversationKey === undefined && record.telegramThreadId === undefined) {
    return record;
  }
  return {
    ...record,
    conversationKey: recordConversationKey(record),
  };
}

export class SessionStore {
  private readonly store: JsonStore<SessionState>;
  readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = new JsonStore<SessionState>(filePath, (value) => {
      const result = SessionStateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid session state");
    });
  }

  async load(): Promise<SessionState> {
    return await withFileMutex(this.filePath, async () => await this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<SessionState> {
    return this.store.read(createDefaultSessionState());
  }

  async inspect(): Promise<{ state: SessionState; warning?: string; repairable?: boolean }> {
    try {
      return { state: await this.load() };
    } catch (error) {
      if (isUnreadableSessionStateError(error)) {
        return {
          state: createDefaultSessionState(),
          warning: SESSION_STATE_UNREADABLE_WARNING,
          repairable: isRepairableSessionStateError(error),
        };
      }

      throw error;
    }
  }

  async upsert(record: SessionRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadUnlocked();
      const normalized = normalizeRecord({ ...record });
      const key = recordConversationKey(normalized);
      const index = state.chats.findIndex((entry) => recordConversationKey(entry) === key);
      const old = state.chats[index];
      requireNoHistoryFence(state.chats.filter(entry => entry === old || entry.codexSessionId === normalized.codexSessionId));
      // Old callers pass whole records or rebuild them. Neither may clear a
      // history fence or restore a stale revision. Only the dedicated transaction
      // below can finish a pending native mutation.
      delete normalized.historyFence;
      delete normalized.historyLastOperation;
      if (old?.historyGeneration || normalized.historyGeneration) {
        normalized.historyGeneration = old?.codexSessionId === normalized.codexSessionId ? old.historyGeneration ?? randomUUID() : randomUUID();
        normalized.historyRevision = randomUUID();
      }

      if (index === -1) {
        state.chats.push(normalized);
      } else {
        state.chats[index] = normalized;
      }

      await this.store.write(state);
    });
  }

  async findByChatId(telegramChatId: number): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => matchesChatId(record, telegramChatId)) ?? null;
  }

  async findByConversationKey(conversationKey: string): Promise<SessionRecord | null> {
    const state = await this.load();
    return state.chats.find((record) => recordConversationKey(record) === conversationKey) ?? null;
  }

  async findByChatIdSafe(
    telegramChatId: number,
  ): Promise<{ record: SessionRecord | null; warning?: string; repairable?: boolean }> {
    const { state, warning, repairable } = await this.inspect();
    return {
      record: state.chats.find((entry) => matchesChatId(entry, telegramChatId)) ?? null,
      warning,
      repairable,
    };
  }

  async findByConversationKeySafe(
    conversationKey: string,
  ): Promise<{ record: SessionRecord | null; warning?: string; repairable?: boolean }> {
    const { state, warning, repairable } = await this.inspect();
    return {
      record: state.chats.find((entry) => recordConversationKey(entry) === conversationKey) ?? null,
      warning,
      repairable,
    };
  }

  async removeByChatId(telegramChatId: number): Promise<boolean> {
    return this.removeMatching((record) => matchesChatId(record, telegramChatId));
  }

  async removeByConversationKey(conversationKey: string): Promise<boolean> {
    return this.removeMatching((record) => recordConversationKey(record) === conversationKey);
  }

  private async removeMatching(predicate: (record: SessionRecord) => boolean): Promise<boolean> {
    return this.enqueueWrite(async () => this.removeMatchingUnlocked(predicate));
  }

  private async removeMatchingUnlocked(predicate: (record: SessionRecord) => boolean): Promise<boolean> {
    const state = await this.loadUnlocked();
    requireNoHistoryFence(state.chats.filter(predicate));
    let removed = false;
    const nextChats = state.chats.filter((record) => {
      if (predicate(record)) {
        removed = true;
        return false;
      }

      return true;
    });

    if (removed) {
      state.chats = nextChats;
      await this.store.write(state);
    }

    return removed;
  }

  async clearAll(): Promise<number> {
    return this.enqueueWrite(async () => {
      const state = await this.loadUnlocked();
      requireNoHistoryFence(state.chats);
      const removedCount = state.chats.length;
      if (removedCount === 0) {
        return 0;
      }

      state.chats = [];
      await this.store.write(state);
      return removedCount;
    });
  }

  /**
   * Clear bindings while another durable update runs. The session mutex stays
   * held for the whole operation so concurrent upserts cannot be overwritten;
   * if the update fails, the original bindings are restored before release.
   */
  async clearAllThen<T>(operation: () => Promise<T>): Promise<{ removedCount: number; result: T }> {
    return this.enqueueWrite(async () => {
      const original = await this.loadUnlocked();
      requireNoHistoryFence(original.chats);
      const removedCount = original.chats.length;
      if (removedCount > 0) {
        await this.store.write(createDefaultSessionState());
      }

      try {
        return { removedCount, result: await operation() };
      } catch (cause) {
        if (removedCount > 0) {
          try {
            await this.store.write(original);
          } catch (rollbackError) {
            throw new AggregateError(
              [cause, rollbackError],
              "session bindings could not be restored after a failed update",
            );
          }
        }
        throw cause;
      }
    });
  }

  async removeByChatIdRecovering(telegramChatId: number): Promise<{ removed: boolean; repaired: boolean }> {
    return this.removeMatchingRecovering((record) => matchesChatId(record, telegramChatId));
  }

  async removeByConversationKeyRecovering(conversationKey: string): Promise<{ removed: boolean; repaired: boolean }> {
    return this.removeMatchingRecovering((record) => recordConversationKey(record) === conversationKey);
  }

  private async removeMatchingRecovering(
    predicate: (record: SessionRecord) => boolean,
  ): Promise<{ removed: boolean; repaired: boolean }> {
    return this.enqueueWrite(async () => {
      try {
        return {
          removed: await this.removeMatchingUnlocked(predicate),
          repaired: false,
        };
      } catch (error) {
        if (!isRepairableSessionStateError(error)) {
          throw error;
        }

        await this.store.quarantineCurrentFile("corrupt");
        await this.store.write(createDefaultSessionState());
        return { removed: false, repaired: true };
      }
    });
  }

  async reset(): Promise<void> {
    await this.enqueueWrite(async () => {
      try {
        requireNoHistoryFence((await this.loadUnlocked()).chats);
      } catch (error) {
        if (!isRepairableSessionStateError(error)) throw error;
        // Explicit reset has always been a repair entry point. Preserve the
        // damaged file, but never erase a readable pending history operation.
        await this.store.quarantineCurrentFile("corrupt");
      }
      await this.store.write(createDefaultSessionState());
    });
  }

  async inspectHistory(conversationKey: string): Promise<SessionHistoryBinding | null> {
    return this.enqueueWrite(async () => {
      const state = await this.loadUnlocked();
      const record = state.chats.find(entry => recordConversationKey(entry) === conversationKey);
      if (!record) return null;
      if (!record.historyGeneration || !record.historyRevision) {
        record.historyGeneration ??= randomUUID(); record.historyRevision ??= randomUUID();
        await this.store.write(state);
      }
      return { record, shared: state.chats.some(other => other !== record && other.codexSessionId === record.codexSessionId) };
    });
  }

  async reserveHistory(conversationKey: string, expectedRevision: string, operationId: string): Promise<SessionHistoryBinding> {
    return this.enqueueWrite(async () => {
      const state = await this.loadUnlocked();
      const record = state.chats.find(entry => recordConversationKey(entry) === conversationKey);
      if (!record || record.historyRevision !== expectedRevision) throw new Error("history_source_changed");
      requireNoHistoryFence([record]);
      if (state.chats.some(other => other !== record && other.codexSessionId === record.codexSessionId)) throw new Error("history_shared_session");
      record.historyFence = { operationId, sourceRevision: expectedRevision };
      await this.store.write(state);
      return { record, shared: false };
    });
  }

  /** Only a definitely unadmitted/refused native operation may release its
   * reservation. An RPC timeout or missing result is never such evidence. */
  async releaseHistory(conversationKey: string, operationId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadUnlocked();
      const record = state.chats.find(entry => recordConversationKey(entry) === conversationKey);
      const signature = createHash("sha256").update("rejected").digest("hex");
      if (record?.historyLastOperation?.operationId === operationId && record.historyLastOperation.signature === signature) return;
      if (!record || record.historyFence?.operationId !== operationId) throw new Error("history_source_changed");
      delete record.historyFence;
      record.historyLastOperation = { operationId, signature, revision: record.historyRevision! };
      await this.store.write(state);
    });
  }

  /** Native receipt must already be durable. Commits local binding only; it
   * never invokes a native operation. A repeated identical finalization is safe. */
  async finalizeHistory(conversationKey: string, input: SessionHistoryFinalization): Promise<{ revision: string }> {
    return this.enqueueWrite(async () => {
      const state = await this.loadUnlocked();
      const record = state.chats.find(entry => recordConversationKey(entry) === conversationKey);
      if (!record) throw new Error("history_source_changed");
      const signature = createHash("sha256").update(JSON.stringify([input.operationId, input.rewind === true,
        input.destination ? [recordConversationKey(input.destination), input.destination.codexSessionId, input.destination.resume ?? null] : null])).digest("hex");
      if (record.historyLastOperation?.operationId === input.operationId) {
        if (record.historyLastOperation.signature !== signature) throw new Error("history_request_conflict");
        return { revision: record.historyLastOperation.revision };
      }
      if (record.historyFence?.operationId !== input.operationId || record.historyFence.sourceRevision !== record.historyRevision) throw new Error("history_source_changed");
      if (input.destination) {
        const destinationKey = recordConversationKey(input.destination);
        if (input.rewind || state.chats.some(entry => recordConversationKey(entry) === destinationKey || entry.codexSessionId === input.destination!.codexSessionId)) throw new Error("history_destination_exists");
        const destination = normalizeRecord({ ...input.destination, historyGeneration: randomUUID(), historyRevision: randomUUID() });
        delete destination.historyFence; delete destination.historyLastOperation; delete destination.suspendedPrevious;
        state.chats.push(destination);
      }
      if (input.rewind) record.historyRevision = randomUUID();
      const revision = record.historyRevision!;
      delete record.historyFence;
      record.historyLastOperation = { operationId: input.operationId, signature, revision };
      await this.store.write(state);
      return { revision };
    });
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.pendingWrite.then(
      () => withFileMutex(this.filePath, task),
      () => withFileMutex(this.filePath, task),
    );
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }
}

function matchesChatId(record: SessionRecord, telegramChatId: number): boolean {
  if (record.telegramThreadId !== undefined) {
    return false;
  }
  if (record.conversationKey?.startsWith("lark:")) {
    return record.telegramChatId === telegramChatId;
  }
  return recordConversationKey(record) === getConversationKey(telegramChatId);
}

function isUnreadableSessionStateError(error: unknown): boolean {
  return (
    isRepairableSessionStateError(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (((error as NodeJS.ErrnoException).code === "EACCES") || (error as NodeJS.ErrnoException).code === "EPERM"))
  );
}

function isRepairableSessionStateError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === "invalid session state")
  );
}
