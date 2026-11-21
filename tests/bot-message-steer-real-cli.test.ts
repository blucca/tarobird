// Issue #62 acceptance with real engine CLIs. Explicit local runs only:
//   TAROBIRD_STEER_REAL_CODEX=/path/to/codex  TAROBIRD_STEER_REAL_CLAUDE=/path/to/claude
// Each engine gets a throwaway home and a fake key; every model request ends
// at the loopback fixture below. No account, credential or real model is used.
// Hub, signed Bot-message routes, Gateway, Core, Bridge, adapter and the CLI
// process are real; only the model provider is scripted.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexAdapter } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { Bridge, type AccessStoreLike } from "../src/runtime/bridge.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });
async function until(check: () => Promise<boolean> | boolean, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("real_cli_condition_timeout"); await new Promise(resolve => setTimeout(resolve, 50)); }
}
const TASK = "TASK_ONE: write a short plan.", STEER = "STEER_MARKER_TEXT: use the staging database.", FINAL = "FINAL_AFTER_STEER";

/** Holds the first model request carrying the task until released. */
function loopbackProvider(kind: "responses" | "messages") {
  const bodies: string[] = [];
  let release!: () => void, held = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = http.createServer((request, response) => {
    let raw = ""; request.on("data", chunk => { raw += chunk; });
    request.on("end", () => void (async () => {
      const route = request.url?.split("?")[0] ?? "";
      if (request.method !== "POST" || (kind === "responses" ? route !== "/v1/responses" : !route.endsWith("/v1/messages"))) { response.writeHead(404, { "content-type": "application/json" }).end("{}"); return; }
      bodies.push(raw);
      if (raw.includes("TASK_ONE") && !raw.includes("STEER_MARKER_TEXT") && !held) { held = true; await released; }
      const text = raw.includes("STEER_MARKER_TEXT") ? FINAL : "FIRST_SEGMENT";
      if (kind === "responses") {
        const id = `resp_${bodies.length}`;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const event = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("response.created", { response: { id } });
        event("response.output_item.done", { item: { type: "message", role: "assistant", id: `m_${bodies.length}`, content: [{ type: "output_text", text }] } });
        event("response.completed", { response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } });
        response.end(); return;
      }
      const body = JSON.parse(raw) as { model?: string; stream?: boolean };
      const usage = { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const message = { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: body.model ?? "fake", stop_sequence: null, usage };
      if (!body.stream) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn" })); return; }
      const frames: Array<[string, unknown]> = [
        ["message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
      ];
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }).end(frames.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    })());
  });
  return { server, bodies, release, held: () => held };
}

