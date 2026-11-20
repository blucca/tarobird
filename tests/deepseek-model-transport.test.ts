import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { hashSecret } from "../src/hub/auth.js";
import { instanceFrameSchema, botRuntimeStatusSchema } from "../src/client-protocol/instance.js";
import { dispatchTicketRequestSchema, ticketAttemptSchema, conversationTicketSchema } from "../src/client-protocol/dispatch.js";
import { encodeDeepSeekModel } from "../src/codex/deepseek-models.js";

const model = encodeDeepSeekModel("provider/route", "family/" + "x".repeat(140) + "%");
it("keeps complete DeepSeek model identity through hello and heartbeat without widening other engines", () => {
  const status = { engine: "deepseek", model, effort: "off" };
  expect(botRuntimeStatusSchema.parse(status)).toEqual(status);
  expect(instanceFrameSchema.parse({ v: 1, type: "instance.hello", botId: "bot", secret: "s".repeat(43), ...status })).toMatchObject(status);
  expect(instanceFrameSchema.parse({ v: 1, type: "ping", status })).toMatchObject({ status });
  for (const engine of ["codex", "claude", "kimi", "antigravity"]) expect(botRuntimeStatusSchema.safeParse({ ...status, engine }).success).toBe(false);
  expect(botRuntimeStatusSchema.safeParse({ ...status, model: "x".repeat(513) }).success).toBe(false);
});

it("preserves an explicit DeepSeek model and off through ticket request, ledger and conversation metadata", () => {
  const request = { requestId: "request", ticketId: "ticket", engine: "deepseek", model, effort: "off" };
  expect(dispatchTicketRequestSchema.parse(request)).toEqual(request);
  expect(ticketAttemptSchema.parse({ id: "attempt", conversationId: "chat", inputMessageId: "input", startedAt: 1, botId: "bot", engine: "deepseek", model, effort: "off" })).toMatchObject({ model, effort: "off" });
  expect(conversationTicketSchema.parse({ id: "ticket", dispatcherBotId: "chief", model, effort: "off" })).toMatchObject({ model, effort: "off" });
  for (const engine of ["codex", "claude", "kimi", "antigravity"]) {
    expect(dispatchTicketRequestSchema.safeParse({ ...request, engine }).success).toBe(false);
    expect(dispatchTicketRequestSchema.safeParse({ ...request, model: "plain", engine }).success).toBe(false);
  }
  for (const value of ["-option", "provider/model;command", "provider/model\ncommand", "x".repeat(513)]) expect(dispatchTicketRequestSchema.safeParse({ ...request, model: value }).success).toBe(false);
});

it("loads and refreshes a long DeepSeek model on the actual authenticated Gateway connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-model-status-"));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const stateDir = path.join(root, "bot"), secret = randomBytes(32).toString("base64url");
  await mkdir(stateDir);
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Example',?,'deepseek')", [hashSecret(secret)]);
  const config = path.join(stateDir, "config.json");
  const transport = new GatewayTransport({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "bot", secret, engine: "deepseek" });
  try {
    await writeFile(config, JSON.stringify({ engine: "deepseek", model, effort: "off" }));
    await transport.connect();
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.model).toBe(model);
    const next = encodeDeepSeekModel("next/provider", "y".repeat(150));
    await writeFile(config, JSON.stringify({ engine: "deepseek", model: next, effort: "medium" }));
    await transport.refreshStatus();
    await expect.poll(async () => (await hub.store.bots("owner"))[0]?.model).toBe(next);
  } finally { await transport.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
