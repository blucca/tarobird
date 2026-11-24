import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HubWorkspaceFiles } from "../src/hub/workspace-files.js";
import { WORKSPACE_FILES_CAPABILITY } from "../src/client-protocol/workspace-files.js";
import { CAPABILITIES, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";

const tempDirs: string[] = [];
async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Workspace read-only file tree and preview (#99)", () => {
  it("advertises workspace.files.v1 capability", () => {
    expect(SERVER_CAPABILITIES).toContain(WORKSPACE_FILES_CAPABILITY);
  });

  it("lists workspace tree lazily, sorts dirs before files, flags heavy and sensitive entries, and blocks symlink escapes", async () => {
    const root = await makeTemp("ws-files-root-");
    const outside = await makeTemp("ws-files-outside-");
    const stateDir = path.join(root, "bot-state");
    const workspace = path.join(root, "project");
    await mkdir(stateDir, { recursive: true });
    await mkdir(path.join(workspace, "src", "components"), { recursive: true });
    await mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ workspacePath: workspace }));
    await writeFile(path.join(workspace, "README.md"), "# Demo Project\n\nHello world.\n");
    await writeFile(path.join(workspace, ".env"), "SECRET_KEY=top-secret-value\n");
    await writeFile(path.join(workspace, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(path.join(workspace, "src", "components", "App.tsx"), "export function App() { return null; }\n");
    await writeFile(path.join(outside, "secret.txt"), "outside-secret");
    await symlink(path.join(outside, "secret.txt"), path.join(workspace, "escape-link.txt"));
    await symlink(outside, path.join(workspace, "escape-dir"));

    const service = new HubWorkspaceFiles(async () => stateDir);
    const scope = { conversationId: "conv_1", botId: "bot_1" };
    const authorize = async () => {};
    const signal = new AbortController().signal;

    const top = await service.list(scope, "", signal, authorize);
    expect(top.workspaceName).toBe("project");
    expect(top.path).toBe("");
    const names = top.entries.map((entry) => entry.name);
    // Directories appear before files; heavy dirs (.git, node_modules) are flagged
    expect(names.indexOf("src")).toBeLessThan(names.indexOf("README.md"));
    const nodeModules = top.entries.find((e) => e.name === "node_modules");
    expect(nodeModules).toMatchObject({ kind: "dir", heavy: true });
    const gitDir = top.entries.find((e) => e.name === ".git");
    expect(gitDir).toMatchObject({ kind: "dir", heavy: true });
    const envFile = top.entries.find((e) => e.name === ".env");
    expect(envFile).toMatchObject({ kind: "file", sensitive: true });

    // Lazy subdirectory listing
    const src = await service.list(scope, "src", signal, authorize);
    expect(src.entries.map((e) => e.path)).toEqual(["src/components", "src/index.ts"]);

    // Preview markdown & code
    const md = await service.preview(scope, "README.md", false, signal, authorize);
    expect(md).toMatchObject({ kind: "text", markdown: true, content: "# Demo Project\n\nHello world.\n" });
    const ts = await service.preview(scope, "src/index.ts", false, signal, authorize);
    expect(ts).toMatchObject({ kind: "text", language: "typescript", content: "export const answer = 42;\n" });

    // Sensitive file requires explicit reveal
    const gated = await service.preview(scope, ".env", false, signal, authorize);
    expect(gated).toMatchObject({ kind: "sensitive", path: ".env" });
    expect((gated as Record<string, unknown>).content).toBeUndefined();
    const revealed = await service.preview(scope, ".env", true, signal, authorize);
    expect(revealed).toMatchObject({ kind: "text", sensitive: true, content: "SECRET_KEY=top-secret-value\n" });

    // Symlink escapes & path traversal are strictly blocked
    await expect(service.preview(scope, "escape-link.txt", true, signal, authorize)).rejects.toThrow(/outside|symlink|invalid/);
    await expect(service.list(scope, "escape-dir", signal, authorize)).rejects.toThrow(/outside|symlink|invalid/);
    await expect(service.list(scope, "../outside", signal, authorize)).rejects.toThrow();
    await expect(service.preview(scope, "../../etc/passwd", true, signal, authorize)).rejects.toThrow();
  });

  it("serves authenticated tree and preview endpoints over HubServer", async () => {
    const stateDir = await makeTemp("ws-files-hub-");
    const workspace = await makeTemp("ws-files-work-");
    await mkdir(path.join(workspace, "docs"), { recursive: true });
    await writeFile(path.join(workspace, "docs", "guide.md"), "# Guide\n");
    const botState = path.join(stateDir, "bots", "bot1");
    await mkdir(botState, { recursive: true });
    await writeFile(path.join(botState, "config.json"), JSON.stringify({ workspacePath: workspace }));

    const hub = await HubServer.start({ stateDir });
    (hub as unknown as { botManager: unknown }).botManager = {
      owns: async (id: string) => id === "bot1",
      beginShutdown: () => {},
      close: async () => {},
      shutdownComplete: true,
    };
    try {
      const secret = randomBytes(32).toString("base64url");
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot1','Bot 1',?,'claude')", [hashSecret(secret)]);
      const conv = await hub.store.createConversation("owner", ["bot1"], "Tree test", "tree-test");

      const keys = generateKeyPairSync("ed25519");
      const pair = await hub.auth.pair({
        deviceId: "owner-dev", name: "Owner", platform: "web",
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      }, "127.0.0.1");
      await hub.auth.approve(pair.code, "local-owner");
      const challenge = await hub.auth.challenge("conn_1", "owner-dev", "n1", "127.0.0.1");
      const session = await hub.auth.authenticate("conn_1", sign(null, deviceProof("owner-dev", challenge.nonce, "n1"), keys.privateKey).toString("base64"));

      const headers = { Authorization: `Bearer ${session.token}` };
      const treeRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/tree?botId=bot1`, { headers });
      expect(treeRes.status).toBe(200);
      const tree = await treeRes.json() as { entries: Array<{ name: string; kind: string }> };
      expect(tree.entries).toEqual(expect.arrayContaining([expect.objectContaining({ name: "docs", kind: "dir" })]));

      const previewRes = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/preview?botId=bot1&path=docs%2Fguide.md`, { headers });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as { kind: string; content: string };
      expect(preview).toMatchObject({ kind: "text", content: "# Guide\n" });

      const unauth = await fetch(`${hub.url}/api/conversations/${conv.id}/workspace-files/tree?botId=bot1`);
      expect(unauth.status).toBe(401);
    } finally {
      await hub.close();
    }
  });
});
