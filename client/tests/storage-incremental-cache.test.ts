import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/client-protocol/index.js";

type Row = Record<string, any>;

const mockEnv = vi.hoisted(() => {
  const databases = new Map<string, Map<string, Map<string, Row>>>();
  const channels = new Map<string, Set<MockBroadcastChannel>>();
  const readCounts = { messagesAll: 0 };

  class MockBroadcastChannel {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    private closed = false;
    constructor(readonly name: string) {
      let set = channels.get(name);
      if (!set) channels.set(name, (set = new Set()));
      set.add(this);
    }
    postMessage(data: unknown): void {
      if (this.closed) return;
      for (const peer of channels.get(this.name) ?? []) {
        if (peer !== this && !peer.closed) peer.onmessage?.({ data });
      }
    }
    close(): void {
      this.closed = true;
      channels.get(this.name)?.delete(this);
    }
  }

  function ensureDb(name: string): Map<string, Map<string, Row>> {
    let db = databases.get(name);
    if (!db) {
      db = new Map();
      for (const store of [
        "settings", "conversations", "messages", "activity", "cursors", "outbox",
        "syncState", "syncMessages", "conversationDrafts", "attachmentData",
        "attachmentMeta", "downloadMeta", "downloadChunks", "workbenchLayouts",
        "workbenchBoards", "workbenchMarkdown", "workbenchDesign",
        "workbenchDesignMeta", "workbenchDesignObjects",
      ]) db.set(store, new Map());
      databases.set(name, db);
    }
    return db;
  }

  function encodeKey(key: unknown): string {
    return typeof key === "string" ? key : JSON.stringify(key);
  }

  function cloneValue<T>(v: T): T {
    return v === undefined ? v : structuredClone(v);
  }

  function makeDbHandle(name: string) {
    const stores = ensureDb(name);
    const snapshotAll = () => {
      const copy = new Map<string, Map<string, Row>>();
      for (const [k, m] of stores) copy.set(k, new Map([...m.entries()].map(([ek, ev]) => [ek, cloneValue(ev)])));
      return copy;
    };

    const makeCursor = (entries: Array<[string, any]>, deleteFn: (key: string) => void, updateFn: (key: string, val: any) => void) => {
      let idx = 0;
      const makeItem = (): any => {
        if (idx >= entries.length) return null;
        const [k, v] = entries[idx]!;
        return {
          key: k,
          primaryKey: k,
          value: cloneValue(v),
          delete: async () => { deleteFn(k); },
          update: async (next: any) => { updateFn(k, cloneValue(next)); },
          continue: async () => { idx++; return makeItem(); },
        };
      };
      return makeItem();
    };

    const makeStore = (working: Map<string, Map<string, Row>>, storeName: string) => {
      const map = working.get(storeName)!;
      const keyPath = storeName === "messages" || storeName === "conversations" || storeName === "outbox" ? "id" : undefined;
      const makeIndex = (indexName: string) => ({
        getAll: async (query: any) => {
          if (storeName === "messages" && indexName === "conversation") {
            readCounts.messagesAll++;
            return [...map.values()]
              .filter((r) => r.conversationId === query)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map(cloneValue);
          }
          if (storeName === "messages" && indexName === "status") {
            return [...map.values()].filter((r) => r.status === query).map(cloneValue);
          }
          return [];
        },
        getAllKeys: async (query: any) => {
          if (storeName === "messages" && indexName === "status") {
            return [...map.values()].filter((r) => r.status === query).map((r) => r.id);
          }
          return [];
        },
        openCursor: async (query?: any) => {
          const entries = [...map.entries()].filter(([, v]) => {
            if (query === undefined) return true;
            if (storeName === "messages" && indexName === "conversation") return v.conversationId === query;
            if (storeName === "syncMessages" && indexName === "owner") return v.owner === query;
            if (storeName === "conversationDrafts" && indexName === "reply") return v.reply?.id === query;
            return false;
          });
          return makeCursor(entries, (k) => map.delete(k), (k, v) => map.set(k, v));
        },
      });
      return {
        get: async (key: any) => cloneValue(map.get(encodeKey(key))),
        put: async (value: any, key?: any) => {
          const k = key !== undefined ? encodeKey(key) : keyPath ? encodeKey(value[keyPath]) : encodeKey(value.id);
          map.set(k, cloneValue(value));
          return k;
        },
        add: async (value: any, key?: any) => {
          const k = key !== undefined ? encodeKey(key)
            : storeName === "syncMessages" ? encodeKey([value.owner, value.message.id])
            : keyPath ? encodeKey(value[keyPath]) : encodeKey(value.id);
          map.set(k, cloneValue(value));
          return k;
        },
        delete: async (key: any) => { map.delete(encodeKey(key)); },
        clear: async () => { map.clear(); },
        getAll: async () => [...map.values()].map(cloneValue),
        getAllKeys: async () => [...map.keys()],
        index: makeIndex,
        openCursor: async () => makeCursor([...map.entries()], (k) => map.delete(k), (k, v) => map.set(k, v)),
      };
    };

    return {
      objectStoreNames: [...stores.keys()],
      get: async (storeName: string, key: any) => cloneValue(stores.get(storeName)!.get(encodeKey(key))),
      getAll: async (storeName: string) => [...stores.get(storeName)!.values()].map(cloneValue),
      getAllFromIndex: async (storeName: string, indexName: string, query: any) =>
        makeStore(stores, storeName).index(indexName).getAll(query),
      getAllKeysFromIndex: async (storeName: string, indexName: string, query: any) =>
        makeStore(stores, storeName).index(indexName).getAllKeys(query),
      transaction: (names: string | string[], mode = "readonly") => {
        const list = Array.isArray(names) ? names : [names];
        const working = mode === "readwrite" ? snapshotAll() : stores;
        let aborted = false;
        let committed = false;
        const done = new Promise<void>((resolve, reject) => {
          queueMicrotask(() => {
            if (aborted) {
              reject(new DOMException("Aborted", "AbortError"));
              return;
            }
            if (mode === "readwrite" && !committed) {
              committed = true;
              for (const name of list) stores.set(name, working.get(name)!);
            }
            resolve();
          });
        });
        const storeObj = list.length === 1 ? makeStore(working, list[0]!) : undefined;
        return {
          objectStore: (n: string) => makeStore(working, n),
          store: storeObj,
          objectStoreNames: list,
          abort: () => { aborted = true; },
          done,
        };
      },
      close: () => {},
    };
  }

  return { databases, channels, readCounts, MockBroadcastChannel, makeDbHandle };
});