async function roundtrip(engine: "codex" | "claude", bin: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `bot-steer-real-${engine}-`));
  const provider = loopbackProvider(engine === "codex" ? "responses" : "messages");
  await new Promise<void>(resolve => provider.server.listen(0, "127.0.0.1", resolve));
  const port = (provider.server.address() as { port: number }).port;
  const home = path.join(root, "home"), engineHome = path.join(root, "engine"), workspace = path.join(root, "workspace"), tmp = path.join(root, "tmp"), stateDir = path.join(root, "worker");
  await Promise.all([home, engineHome, workspace, tmp, stateDir].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine, locale: "en", approvalMode: "bypass" }));
  let adapter: CodexAdapter;
  if (engine === "codex") {
    await writeFile(path.join(engineHome, "config.toml"), ['model = "fixture"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
      "[model_providers.fixture]", 'name = "Isolated loopback"', `base_url = "http://127.0.0.1:${port}/v1"`, 'wire_api = "responses"', "request_max_retries = 0", "stream_max_retries = 0", ""].join("\n"));
    adapter = new CodexAppServerAdapter(bin, workspace, { PATH: process.env.PATH, HOME: home, CODEX_HOME: engineHome, TMPDIR: tmp, LANG: "en_US.UTF-8", OPENAI_API_KEY: "sk-fake-not-real" });
  } else {
    adapter = new ClaudeStreamAdapter(bin, { workspacePath: workspace, turnInactivityTimeoutMs: 90_000, idleSweepIntervalMs: 0, childEnv: {
      PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: engineHome, TMPDIR: tmp,
      ANTHROPIC_API_KEY: "sk-ant-fake-not-a-real-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }) as unknown as CodexAdapter;
  }
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  let channel: GatewayChannel | undefined;
  cleanups.push(async () => { provider.release(); await channel?.disconnect(); await hub.close(); await adapter.destroy?.(); provider.server.closeAllConnections(); await new Promise<void>(resolve => provider.server.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('coordinator','Coordinator',?,'codex'),('worker','Worker',?,?)", [hashSecret(randomBytes(16).toString("hex")), hashSecret(secret), engine]);
  const guard = async () => undefined, host = messageHostId(hub.auth.publicKey);
  await hub.botMessages.grant({ sourceHost: host, sourceBot: "coordinator", targetBot: "worker" }, guard);
  const access: AccessStoreLike = { load: vi.fn().mockResolvedValue({ policy: "allowlist", allowlist: [], pairedUsers: [], pendingPairs: [] }), issuePairingCode: vi.fn() };
  const bridge = new Bridge(access, new SessionManager(new SessionStore(path.join(stateDir, "session.json")), adapter), adapter);
  channel = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "worker", secret, engine, bridge, runtime: createCoreServiceRuntime(), recoverDeliveries: false });
  await until(async () => (await hub.store.bots("owner")).find(bot => bot.id === "worker")?.online === 1);
  const local = (operation: string, data: Record<string, unknown>, conversation?: string) => hub.botMessages.local({ operation, host, bot: "worker", requestId: `r_${randomBytes(6).toString("hex")}`, data, ...(conversation ? { conversation } : {}) }, "coordinator", guard, true) as Promise<any>;
  const chat = await local("resolve", {});
  const task = await local("send", { text: TASK, attachments: [] }, chat.conversationId);
  // The real CLI is now answering the task; the provider holds that response.
  await until(() => provider.held(), 90_000);
  const steered = await local("send", { text: STEER, attachments: [], delivery: "steer" }, chat.conversationId);
  provider.release();
  let result: any;
  await until(async () => { result = await local("wait", { messageId: steered.messageId }, chat.conversationId); return result.status !== "pending"; }, 90_000);
  const taskResult = await local("wait", { messageId: task.messageId }, chat.conversationId);
  return { steered, result, taskResult, task, provider, hub };
}

for (const engine of ["codex", "claude"] as const) {
  const bin = engine === "codex" ? process.env.TAROBIRD_STEER_REAL_CODEX : process.env.TAROBIRD_STEER_REAL_CLAUDE;
  it.skipIf(!bin)(`merges a Bot's steer into a live real ${engine} turn and returns that turn's final reply`, async () => {
    const { steered, result, taskResult, task, provider, hub } = await roundtrip(engine, bin!);
    expect(steered).toMatchObject({ status: "steered", delivery: { requested: "steer", actual: "steered", turn: { messageId: task.messageId } } });
    // The engine's next model request carries the attributed text; it was never a separate task.
    const carrying = provider.bodies.filter(body => body.includes("STEER_MARKER_TEXT"));
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying[0]).toContain("[Host: cross-Bot message merged into THIS turn");
    expect(carrying[0]).toContain("Authenticated source identifiers");
    expect(carrying[0]).toMatch(/BOT-TEXT-[0-9a-f]{24}(\\n|\n)STEER_MARKER_TEXT/);
    expect(await hub.store.db.all("SELECT * FROM deliveries WHERE message_id=?", [steered.messageId])).toEqual([]);
    expect(result).toMatchObject({ status: "completed", delivery: { actual: "steered" }, reply: { kind: "merged_turn", turnMessageId: task.messageId } });
    expect(result.text).toContain(FINAL);
    expect(taskResult.text).toBe(result.text);
    console.log(JSON.stringify({ engine, requests: provider.bodies.length, steered: steered.delivery, waitStatus: result.status, reply: result.reply, text: result.text }));
  }, 240_000);
}
