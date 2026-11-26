import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../../src/hub/server.js";
import { deviceProof } from "../../src/hub/auth.js";

const idbState = vi.hoisted(() => ({ dbs: new Map<string, Map<string, Map<string, unknown>>>() }));
const transportState = vi.hoisted(() => ({
  blockHttp: new Set<string>(),
  sockets: new Set<WebSocket>(),
}));

vi.mock("idb", () => {
  const STORES = [
    "hosts", "meta", "networkCandidates",
    "settings", "conversations", "messages", "activity", "attachmentData",
    "attachmentMeta", "downloadMeta", "downloadChunks", "cursors", "outbox",
    "syncState", "syncMessages", "conversationDrafts", "workbenchLayouts",
    "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta",
    "workbenchDesignObjects",
  ];
  function openCursorOn(entries: Array<[string, unknown]>, range?: { lower?: unknown; upper?: unknown }, onDelete?: (k: string) => void) {
    const filtered = entries.filter(([k]) => {
      if (range?.lower !== undefined && k < String(range.lower)) return false;
      if (range?.upper !== undefined && k > String(range.upper)) return false;
      return true;
    });
    let idx = 0;
    const next = async (): Promise<any> => {
      if (idx >= filtered.length) return null;
      const [key, value] = filtered[idx++]!;
      return {
        key,
        primaryKey: key,
        value,
        delete: async () => { onDelete?.(key); },
        continue: next,
      };
    };
    return next();
  }
  function createStoreView(store: Map<string, unknown>) {
    return {
      get: async (key: unknown) => store.get(String(key)),
      put: async (value: unknown, key?: unknown) => {
        const k = key ?? (value && typeof value === "object" && "id" in value ? (value as { id: unknown }).id : undefined);
        store.set(String(k), value);
        return k;
      },
      delete: async (key: unknown) => { store.delete(String(key)); },
      clear: async () => { store.clear(); },
      getAll: async () => [...store.values()],
      getAllKeys: async () => [...store.keys()],
      openCursor: (range?: { lower?: unknown; upper?: unknown }) => openCursorOn([...store.entries()], range, k => { store.delete(k); }),
      openKeyCursor: (range?: { lower?: unknown; upper?: unknown }) => openCursorOn([...store.entries()], range, k => { store.delete(k); }),
      index: () => ({
        getAll: async () => [],
        getAllKeys: async () => [],
        openCursor: async () => null,
        openKeyCursor: async () => null,
      }),
    };
  }
  return {
    openDB: async (name: string) => {
      let stores = idbState.dbs.get(name);
      if (!stores) {
        stores = new Map(STORES.map(store => [store, new Map()]));
        idbState.dbs.set(name, stores);
      }
      const storeViews = new Map(STORES.map(storeName => [storeName, createStoreView(stores!.get(storeName)!)]));
      return {
        objectStoreNames: STORES,
        get: async (store: string, key: unknown) => stores!.get(store)?.get(String(key)),
        put: async (store: string, value: unknown, key?: unknown) => { stores!.get(store)?.set(String(key), value); return key; },
        delete: async (store: string, key: unknown) => { stores!.get(store)?.delete(String(key)); },
        getAll: async (store: string) => [...(stores!.get(store)?.values() ?? [])],
        getAllKeys: async (store: string) => [...(stores!.get(store)?.keys() ?? [])],
        close: () => {},
        transaction: (names: string | string[]) => {
          const list = Array.isArray(names) ? names : [names];
          return {
            objectStoreNames: list,
            store: storeViews.get(list[0]!),
            objectStore: (store: string) => storeViews.get(store)!,
            done: Promise.resolve(),
            abort: () => {},
          };
        },
      };
    },
  };
});

vi.mock("../src/identity.js", () => ({
  randomNonce: () => "n".repeat(44),
  signChallenge: async (identity: { deviceId: string; privateKey?: unknown }, serverNonce: string, clientNonce: string) => {
    return sign(null, deviceProof(identity.deviceId, serverNonce, clientNonce), identity.privateKey as any).toString("base64");
  },
  verifyHub: async () => {},
  verifyRevocation: () => {},
  signDeviceAction: async () => "sig",
}));

