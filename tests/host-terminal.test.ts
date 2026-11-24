import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceActionProofText } from "../src/client-protocol/device-actions.js";
import {
  HOST_TERMINAL_CAPABILITY,
  HOST_TERMINAL_CONFIGURE_PATH,
  HOST_TERMINAL_STATUS_PATH,
  HOST_TERMINALS_PATH,
  terminalConfigureText,
} from "../src/client-protocol/host-terminal.js";
import { parseAnsiOutput } from "../client/src/TerminalPanel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";

let tempRoot: string;
beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "tarobird-terminal-"));
});
afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function issueDeviceSession(hub: HubServer, deviceId: string, role: "owner" | "member") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const userId = role === "owner" ? "owner" : `user_${deviceId}`;
  if (role !== "owner") {
    await hub.store.db.run("INSERT OR IGNORE INTO users(id,name,role) VALUES(?,?,?)", [userId, deviceId, role]);
  }
  await hub.store.db.run(
    "INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen,revoked) VALUES(?,?,?,?,?,?,?,0)",
    [deviceId, userId, deviceId, "macos", pubB64, Date.now(), Date.now()],
  );
  const clientNonce = "n".repeat(43);
  const ch = await hub.auth.challenge(`conn_${deviceId}`, deviceId, clientNonce, "127.0.0.1");
  const sig = sign(null, Buffer.from(`tarocub/device/v1\0${deviceId}\0${ch.nonce}\0${clientNonce}`), privateKey).toString("base64");
  const session = await hub.auth.authenticate(`conn_${deviceId}`, sig);
  return { token: session.token, deviceId, userId, pubB64, privateKey };
}

async function signTerminalConfigure(
  hub: HubServer,
  owner: Awaited<ReturnType<typeof issueDeviceSession>>,
  command: { expectedRevision: number; enabled: boolean; grants: Array<{ deviceId: string; publicKey: string }> },
) {
  const target = createHash("sha256").update(terminalConfigureText(command)).digest("hex");
  const session = await hub.auth.authorize(owner.token, "127.0.0.1");
  const statement = await hub.auth.prepareDeviceAction({ operation: "bot-message-grant", target }, owner.token, session);
  const signature = sign(null, Buffer.from(deviceActionProofText(statement)), owner.privateKey).toString("base64");
  return { command, proof: { nonce: statement.nonce, signature } };
}

