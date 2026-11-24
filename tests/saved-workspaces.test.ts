import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { buildCoreConversationKey } from "../src/core/message-normalizer.js";
import { HubWorkspaceDiff, type WorkspaceGitCommand } from "../src/hub/workspace-diff.js";
import { workspaceDisplayName } from "../src/client-protocol/saved-workspaces.js";
import type { CoreBridgeLike } from "../src/core/types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setupHub() {
  const root = await mkdtemp(path.join(os.tmpdir(), "saved-ws-"));
  roots.push(root);
  const hubDir = path.join(root, "hub");
  const botDir = path.join(root, "bot-state");
  const folderA = path.join(root, "project-alpha");
  const folderB = path.join(root, "project-beta");
  const folderC = path.join(root, "project-gamma");
  const nestedDir = path.join(folderA, "packages");
  await Promise.all([
    mkdir(hubDir, { recursive: true }),
    mkdir(botDir, { recursive: true }),
    mkdir(nestedDir, { recursive: true }),
    mkdir(folderB, { recursive: true }),
    mkdir(folderC, { recursive: true }),
  ]);
  await writeFile(path.join(botDir, "config.json"), JSON.stringify({ engine: "codex", workspacePath: folderA }, null, 2));
  const hub = await HubServer.start({ stateDir: hubDir, host: "127.0.0.1", port: 0 });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run(
    "INSERT INTO bots(id,name,secret_hash,engine,model,effort,online) VALUES(?,?,?,?,?,?,0)",
    ["bot1", "Codex Bot", hashSecret(secret), "codex", "gpt-5", "medium"],
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const deviceId = "dev_owner_" + randomBytes(4).toString("hex");
  const pairing = await hub.auth.pair({ deviceId, name: "Owner Mac", platform: "macos", publicKey: pub }, "test");
  await hub.auth.approve(pairing.code, "local-owner");
  const nonce = randomBytes(32).toString("base64url");
  const challenge = await hub.auth.challenge(deviceId, deviceId, nonce, "test");
  const session = await hub.auth.authenticate(deviceId, sign(null, deviceProof(deviceId, challenge.nonce, nonce), privateKey).toString("base64"));
  const token = session.token;
  const api = async <T = unknown>(route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${hub.url}${route}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    return { status: res.status, body: body as T };
  };
  return { root, hub, hubDir, botDir, folderA, folderB, folderC, nestedDir, secret, deviceId, privateKey, token, api };
}