vi.mock("idb", () => ({
  openDB: async (name: string) => mockEnv.makeDbHandle(name),
}));

import { ClientCache } from "../src/storage.js";

function userMessage(id: string, conversationId: string, createdAt: number, text: string, version = 1): Message {
  return {
    id,
    conversationId,
    authorId: "owner",
    authorType: "user",
    blocks: [{ type: "text", text }],
    status: "complete",
    version,
    clientMsgId: `client_${id}`,
    createdAt,
  };
}

function botMessage(
  id: string,
  conversationId: string,
  createdAt: number,
  text: string,
  status: Message["status"] = "streaming",
  version = 1,
): Message {
  return {
    id,
    conversationId,
    authorId: "bot_1",
    authorType: "bot",
    blocks: [{ type: "text", text }],
    status,
    version,
    createdAt,
  };
}

describe("ClientCache incremental history cache & fail-closed invalidations", () => {
  beforeEach(() => {
    mockEnv.databases.clear();
    mockEnv.channels.clear();
    mockEnv.readCounts.messagesAll = 0;
    vi.stubGlobal("BroadcastChannel", mockEnv.MockBroadcastChannel);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs zero full IDB reads on steady-state creates/streams/updates and matches fresh IDB reads identically", async () => {
    const dbName = "db-incremental-1";
    const cache = new ClientCache(dbName);
    const reader = new ClientCache(dbName);
    try {
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 1, at: 100, kind: "message.created",
        payload: userMessage("m1", "c1", 100, "hello"),
      });

      // Cold read: exactly 1 full IDB read populates ConversationMessageCache.
      expect(await cache.messages("c1")).toHaveLength(1);
      expect(mockEnv.readCounts.messagesAll).toBe(1);

      // Bot starts streaming, receives deltas, completes, and user sends another message.
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 2, at: 110, kind: "message.created",
        payload: botMessage("m2", "c1", 110, "hi", "streaming", 1),
      });
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 3, at: 120, kind: "message.stream",
        payload: { messageId: "m2", baseVersion: 1, version: 2, ops: [{ op: "appendText", block: 0, text: " there" }] },
      });
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 4, at: 130, kind: "message.updated",
        payload: botMessage("m2", "c1", 110, "hi there!", "complete", 3),
      });
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 5, at: 140, kind: "message.created",
        payload: userMessage("m3", "c1", 140, "follow up"),
      });
      // Out-of-order / tied createdAt + tombstone update
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 6, at: 140, kind: "message.created",
        payload: userMessage("m2b", "c1", 140, "tie before m3"),
      });
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 7, at: 150, kind: "message.updated",
        payload: { ...userMessage("m1", "c1", 100, "hello", 2), status: "deleted" },
      });

      const cachedResult = await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(1); // ZERO extra full IDB reads!
      expect(cache.peekMessages("c1")).toEqual(cachedResult);

      // Fresh uncached reader performs 1 IDB read; incremental memory must match it identically.
      const idbResult = await reader.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(2);
      expect(cachedResult).toEqual(idbResult);
      expect(cachedResult.map((m) => [m.id, m.status])).toEqual([
        ["m1", "deleted"],
        ["m2", "complete"],
        ["m2b", "complete"],
        ["m3", "complete"],
      ]);
    } finally {
      cache.close();
      reader.close();
    }
  });

  it("fails closed to a fresh IDB read on cross-tab BroadcastChannel, snapshot backfill, invalidateMessages, and reset", async () => {
    const dbName = "db-fail-closed";
    const cache = new ClientCache(dbName);
    const otherTab = new ClientCache(dbName);
    try {
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 1, at: 100, kind: "message.created",
        payload: userMessage("m1", "c1", 100, "initial"),
      });
      await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(1);

      // 1) Cross-tab / sibling mutation invalidates cache -> next read hits IDB.
      await otherTab.apply({
        v: 1, type: "event", conversationId: "c1", seq: 2, at: 200, kind: "message.created",
        payload: userMessage("m2", "c1", 200, "from-other-tab"),
      });
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(mockEnv.readCounts.messagesAll).toBe(2);

      // 2) Simulated BroadcastChannel invalidation from a separate tab.
      const bc = new mockEnv.MockBroadcastChannel(`tarobot-messages:${dbName}`);
      bc.postMessage({ v: 1, conversationId: "c1" });
      bc.close();
      expect(cache.peekMessages("c1")).toBeUndefined();
      await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(3);

      // 3) acceptSnapshot backfill invalidates cache -> next read hits IDB.
      const conv = { id: "c1", type: "direct" as const, title: "Chat", ownerId: "owner", botIds: ["bot_1"], archived: false, createdAt: 1 };
      await cache.acceptSnapshot({ v: 1, type: "snapshot.begin", id: "snap_1", conversation: conv, after: 2, seq: 10, readSeq: 10 });
      await cache.acceptSnapshot({
        v: 1, type: "snapshot.message", id: "snap_1", index: 0, contentSeq: 10, unreadSeq: 0,
        message: userMessage("m_snap", "c1", 300, "rebuilt"),
      });
      await cache.acceptSnapshot({ v: 1, type: "snapshot.end", id: "snap_1", count: 1 });
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m_snap"]);
      expect(mockEnv.readCounts.messagesAll).toBe(4);

      // 4) Explicit invalidateMessages (deleteMessages / history clear / rewind / outbox reconcile).
      cache.invalidateMessages("c1");
      expect(cache.peekMessages("c1")).toBeUndefined();
      await cache.messages("c1");
      expect(mockEnv.readCounts.messagesAll).toBe(5);

      // 5) forgetIdentity / close fail closed.
      await cache.forgetIdentity();
      expect(cache.peekMessages("c1")).toBeUndefined();
      expect(await cache.messages("c1")).toEqual([]);
      expect(mockEnv.readCounts.messagesAll).toBe(6);

      cache.close();
      expect(cache.peekMessages("c1")).toBeUndefined();
    } finally {
      cache.close();
      otherTab.close();
    }
  });

  it("does not corrupt cache when an apply() transaction fails or races an initial IDB load", async () => {
    const dbName = "db-abort-race";
    const cache = new ClientCache(dbName);
    try {
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 1, at: 100, kind: "message.created",
        payload: userMessage("m1", "c1", 100, "first"),
      });
      await cache.messages("c1");

      // Sync gap aborts transaction: cache must still have only m1.
      await expect(cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 5, at: 200, kind: "message.created",
        payload: userMessage("m_gap", "c1", 200, "skipped"),
      })).rejects.toThrow("sync_gap");
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1"]);

      // Invalidate, start a slow IDB read, and mutate mid-read: stale read must not populate cache.
      cache.invalidateMessages("c1");
      const db = mockEnv.databases.get(dbName)!;
      const messagesMap = db.get("messages")!;
      const originalEntries = [...messagesMap.entries()];
      const pendingRead = cache.messages("c1");
      // Immediately commit seq 2 before pendingRead resolves:
      await cache.apply({
        v: 1, type: "event", conversationId: "c1", seq: 2, at: 150, kind: "message.created",
        payload: userMessage("m2", "c1", 150, "second"),
      });
      await pendingRead;
      // Epoch changed mid-read, so cache was NOT populated with stale [m1]:
      // next read hits IDB and sees both [m1, m2].
      expect(originalEntries).toHaveLength(1);
      expect((await cache.messages("c1")).map((m) => m.id)).toEqual(["m1", "m2"]);
    } finally {
      cache.close();
    }
  });
});
