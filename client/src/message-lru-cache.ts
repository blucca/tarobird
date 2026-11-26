import type { Message } from "../../src/client-protocol/index.js";

export type CachedConversationMessages = {
  messages: Message[];
  revision: number;
  epoch: number;
  hasFullSnapshot: boolean;
};

export const DEFAULT_MESSAGE_CACHE_CONVERSATIONS = 16;
export const DEFAULT_MESSAGE_CACHE_MAX_MESSAGES = 12_000;

/**
 * Match IndexedDB `getAllFromIndex("messages", "conversation", id).sort((a, b) => a.createdAt - b.createdAt)`:
 * primary sort by `createdAt` ascending, tie-broken by UTF-16 code-unit `id` order.
 */
export function compareMessages(a: Pick<Message, "createdAt" | "id">, b: Pick<Message, "createdAt" | "id">): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Bounded per-host LRU cache for conversation histories.
 * Enables zero-frame conversation switches and avoids repeated full-conversation
 * IndexedDB reads during streaming or rapid navigation.
 */
export class ConversationMessageCache {
  private readonly entries = new Map<string, CachedConversationMessages>();
  private totalMessages = 0;

  constructor(
    private readonly maxConversations = DEFAULT_MESSAGE_CACHE_CONVERSATIONS,
    private readonly maxMessages = DEFAULT_MESSAGE_CACHE_MAX_MESSAGES,
  ) {}

  peek(conversationId: string, expectedEpoch?: number): CachedConversationMessages | undefined {
    const entry = this.entries.get(conversationId);
    if (!entry) return undefined;
    if (!entry.hasFullSnapshot || (expectedEpoch !== undefined && entry.epoch !== expectedEpoch)) {
      this.invalidate(conversationId);
      return undefined;
    }
    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
    return entry;
  }

  set(
    conversationId: string,
    messages: Message[],
    revision = 0,
    options?: { epoch?: number; hasFullSnapshot?: boolean },
  ): boolean {
    const hasFullSnapshot = options?.hasFullSnapshot ?? true;
    if (!hasFullSnapshot || messages.length > this.maxMessages) {
      this.invalidate(conversationId);
      return false;
    }
    const existing = this.entries.get(conversationId);
    if (existing) {
      this.totalMessages -= existing.messages.length;
      this.entries.delete(conversationId);
    }
    this.entries.set(conversationId, {
      messages,
      revision,
      epoch: options?.epoch ?? revision,
      hasFullSnapshot: true,
    });
    this.totalMessages += messages.length;
    this.evict(conversationId);
    return true;
  }

  patchMessage(
    conversationId: string,
    message: Message,
    options?: { expectedEpoch?: number; nextEpoch?: number; revision?: number },
  ): boolean {
    const existing = this.entries.get(conversationId);
    if (!existing || !existing.hasFullSnapshot) return false;
    if (options?.expectedEpoch !== undefined && existing.epoch !== options.expectedEpoch) {
      this.invalidate(conversationId);
      return false;
    }
    this.entries.delete(conversationId);
    this.entries.set(conversationId, existing);

    const prev = existing.messages;
    let index = -1;
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i]!.id === message.id) {
        index = i;
        break;
      }
    }
    let next: Message[];
    if (index !== -1) {
      const old = prev[index]!;
      if (message.version < old.version) {
        if (options?.nextEpoch !== undefined) existing.epoch = options.nextEpoch;
        if (options?.revision !== undefined) existing.revision = options.revision;
        return true;
      }
      next = prev.slice();
      next[index] = message;
      if (old.createdAt !== message.createdAt) {
        next.sort(compareMessages);
      }
    } else {
      if (prev.length + 1 > this.maxMessages) {
        this.totalMessages -= prev.length;
        this.entries.delete(conversationId);
        return false;
      }
      next = prev.slice();
      if (!next.length || compareMessages(next[next.length - 1]!, message) <= 0) {
        next.push(message);
      } else {
        let insertAt = 0;
        for (let i = next.length - 1; i >= 0; i--) {
          if (compareMessages(next[i]!, message) <= 0) {
            insertAt = i + 1;
            break;
          }
        }
        next.splice(insertAt, 0, message);
      }
      this.totalMessages += 1;
    }
    existing.messages = next;
    if (options?.nextEpoch !== undefined) existing.epoch = options.nextEpoch;
    if (options?.revision !== undefined) existing.revision = options.revision;
    this.evict(conversationId);
    return true;
  }

  invalidate(conversationId?: string): void {
    if (conversationId === undefined) {
      this.entries.clear();
      this.totalMessages = 0;
      return;
    }
    const existing = this.entries.get(conversationId);
    if (!existing) return;
    this.totalMessages -= existing.messages.length;
    this.entries.delete(conversationId);
  }

  stats(): { conversations: number; totalMessages: number } {
    return { conversations: this.entries.size, totalMessages: this.totalMessages };
  }

  private evict(protectedKey?: string): void {
    for (const [key, value] of this.entries) {
      if (this.entries.size <= this.maxConversations && this.totalMessages <= this.maxMessages) break;
      if (key === protectedKey && this.entries.size > 1) continue;
      this.entries.delete(key);
      this.totalMessages -= value.messages.length;
    }
    if (this.totalMessages > this.maxMessages && protectedKey !== undefined) {
      this.invalidate(protectedKey);
    }
  }
}
