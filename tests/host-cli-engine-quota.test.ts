import { it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runHostCli } from "../src/host-cli/cli.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { startHubControl } from "../src/hub/service.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { unavailableQuota } from "../src/codex/account-quota.js";
import { quotaDirectorySchema } from "../src/client-protocol/engine-quota.js";

// Real Hub, Gateways and CLI process entry; synthetic quota replies only, no engine or model call.
it("engines quota explains reasons on standard error in normal mode and keeps --json output machine-only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobird-quota-cli-"));
  await initializeHost(root, "Quota CLI fixture");
  const hub = await HubServer.start({ stateDir: root }), gateways = [];
  const replies = { coder: unavailableQuota("codex", "login_required"), writer: unavailableQuota("claude", "scope_unverifiable") };
  let turns = 0;
  for (const [id, name, engine] of [["coder", "Coding Bot", "codex"], ["writer", "Writing Bot", "claude"]] as const) {
    const stateDir = path.join(root, id), secret = randomBytes(32).toString("base64url"); await mkdir(stateDir);
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine }));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, name, hashSecret(secret)]);
    gateways.push(await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", secret, botId: id, engine, runtime: createCoreServiceRuntime(), bridge: {
      handleAuthorizedMessage: async () => { turns++; throw new Error("quota_must_not_send_a_turn"); },
      readAccountQuota: async () => ({ revision: `${id}_rev`, snapshot: replies[id] }),
    } }));
  }
  const control = await startHubControl(root, { running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }, () => {}, { enrollController: value => hub.enrollLocalController(value) });
  const local = await LocalHostClient.connect(root, { enroll: true });
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await runHostCli(["engines", "quota", "--state-dir", root]);
    const human = quotaDirectorySchema.parse(JSON.parse(log.mock.calls.at(-1)![0] as string));
    const notes = error.mock.calls.map(call => String(call[0])).join("\n");
    expect(human.scopes.map(scope => scope.reason).sort()).toEqual(["login_required", "scope_unverifiable"]);
    expect(notes).toContain("Coding Bot（Codex）：需要登录 — 请先在运行主机上完成引擎登录，再刷新。 / Sign-in required — Sign in to the engine on the Host, then refresh.");
    expect(notes).toContain("刷新 / Refresh: tarobird engines quota --bot coder --refresh --revision coder_rev");
    expect(notes).toContain("Writing Bot（Claude Code）：尚无数据 — Claude Code 的凭据来源无法由公开接口核实");
    expect(notes).toMatch(/官方查看.*\/usage/);
    expect(notes).not.toMatch(/login_required|scope_unverifiable/);
    error.mockClear();
    await runHostCli(["engines", "quota", "--state-dir", root, "--json"]);
    expect(quotaDirectorySchema.parse(JSON.parse(log.mock.calls.at(-1)![0] as string)).scopes.map(scope => scope.reason).sort()).toEqual(["login_required", "scope_unverifiable"]);
    expect(error).not.toHaveBeenCalled();
    error.mockClear();
    await runHostCli(["engines", "quota", "--bot", "coder", "--state-dir", root]);
    expect(error.mock.calls.map(call => String(call[0])).join("\n")).toContain("Coding Bot（Codex）：需要登录");
    expect(turns).toBe(0);
  } finally {
    log.mockRestore(); error.mockRestore(); local.close();
    for (const gateway of gateways) await gateway.disconnect();
    await control(); await hub.close(); await rm(root, { recursive: true, force: true });
  }
});
