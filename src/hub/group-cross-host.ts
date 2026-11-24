import { createHash, randomUUID, verify } from "node:crypto";
import type { Conversation, Message } from "../client-protocol/index.js";
import type { BotSource } from "../client-protocol/bot-messages.js";
import { blocksText } from "../client-protocol/index.js";
import {
  GROUP_MAX_REMOTE_MEMBERS,
  GROUP_MAX_TOTAL_MEMBERS,
  addGroupMemberInputSchema,
  createGroupRoomInputSchema,
  groupAutoSessionTitle,
  groupHistoryVisibilitySchema,
  groupMailDeliverSchema,
  groupMailReplySchema,
  makeGroupMemberKey,
  setDesignatedMemberInputSchema,
  switchGroupMemberSessionInputSchema,
  type AddGroupMemberInput,
  type CreateGroupRoomInput,
  type GroupFormerSession,
  type GroupHistoryVisibility,
  type GroupMailDeliver,
  type GroupMailReply,
  type GroupMemberSession,
  type GroupMembersState,
  type GroupPeerBot,
  type GroupSessionCandidate,
  type RemoteGroupQuestion,
  type RemoteGroupQuestionStatus,
  type SwitchGroupMemberSessionInput,
} from "../client-protocol/group-members.js";
import { parsePublicKey, type HubAuth } from "./auth.js";
import { HubError, type HubStore } from "./store.js";

export type GroupPeerEndpoint = {
  hostId: string;
  hostName: string;
  publicKey: string;
  url: string;
};

type PeerFetchResult = { status: number; json: unknown };
export type GroupPeerTransport = (
  peer: GroupPeerEndpoint,
  method: "GET" | "POST",
  routePath: string,
  headers: Record<string, string>,
  body?: string,
) => Promise<PeerFetchResult>;

const PEER_CLOCK_SKEW_MS = 60_000;
const PEER_TIMEOUT_MS = 10_000;

function peerSignaturePayload(method: string, routePath: string, timestamp: string, bodyText: string): string {
  const digest = createHash("sha256").update(bodyText).digest("hex");
  return `tarobot/group-mail/v1\0${method}\0${routePath}\0${timestamp}\0${digest}`;
}