describe("saved workspaces (#91)", () => {
  it("formats workspace display names cleanly for POSIX and Windows paths", () => {
    expect(workspaceDisplayName("/srv/projects/alpha")).toBe("alpha");
    expect(workspaceDisplayName("/srv/projects/alpha/")).toBe("alpha");
    expect(workspaceDisplayName("D:\\work\\beta\\")).toBe("beta");
    expect(workspaceDisplayName("/")).toBe("/");
    expect(workspaceDisplayName("")).toBe("");
  });

  it("supports saved workspaces CRUD and Host directory browsing", async () => {
    const ctx = await setupHub();
    try {
      const browse = await ctx.api<{ path: string; parent: string | null; entries: Array<{ name: string; path: string }> }>(
        `/api/workspaces/browse?path=${encodeURIComponent(ctx.root)}`,
      );
      expect(browse.status).toBe(200);
      expect(browse.body.path).toBe(path.resolve(ctx.root));
      expect(browse.body.entries.map(e => e.name)).toEqual(expect.arrayContaining(["project-alpha", "project-beta", "project-gamma"]));

      const badAdd = await ctx.api("/api/workspaces", { method: "POST", body: JSON.stringify({ path: path.join(ctx.root, "does-not-exist") }) });
      expect(badAdd.status).toBe(400);

      const addedA = await ctx.api<{ workspace: { id: string; name: string; path: string }; items: Array<{ id: string; name: string; path: string }> }>(
        "/api/workspaces",
        { method: "POST", body: JSON.stringify({ path: ctx.folderA }) },
      );
      expect(addedA.status).toBe(201);
      expect(addedA.body.workspace).toMatchObject({ name: "project-alpha", path: path.resolve(ctx.folderA) });

      const addedB = await ctx.api<{ workspace: { id: string; name: string; path: string }; items: Array<{ id: string; name: string; path: string }> }>(
        "/api/workspaces",
        { method: "POST", body: JSON.stringify({ path: ctx.folderB, name: "Beta App" }) },
      );
      expect(addedB.status).toBe(201);
      expect(addedB.body.workspace).toMatchObject({ name: "Beta App", path: path.resolve(ctx.folderB) });
      expect(addedB.body.items[0]!.path).toBe(path.resolve(ctx.folderB));

      const removed = await ctx.api<{ items: Array<{ id: string }> }>(
        `/api/workspaces/${encodeURIComponent(addedA.body.workspace.id)}`,
        { method: "DELETE" },
      );
      expect(removed.status).toBe(200);
      expect(removed.body.items.map(i => i.id)).toEqual([addedB.body.workspace.id]);
    } finally {
      await ctx.hub.close();
    }
  });

  it("switches a Bot default workspace, keeps earlier conversations pinned, and runs two conversations in different folders concurrently", async () => {
    const ctx = await setupHub();
    const seenByConversation = new Map<string, string[]>();
    const activeByConversation = new Map<string, { workspace?: string; resolve: () => void }>();
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>(resolve => { releaseBoth = resolve; });
    let holdConcurrent = false;
    const listedCwds: Array<string | undefined> = [];

    const bridge: CoreBridgeLike = {
      checkAccess: async () => ({ kind: "allow" }),
      handleAuthorizedMessage: async (input) => {
        const key = input.conversationKey ?? "";
        seenByConversation.set(key, [...(seenByConversation.get(key) ?? []), input.workspaceOverride ?? ""]);
        if (holdConcurrent) {
          await new Promise<void>(resolve => {
            activeByConversation.set(key, { workspace: input.workspaceOverride, resolve });
            if (activeByConversation.size === 2) releaseBoth();
          });
        }
        return { text: `ran in ${path.basename(input.workspaceOverride ?? "")}` };
      },
      listExternalSessions: async (input) => {
        listedCwds.push(input?.cwd);
        return [];
      },
    };
    const runtime = createCoreServiceRuntime();
    const channel = await attachGateway({
      url: `${(ctx.hub.instanceUrl || ctx.hub.url).replace(/^http/, "ws")}/instance`,
      botId: "bot1",
      secret: ctx.secret,
      stateDir: ctx.botDir,
      engine: "codex",
      bridge,
      runtime,
      recoverDeliveries: false,
    });
    // Wait for Bot instance handshake to complete before issuing API calls.
    await vi.waitFor(async () => {
      const bots = await ctx.hub.store.bots("owner");
      expect(bots.find(b => b.id === "bot1")?.online).toBe(1);
    }, { timeout: 5000 });

    try {
      // 1. Create Conversation 1 under Bot's initial default (folderA)
      const c1Res = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "c1", botIds: ["bot1"], title: "Chat Alpha", conversationType: "direct" }),
      });
      expect(c1Res.status).toBe(201);
      expect(c1Res.body.workspacePath).toBe(path.resolve(ctx.folderA));

      // 2. Switch Bot's default workspace to folderB via HTTP API (no commands)
      const wsGet = await ctx.api<{ revision: string; workspacePath: string }>("/api/bots/bot1/workspace");
      expect(wsGet.status).toBe(200);
      expect(wsGet.body.workspacePath).toBe(path.resolve(ctx.folderA));

      const wsPut = await ctx.api<{ revision: string; workspacePath: string }>("/api/bots/bot1/workspace", {
        method: "PUT",
        body: JSON.stringify({ revision: wsGet.body.revision, workspacePath: ctx.folderB }),
      });
      expect(wsPut.status).toBe(200);
      expect(wsPut.body.workspacePath).toBe(path.resolve(ctx.folderB));

      // 3. New Conversation 2 uses the Bot's new default (folderB)
      const c2Res = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "c2", botIds: ["bot1"], title: "Chat Beta", conversationType: "direct" }),
      });
      expect(c2Res.status).toBe(201);
      expect(c2Res.body.workspacePath).toBe(path.resolve(ctx.folderB));

      // 4. New Conversation 3 picks folderC explicitly for just this conversation
      const c3Res = await ctx.api<{ id: string; workspacePath?: string }>("/api/conversations", {
        method: "POST",
        body: JSON.stringify({ v: 1, type: "conversation.create", clientActionId: "c3", botIds: ["bot1"], title: "Chat Gamma", conversationType: "direct", workspacePath: ctx.folderC }),
      });
      expect(c3Res.status).toBe(201);
      expect(c3Res.body.workspacePath).toBe(path.resolve(ctx.folderC));

      // 5. Run Conversation 1 (original folderA) and Conversation 3 (folderC) CONCURRENTLY on the same Bot!
      holdConcurrent = true;
      await ctx.hub.store.sendMessage("owner", { conversationId: c1Res.body.id, clientMsgId: "m1", text: "hello alpha", attachments: [] });
      await ctx.hub.store.sendMessage("owner", { conversationId: c3Res.body.id, clientMsgId: "m3", text: "hello gamma", attachments: [] });
      await Promise.race([
        bothArrived,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for concurrent turns")), 5000)),
      ]);
      const activeWorkspaces = [...activeByConversation.values()].map(v => v.workspace).sort();
      expect(activeWorkspaces).toEqual([path.resolve(ctx.folderA), path.resolve(ctx.folderC)].sort());
      for (const entry of activeByConversation.values()) entry.resolve();

      // Wait briefly for turns to settle, then verify c2 runs in folderB
      holdConcurrent = false;
      await ctx.hub.store.sendMessage("owner", { conversationId: c2Res.body.id, clientMsgId: "m2", text: "hello beta", attachments: [] });
      await vi.waitFor(() => {
        expect(seenByConversation.get(buildCoreConversationKey(c2Res.body.id)) ?? []).toContain(path.resolve(ctx.folderB));
      }, { timeout: 5000 });

      // Earlier Conversation 1 STILL ran in folderA even after default switched to folderB
      expect(seenByConversation.get(buildCoreConversationKey(c1Res.body.id))).toEqual([path.resolve(ctx.folderA)]);
      expect(seenByConversation.get(buildCoreConversationKey(c3Res.body.id))).toEqual([path.resolve(ctx.folderC)]);
    } finally {
      await channel.disconnect();
      await ctx.hub.close();
    }
  });

  it("pins HubWorkspaceDiff to the conversation's folder rather than the Bot's switched default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "diff-conv-ws-"));
    roots.push(root);
    const state = path.join(root, "bot");
    const repoDefault = path.join(root, "repo-default");
    const repoPinned = path.join(root, "repo-pinned");
    await Promise.all([
      mkdir(state, { recursive: true }),
      mkdir(path.join(repoDefault, ".git", "objects", "info"), { recursive: true }),
      mkdir(path.join(repoPinned, ".git", "objects", "info"), { recursive: true }),
    ]);
    await writeFile(path.join(state, "config.json"), JSON.stringify({ workspacePath: repoDefault }));
    await writeFile(path.join(repoPinned, "pinned.txt"), "hello\n");

    const seenCwds: string[] = [];
    const ok = (stdout = "") => ({ stdout: Buffer.from(stdout), code: 0, stderr: "", limited: false });
    const runGit: WorkspaceGitCommand = async (cwd, args) => {
      seenCwds.push(cwd);
      if (args[0] === "config") return ok("core.repositoryformatversion\n0\0");
      if (args[0] === "rev-parse") {
        if (args.includes("--show-toplevel")) return ok(`${repoPinned}\n`);
        if (args.includes("--absolute-git-dir")) return ok(`${path.join(repoPinned, ".git")}\n`);
        if (args.includes("--git-common-dir")) return ok(`${path.join(repoPinned, ".git")}\n`);
        if (args.includes("--is-bare-repository")) return ok("false\n");
        if (args.includes("--show-prefix")) return ok("\n");
        return ok(`${"a".repeat(40)}\n`);
      }
      if (args[0] === "status") return ok("? pinned.txt\0");
      throw new Error(`unexpected git ${args.join(" ")}`);
    };

    const diff = new HubWorkspaceDiff(async () => state, {
      runGit,
      conversationWorkspace: async (conversationId) => conversationId === "conv-pinned" ? repoPinned : undefined,
    });
    const list = await diff.list({ conversationId: "conv-pinned", botId: "bot1" }, new AbortController().signal, async () => {});
    expect(list.state).toBe("ready");
    expect(list.items.map(i => i.path)).toEqual(["pinned.txt"]);
    expect(seenCwds.every(c => c.includes("repo-pinned"))).toBe(true);
  });
});
