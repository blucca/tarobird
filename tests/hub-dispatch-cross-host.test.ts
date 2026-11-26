import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashSecret } from "../src/hub/auth.js";
import { messageHostId } from "../src/hub/bot-messages.js";
import { desktopTls } from "../src/hub/desktop-tls.js";
import { buildBatchSummaryText, parseSplitTaskSpec, planSplitBatches } from "../src/hub/dispatch-planner.js";
import { networkId } from "../src/hub/private-network.js";
import { HubServer } from "../src/hub/server.js";
import { startHubControl } from "../src/hub/service.js";
import { loadHubTls } from "../src/hub/tls.js";
import { LocalHostClient } from "../src/host-cli/client.js";
import { initializeHost } from "../src/host-cli/setup.js";
import { runTicketsCommand } from "../src/host-cli/tickets.js";
import { networkCanonical, type NetworkManifest } from "../src/client-protocol/private-network.js";
import {
  crossHostDispatchGrantCommandSchema, defaultDispatcherSettings, dispatchNodesResponseSchema,
  type DispatchEngine, type DispatchNodeTarget, type DispatchTicket,
} from "../src/client-protocol/dispatch.js";

const owner = { kind: "owner" as const, userId: "owner" };
const ENGINES: readonly DispatchEngine[] = ["codex", "claude", "kimi", "deepseek", "antigravity"];

function makeNode(hostId: string, hostName: string, overrides: Partial<DispatchNodeTarget> = {}): DispatchNodeTarget {
  return {
    hostId,
    hostName,
    local: hostName === "macmini",
    enabled: true,
    online: true,
    authorized: true,
    preference: "normal",
    maxConcurrent: 2,
    activeOnNode: 0,
    load: {
      hostId,
      hostName,
      online: true,
      authorized: true,
      cpuCount: 8,
      cpuLoadRatio: 0.25,
      freeMemoryRatio: 0.65,
      activeTurns: 0,
      activeTickets: 0,
      engines: ENGINES.map(engine => ({
        engine,
        installed: engine !== "antigravity",
        available: engine !== "antigravity",
        quotaState: "ok",
        models: [{ id: "", efforts: [""] }],
        defaultModel: "",
        defaultEffort: "",
      })),
      observedAt: Date.now(),
    },
    eligible: true,
    score: 100,
    ...overrides,
  };
}