async function defaultPeerTransport(
  peer: GroupPeerEndpoint,
  method: "GET" | "POST",
  routePath: string,
  headers: Record<string, string>,
  body?: string,
): Promise<PeerFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS);
  try {
    const res = await fetch(new URL(routePath, peer.url), {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

export class HubCrossHostGroups {
  private readonly peers = new Map<string, GroupPeerEndpoint>();
  private initialized = false;
  private initPromise?: Promise<void>;
  private transport: GroupPeerTransport;
  private localUrlProvider: () => string | undefined;
  private localHostNameProvider: () => Promise<string>;
  private networkPeersProvider?: () => Promise<GroupPeerEndpoint[]>;
  private onGroupStopLocal?: (groupId: string) => Promise<void>;

  constructor(
    private readonly store: HubStore,
    private readonly auth: HubAuth,
    options?: {
      transport?: GroupPeerTransport;
      localUrl?: () => string | undefined;
      localHostName?: () => Promise<string>;
      networkPeers?: () => Promise<GroupPeerEndpoint[]>;
      onGroupStopLocal?: (groupId: string) => Promise<void>;
    },
  ) {
    this.transport = options?.transport ?? defaultPeerTransport;
    this.localUrlProvider = options?.localUrl ?? (() => undefined);
    this.localHostNameProvider = options?.localHostName ?? (async () => "local");
    this.networkPeersProvider = options?.networkPeers;
    this.onGroupStopLocal = options?.onGroupStopLocal;
  }

  /** Allows tests or custom deployments to override the cross-host transport (e.g. simulate mid-flight drops). */
  setTransport(transport: GroupPeerTransport): void {
    this.transport = transport;
  }

  registerPeer(peer: GroupPeerEndpoint): void {
    this.peers.set(peer.hostId, peer);
  }

  unregisterPeer(hostId: string): void {
    this.peers.delete(hostId);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.store.db.serial(async () => {
        await this.store.db.run(`CREATE TABLE IF NOT EXISTS group_session_members (
          group_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT NOT NULL,
          host_public_key TEXT,
          bot_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          session_title TEXT NOT NULL,
          name_snapshot TEXT NOT NULL,
          avatar_snapshot TEXT,
          engine_snapshot TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          joined_after_seq INTEGER NOT NULL,
          history_visibility_json TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          removed_at INTEGER,
          PRIMARY KEY (group_id, member_key, session_id)
        )`);
        await this.store.db.run(`CREATE TABLE IF NOT EXISTS group_former_sessions (
          group_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          revoked_at INTEGER NOT NULL,
          PRIMARY KEY (group_id, session_id)
        )`);
        await this.store.db.run(`CREATE TABLE IF NOT EXISTS group_designated_member (
          group_id TEXT PRIMARY KEY,
          member_key TEXT NOT NULL
        )`);
        await this.store.db.run(`CREATE TABLE IF NOT EXISTS group_remote_questions (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          member_key TEXT NOT NULL,
          host_id TEXT NOT NULL,
          host_name TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          bot_name_snapshot TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          stopped_unanswered INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          answered_at INTEGER,
          answer_message_id TEXT
        )`);
        await this.store.db.run(`CREATE TABLE IF NOT EXISTS group_mail_inbox (
          request_id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          source_host_id TEXT NOT NULL,
          source_host_name TEXT NOT NULL,
          source_public_key TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          delivered_message_id TEXT NOT NULL,
          reply_message_id TEXT,
          reply_text TEXT,
          status TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          answered_at INTEGER
        )`);
        this.initialized = true;
      });
    }
    await this.initPromise;
  }

  private async allPeers(): Promise<GroupPeerEndpoint[]> {
    const merged = new Map<string, GroupPeerEndpoint>();
    if (this.networkPeersProvider) {
      for (const peer of await this.networkPeersProvider().catch(() => [])) {
        if (peer.publicKey !== this.auth.publicKey) merged.set(peer.hostId, peer);
      }
    }
    for (const peer of this.peers.values()) {
      if (peer.publicKey !== this.auth.publicKey) merged.set(peer.hostId, peer);
    }
    return [...merged.values()];
  }

  private async findPeer(hostId: string): Promise<GroupPeerEndpoint | undefined> {
    const peers = await this.allPeers();
    return peers.find((p) => p.hostId === hostId);
  }

  private async findPeerByPublicKey(publicKey: string): Promise<GroupPeerEndpoint | undefined> {
    const peers = await this.allPeers();
    return peers.find((p) => p.publicKey === publicKey);
  }

  private signPeerHeaders(method: "GET" | "POST", routePath: string, bodyText: string): Record<string, string> {
    const timestamp = String(Date.now());
    const payload = peerSignaturePayload(method, routePath, timestamp, bodyText);
    const signature = this.auth.signGroupMail(payload);
    return {
      "X-TaroBot-Group-Peer-Key": this.auth.publicKey,
      "X-TaroBot-Group-Timestamp": timestamp,
      "X-TaroBot-Group-Signature": signature,
    };
  }

  async verifyPeerRequest(
    method: "GET" | "POST",
    routePath: string,
    headers: Record<string, string | string[] | undefined>,
    bodyText: string,
  ): Promise<GroupPeerEndpoint> {
    await this.init();
    const key = String(headers["x-tarobot-group-peer-key"] ?? "");
    const timestamp = String(headers["x-tarobot-group-timestamp"] ?? "");
    const signature = String(headers["x-tarobot-group-signature"] ?? "");
    if (!key || !timestamp || !signature) throw new HubError("group_peer_unauthorized", 401);
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > PEER_CLOCK_SKEW_MS) {
      throw new HubError("group_peer_timestamp_expired", 401);
    }
    const peer = await this.findPeerByPublicKey(key);
    if (!peer) throw new HubError("group_peer_unknown", 403);
    const payload = peerSignaturePayload(method, routePath, timestamp, bodyText);
    const ok = verify(null, Buffer.from(payload), parsePublicKey(peer.publicKey), Buffer.from(signature, "base64"));
    if (!ok) throw new HubError("group_peer_signature_invalid", 403);
    return peer;
  }

  private async callPeer(peer: GroupPeerEndpoint, method: "GET" | "POST", routePath: string, body?: unknown): Promise<PeerFetchResult> {
    const bodyText = body !== undefined ? JSON.stringify(body) : "";
    const headers = this.signPeerHeaders(method, routePath, bodyText);
    return this.transport(peer, method, routePath, headers, body !== undefined ? bodyText : undefined);
  }

  private async listLocalBotSessions(ownerId: string, botId: string): Promise<GroupSessionCandidate[]> {
    const rows = await this.store.db.all<{ id: string; title: string; created_at: number }>(
      `SELECT c.id, c.title, c.created_at
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE c.type = 'direct' AND c.archived = 0 AND c.hidden = 0 AND c.owner_id = ?
         AND cm.member_type = 'bot' AND cm.member_id = ?
       ORDER BY c.created_at DESC LIMIT 64`,
      [ownerId, botId],
    );
    return rows.map((row) => ({ sessionId: row.id, title: row.title, createdAt: row.created_at }));
  }

  /** Serves this Hub's local Bots + direct sessions to an authenticated peer Hub. */
  async handlePeerDirectory(): Promise<{ hostName: string; bots: GroupPeerBot[] }> {
    await this.init();
    const hostName = await this.localHostNameProvider();
    const owner = await this.store.db.get<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1");
    const ownerId = owner?.id ?? "owner";
    const bots = await this.store.db.all<{ id: string; name: string; engine: string; online: number }>(
      "SELECT id, name, engine, online FROM bots WHERE deleted_at IS NULL AND (role IS NULL OR role NOT IN ('dispatcher','worker')) ORDER BY name ASC",
    );
    const result: GroupPeerBot[] = [];
    for (const bot of bots) {
      const sessions = await this.listLocalBotSessions(ownerId, bot.id);
      result.push({
        hostId: "remote",
        hostName,
        hostPublicKey: this.auth.publicKey,
        online: !!bot.online,
        botId: bot.id,
        name: bot.name,
        engine: bot.engine,
        sessions,
      });
    }
    return { hostName, bots: result };
  }

  private async getConversation(userId: string, id: string): Promise<Conversation> {
    return this.store.db.serial(async () => {
      await this.store.requireMember(userId, id);
      return this.store.conversationInTransaction(id);
    });
  }

  private async insertRemoteBotAnswer(input: {
    conversationId: string;
    botId: string;
    clientMsgId: string;
    replyTo: string;
    text: string;
    botSource: BotSource;
  }): Promise<Message> {
    const id = `msg_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = Date.now();
    const message: Message = {
      id,
      conversationId: input.conversationId,
      authorId: input.botId,
      authorType: "bot",
      blocks: [{ type: "text", text: input.text }],
      status: "complete",
      version: 1,
      clientMsgId: input.clientMsgId,
      replyTo: input.replyTo,
      botSource: input.botSource,
      createdAt: now,
    };
    await this.store.db.transaction(async () => {
      await this.store.db.run(
        `INSERT INTO messages(id,conversation_id,author_id,author_type,blocks_json,status,version,client_msg_id,reply_to,created_at,bot_source_json)
         VALUES(?,?,?,?,?,'complete',1,?,?,?,?)`,
        [id, input.conversationId, input.botId, "bot", JSON.stringify(message.blocks), input.clientMsgId, input.replyTo, now, JSON.stringify(input.botSource)],
      );
      const seqRow = await this.store.db.get<{ n: number }>("SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE conversation_id=?", [input.conversationId]);
      await this.store.db.run(
        "INSERT INTO events(conversation_id,seq,kind,payload_json,at) VALUES(?,?,'message.created',?,?)",
        [input.conversationId, seqRow?.n ?? 1, JSON.stringify(message), now],
      );
    });
    return message;
  }

  /** Creates a new direct session for a Bot on this Hub when requested by a peer Hub joining a group. */
  async handlePeerEnsureSession(body: { botId: string; title: string }): Promise<GroupSessionCandidate> {
    await this.init();
    const bot = await this.store.db.get<{ id: string; name: string }>(
      "SELECT id, name FROM bots WHERE id=? AND deleted_at IS NULL",
      [body.botId],
    );
    if (!bot) throw new HubError("bot_not_found", 404);
    const owner = await this.store.db.get<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1");
    const ownerId = owner?.id ?? "owner";
    const sessionId = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const conv = await this.store.createConversation(ownerId, [bot.id], body.title.slice(0, 256), sessionId, { type: "direct" });
    return { sessionId: conv.id, title: conv.title, createdAt: conv.createdAt };
  }

  /** Receives a cross-host group question on the target Hub, strictly bound to `botId` + `sessionId` (never mutable name!). */
  async handlePeerDeliver(peer: GroupPeerEndpoint, raw: unknown): Promise<{
    requestId: string;
    status: "delivered";
    deliveredMessageId: string;
    botId: string;
    sessionId: string;
  }> {
    await this.init();
    const input = groupMailDeliverSchema.parse(raw);

    // Idempotent check across Hub restarts!
    const existing = await this.store.db.get<{ delivered_message_id: string; bot_id: string; session_id: string }>(
      "SELECT delivered_message_id, bot_id, session_id FROM group_mail_inbox WHERE request_id=?",
      [input.requestId],
    );
    if (existing) {
      return {
        requestId: input.requestId,
        status: "delivered",
        deliveredMessageId: existing.delivered_message_id,
        botId: existing.bot_id,
        sessionId: existing.session_id,
      };
    }

    // Strict ID binding: verify exact botId exists and exact sessionId belongs to that botId!
    const bot = await this.store.db.get<{ id: string; name: string }>(
      "SELECT id, name FROM bots WHERE id=? AND deleted_at IS NULL",
      [input.botId],
    );
    if (!bot) throw new HubError("remote_bot_not_found", 404);

    const sessionMember = await this.store.db.get<{ conversation_id: string }>(
      "SELECT conversation_id FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id=?",
      [input.sessionId, input.botId],
    );
    if (!sessionMember) throw new HubError("remote_session_mismatch", 409);

    const owner = await this.store.db.get<{ id: string }>("SELECT id FROM users WHERE role='owner' ORDER BY id ASC LIMIT 1");
    const ownerId = owner?.id ?? "owner";
    const contextPrefix = input.contextMessages.length
      ? `[Group "${input.groupTitle}" recent context]\n${input.contextMessages.map((m) => `${m.authorName}: ${m.text}`).join("\n")}\n\n`
      : "";
    const composedText = `${contextPrefix}[From ${input.sourceHostName} · Group "${input.groupTitle}"]\n${input.text}`;
    const botSource: BotSource = {
      hostId: input.sourceHostId,
      hostName: input.sourceHostName,
      botId: input.groupId,
      botName: input.groupTitle,
      requestId: input.requestId,
      hops: 1,
    };

    const delivered = await this.store.sendMessage(ownerId, {
      conversationId: input.sessionId,
      clientMsgId: `gmail_${input.requestId}`,
      text: composedText,
      attachments: [],
      mentions: [input.botId],
      botSource,
    });

    await this.store.db.run(
      `INSERT INTO group_mail_inbox(request_id, group_id, conversation_id, source_host_id, source_host_name, source_public_key, bot_id, session_id, delivered_message_id, status, received_at)
       VALUES(?,?,?,?,?,?,?,?,?,'delivered',?)`,
      [input.requestId, input.groupId, input.conversationId, input.sourceHostId, input.sourceHostName, peer.publicKey, input.botId, input.sessionId, delivered.message.id, Date.now()],
    );

    return {
      requestId: input.requestId,
      status: "delivered",
      deliveredMessageId: delivered.message.id,
      botId: input.botId,
      sessionId: input.sessionId,
    };
  }

  /** Records a remote Bot's reply on the target Hub and optionally forwards it back to the originating group Hub. */
  async recordRemoteBotReply(requestId: string, replyMessageId: string, replyText: string): Promise<void> {
    await this.init();
    const row = await this.store.db.get<{
      request_id: string;
      group_id: string;
      conversation_id: string;
      source_public_key: string;
      bot_id: string;
      session_id: string;
    }>("SELECT request_id, group_id, conversation_id, source_public_key, bot_id, session_id FROM group_mail_inbox WHERE request_id=?", [requestId]);
    if (!row) return;
    await this.store.db.run(
      "UPDATE group_mail_inbox SET reply_message_id=?, reply_text=?, status='answered', answered_at=? WHERE request_id=?",
      [replyMessageId, replyText, Date.now(), requestId],
    );
    const originPeer = await this.findPeerByPublicKey(row.source_public_key);
    if (!originPeer) return;
    const payload: GroupMailReply = {
      requestId: row.request_id,
      groupId: row.group_id,
      conversationId: row.conversation_id,
      botId: row.bot_id,
      sessionId: row.session_id,
      text: replyText,
    };
    await this.callPeer(originPeer, "POST", "/api/group-mail/reply", payload).catch(() => undefined);
  }

  /** Allows the originating Hub to query status/recovery of an uncertain request after target Hub restart. */
  async handlePeerStatus(requestId: string): Promise<{
    found: boolean;
    status?: "delivered" | "answered";
    deliveredMessageId?: string;
    replyText?: string;
    botId?: string;
    sessionId?: string;
  }> {
    await this.init();
    const row = await this.store.db.get<{
      status: string;
      delivered_message_id: string;
      reply_text: string | null;
      bot_id: string;
      session_id: string;
    }>("SELECT status, delivered_message_id, reply_text, bot_id, session_id FROM group_mail_inbox WHERE request_id=?", [requestId]);
    if (!row) return { found: false };
    return {
      found: true,
      status: row.status === "answered" ? "answered" : "delivered",
      deliveredMessageId: row.delivered_message_id,
      ...(row.reply_text !== null ? { replyText: row.reply_text } : {}),
      botId: row.bot_id,
      sessionId: row.session_id,
    };
  }

  /** Receives a remote Bot's reply (even late, after restart or after group stop) and posts it into the group. */
  async handlePeerReply(peer: GroupPeerEndpoint, raw: unknown): Promise<{ accepted: true; messageId: string }> {
    await this.init();
    const input = groupMailReplySchema.parse(raw);
    const question = await this.store.db.get<{
      id: string;
      group_id: string;
      conversation_id: string;
      host_id: string;
      host_name: string;
      bot_id: string;
      session_id: string;
      bot_name_snapshot: string;
      source_message_id: string;
      answer_message_id: string | null;
    }>("SELECT * FROM group_remote_questions WHERE request_id=?", [input.requestId]);
    if (!question) throw new HubError("group_question_not_found", 404);
    if (question.bot_id !== input.botId || question.session_id !== input.sessionId) {
      throw new HubError("group_question_identity_mismatch", 403);
    }
    if (question.answer_message_id) {
      return { accepted: true, messageId: question.answer_message_id };
    }
    const answer = await this.insertRemoteBotAnswer({
      conversationId: question.conversation_id,
      botId: question.bot_id,
      clientMsgId: `gans_${input.requestId}`,
      replyTo: question.source_message_id,
      text: input.text,
      botSource: {
        hostId: peer.hostId,
        hostName: question.host_name,
        botId: question.bot_id,
        botName: question.bot_name_snapshot,
        requestId: input.requestId,
        hops: 1,
      },
    });
    const now = Date.now();
    await this.store.db.run(
      "UPDATE group_remote_questions SET status='delivered', updated_at=?, answered_at=?, answer_message_id=? WHERE id=?",
      [now, now, answer.id, question.id],
    );
    return { accepted: true, messageId: answer.id };
  }

  /** Ensures every existing local Bot in `conversation.botIds` has a session-member record (migrating legacy groups seamlessly). */
  private async ensureLocalMemberRecords(userId: string, group: Conversation): Promise<void> {
    const localHostName = await this.localHostNameProvider();
    for (const botId of group.botIds) {
      const memberKey = makeGroupMemberKey("local", "local", botId);
      const existing = await this.store.db.get<{ session_id: string }>(
        "SELECT session_id FROM group_session_members WHERE group_id=? AND member_key=? AND active=1",
        [group.id, memberKey],
      );
      if (existing) continue;
      const bot = await this.store.db.get<{ id: string; name: string; engine: string }>(
        "SELECT id, name, engine FROM bots WHERE id=?",
        [botId],
      );
      if (!bot) continue;
      const sessions = await this.listLocalBotSessions(userId, botId);
      let chosen = sessions[0];
      if (!chosen) {
        const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const title = groupAutoSessionTitle(group.title, bot.name);
        const created = await this.store.createConversation(userId, [botId], title, sid, { type: "direct" });
        chosen = { sessionId: created.id, title: created.title, createdAt: created.createdAt };
      }
      await this.store.db.run(
        `INSERT OR REPLACE INTO group_session_members(
          group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
          session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
          joined_at, joined_after_seq, history_visibility_json, active, removed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`,
        [
          group.id, memberKey, "local", "local", localHostName, this.auth.publicKey,
          bot.id, chosen.sessionId, chosen.title, bot.name, null, bot.engine,
          Date.now(), 0, JSON.stringify({ kind: "all" } satisfies GroupHistoryVisibility),
        ],
      );
    }
  }

  private async currentGroupMaxSeq(groupId: string): Promise<number> {
    const row = await this.store.db.get<{ max_seq: number | null }>(
      "SELECT MAX(seq) AS max_seq FROM events WHERE conversation_id=?",
      [groupId],
    );
    return row?.max_seq ?? 0;
  }

  private mapMemberRow(row: Record<string, unknown>): GroupMemberSession {
    return {
      memberKey: String(row.member_key),
      kind: row.kind === "remote" ? "remote" : "local",
      hostId: String(row.host_id),
      hostName: String(row.host_name),
      ...(row.host_public_key ? { hostPublicKey: String(row.host_public_key) } : {}),
      botId: String(row.bot_id),
      sessionId: String(row.session_id),
      sessionTitle: String(row.session_title),
      nameSnapshot: String(row.name_snapshot),
      ...(row.avatar_snapshot ? { avatarSnapshot: String(row.avatar_snapshot) } : {}),
      engineSnapshot: String(row.engine_snapshot),
      joinedAt: Number(row.joined_at),
      joinedAfterSeq: Number(row.joined_after_seq),
      historyVisibility: groupHistoryVisibilitySchema.parse(JSON.parse(String(row.history_visibility_json))),
      active: Boolean(row.active),
      ...(row.removed_at ? { removedAt: Number(row.removed_at) } : {}),
    };
  }

  private mapQuestionRow(row: Record<string, unknown>): RemoteGroupQuestion {
    return {
      id: String(row.id),
      groupId: String(row.group_id),
      conversationId: String(row.conversation_id),
      memberKey: String(row.member_key),
      hostId: String(row.host_id),
      hostName: String(row.host_name),
      botId: String(row.bot_id),
      sessionId: String(row.session_id),
      botNameSnapshot: String(row.bot_name_snapshot),
      sourceMessageId: String(row.source_message_id),
      requestId: String(row.request_id),
      status: String(row.status) as RemoteGroupQuestionStatus,
      stoppedUnanswered: Boolean(row.stopped_unanswered),
      ...(row.error ? { error: String(row.error) } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(row.answered_at ? { answeredAt: Number(row.answered_at) } : {}),
      ...(row.answer_message_id ? { answerMessageId: String(row.answer_message_id) } : {}),
    };
  }

  /** Lists available local & peer Bots along with their existing sessions so the UI/CLI can pick a session on join. */
  async listAvailableDirectory(userId: string): Promise<GroupPeerBot[]> {
    await this.init();
    const localHostName = await this.localHostNameProvider();
    const localBots = await this.store.db.all<{ id: string; name: string; engine: string; online: number }>(
      "SELECT id, name, engine, online FROM bots WHERE deleted_at IS NULL AND (role IS NULL OR role NOT IN ('dispatcher','worker')) ORDER BY name ASC",
    );
    const directory: GroupPeerBot[] = [];
    for (const bot of localBots) {
      directory.push({
        hostId: "local",
        hostName: localHostName,
        hostPublicKey: this.auth.publicKey,
        online: !!bot.online,
        botId: bot.id,
        name: bot.name,
        engine: bot.engine,
        sessions: await this.listLocalBotSessions(userId, bot.id),
      });
    }
    for (const peer of await this.allPeers()) {
      try {
        const res = await this.callPeer(peer, "GET", "/api/group-mail/directory");
        if (res.status === 200 && res.json && typeof res.json === "object") {
          const data = res.json as { hostName?: string; bots?: GroupPeerBot[] };
          for (const bot of data.bots ?? []) {
            directory.push({
              ...bot,
              hostId: peer.hostId,
              hostName: data.hostName || peer.hostName,
              hostPublicKey: peer.publicKey,
            });
          }
        }
      } catch {
        // Peer offline: omit live directory entries without failing local settings view.
      }
    }
    return directory;
  }

  async getState(userId: string, groupId: string, includeDirectory = true): Promise<GroupMembersState> {
    await this.init();
    const group = await this.getConversation(userId, groupId);
    if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
    await this.ensureLocalMemberRecords(userId, group);

    const memberRows = await this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE group_id=? AND active=1 ORDER BY joined_at ASC",
      [groupId],
    );
    const formerRows = await this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM group_former_sessions WHERE group_id=? ORDER BY revoked_at DESC",
      [groupId],
    );
    const designatedRow = await this.store.db.get<{ member_key: string }>(
      "SELECT member_key FROM group_designated_member WHERE group_id=?",
      [groupId],
    );
    const questionRows = await this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM group_remote_questions WHERE group_id=? ORDER BY created_at DESC LIMIT 200",
      [groupId],
    );
    const formerSessions: GroupFormerSession[] = formerRows.map((row) => ({
      sessionId: String(row.session_id),
      memberKey: String(row.member_key),
      botId: String(row.bot_id),
      hostId: String(row.host_id),
      revokedAt: Number(row.revoked_at),
    }));

    return {
      groupId,
      designatedMemberKey: designatedRow?.member_key ?? null,
      members: memberRows.map((r) => this.mapMemberRow(r)),
      formerSessionIds: formerSessions.map((f) => f.sessionId),
      formerSessions,
      questions: questionRows.map((r) => this.mapQuestionRow(r)),
      ...(includeDirectory ? { directory: await this.listAvailableDirectory(userId) } : {}),
    };
  }

  async addMember(userId: string, groupId: string, rawInput: AddGroupMemberInput | unknown): Promise<GroupMemberSession> {
    await this.init();
    const input = addGroupMemberInputSchema.parse(rawInput);
    const group = await this.getConversation(userId, groupId);
    if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
    if (group.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
    if (group.archived) throw new HubError("conversation_archived", 409);
    await this.ensureLocalMemberRecords(userId, group);

    const activeMembers = await this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE group_id=? AND active=1",
      [groupId],
    );
    if (activeMembers.length >= GROUP_MAX_TOTAL_MEMBERS) throw new HubError("group_member_limit", 409);

    const isRemote = !!input.hostId && input.hostId !== "local";
    if (isRemote) {
      const remoteCount = activeMembers.filter((m) => m.kind === "remote").length;
      if (remoteCount >= GROUP_MAX_REMOTE_MEMBERS) throw new HubError("group_remote_member_limit", 409);
    }

    const historyVisibility: GroupHistoryVisibility = input.historyVisibility ?? { kind: "none" };
    const joinedAfterSeq = await this.currentGroupMaxSeq(groupId);
    const now = Date.now();

    if (!isRemote) {
      const bot = await this.store.db.get<{ id: string; name: string; engine: string; role: string | null }>(
        "SELECT id, name, engine, role FROM bots WHERE id=? AND deleted_at IS NULL",
        [input.botId],
      );
      if (!bot) throw new HubError("bot_not_found", 404);
      if (bot.role === "dispatcher") throw new HubError("dispatcher_group_forbidden", 409);
      const localHostName = await this.localHostNameProvider();
      const sessions = await this.listLocalBotSessions(userId, bot.id);
      let chosen: GroupSessionCandidate | undefined;
      if (input.sessionId) {
        chosen = sessions.find((s) => s.sessionId === input.sessionId);
        if (!chosen) throw new HubError("session_not_found", 404);
      } else if (sessions.length > 0) {
        chosen = sessions[0]!;
      } else {
        const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const title = groupAutoSessionTitle(group.title, bot.name);
        const created = await this.store.createConversation(userId, [bot.id], title, sid, { type: "direct" });
        chosen = { sessionId: created.id, title: created.title, createdAt: created.createdAt };
      }

      const memberKey = makeGroupMemberKey("local", "local", bot.id);
      await this.store.db.run(
        "UPDATE group_session_members SET active=0, removed_at=? WHERE group_id=? AND member_key=? AND active=1",
        [now, groupId, memberKey],
      );
      await this.store.db.run(
        `INSERT OR REPLACE INTO group_session_members(
          group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
          session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
          joined_at, joined_after_seq, history_visibility_json, active, removed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`,
        [
          groupId, memberKey, "local", "local", localHostName, this.auth.publicKey,
          bot.id, chosen.sessionId, chosen.title, bot.name, null, bot.engine,
          now, joinedAfterSeq, JSON.stringify(historyVisibility),
        ],
      );
      // Ensure local Bot is also in conversation_members for the group & its topics
      const convRows = await this.store.db.all<{ id: string }>("SELECT id FROM conversations WHERE id=? OR parent_id=?", [groupId, groupId]);
      for (const row of convRows) {
        await this.store.db.run("INSERT OR IGNORE INTO conversation_members VALUES(?,'bot',?,0)", [row.id, bot.id]);
      }
      const saved = await this.store.db.get<Record<string, unknown>>(
        "SELECT * FROM group_session_members WHERE group_id=? AND member_key=? AND session_id=?",
        [groupId, memberKey, chosen.sessionId],
      );
      return this.mapMemberRow(saved!);
    }

    // Remote Host member
    const peer = await this.findPeer(input.hostId!);
    if (!peer) throw new HubError("peer_host_not_found", 404);
    const dirRes = await this.callPeer(peer, "GET", "/api/group-mail/directory").catch(() => {
      throw new HubError("peer_host_offline", 503);
    });
    if (dirRes.status !== 200 || !dirRes.json || typeof dirRes.json !== "object") {
      throw new HubError("peer_host_unavailable", 503);
    }
    const dirData = dirRes.json as { hostName?: string; bots?: GroupPeerBot[] };
    const remoteBot = (dirData.bots ?? []).find((b) => b.botId === input.botId);
    if (!remoteBot) throw new HubError("remote_bot_not_found", 404);

    let chosen: GroupSessionCandidate | undefined;
    if (input.sessionId) {
      chosen = remoteBot.sessions.find((s) => s.sessionId === input.sessionId);
      if (!chosen) throw new HubError("remote_session_not_found", 404);
    } else if (remoteBot.sessions.length > 0) {
      chosen = remoteBot.sessions[0]!;
    } else {
      const title = groupAutoSessionTitle(group.title, remoteBot.name);
      const createdRes = await this.callPeer(peer, "POST", "/api/group-mail/sessions", { botId: remoteBot.botId, title });
      if (createdRes.status !== 200 || !createdRes.json || typeof createdRes.json !== "object") {
        throw new HubError("remote_session_create_failed", 502);
      }
      chosen = createdRes.json as GroupSessionCandidate;
    }

    const memberKey = makeGroupMemberKey("remote", peer.hostId, remoteBot.botId);
    const hostNameSnapshot = dirData.hostName || peer.hostName;
    await this.store.db.run(
      "UPDATE group_session_members SET active=0, removed_at=? WHERE group_id=? AND member_key=? AND active=1",
      [now, groupId, memberKey],
    );
    await this.store.db.run(
      `INSERT OR REPLACE INTO group_session_members(
        group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
        session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
        joined_at, joined_after_seq, history_visibility_json, active, removed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`,
      [
        groupId, memberKey, "remote", peer.hostId, hostNameSnapshot, peer.publicKey,
        remoteBot.botId, chosen.sessionId, chosen.title, remoteBot.name, remoteBot.avatar ?? null,
        remoteBot.engine, now, joinedAfterSeq, JSON.stringify(historyVisibility),
      ],
    );
    const saved = await this.store.db.get<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE group_id=? AND member_key=? AND session_id=?",
      [groupId, memberKey, chosen.sessionId],
    );
    return this.mapMemberRow(saved!);
  }

  async switchMemberSession(
    userId: string,
    groupId: string,
    memberKey: string,
    rawInput: SwitchGroupMemberSessionInput | unknown,
  ): Promise<GroupMemberSession> {
    await this.init();
    const input = switchGroupMemberSessionInputSchema.parse(rawInput);
    const group = await this.getConversation(userId, groupId);
    if (group.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
    const existingRow = await this.store.db.get<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE group_id=? AND member_key=? AND active=1",
      [groupId, memberKey],
    );
    if (!existingRow) throw new HubError("group_member_not_found", 404);
    const existing = this.mapMemberRow(existingRow);
    const now = Date.now();

    let nextSession: GroupSessionCandidate;
    if (existing.kind === "local") {
      if (input.createNew || !input.sessionId) {
        const sid = `sess_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const title = groupAutoSessionTitle(group.title, existing.nameSnapshot);
        const created = await this.store.createConversation(userId, [existing.botId], title, sid, { type: "direct" });
        nextSession = { sessionId: created.id, title: created.title, createdAt: created.createdAt };
      } else {
        const sessions = await this.listLocalBotSessions(userId, existing.botId);
        const found = sessions.find((s) => s.sessionId === input.sessionId);
        if (!found) throw new HubError("session_not_found", 404);
        nextSession = found;
      }
    } else {
      const peer = await this.findPeer(existing.hostId);
      if (!peer) throw new HubError("peer_host_not_found", 404);
      if (input.createNew || !input.sessionId) {
        const title = groupAutoSessionTitle(group.title, existing.nameSnapshot);
        const createdRes = await this.callPeer(peer, "POST", "/api/group-mail/sessions", { botId: existing.botId, title });
        if (createdRes.status !== 200) throw new HubError("remote_session_create_failed", 502);
        nextSession = createdRes.json as GroupSessionCandidate;
      } else {
        const dirRes = await this.callPeer(peer, "GET", "/api/group-mail/directory");
        const dirData = dirRes.json as { bots?: GroupPeerBot[] };
        const bot = (dirData.bots ?? []).find((b) => b.botId === existing.botId);
        const found = bot?.sessions.find((s) => s.sessionId === input.sessionId);
        if (!found) throw new HubError("remote_session_not_found", 404);
        nextSession = found;
      }
    }

    // Retire old session into formerSessionIds (revokes future access while keeping history readable).
    await this.store.db.run(
      "UPDATE group_session_members SET active=0, removed_at=? WHERE group_id=? AND member_key=? AND session_id=?",
      [now, groupId, memberKey, existing.sessionId],
    );
    await this.store.db.run(
      "INSERT OR REPLACE INTO group_former_sessions(group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?)",
      [groupId, existing.sessionId, memberKey, existing.botId, existing.hostId, now],
    );
    await this.store.db.run(
      `INSERT OR REPLACE INTO group_session_members(
        group_id, member_key, kind, host_id, host_name, host_public_key, bot_id,
        session_id, session_title, name_snapshot, avatar_snapshot, engine_snapshot,
        joined_at, joined_after_seq, history_visibility_json, active, removed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL)`,
      [
        groupId, memberKey, existing.kind, existing.hostId, existing.hostName, existing.hostPublicKey ?? null,
        existing.botId, nextSession.sessionId, nextSession.title, existing.nameSnapshot, existing.avatarSnapshot ?? null,
        existing.engineSnapshot, now, await this.currentGroupMaxSeq(groupId), JSON.stringify(existing.historyVisibility),
      ],
    );
    const saved = await this.store.db.get<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE group_id=? AND member_key=? AND session_id=?",
      [groupId, memberKey, nextSession.sessionId],
    );
    return this.mapMemberRow(saved!);
  }

  async removeMember(userId: string, groupId: string, memberKey: string): Promise<{ removed: GroupFormerSession }> {
    await this.init();
    const group = await this.getConversation(userId, groupId);
    if (group.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
    const existingRow = await this.store.db.get<Record<string, unknown>>(
      "SELECT * FROM group_session_members WHERE group_id=? AND member_key=? AND active=1",
      [groupId, memberKey],
    );
    if (!existingRow) throw new HubError("group_member_not_found", 404);
    const existing = this.mapMemberRow(existingRow);
    const now = Date.now();
    await this.store.db.run(
      "UPDATE group_session_members SET active=0, removed_at=? WHERE group_id=? AND member_key=? AND session_id=?",
      [now, groupId, memberKey, existing.sessionId],
    );
    await this.store.db.run(
      "INSERT OR REPLACE INTO group_former_sessions(group_id, session_id, member_key, bot_id, host_id, revoked_at) VALUES(?,?,?,?,?,?)",
      [groupId, existing.sessionId, memberKey, existing.botId, existing.hostId, now],
    );
    await this.store.db.run(
      "DELETE FROM group_designated_member WHERE group_id=? AND member_key=?",
      [groupId, memberKey],
    );
    if (existing.kind === "local") {
      const convRows = await this.store.db.all<{ id: string }>("SELECT id FROM conversations WHERE id=? OR parent_id=?", [groupId, groupId]);
      for (const row of convRows) {
        await this.store.db.run(
          "DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot' AND member_id=?",
          [row.id, existing.botId],
        );
      }
    }
    return {
      removed: {
        sessionId: existing.sessionId,
        memberKey,
        botId: existing.botId,
        hostId: existing.hostId,
        revokedAt: now,
      },
    };
  }

  /** Checks whether a session currently has access to new messages in a group. Former sessions return false. */
  async canSessionAccessGroup(groupId: string, sessionId: string): Promise<boolean> {
    await this.init();
    const active = await this.store.db.get<{ session_id: string }>(
      "SELECT session_id FROM group_session_members WHERE group_id=? AND session_id=? AND active=1",
      [groupId, sessionId],
    );
    return !!active;
  }

  async setDesignatedMember(userId: string, groupId: string, rawInput: unknown): Promise<{ designatedMemberKey: string | null }> {
    await this.init();
    const input = setDesignatedMemberInputSchema.parse(rawInput);
    const group = await this.getConversation(userId, groupId);
    if (group.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
    if (input.memberKey === null) {
      await this.store.db.run("DELETE FROM group_designated_member WHERE group_id=?", [groupId]);
      return { designatedMemberKey: null };
    }
    const member = await this.store.db.get<{ member_key: string }>(
      "SELECT member_key FROM group_session_members WHERE group_id=? AND member_key=? AND active=1",
      [groupId, input.memberKey],
    );
    if (!member) throw new HubError("group_member_not_found", 404);
    await this.store.db.run(
      "INSERT INTO group_designated_member(group_id, member_key) VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET member_key=excluded.member_key",
      [groupId, input.memberKey],
    );
    return { designatedMemberKey: input.memberKey };
  }

  /** Creates a new room/topic inside the group where every active member switches to a fresh session. */
  async createRoom(userId: string, groupId: string, rawInput: CreateGroupRoomInput | unknown = {}): Promise<{
    room: Conversation;
    memberSessions: Array<{ memberKey: string; sessionId: string; sessionTitle: string }>;
  }> {
    await this.init();
    const input = createGroupRoomInputSchema.parse(rawInput);
    const group = await this.getConversation(userId, groupId);
    if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
    if (group.ownerId !== userId) throw new HubError("conversation_owner_required", 403);
    const roomTitle = input.title ?? `${group.title} · Room ${new Date().toISOString().slice(11, 16)}`;
    const room = await this.store.createConversation(userId, group.botIds, roomTitle, `room_${randomUUID().replaceAll("-", "").slice(0, 12)}`, { parentId: groupId });
    const state = await this.getState(userId, groupId, false);
    const memberSessions: Array<{ memberKey: string; sessionId: string; sessionTitle: string }> = [];
    for (const member of state.members) {
      const switched = await this.switchMemberSession(userId, groupId, member.memberKey, { createNew: true });
      memberSessions.push({ memberKey: member.memberKey, sessionId: switched.sessionId, sessionTitle: switched.sessionTitle });
    }
    return { room, memberSessions };
  }

  private async visibleHistoryForMember(groupId: string, conversationId: string, member: GroupMemberSession): Promise<Array<{ seq: number; authorName: string; text: string; createdAt: number }>> {
    if (member.historyVisibility.kind === "none") return [];
    const limit = member.historyVisibility.kind === "recent" ? member.historyVisibility.count : 200;
    const rows = await this.store.db.all<{ id: string; author_id: string; author_type: string; blocks_json: string; created_at: number }>(
      `SELECT id, author_id, author_type, blocks_json, created_at
       FROM messages
       WHERE conversation_id=? AND status='complete'
       ORDER BY created_at DESC LIMIT ?`,
      [conversationId, limit],
    );
    return rows.reverse().map((row, idx) => ({
      seq: idx + 1,
      authorName: row.author_type === "user" ? "User" : row.author_id,
      text: blocksText(JSON.parse(row.blocks_json)).slice(0, 4000),
      createdAt: row.created_at,
    }));
  }

  /** Sends a group question to one or all active remote members with explicit 4-state tracking
   * (`sending`, `delivered`, `failed`, `uncertain`) and zero message loss when offline. */
  async sendToRemoteMembers(
    userId: string,
    groupId: string,
    conversationId: string,
    sourceMessage: Message,
    options?: { targetMemberKeys?: string[] },
  ): Promise<RemoteGroupQuestion[]> {
    await this.init();
    const group = await this.getConversation(userId, groupId);
    const state = await this.getState(userId, groupId, false);
    const remoteMembers = state.members.filter(
      (m) => m.kind === "remote" && (!options?.targetMemberKeys || options.targetMemberKeys.includes(m.memberKey)),
    );
    if (!remoteMembers.length) return [];

    const localHostName = await this.localHostNameProvider();
    const text = blocksText(sourceMessage.blocks);
    const results: RemoteGroupQuestion[] = [];

    for (const member of remoteMembers) {
      const qid = `gq_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const requestId = `greq_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const now = Date.now();
      await this.store.db.run(
        `INSERT INTO group_remote_questions(
          id, group_id, conversation_id, member_key, host_id, host_name, bot_id, session_id,
          bot_name_snapshot, source_message_id, request_id, status, stopped_unanswered, error, created_at, updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'sending',0,NULL,?,?)`,
        [qid, groupId, conversationId, member.memberKey, member.hostId, member.hostName, member.botId, member.sessionId, member.nameSnapshot, sourceMessage.id, requestId, now, now],
      );

      const peer = await this.findPeer(member.hostId);
      if (!peer) {
        const offlineError = `${member.hostName} is offline; message kept without loss`;
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='failed', error=?, updated_at=? WHERE id=?",
          [offlineError, Date.now(), qid],
        );
        const row = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [qid]);
        results.push(this.mapQuestionRow(row!));
        continue;
      }

      const contextMessages = await this.visibleHistoryForMember(groupId, conversationId, member);
      const payload: GroupMailDeliver = {
        requestId,
        groupId,
        groupTitle: group.title,
        conversationId,
        sourceHostId: "origin",
        sourceHostName: localHostName,
        sourceMessageId: sourceMessage.id,
        botId: member.botId,
        sessionId: member.sessionId,
        text,
        contextMessages,
        ...(this.localUrlProvider() ? { callbackUrl: this.localUrlProvider() } : {}),
      };

      try {
        const res = await this.callPeer(peer, "POST", "/api/group-mail/deliver", payload);
        if (res.status === 200) {
          await this.store.db.run(
            "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=? WHERE id=?",
            [Date.now(), qid],
          );
        } else if (res.status >= 400 && res.status < 500) {
          const reason = (res.json as { error?: string } | undefined)?.error ?? `http_${res.status}`;
          await this.store.db.run(
            "UPDATE group_remote_questions SET status='failed', error=?, updated_at=? WHERE id=?",
            [reason, Date.now(), qid],
          );
        } else {
          // 5xx or unexpected gateway status -> uncertain (may have been persisted before error).
          await this.store.db.run(
            "UPDATE group_remote_questions SET status='uncertain', error=?, updated_at=? WHERE id=?",
            [`http_${res.status}`, Date.now(), qid],
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const causeCode = String((error as { cause?: { code?: string } } | null)?.cause?.code ?? "");
        const isDefiniteRefused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(`${msg} ${causeCode}`);
        const nextStatus: RemoteGroupQuestionStatus = isDefiniteRefused ? "failed" : "uncertain";
        const detail = isDefiniteRefused ? `${member.hostName} is offline; message kept without loss` : `uncertain_delivery: ${msg}`;
        await this.store.db.run(
          "UPDATE group_remote_questions SET status=?, error=?, updated_at=? WHERE id=?",
          [nextStatus, detail, Date.now(), qid],
        );
      }

      const finalRow = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [qid]);
      results.push(this.mapQuestionRow(finalRow!));
    }
    return results;
  }

  /** Reconciles or retries a `failed` or `uncertain` cross-host question (e.g. after remote Hub B restarts). */
  async reconcileOrRetryQuestion(userId: string, groupId: string, questionId: string): Promise<RemoteGroupQuestion> {
    await this.init();
    const group = await this.getConversation(userId, groupId);
    const row = await this.store.db.get<Record<string, unknown>>(
      "SELECT * FROM group_remote_questions WHERE id=? AND group_id=?",
      [questionId, groupId],
    );
    if (!row) throw new HubError("group_question_not_found", 404);
    const q = this.mapQuestionRow(row);
    const peer = await this.findPeer(q.hostId);
    if (!peer) throw new HubError("peer_host_offline", 503);

    // 1. Check remote status by idempotent requestId first (recovery without double-sending!).
    const statusRes = await this.callPeer(peer, "GET", `/api/group-mail/status/${encodeURIComponent(q.requestId)}`);
    if (statusRes.status === 200 && statusRes.json && typeof statusRes.json === "object") {
      const info = statusRes.json as { found?: boolean; status?: string; replyText?: string };
      if (info.found) {
        await this.store.db.run(
          "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=? WHERE id=?",
          [Date.now(), q.id],
        );
        if (info.status === "answered" && typeof info.replyText === "string" && !q.answerMessageId) {
          await this.handlePeerReply(peer, {
            requestId: q.requestId,
            groupId: q.groupId,
            conversationId: q.conversationId,
            botId: q.botId,
            sessionId: q.sessionId,
            text: info.replyText,
          });
        }
        const updated = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [q.id]);
        return this.mapQuestionRow(updated!);
      }
    }

    // 2. Not found on remote -> safely re-deliver using the SAME idempotent requestId!
    const sourceRow = await this.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=?", [q.sourceMessageId]);
    const text = sourceRow ? blocksText(JSON.parse(sourceRow.blocks_json)) : "";
    const localHostName = await this.localHostNameProvider();
    const res = await this.callPeer(peer, "POST", "/api/group-mail/deliver", {
      requestId: q.requestId,
      groupId: q.groupId,
      groupTitle: group.title,
      conversationId: q.conversationId,
      sourceHostId: "origin",
      sourceHostName: localHostName,
      sourceMessageId: q.sourceMessageId,
      botId: q.botId,
      sessionId: q.sessionId,
      text,
      contextMessages: [],
      ...(this.localUrlProvider() ? { callbackUrl: this.localUrlProvider() } : {}),
    } satisfies GroupMailDeliver);
    if (res.status === 200) {
      await this.store.db.run(
        "UPDATE group_remote_questions SET status='delivered', error=NULL, updated_at=? WHERE id=?",
        [Date.now(), q.id],
      );
    } else {
      await this.store.db.run(
        "UPDATE group_remote_questions SET status='failed', error=?, updated_at=? WHERE id=?",
        [`http_${res.status}`, Date.now(), q.id],
      );
    }
    const updated = await this.store.db.get<Record<string, unknown>>("SELECT * FROM group_remote_questions WHERE id=?", [q.id]);
    return this.mapQuestionRow(updated!);
  }

  /** Stops the whole group: halts active local work and marks every unanswered remote question cleanly
   * (`stoppedUnanswered: true`) while still letting late remote answers land in the group. */
  async stopGroup(userId: string, groupId: string): Promise<{ stoppedUnansweredCount: number; questions: RemoteGroupQuestion[] }> {
    await this.init();
    const group = await this.getConversation(userId, groupId);
    if (group.type !== "group" || group.parentId) throw new HubError("group_required", 400);
    if (this.onGroupStopLocal) await this.onGroupStopLocal(groupId);
    const now = Date.now();
    await this.store.db.run(
      "UPDATE group_remote_questions SET stopped_unanswered=1, updated_at=? WHERE group_id=? AND answer_message_id IS NULL",
      [now, groupId],
    );
    const rows = await this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM group_remote_questions WHERE group_id=? AND stopped_unanswered=1 ORDER BY created_at DESC",
      [groupId],
    );
    return {
      stoppedUnansweredCount: rows.length,
      questions: rows.map((r) => this.mapQuestionRow(r)),
    };
  }
}