vi.mock("../src/transport.js", () => ({
  usesPinnedTransport: () => false,
  hubSocket: (origin: string) => {
    const raw = new WebSocket(origin.replace(/^http/, "ws") + "/ws");
    transportState.sockets.add(raw);
    const wrapper: any = {
      get readyState() { return raw.readyState; },
      onopen: undefined as undefined | (() => void),
      onmessage: undefined as undefined | ((event: { data: string }) => void),
      onerror: undefined as undefined | (() => void),
      onclose: undefined as undefined | ((event: { code: number; reason: string }) => void),
      send: (data: string) => raw.send(data),
      close: (code?: number, reason?: string) => raw.close(code, reason),
    };
    raw.on("open", () => wrapper.onopen?.());
    raw.on("message", data => wrapper.onmessage?.({ data: data.toString() }));
    raw.on("error", () => wrapper.onerror?.());
    raw.on("close", (code, reason) => {
      transportState.sockets.delete(raw);
      wrapper.onclose?.({ code, reason: reason.toString() });
    });
    return wrapper;
  },
  hubFetch: async (origin: string, reqPath: string, _hubKey?: string, init: RequestInit = {}) => {
    if (transportState.blockHttp.has(origin)) throw new TypeError("offline");
    return fetch(origin + reqPath, init);
  },
}));

vi.mock("../src/native.js", () => ({ nativePlatform: () => "web" }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));

import { ClientCache, type Identity } from "../src/storage.js";
import { HubConnection } from "../src/connection.js";
import {
  CROSS_HOST_FOLDER_ORDER_KEY,
  applyCrossHostFolderMove,
  crossHostFolderKey,
  emptyCrossHostFolderOrder,
  flushCrossHostFolderOrderPersistence,
  readCrossHostFolderOrder,
  readyCrossHostFolderOrder,
  resetCrossHostFolderOrderCache,
  writeCrossHostFolderOrder,
} from "../src/cross-host-folder-order.js";
import { CrossHostFolderOrderSync, type CrossHostOrderConnectionSource } from "../src/cross-host-folder-order-sync.js";

const k = (hostKey: string, folderId: string | null) => crossHostFolderKey({ hostKey, folderId });

function installBrowserGlobals() {
  const storageMap = new Map<string, string>();
  const storage = {
    get length() { return storageMap.size; },
    key: (index: number) => [...storageMap.keys()][index] ?? null,
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { storageMap.set(key, value); },
    removeItem: (key: string) => { storageMap.delete(key); },
    clear: () => { storageMap.clear(); },
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("indexedDB", {});
  vi.stubGlobal("WebSocket", WebSocket);
  vi.stubGlobal("IDBKeyRange", {
    bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    lowerBound: (lower: unknown) => ({ lower }),
  });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    addEventListener: EventTarget.prototype.addEventListener,
    removeEventListener: EventTarget.prototype.removeEventListener,
  }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    hidden: false,
    visibilityState: "visible",
    hasFocus: () => true,
  }));
  return { storageMap };
}

async function createPairedDevice(hub: HubServer, deviceId: string, dbName: string, userId = "owner") {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const pair = await hub.auth.pair({ deviceId, name: deviceId, platform: "web", publicKey }, deviceId);
  await hub.auth.approve(pair.code, "local-owner", userId);
  const identity: Identity = {
    deviceId,
    name: deviceId,
    platform: "web",
    publicKey,
    privateKey: keys.privateKey as unknown as CryptoKey,
    hubPublicKey: hub.auth.publicKey,
    routes: [{ name: "LAN", url: hub.url }],
  };
  const cache = new ClientCache(dbName);
  await cache.saveIdentity(identity);
  return { identity, cache };
}

function makeSource(connections: HubConnection[]): CrossHostOrderConnectionSource {
  const listeners = new Set<() => void>();
  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getConnections: () => connections,
  };
}