let root: string, aDir: string, bDir: string, a: HubServer, b: HubServer;
let macId: string, studioId: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dispatch-cross-host-"));
  aDir = path.join(root, "a");
  bDir = path.join(root, "b");
  await initializeHost(bDir, "studio-b");
  const address = Object.values(networkInterfaces()).flat().find(item => item?.family === "IPv4" && !item.internal)!.address;
  const cert = await desktopTls(root, [address]);
  const tls = await loadHubTls({ cert: cert.cert, key: cert.key });

  a = await HubServer.start({ stateDir: aDir });
  b = await HubServer.start({ stateDir: bDir, host: address, tls, exposure: "public" });
  await a.profile.update({ name: "macmini", revision: 0 });
  await b.profile.update({ name: "studio-b", revision: 0 });

  macId = messageHostId(a.auth.publicKey);
  studioId = messageHostId(b.auth.publicKey);

  // Pair A and B into a shared signed private network manifest over real TLS.
  const hosts = [
    { publicKey: a.auth.publicKey, name: "macmini", routes: [], protocol: 2 as const, state: "active" as const, revoked: false },
    { publicKey: b.auth.publicKey, name: "studio-b", routes: [{ name: "Direct" as const, url: b.url, certificateAuthority: cert.certificateAuthority }], protocol: 2 as const, state: "active" as const, revoked: false },
  ];
  const nonce = randomBytes(32).toString("base64url");
  const manifest: NetworkManifest = {
    v: 2,
    id: networkId(a.auth.publicKey, nonce),
    authorityKey: a.auth.publicKey,
    genesisNonce: nonce,
    name: "CrossHostTest",
    revision: 1,
    hosts,
    devices: [],
    revokedMembers: [],
    blockedBindings: [],
  };
  const membership = { manifest, signature: a.auth.signNetworkManifest(manifest) };
  for (const hub of [a, b]) {
    await hub.store.db.run(
      "INSERT INTO meta(key,value) VALUES('private-network:v1',?)",
      [JSON.stringify({
        v: 1,
        routes: hub === b ? hosts[1]!.routes : [],
        membership,
        imported: {},
        revokedMembers: [],
        revokedHosts: [],
        retiredNetworks: [],
        admissions: [],
        peers: [],
        proofs: [],
        intents: {},
        lastSyncedAt: Date.now(),
        waiting: false,
      })],
    );
  }

  // Dispatcher + local worker on Hub A ("macmini").
  await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('d','Chancellor',?,'claude','','','dispatcher')", [hashSecret("disp-secret")]);
  await a.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('w_local_codex','Chancellor · codex','fixture','codex','','','worker')");
  await a.store.createConversation("owner", ["d"], "Chancellor", "home");
  await a.dispatch.updateSettings("owner", "d", {
    settings: {
      ...defaultDispatcherSettings(),
      mode: "auto",
      maxConcurrent: 4,
      nodes: [
        { hostId: macId, enabled: true, maxConcurrent: 2, preference: "normal" },
        { hostId: studioId, enabled: true, maxConcurrent: 2, preference: "normal" },
      ],
    },
    expectedRevision: (await a.dispatch.settings("owner", "d")).revision,
  });

  // Remote worker on Hub B ("studio-b").
  await b.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,model,effort,role) VALUES('w_remote_codex','Remote · codex','fixture','codex','','','worker')");

  const catalogFor = () => ({ engines: ENGINES.map(id => ({ id, available: id !== "antigravity", models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" })) });
  a.dispatch.workers = {
    catalog: async () => catalogFor(),
    dispatchWorker: async (_dispatcher, engine) => (engine === "codex" ? "w_local_codex" : "w_local_codex"),
    ticketWorkspace: async (_dispatcher, ticketId) => path.join(aDir, "tickets", ticketId),
  };
  (b.dispatch as { workers: unknown }).workers = {
    catalog: async () => catalogFor(),
    dispatchWorker: async () => "w_remote_codex",
    ticketWorkspace: async (_dispatcher, ticketId) => path.join(bDir, "tickets", ticketId),
    remoteDispatchWorker: async () => "w_remote_codex",
    remoteTicketWorkspace: async (_sourceHostId: string, remoteTicketId: string) => path.join(bDir, "remote-tickets", remoteTicketId),
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  await a?.close().catch(() => undefined);
  await b?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function authorizeStudioFromMac(): Promise<void> {
  const closeCtrl = await startHubControl(
    bDir,
    { running: true, pid: process.pid, url: b.url, instanceUrl: b.instanceUrl, publicKey: b.auth.publicKey },
    () => {},
    { enrollController: value => b.enrollLocalController(value) },
  );
  const client = await LocalHostClient.connect(bDir, { enroll: true });
  try {
    const command = crossHostDispatchGrantCommandSchema.parse({
      operation: "cross-host-dispatch-grant",
      sourceHost: macId,
      sourceBot: "d",
      allowed: true,
    });
    const proof = await client.deviceAction({
      operation: "bot-message-grant",
      target: createHash("sha256").update(networkCanonical(command)).digest("hex"),
    });
    await client.request("/api/dispatch/cross-host-grants", "POST", { command, proof });
  } finally {
    client.close();
    await closeCtrl();
  }
}

it("splits N-item tasks cleanly and honors #88 preferences, quota health, and manual_only skips", () => {
  const spec = parseSplitTaskSpec("写 50 个自动化脚本，每台机器最多 10 个");
  expect(spec.totalItems).toBe(50);
  expect(spec.perNode).toBe(10);

  const mac = makeNode(`hub_${"a".repeat(64)}`, "macmini", { preference: "prefer", maxConcurrent: 2 });
  const studio = makeNode(`hub_${"b".repeat(64)}`, "studio-b", { preference: "normal", maxConcurrent: 2 });
  const manual = makeNode(`hub_${"c".repeat(64)}`, "manual-box", { preference: "manual_only" });
  const offline = makeNode(`hub_${"d".repeat(64)}`, "offline-box", { online: false, eligible: false });
  const blockedQuota = makeNode(`hub_${"e".repeat(64)}`, "blocked-box", {
    load: {
      ...makeNode(`hub_${"e".repeat(64)}`, "blocked-box").load,
      engines: ENGINES.map(engine => ({
        engine,
        installed: true,
        available: true,
        quotaState: engine === "codex" ? "blocked" : "ok",
        models: [{ id: "", efforts: [""] }],
        defaultModel: "",
        defaultEffort: "",
      })),
    },
  });

  const plan = planSplitBatches(
    { requestId: "req1", request: "写 50 个自动化脚本，每台机器最多 10 个", engine: "codex", totalItems: 50, perNode: 10, create: false, dispatch: false },
    [manual, offline, blockedQuota, studio, mac],
    { ...defaultDispatcherSettings(), mode: "auto", maxConcurrent: 4 },
    "batch_test",
  );

  expect(plan.batches).toHaveLength(5);
  expect(plan.batches.every(batch => batch.hostId === mac.hostId || batch.hostId === studio.hostId)).toBe(true);
  // First batch prefers the higher-scoring #88 "prefer" node (macmini).
  expect(plan.batches[0]!.hostId).toBe(mac.hostId);
  expect(plan.skippedNodes.map(s => s.hostId)).toEqual(expect.arrayContaining([manual.hostId, offline.hostId, blockedQuota.hostId]));

  const summary = buildBatchSummaryText(
    "batch_test",
    [
      { id: "tk1", dispatcherBotId: "d", conversationId: "home", title: "Batch 1", request: "x", status: "needs_review", paused: false, attempts: [{ id: "ta1", botId: "w", engine: "codex", model: "", effort: "", conversationId: "c1", inputMessageId: "m1", startedAt: 1, endedAt: 2, outcome: "completed", hostId: mac.hostId, hostName: "macmini" }], hostId: mac.hostId, hostName: "macmini", batchId: "batch_test", batchIndex: 0, batchTotal: 2, result: "Scripts 1-25 generated", createdAt: 1, updatedAt: 2 },
      { id: "tk2", dispatcherBotId: "d", conversationId: "home", title: "Batch 2", request: "y", status: "needs_review", paused: false, attempts: [{ id: "ta2", botId: "w", engine: "codex", model: "", effort: "", conversationId: "c2", inputMessageId: "m2", startedAt: 1, endedAt: 2, outcome: "completed", hostId: studio.hostId, hostName: "studio-b" }], hostId: studio.hostId, hostName: "studio-b", batchId: "batch_test", batchIndex: 1, batchTotal: 2, result: "Scripts 26-50 generated", artifacts: [{ id: "att1", name: "scripts.tar.gz", size: 120, mime: "application/gzip", localAttachmentId: "att1" }], createdAt: 1, updatedAt: 2 },
    ],
    "macmini",
  );
  expect(summary).toContain("macmini");
  expect(summary).toContain("studio-b");
  expect(summary).toContain("scripts.tar.gz");
});

it("enforces remote authorization, dispatches across 2 real TLS Hubs in parallel, collects artifacts, and publishes one consolidated summary", async () => {
  // 1. Before authorization: studio-b is online but unauthorized.
  const preNodes = dispatchNodesResponseSchema.parse(await a.dispatch.nodes(owner, "d"));
  const preStudio = preNodes.nodes.find(n => n.hostId === studioId)!;
  expect(preStudio).toMatchObject({ online: true, authorized: false, eligible: false });

  const unauthTicket = await a.dispatch.create(owner, "d", { requestId: "unauth-c", title: "Unauthorized test", request: "Run on studio-b" });
  await expect(a.dispatch.dispatch(owner, "d", { requestId: "unauth-d", ticketId: unauthTicket.id, engine: "codex", hostId: studioId })).rejects.toThrow("bot_message_not_authorized");

  // 2. Owner explicitly authorizes macmini's dispatcher ("d") on studio-b via signed deviceAction proof.
  await authorizeStudioFromMac();

  const postNodes = dispatchNodesResponseSchema.parse(await a.dispatch.nodes(owner, "d"));
  const postStudio = postNodes.nodes.find(n => n.hostId === studioId)!;
  expect(postStudio).toMatchObject({ online: true, authorized: true, eligible: true });

  // 3. Plan & dispatch 4 items (2 per node -> 2 parallel tickets: 1 on macmini, 1 on studio-b).
  const plan = await a.dispatch.plan(owner, "d", {
    requestId: "parallel-4",
    title: "Generate batch",
    request: "写 4 个脚本，每台机器 2 个",
    engine: "codex",
    totalItems: 4,
    perNode: 2,
    create: true,
    dispatch: true,
  });

  expect(plan.batches).toHaveLength(2);
  expect(plan.tickets).toHaveLength(2);
  const byHost = new Map(plan.tickets!.map(t => [t.hostId!, t]));
  const localTicket = byHost.get(macId)!;
  const remoteTicket = byHost.get(studioId)!;
  expect(localTicket.status).toBe("working");
  expect(remoteTicket.status).toBe("working");
  expect(remoteTicket.attempts[0]!.remoteTicketId).toBeTruthy();

  // 4. Complete the local worker on macmini AND the remote worker on studio-b (with a generated attachment!).
  const localAttempt = localTicket.attempts.at(-1)!;
  await a.store.publishBotMessage(localAttempt.botId, {
    conversationId: localAttempt.conversationId,
    blocks: [{ type: "text", text: "Completed local items 1-2 cleanly." }],
    replyTo: localAttempt.inputMessageId,
    status: "complete",
  });
  await a.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [localAttempt.inputMessageId, localAttempt.botId]);

  const remoteAttempt = remoteTicket.attempts.at(-1)!;
  const payload = Buffer.from("console.log('batch-part-2');\n");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const savedAttachment = await b.attachments.create("owner", {
    conversationId: remoteAttempt.conversationId,
    name: "remote_script.js",
    mime: "text/javascript",
    size: payload.length,
    sha256,
  });
  await b.attachments.putChunk("owner", savedAttachment.id, 0, payload);
  await b.attachments.complete("owner", savedAttachment.id);
  await b.store.publishBotMessage(remoteAttempt.botId, {
    conversationId: remoteAttempt.conversationId,
    blocks: [
      { type: "text", text: "Completed remote items 3-4 on studio-b." },
      { type: "file", attachmentId: savedAttachment.id, name: "remote_script.js", mime: "text/javascript", size: payload.length },
    ],
    replyTo: remoteAttempt.inputMessageId,
    status: "complete",
  });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [remoteAttempt.inputMessageId, remoteAttempt.botId]);

  // 5. Sweep on macmini settles both tickets, downloads remote attachment over TLS, and posts one consolidated summary.
  await a.dispatch.sweep();
  const updatedLocal = await a.dispatch.show(owner, localTicket.id);
  const updatedRemote = await a.dispatch.show(owner, remoteTicket.id);
  expect(updatedLocal.status).toBe("needs_review");
  expect(updatedRemote.status).toBe("needs_review");
  expect(updatedRemote.result).toContain("Completed remote items 3-4 on studio-b.");
  expect(updatedRemote.artifacts).toHaveLength(1);
  expect(updatedRemote.artifacts![0]!.localAttachmentId).toBeTruthy();

  // Verify downloaded attachment bytes exist in Hub A's attachment store.
  const downloadedMeta = await a.attachments.download({ userId: "owner" }, updatedRemote.artifacts![0]!.localAttachmentId!);
  expect(downloadedMeta.row).toMatchObject({ name: "remote_script.js", size: payload.length, sha256 });

  // Verify consolidated batch summary was published ONCE to Dispatcher's home conversation with the attachment.
  const home = (await a.store.conversations("owner")).find(c => c.botIds.includes("d"))!;
  const msgs1 = await a.store.db.all<{ id: string; blocks_json: string }>("SELECT id,blocks_json FROM messages WHERE conversation_id=? ORDER BY created_at,rowid", [home.id]);
  const summaryMsgs = msgs1.filter(m => m.blocks_json.includes("跨主机任务汇总"));
  expect(summaryMsgs).toHaveLength(1);
  expect(summaryMsgs[0]!.blocks_json).toContain("macmini");
  expect(summaryMsgs[0]!.blocks_json).toContain("studio-b");
  expect(summaryMsgs[0]!.blocks_json).toContain(updatedRemote.artifacts![0]!.localAttachmentId!);

  // Re-sweeping never duplicates the summary.
  await a.dispatch.sweep();
  const msgs2 = await a.store.db.all<{ id: string }>("SELECT id FROM messages WHERE conversation_id=? AND blocks_json LIKE '%跨主机任务汇总%'", [home.id]);
  expect(msgs2).toHaveLength(1);
});

it("preserves completed remote batches and reassigns unfinished batches when a remote Host goes offline", async () => {
  await authorizeStudioFromMac();

  // Batch 1 & Batch 2 both run concurrently on studio-b (maxConcurrent=2); Batch 1 finishes, then studio-b goes offline midway.
  const failoverPlan = await a.dispatch.plan(owner, "d", {
    requestId: "plan-failover",
    title: "Failover batch",
    request: "Split into 2 parts",
    engine: "codex",
    items: ["Part 1 work", "Part 2 work"],
    hostIds: [studioId],
    create: true,
    dispatch: true,
  });
  const [t1, t2] = failoverPlan.tickets!;
  expect(t1!.status).toBe("working");
  expect(t2!.status).toBe("working");
  const a1 = t1!.attempts.at(-1)!;
  await b.store.publishBotMessage(a1.botId, { conversationId: a1.conversationId, blocks: [{ type: "text", text: "Part 1 already done on studio-b" }], replyTo: a1.inputMessageId, status: "complete" });
  await b.store.db.run("UPDATE deliveries SET status='accepted' WHERE message_id=? AND bot_id=?", [a1.inputMessageId, a1.botId]);
  await a.dispatch.sweep();
  expect((await a.dispatch.show(owner, t1!.id)).status).toBe("needs_review");

  // Shut down Hub B (studio-b goes offline while Part 2 is still running).
  await b.close();
  a.dispatch.remoteOfflineThreshold = 0;

  await a.dispatch.sweep();

  // Finished batch 1 stays untouched at needs_review!
  const after1 = await a.dispatch.show(owner, t1!.id);
  expect(after1.status).toBe("needs_review");
  expect(after1.hostId).toBe(studioId);

  // Unfinished batch 2 transitioned offline -> automatically reassigned onto healthy macmini!
  const after2 = await a.dispatch.show(owner, t2!.id);
  expect(after2.attempts).toHaveLength(2);
  expect(after2.attempts[0]!.failure?.category).toBe("host-offline");
  expect(after2.status).toBe("working");
  expect(after2.hostId).toBe(macId);
  expect(after2.hostName).toBe("macmini");

  // Bulk pause -> resume -> cancel across all open batch tickets.
  await a.dispatch.bulkAction("owner", "d", { requestId: "bulk-pause", action: "pause" });
  expect((await a.dispatch.show(owner, t2!.id)).paused).toBe(true);
  await a.dispatch.bulkAction("owner", "d", { requestId: "bulk-resume", action: "resume" });
  expect((await a.dispatch.show(owner, t2!.id)).paused).toBe(false);
  await a.dispatch.bulkAction("owner", "d", { requestId: "bulk-cancel", action: "cancel" });
  expect(["cancelled", "working"]).toContain((await a.dispatch.show(owner, t2!.id)).status);
});

it("guards ask-mode split plans, supports remote stop over TLS, and exposes CLI nodes/plan subcommands", async () => {
  await authorizeStudioFromMac();

  // Switch dispatcher to ask mode -> bot actor cannot pass dispatch: true directly without owner confirmation.
  const currentSettings = await a.dispatch.settings("owner", "d");
  await a.dispatch.updateSettings("owner", "d", {
    settings: { ...currentSettings.settings, mode: "ask" },
    expectedRevision: currentSettings.revision,
  });

  // Start an active turn on the dispatcher so bot actor authorization passes context checks.
  const home = (await a.store.conversations("owner")).find(c => c.botIds.includes("d"))!;
  const msg = await a.store.sendMessage("owner", { conversationId: home.id, clientMsgId: "turn-ask", text: "请拆分并跨机写 4 个脚本", attachments: [] });
  await a.store.db.run("UPDATE deliveries SET dispatched=1 WHERE message_id=? AND bot_id='d'", [msg.message.id]);

  await expect(a.dispatch.plan(
    { kind: "bot", botId: "d", contextMessage: msg.message.id },
    "d",
    { requestId: "ask-guard", request: "写 4 个脚本，每台机器 2 个", engine: "codex", create: true, dispatch: true },
  )).rejects.toThrow("dispatch_confirmation_required");

  // Previewing split plan in ask mode returns requiresConfirmation: true and 2 balanced batches without creating tickets yet.
  const preview = await a.dispatch.plan(
    { kind: "bot", botId: "d", contextMessage: msg.message.id },
    "d",
    { requestId: "ask-preview", request: "写 4 个脚本，每台机器 2 个", engine: "codex", totalItems: 4, perNode: 2 },
  );
  expect(preview.requiresConfirmation).toBe(true);
  expect(preview.batches).toHaveLength(2);
  expect(preview.tickets).toBeUndefined();

  // Remote pause/cancel propagates to Hub B over signed TLS.
  const created = await a.dispatch.create(owner, "d", { requestId: "remote-stop-c", title: "Remote stop", request: "Long remote task" });
  const running = await a.dispatch.dispatch(owner, "d", { requestId: "remote-stop-d", ticketId: created.id, engine: "codex", hostId: studioId });
  const remoteId = running.attempts.at(-1)!.remoteTicketId!;
  await a.dispatch.action("owner", created.id, { requestId: "remote-stop-pause", action: "pause" });
  await a.dispatch.sweep();
  const stoppedLocal = await a.dispatch.show(owner, created.id);
  expect(stoppedLocal).toMatchObject({ paused: true, status: "queued" });
  const remoteRow = await b.store.db.get<{ status: string }>("SELECT status FROM remote_dispatch_tickets WHERE id=?", [remoteId]);
  expect(remoteRow?.status).toBe("cancelled");

  // Owner CLI `tickets nodes` and `tickets plan` work against the local controller socket.
  const closeA = await startHubControl(
    aDir,
    { running: true, pid: process.pid, url: a.url, instanceUrl: a.instanceUrl, publicKey: a.auth.publicKey },
    () => {},
    { enrollController: value => a.enrollLocalController(value) },
  );
  try {
    (await LocalHostClient.connect(aDir, { enroll: true })).close();
    const cliNodes = await runTicketsCommand(aDir, "nodes", undefined, {}, () => {}) as { nodes: { hostName: string; authorized: boolean }[] };
    expect(cliNodes.nodes.map(n => [n.hostName, n.authorized])).toEqual(expect.arrayContaining([["macmini", true], ["studio-b", true]]));
    const cliPlan = await runTicketsCommand(aDir, "plan", undefined, { text: "Write 6 scripts, 3 per machine", engine: "codex" }, () => {}) as { batches: unknown[]; mode: string };
    expect(cliPlan.mode).toBe("ask");
    expect(cliPlan.batches).toHaveLength(2);
  } finally {
    await closeA();
  }
});
