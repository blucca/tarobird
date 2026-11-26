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
      const storeViews = new Map(STORES.map(name => [name, createStoreView(stores!.get(name)!)]));
      const db = {
        objectStoreNames: STORES,
        get: async (store: string, key: unknown) => stores!.get(store)?.get(String(key)),
        put: async (store: string, value: unknown, key?: unknown) => { stores!.get(store)?.set(String(key), value); return key; },
        delete: async (store: string, key: unknown) => { stores!.get(store)?.delete(String(key)); },
        getAll: async (store: string) => [...(stores!.get(store)?.values() ?? [])],
        getAllKeys: async (store: string) => [...(stores!.get(store)?.keys() ?? [])],
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
      return db;
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
    if (transportState.blockHttp.has(origin)) {
      throw new TypeError("offline");
    }
    return fetch(origin + reqPath, init);
  },
}));

vi.mock("../src/native.js", () => ({ nativePlatform: () => "web" }));
vi.mock("../src/share-inbox.js", () => ({ syncShareUploadLimit: async () => {} }));

import { ClientCache, type Identity } from "../src/storage.js";
import { HubConnection } from "../src/connection.js";

function installBrowserGlobals() {
  vi.stubGlobal("WebSocket", WebSocket);
  vi.stubGlobal("IDBKeyRange", {
    bound: (lower: unknown, upper: unknown) => ({ lower, upper }),
    lowerBound: (lower: unknown) => ({ lower }),
  });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", Object.assign(new EventTarget(), {
    hidden: false,
    visibilityState: "visible",
    hasFocus: () => true,
  }));
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

