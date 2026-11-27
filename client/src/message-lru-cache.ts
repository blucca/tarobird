import type { Message } from "../../src/client-protocol/index.js";

export type CachedConversationMessages = {
  messages: Message[];
  revision: number;
  lineage?: string;
};

export const DEFAULT_MESSAGE_CACHE_CONVERSATIONS = 16;
export const DEFAULT_MESSAGE_CACHE_MAX_MESSAGES = 12_000;

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

  inspect(conversationId: string): CachedConversationMessages | undefined {
    return this.entries.get(conversationId);
  }

  peek(conversationId: string): CachedConversationMessages | undefined {
    const entry = this.entries.get(conversationId);
    if (!entry) return undefined;
    this.entries.delete(conversationId);
    this.entries.set(conversationId, entry);
    return entry;
  }

  set(conversationId: string, messages: Message[], revision = 0, lineage?: string): boolean {
    if (messages.length > this.maxMessages) {
      this.invalidate(conversationId);
      return false;
    }
    const existing = this.entries.get(conversationId);
    if (existing) {
      this.totalMessages -= existing.messages.length;
      this.entries.delete(conversationId);
    }
    this.entries.set(conversationId, { messages, revision, lineage });
    this.totalMessages += messages.length;
    this.evict(conversationId);
    return true;
  }

  setRevision(conversationId: string, revision: number, lineage?: string): void {
    const existing = this.entries.get(conversationId);
    if (!existing) return;
    existing.revision = revision;
    existing.lineage = lineage;
  }

  patchMessage(conversationId: string, message: Message, revision?: number): boolean {
    const existing = this.entries.get(conversationId);
    if (!existing) return false;
    this.entries.delete(conversationId);
    this.entries.set(conversationId, existing);

    const prev = existing.messages;
    const index = prev.findIndex((item) => item.id === message.id);
    let next: Message[];
    if (index !== -1) {
      next = prev.slice();
      const old = next[index]!;
      next[index] = message;
      if (old.createdAt !== message.createdAt) {
        next.sort((a, b) => a.createdAt - b.createdAt);
      }
    } else {
      if (prev.length + 1 > this.maxMessages) {
        this.totalMessages -= prev.length;
        this.entries.delete(conversationId);
        return false;
      }
      next = prev.slice();
      if (!next.length || message.createdAt >= next[next.length - 1]!.createdAt) {
        next.push(message);
      } else {
        let insertAt = next.length;
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i]!.createdAt <= message.createdAt) {
            insertAt = i + 1;
            break;
          }
          insertAt = i;
        }
        next.splice(insertAt, 0, message);
      }
      this.totalMessages += 1;
    }
    existing.messages = next;
    if (revision !== undefined) existing.revision = revision;
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