describe("client cross-host folder order multi-Hub sync", () => {
  let root: string;
  const hubs: HubServer[] = [];
  const connections: HubConnection[] = [];
  const coordinators: CrossHostFolderOrderSync[] = [];

  beforeEach(() => {
    idbState.dbs.clear();
    transportState.blockHttp.clear();
    resetCrossHostFolderOrderCache();
    installBrowserGlobals();
  });

  afterEach(async () => {
    for (const coord of coordinators.splice(0)) coord.dispose();
    for (const c of connections.splice(0)) c.close();
    for (const ws of transportState.sockets) ws.terminate();
    transportState.sockets.clear();
    for (const h of hubs.splice(0)) await h.close();
    resetCrossHostFolderOrderCache();
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("performs one-time migration upload and live 2-device sync across 2 owner Hubs", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-cross-order-2dev-"));
    const hubA = await HubServer.start({ stateDir: path.join(root, "a") });
    const hubB = await HubServer.start({ stateDir: path.join(root, "b") });
    hubs.push(hubA, hubB);

    const keyA = hubA.auth.publicKey;
    const keyB = hubB.auth.publicKey;

    // Pre-upgrade local order (no updatedAt) on Device 1 before first sync.
    const preUpgrade = {
      version: 1 as const,
      pinned: [k(keyB, "f3")],
      ordinary: [k(keyA, "f1"), k(keyB, null), k(keyA, null)],
    };
    localStorage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify(preUpgrade));
    resetCrossHostFolderOrderCache();

    const dev1A = await createPairedDevice(hubA, "dev1-a", "db-1a");
    const dev1B = await createPairedDevice(hubB, "dev1-b", "db-1b");
    const dev2A = await createPairedDevice(hubA, "dev2-a", "db-2a");
    const dev2B = await createPairedDevice(hubB, "dev2-b", "db-2b");

    const conn1A = new HubConnection(dev1A.identity, dev1A.cache);
    const conn1B = new HubConnection(dev1B.identity, dev1B.cache);
    const conn2A = new HubConnection(dev2A.identity, dev2A.cache);
    const conn2B = new HubConnection(dev2B.identity, dev2B.cache);
    connections.push(conn1A, conn1B, conn2A, conn2B);

    await Promise.all([conn1A.start(), conn1B.start(), conn2A.start(), conn2B.start()]);
    await vi.waitFor(() => {
      expect(conn1A.state.status).toBe("online");
      expect(conn1B.state.status).toBe("online");
      expect(conn2A.state.status).toBe("online");
      expect(conn2B.state.status).toBe("online");
    });

    const sync1 = new CrossHostFolderOrderSync(makeSource([conn1A, conn1B]));
    coordinators.push(sync1);
    await sync1.syncNow();

    // Both Hubs received Device 1's pre-upgrade order, and Device 2 received live WS updates!
    await vi.waitFor(() => {
      expect(conn1A.state.crossHostFolderOrder?.revision).toBe(1);
      expect(conn1B.state.crossHostFolderOrder?.revision).toBe(1);
      expect(conn2A.state.crossHostFolderOrder?.revision).toBe(1);
      expect(conn2B.state.crossHostFolderOrder?.revision).toBe(1);
    });
    expect(conn2A.state.crossHostFolderOrder?.pinned).toEqual(preUpgrade.pinned);
    expect(conn2B.state.crossHostFolderOrder?.ordinary).toEqual(preUpgrade.ordinary);

    // Device 1 makes a new reorder -> both Hubs and Device 2 update live.
    const nextOrder = {
      version: 1 as const,
      pinned: [],
      ordinary: [k(keyB, "f3"), k(keyA, "f1"), k(keyA, null), k(keyB, null)],
    };
    writeCrossHostFolderOrder(nextOrder);
    await vi.waitFor(() => {
      expect(conn2A.state.crossHostFolderOrder?.revision).toBe(2);
      expect(conn2B.state.crossHostFolderOrder?.revision).toBe(2);
    });
    expect(conn2A.state.crossHostFolderOrder?.ordinary).toEqual(nextOrder.ordinary);
    expect(conn2B.state.crossHostFolderOrder?.ordinary).toEqual(nextOrder.ordinary);

    // Switch local client storage to fresh Device 2 -> Device 2 adopts Hub's synced order even if Device 2 had stale pre-upgrade local data.
    sync1.dispose();
    idbState.dbs.get("tarocub-hosts-v1")?.get("meta")?.clear();
    localStorage.setItem(CROSS_HOST_FOLDER_ORDER_KEY, JSON.stringify({
      version: 1,
      pinned: [],
      ordinary: [k(keyA, "old-local")],
    }));
    resetCrossHostFolderOrderCache();
    const sync2 = new CrossHostFolderOrderSync(makeSource([conn2A, conn2B]));
    coordinators.push(sync2);
    await sync2.syncNow();
    expect(readCrossHostFolderOrder().ordinary).toEqual(nextOrder.ordinary);
    expect(readCrossHostFolderOrder().updatedAt).toBe(conn2A.state.crossHostFolderOrder?.updatedAt);
  });

  it("reconciles offline changes on reconnect with LWW and propagates newer state to lagging Hubs", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-cross-order-offline-"));
    const hubA = await HubServer.start({ stateDir: path.join(root, "a") });
    const hubB = await HubServer.start({ stateDir: path.join(root, "b") });
    hubs.push(hubA, hubB);
    const keyA = hubA.auth.publicKey;
    const keyB = hubB.auth.publicKey;

    const devA = await createPairedDevice(hubA, "dev-a", "db-a");
    const devB = await createPairedDevice(hubB, "dev-b", "db-b");
    const otherDevA = await createPairedDevice(hubA, "other-a", "db-other-a");
    const connA = new HubConnection(devA.identity, devA.cache);
    const connB = new HubConnection(devB.identity, devB.cache);
    const connOtherA = new HubConnection(otherDevA.identity, otherDevA.cache);
    connections.push(connA, connB, connOtherA);

    await Promise.all([connA.start(), connB.start(), connOtherA.start()]);
    await vi.waitFor(() => {
      expect(connA.state.status).toBe("online");
      expect(connB.state.status).toBe("online");
      expect(connOtherA.state.status).toBe("online");
    });

    const sync = new CrossHostFolderOrderSync(makeSource([connA, connB]));
    coordinators.push(sync);

    const t1 = Date.now();
    writeCrossHostFolderOrder({
      version: 1,
      pinned: [],
      ordinary: [k(keyA, "f1"), k(keyB, "f2")],
    }, { updatedAt: t1 });
    await vi.waitFor(() => {
      expect(connA.state.crossHostFolderOrder?.updatedAt).toBe(t1);
      expect(connB.state.crossHostFolderOrder?.updatedAt).toBe(t1);
    });

    // Simulate Device 1 offline while editing ONLY Hub B offline? No, both connections closed while offline!
    connA.close();
    connB.close();

    // Case 1: Other device pushes a NEWER edit (t1 + 5000) to Hub A while Device 1 made an OLDER offline edit (t1 + 1000).
    writeCrossHostFolderOrder({
      version: 1,
      pinned: [],
      ordinary: [k(keyB, "f2"), k(keyA, "f1")],
    }, { updatedAt: t1 + 1000 });
    await flushCrossHostFolderOrderPersistence();

    const newerOrder = [k(keyB, "f2"), k(keyA, "f1"), k(keyA, null)];
    await connOtherA.saveCrossHostFolderOrder({
      updatedAt: t1 + 5000,
      pinned: [k(keyA, "pin1")],
      ordinary: newerOrder,
    }, 1);

    // Reconnect Device 1 -> Device 1 adopts Hub A's newer t1+5000 AND propagates it to lagging Hub B!
    const devA2 = new HubConnection(devA.identity, devA.cache);
    const devB2 = new HubConnection(devB.identity, devB.cache);
    connections.push(devA2, devB2);
    await Promise.all([devA2.start(), devB2.start()]);
    await vi.waitFor(() => {
      expect(devA2.state.status).toBe("online");
      expect(devB2.state.status).toBe("online");
    });
    const sync2 = new CrossHostFolderOrderSync(makeSource([devA2, devB2]));
    coordinators.push(sync2);
    await sync2.syncNow();

    expect(readCrossHostFolderOrder()).toMatchObject({
      pinned: [k(keyA, "pin1")],
      ordinary: newerOrder,
      updatedAt: t1 + 5000,
    });
    expect(devB2.state.crossHostFolderOrder).toMatchObject({
      pinned: [k(keyA, "pin1")],
      ordinary: newerOrder,
      updatedAt: t1 + 5000,
    });

    // Case 2: Device 1 goes offline and makes a NEWER edit (t1 + 10_000), then reconnects -> Device 1 wins!
    devA2.close();
    devB2.close();
    const offlineWinner = [k(keyA, "f1"), k(keyB, "f2"), k(keyB, null)];
    writeCrossHostFolderOrder({
      version: 1,
      pinned: [],
      ordinary: offlineWinner,
    }, { updatedAt: t1 + 10_000 });

    const devA3 = new HubConnection(devA.identity, devA.cache);
    const devB3 = new HubConnection(devB.identity, devB.cache);
    connections.push(devA3, devB3);
    await Promise.all([devA3.start(), devB3.start()]);
    await vi.waitFor(() => {
      expect(devA3.state.status).toBe("online");
      expect(devB3.state.status).toBe("online");
    });
    const sync3 = new CrossHostFolderOrderSync(makeSource([devA3, devB3]));
    coordinators.push(sync3);
    await sync3.syncNow();

    expect(devA3.state.crossHostFolderOrder?.ordinary).toEqual(offlineWinner);
    expect(devB3.state.crossHostFolderOrder?.ordinary).toEqual(offlineWinner);
    expect(devA3.state.crossHostFolderOrder?.updatedAt).toBe(t1 + 10_000);
  });

  it("ignores legacy Hubs without capability and non-owner member Hubs without errors", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-cross-order-compat-"));
    const ownerHub = await HubServer.start({ stateDir: path.join(root, "owner") });
    const memberHub = await HubServer.start({ stateDir: path.join(root, "member") });
    hubs.push(ownerHub, memberHub);
    await memberHub.store.db.run("INSERT INTO users VALUES('member','Member','member')");

    const devOwner = await createPairedDevice(ownerHub, "dev-owner", "db-owner", "owner");
    const devMember = await createPairedDevice(memberHub, "dev-member", "db-member", "member");
    const connOwner = new HubConnection(devOwner.identity, devOwner.cache);
    const connMember = new HubConnection(devMember.identity, devMember.cache);
    connections.push(connOwner, connMember);

    await Promise.all([connOwner.start(), connMember.start()]);
    await vi.waitFor(() => {
      expect(connOwner.state.status).toBe("online");
      expect(connMember.state.status).toBe("online");
    });

    // Simulate legacy Hub by clearing capability flag on a third connection state check.
    const legacyStateSpy = { ...connOwner.state, crossHostFolderOrderAvailable: false };
    expect(legacyStateSpy.crossHostFolderOrderAvailable).toBe(false);

    const sync = new CrossHostFolderOrderSync(makeSource([connOwner, connMember]));
    coordinators.push(sync);

    writeCrossHostFolderOrder({
      version: 1,
      pinned: [],
      ordinary: [k(ownerHub.auth.publicKey, "f1"), k(memberHub.auth.publicKey, "f2")],
    });
    await sync.syncNow();

    // Owner Hub synced, while member Hub was left untouched (revision 0).
    expect(connOwner.state.crossHostFolderOrder?.revision).toBe(1);
    expect(connMember.state.crossHostFolderOrder?.revision).toBe(0);
    writeCrossHostFolderOrder(emptyCrossHostFolderOrder(), { fromSync: true });
  });

  it("mirrors order into IndexedDB tarocub-hosts-v1 meta and recovers when localStorage is wiped", async () => {
    const sourceA = {
      hostId: "a",
      hostKey: "keyA",
      hostName: "Host Alpha",
      folders: { revision: 1, folders: [{ id: "a1", name: "A1" }], assignments: [] },
      online: true,
      foldersAuthoritative: true,
    };
    const sourceB = {
      hostId: "b",
      hostKey: "keyB",
      hostName: "Host Beta",
      folders: { revision: 1, folders: [{ id: "b1", name: "B1" }], assignments: [] },
      online: true,
      foldersAuthoritative: true,
    };
    applyCrossHostFolderMove([sourceA, sourceB], k("keyB", "b1"), "top");
    await flushCrossHostFolderOrderPersistence();

    const savedJson = idbState.dbs.get("tarocub-hosts-v1")?.get("meta")?.get(CROSS_HOST_FOLDER_ORDER_KEY);
    expect(typeof savedJson).toBe("string");
    const saved = JSON.parse(savedJson as string);
    expect(saved.ordinary[0]).toBe(k("keyB", "b1"));
    expect(saved.updatedAt).toBeGreaterThan(0);

    // Wipe localStorage while IndexedDB retains the mirrored order.
    localStorage.clear();
    resetCrossHostFolderOrderCache();
    const recovered = await readyCrossHostFolderOrder();
    expect(recovered.ordinary[0]).toBe(k("keyB", "b1"));
    expect(recovered.updatedAt).toBe(saved.updatedAt);
    expect(JSON.parse(localStorage.getItem(CROSS_HOST_FOLDER_ORDER_KEY)!)).toEqual(saved);
  });
});