describe("client HubConnection conversation pin sync", () => {
  let root: string, hubs: HubServer[] = [];
  const connections: HubConnection[] = [];

  beforeEach(() => {
    idbState.dbs.clear();
    transportState.blockHttp.clear();
    installBrowserGlobals();
  });

  afterEach(async () => {
    for (const c of connections.splice(0)) c.close();
    for (const ws of transportState.sockets) ws.terminate();
    transportState.sockets.clear();
    for (const h of hubs.splice(0)) await h.close();
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("syncs group and global pins across two paired devices via one Host", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-pins-2dev-"));
    const hub = await HubServer.start({ stateDir: root });
    hubs.push(hub);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const c1 = (await hub.store.createConversation("owner", ["bot"], "Chat 1", "c1")).id;
    const c2 = (await hub.store.createConversation("owner", ["bot"], "Chat 2", "c2")).id;

    const devA = await createPairedDevice(hub, "dev-a", "db-a");
    const devB = await createPairedDevice(hub, "dev-b", "db-b");
    const connA = new HubConnection(devA.identity, devA.cache);
    const connB = new HubConnection(devB.identity, devB.cache);
    connections.push(connA, connB);

    await Promise.all([connA.start(), connB.start()]);
    await vi.waitFor(() => {
      expect({ status: connA.state.status, error: connA.state.error }).toEqual({ status: "online", error: undefined });
      expect({ status: connB.state.status, error: connB.state.error }).toEqual({ status: "online", error: undefined });
      expect(connA.state.pinsAvailable).toBe(true);
      expect(connB.state.pinsAvailable).toBe(true);
    });

    await connA.pinConversation(c1, true, "global");
    await connA.pinConversation(c2, true, "group");
    await connA.syncPins();

    await vi.waitFor(async () => {
      expect(await devB.cache.pins("global")).toEqual([c1]);
      expect(await devB.cache.pins("group")).toEqual([c2]);
    });

    await connB.pinConversation(c1, false, "global");
    await connB.syncPins();

    await vi.waitFor(async () => {
      expect(await devA.cache.pins("global")).toEqual([]);
      expect(await devA.cache.pins("group")).toEqual([c2]);
    });
  });

  it("performs one-time union upgrade merge across devices without losing existing local pins", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-pins-upgrade-"));
    const hub = await HubServer.start({ stateDir: root });
    hubs.push(hub);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const c1 = (await hub.store.createConversation("owner", ["bot"], "Chat 1", "c1")).id;
    const c2 = (await hub.store.createConversation("owner", ["bot"], "Chat 2", "c2")).id;
    const c3 = (await hub.store.createConversation("owner", ["bot"], "Chat 3", "c3")).id;

    // Pre-upgrade local pins on Device A and Device B (no conversationPins sync metadata yet).
    const devA = await createPairedDevice(hub, "dev-a", "db-upg-a");
    const devB = await createPairedDevice(hub, "dev-b", "db-upg-b");
    await devA.cache.setPinned(c1, true, "global");
    await devA.cache.setPinned(c2, true, "group");
    await devB.cache.setPinned(c3, true, "global");

    const connA = new HubConnection(devA.identity, devA.cache);
    const connB = new HubConnection(devB.identity, devB.cache);
    connections.push(connA, connB);

    await connA.start();
    await vi.waitFor(async () => {
      expect(connA.state.status).toBe("online");
      expect(connA.state.conversationPins?.globalPins).toEqual([c1]);
      expect(connA.state.conversationPins?.pins).toEqual([c2]);
    });

    await connB.start();
    await vi.waitFor(async () => {
      expect(connB.state.status).toBe("online");
      expect(await devB.cache.pins("global")).toEqual(expect.arrayContaining([c1, c3]));
      expect(await devB.cache.pins("group")).toEqual([c2]);
      expect(await devA.cache.pins("global")).toEqual(expect.arrayContaining([c1, c3]));
      expect(await devA.cache.pins("group")).toEqual([c2]);
    });

    // After upgrade migration is complete, unpinning on A removes it everywhere (no re-merge).
    await connA.pinConversation(c3, false, "global");
    await connA.syncPins();
    await vi.waitFor(async () => {
      expect(await devB.cache.pins("global")).toEqual([c1]);
    });
  });

  it("queues offline pin/unpin changes and reconciles with last-change-wins on reconnect", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-pins-offline-"));
    const hub = await HubServer.start({ stateDir: root });
    hubs.push(hub);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const c1 = (await hub.store.createConversation("owner", ["bot"], "Chat 1", "c1")).id;
    const c2 = (await hub.store.createConversation("owner", ["bot"], "Chat 2", "c2")).id;
    const c3 = (await hub.store.createConversation("owner", ["bot"], "Chat 3", "c3")).id;

    const devA = await createPairedDevice(hub, "dev-a", "db-off-a");
    const devB = await createPairedDevice(hub, "dev-b", "db-off-b");
    const connA = new HubConnection(devA.identity, devA.cache);
    const connB = new HubConnection(devB.identity, devB.cache);
    connections.push(connA, connB);

    await Promise.all([connA.start(), connB.start()]);
    await vi.waitFor(() => {
      expect(connA.state.status).toBe("online");
      expect(connB.state.status).toBe("online");
    });

    // Initial state: c1 pinned globally on both.
    await connA.pinConversation(c1, true, "global");
    await connA.syncPins();
    await vi.waitFor(async () => {
      expect(await devB.cache.pins("global")).toEqual([c1]);
    });

    // Device A goes offline.
    connA.close();
    const connAOffline = new HubConnection(devA.identity, devA.cache);
    connections.push(connAOffline);

    // Offline at t=T1: Device A pins c3 globally and pins c2 in group.
    await connAOffline.pinConversation(c3, true, "global");
    await connAOffline.pinConversation(c2, true, "group");
    expect(await devA.cache.pins("global")).toEqual([c1, c3]);
    expect(await devA.cache.pins("group")).toEqual([c2]);
    expect((await devA.cache.pendingPinChanges()).length).toBe(2);

    // Device B (online) later unpins c3? Wait: c3 wasn't pinned on B yet, so B pins c2 in group and THEN unpins c2 later!
    await new Promise(resolve => setTimeout(resolve, 15));
    await connB.pinConversation(c2, true, "group");
    await connB.syncPins();
    await new Promise(resolve => setTimeout(resolve, 15));
    await connB.pinConversation(c2, false, "group");
    await connB.syncPins();

    // Also while offline, Device A unpins c1 LATER than B's earlier pin.
    await new Promise(resolve => setTimeout(resolve, 15));
    await connAOffline.pinConversation(c1, false, "global");
    expect(await devA.cache.pins("global")).toEqual([c3]);

    // Reconnect Device A: c3 (pinned offline) stays pinned, c1 (unpinned later) becomes unpinned on B,
    // and c2 (where B unpinned later than A's offline pin) resolves to unpinned on both!
    await connAOffline.start();
    await vi.waitFor(async () => {
      expect(connAOffline.state.status).toBe("online");
      expect(await devA.cache.pendingPinChanges()).toEqual([]);
      expect(await devA.cache.pins("global")).toEqual([c3]);
      expect(await devA.cache.pins("group")).toEqual([]);
      expect(await devB.cache.pins("global")).toEqual([c3]);
      expect(await devB.cache.pins("group")).toEqual([]);
    });
  });

  it("isolates separate Hosts and stays compatible with older Hosts lacking pin sync", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "client-pins-hosts-"));
    const hubA = await HubServer.start({ stateDir: path.join(root, "a") });
    const hubB = await HubServer.start({ stateDir: path.join(root, "b") });
    hubs.push(hubA, hubB);
    for (const h of [hubA, hubB]) {
      await h.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
      await h.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same','direct','Same','owner',10,'same')");
      await h.store.db.run("INSERT INTO conversation_members VALUES('same','user','owner',0)");
      await h.store.db.run("INSERT INTO conversation_members VALUES('same','bot','bot',0)");
    }

    const devHostA = await createPairedDevice(hubA, "dev-ha", "db-host-a");
    const devHostB = await createPairedDevice(hubB, "dev-hb", "db-host-b");
    const connA = new HubConnection(devHostA.identity, devHostA.cache);
    const connB = new HubConnection(devHostB.identity, devHostB.cache);
    connections.push(connA, connB);

    await Promise.all([connA.start(), connB.start()]);
    await vi.waitFor(() => {
      expect(connA.state.status).toBe("online");
      expect(connB.state.status).toBe("online");
    });

    await connA.pinConversation("same", true, "global");
    await connA.syncPins();
    expect(await devHostA.cache.pins("global")).toEqual(["same"]);
    expect(await devHostB.cache.pins("global")).toEqual([]);
    expect(connB.state.conversationPins?.globalPins).toEqual([]);

    // Simulate an older Host (connected online without conversationPins / conversation-pins.v1).
    const oldIdentity: Identity = {
      deviceId: "old-dev",
      name: "old-dev",
      platform: "web",
      publicKey: "pub",
      hubPublicKey: "old-hub-key",
      routes: [{ name: "LAN", url: "http://127.0.0.1:1" }],
    };
    const oldCache = new ClientCache("db-old-host");
    await oldCache.saveIdentity(oldIdentity);
    const oldConn = new HubConnection(oldIdentity, oldCache);
    connections.push(oldConn);
    const httpSpy = vi.fn();
    Reflect.set(oldConn, "http", httpSpy);
    oldConn.state = { ...oldConn.state, status: "online", pinsAvailable: false };
    await expect(oldConn.pinConversation("same", true, "global")).resolves.toBeUndefined();
    await expect(oldConn.pinConversation("same", true, "group")).resolves.toBeUndefined();
    expect(httpSpy).not.toHaveBeenCalled();
    expect(await oldCache.pins("global")).toEqual(["same"]);
    expect(await oldCache.pins("group")).toEqual(["same"]);
    expect(await oldCache.pendingPinChanges()).toEqual([]);
  });
});