describe("Host terminal permissions, workspace cwd, lifetime, and audit (#100)", () => {
  it("parses ANSI colors and clears cleanly", () => {
    const segs = parseAnsiOutput("before\x1b[2J\x1b[32mhello\x1b[0m \x1b[1mworld\x1b[0m\r\n");
    expect(segs.map((s) => s.text).join("")).toBe("hello world\n");
    expect(segs[0]?.color).toBe("#4ade80");
    expect(segs[2]?.bold).toBe(true);
  });

  it("is off by default, enforces per-device grants, starts in conversation workspace, keeps alive across reads, ends on tab close, and records audit entries", async () => {
    const stateDir = path.join(tempRoot, "hub-terminal");
    const botWorkspace = path.join(tempRoot, "project-workspace");
    await mkdir(botWorkspace, { recursive: true });
    await mkdir(path.join(stateDir, "bots", "bot_dev"), { recursive: true });
    await writeFile(path.join(stateDir, "bots", "bot_dev", "config.json"), JSON.stringify({ engine: "codex", workspacePath: botWorkspace }));

    const hub = await HubServer.start({ stateDir });
    try {
      expect(HOST_TERMINAL_CAPABILITY).toBe("host.terminal.v1");
      await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_dev','Dev','codex','h',1)");
      const conv = await hub.store.createConversation("owner", ["bot_dev"], "Workspace Chat", "conv_term", "direct");

      const ownerDev = await issueDeviceSession(hub, "owner_mac", "owner");
      const otherDev = await issueDeviceSession(hub, "other_mac", "owner");

      // 1. Off by default: neither device is allowed and POST /api/terminals is forbidden
      const initStatus = await (await fetch(hub.url + HOST_TERMINAL_STATUS_PATH, { headers: { Authorization: `Bearer ${ownerDev.token}` } })).json() as { enabled: boolean; allowed: boolean; canManage: boolean };
      expect(initStatus.enabled).toBe(false);
      expect(initStatus.allowed).toBe(false);
      expect(initStatus.canManage).toBe(true);

      const deniedCreate = await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      });
      expect(deniedCreate.status).toBe(403);

      // 2. Owner enables terminal ONLY for ownerDev (not otherDev)
      const signed = await signTerminalConfigure(hub, ownerDev, {
        expectedRevision: 0,
        enabled: true,
        grants: [{ deviceId: ownerDev.deviceId, publicKey: ownerDev.pubB64 }],
      });
      const cfgRes = await fetch(hub.url + HOST_TERMINAL_CONFIGURE_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      expect(cfgRes.status).toBe(200);

      // otherDev still does NOT have permission
      const otherStatus = await (await fetch(hub.url + HOST_TERMINAL_STATUS_PATH, { headers: { Authorization: `Bearer ${otherDev.token}` } })).json() as { allowed: boolean };
      expect(otherStatus.allowed).toBe(false);
      const otherDenied = await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${otherDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      });
      expect(otherDenied.status).toBe(403);

      // 3. ownerDev opens 2 terminals in the conversation workspace
      const create1 = await (await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      })).json() as { terminal: { id: string; cwd: string; running: boolean } };
      expect(create1.terminal.cwd).toBe(botWorkspace);
      expect(create1.terminal.running).toBe(true);

      const create2 = await (await fetch(hub.url + HOST_TERMINALS_PATH, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: conv.id }),
      })).json() as { terminal: { id: string; cwd: string; running: boolean } };
      expect(create2.terminal.id).not.toBe(create1.terminal.id);

      // 4. Execute pwd + echo in terminal 1 and verify real output in the workspace
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/input`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerDev.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ data: "pwd && echo TAROBIRD_TERM_OK\n" }),
      });

      let collected = "";
      for (let i = 0; i < 15 && !collected.includes("TAROBIRD_TERM_OK"); i++) {
        const out = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}/output?after=0&wait=500`, {
          headers: { Authorization: `Bearer ${ownerDev.token}` },
        })).json() as { chunks: Array<{ data: string }> };
        collected = out.chunks.map((c) => c.data).join("");
      }
      expect(collected).toContain("TAROBIRD_TERM_OK");
      expect(collected).toContain(path.basename(botWorkspace));

      // 5. Re-listing (simulating panel close + reopen) still returns both running terminals
      const listed = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}?conversationId=${conv.id}`, {
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      })).json() as { sessions: Array<{ id: string; running: boolean }> };
      expect(listed.sessions.map((s) => s.id)).toEqual([create1.terminal.id, create2.terminal.id]);

      // 6. Closing tab 1 terminates only tab 1; tab 2 remains alive
      const del1 = await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create1.terminal.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      });
      expect(del1.status).toBe(200);
      const afterClose = await (await fetch(`${hub.url}${HOST_TERMINALS_PATH}?conversationId=${conv.id}`, {
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      })).json() as { sessions: Array<{ id: string }> };
      expect(afterClose.sessions.map((s) => s.id)).toEqual([create2.terminal.id]);

      // 7. Close tab 2 and verify audit log recorded policy, opened (x2), and closed (x2)
      await fetch(`${hub.url}${HOST_TERMINALS_PATH}/${create2.terminal.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ownerDev.token}` },
      });
      const audits = await hub.store.db.all<{ kind: string; actor: string }>(
        "SELECT kind, actor FROM audit_log WHERE kind LIKE 'terminal.%' ORDER BY at ASC",
      );
      expect(audits.filter((a) => a.kind === "terminal.policy")).toHaveLength(1);
      expect(audits.filter((a) => a.kind === "terminal.opened")).toHaveLength(2);
      expect(audits.filter((a) => a.kind === "terminal.closed")).toHaveLength(2);
    } finally {
      await hub.close();
    }
  });
});
