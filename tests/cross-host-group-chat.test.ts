import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HubServer } from "../src/hub/server.js";

describe("Cross-host group chat, session-based members & Orca-style group settings (#85)", () => {
  const dirs: string[] = [];
  const hubs: HubServer[] = [];

  async function startHub(name: string, existingStateDir?: string): Promise<{ hub: HubServer; stateDir: string }> {
    const stateDir = existingStateDir ?? await fs.mkdtemp(path.join(os.tmpdir(), `tarobird-85-${name}-`));
    if (!existingStateDir) dirs.push(stateDir);
    const hub = await HubServer.start({ stateDir });
    hubs.push(hub);
    const profile = await hub.profile.read();
    await hub.profile.update({ name, revision: profile.revision });
    return { hub, stateDir };
  }

  afterEach(async () => {
    while (hubs.length) {
      const h = hubs.pop()!;
      await h.close().catch(() => undefined);
    }
    while (dirs.length) {
      await fs.rm(dirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("supports joining by existing session, different sessions per group, and auto-creating a session when none exists", async () => {
    const { hub } = await startHub("macmini");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_alpha','Alpha','codex','h',1)");
    await hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_beta','Beta','claude','h',1)");

    // Give bot_alpha two pre-existing sessions; bot_beta has NONE.
    const sess1 = await hub.store.createConversation("owner", ["bot_alpha"], "Alpha Session 1", "s_alpha_1", { type: "direct" });
    const sess2 = await hub.store.createConversation("owner", ["bot_alpha"], "Alpha Session 2", "s_alpha_2", { type: "direct" });

    const g1 = await hub.store.createConversation("owner", ["bot_alpha"], "Architecture Group", "g_arch", { type: "group" });
    const g2 = await hub.store.createConversation("owner", ["bot_alpha"], "Release Group", "g_rel", { type: "group" });

    // 1. Join g1 with explicit session sess1 and g2 with explicit session sess2 (same Bot, different sessions!)
    const m1 = await hub.crossHostGroups.addMember("owner", g1.id, {
      botId: "bot_alpha",
      sessionId: sess1.id,
      historyVisibility: { kind: "recent", count: 10 },
    });
    const m2 = await hub.crossHostGroups.addMember("owner", g2.id, {
      botId: "bot_alpha",
      sessionId: sess2.id,
      historyVisibility: { kind: "all" },
    });
    expect(m1.sessionId).toBe(sess1.id);
    expect(m2.sessionId).toBe(sess2.id);
    expect(m1.historyVisibility).toEqual({ kind: "recent", count: 10 });

    // 2. Join bot_beta which has NO existing session -> auto-creates a session stating which group it came from!
    const mBeta = await hub.crossHostGroups.addMember("owner", g1.id, {
      botId: "bot_beta",
      historyVisibility: { kind: "none" },
    });
    expect(mBeta.sessionTitle).toContain("Architecture Group");
    expect(mBeta.sessionTitle).toContain("Beta");
    expect(await hub.crossHostGroups.canSessionAccessGroup(g1.id, mBeta.sessionId)).toBe(true);

    // 3. Removing a member revokes future access and records sessionId in formerSessionIds while keeping history openable!
    const { removed } = await hub.crossHostGroups.removeMember("owner", g1.id, mBeta.memberKey);
    expect(removed.sessionId).toBe(mBeta.sessionId);
    expect(await hub.crossHostGroups.canSessionAccessGroup(g1.id, mBeta.sessionId)).toBe(false);
    const state = await hub.crossHostGroups.getState("owner", g1.id, false);
    expect(state.formerSessionIds).toContain(mBeta.sessionId);
    expect(state.members.some((m) => m.memberKey === mBeta.memberKey)).toBe(false);
    // Former session conversation still exists in store so history stays readable
    const allConvs = await hub.store.conversations("owner");
    expect(allConvs.some((c) => c.id === mBeta.sessionId)).toBe(true);
  });

  it("delivers cross-host questions across two real Hubs, covers all 4 delivery states, survives Hub B restart, prevents rename hijacking, and marks unanswered questions on group stop", async () => {
    const a = await startHub("macmini");
    let b = await startHub("studio-b");

    // Wire mutual Ed25519 peer trust between Hub A and Hub B
    const linkPeers = () => {
      a.hub.crossHostGroups.registerPeer({ hostId: "peer_b", hostName: "studio-b", publicKey: b.hub.auth.publicKey, url: b.hub.url });
      b.hub.crossHostGroups.registerPeer({ hostId: "peer_a", hostName: "macmini", publicKey: a.hub.auth.publicKey, url: a.hub.url });
    };
    linkPeers();

    await a.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_local','Architect','codex','h',1)");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_remote','Reviewer','claude','h',1)");

    const group = await a.hub.store.createConversation("owner", ["bot_local"], "Cross-Host Review", "g_cross", { type: "group" });

    // Join remote bot_remote on Hub B (no session yet -> auto-creates session on Hub B!)
    const remoteMember = await a.hub.crossHostGroups.addMember("owner", group.id, {
      hostId: "peer_b",
      botId: "bot_remote",
      historyVisibility: { kind: "recent", count: 5 },
    });
    expect(remoteMember.kind).toBe("remote");
    expect(remoteMember.hostName).toBe("studio-b");
    expect(remoteMember.nameSnapshot).toBe("Reviewer");
    expect(remoteMember.sessionTitle).toContain("Cross-Host Review");

    // 1. Delivered state: Hub A sends a real signed cross-host question -> Hub B receives it in bot_remote's exact session!
    const msg1 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_1",
      text: "Please review the TLS handshake patch.",
      attachments: [],
    });
    const deliveredQuestions = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg1.message);
    expect(deliveredQuestions).toHaveLength(1);
    expect(deliveredQuestions[0]!.status).toBe("delivered");

    // Remote Bot replies on Hub B -> lands cleanly in Hub A's group attributed to join-time snapshot "Reviewer" on "studio-b"
    await b.hub.crossHostGroups.recordRemoteBotReply(deliveredQuestions[0]!.requestId, "b_reply_1", "Looks solid from studio-b!");
    const groupMsgsAfterReply = await a.hub.store.db.all<{ bot_source_json: string | null; blocks_json: string }>(
      "SELECT bot_source_json, blocks_json FROM messages WHERE conversation_id=?",
      [group.id],
    );
    expect(groupMsgsAfterReply.some((m) => m.bot_source_json && JSON.parse(m.bot_source_json).botName === "Reviewer" && JSON.parse(m.bot_source_json).hostName === "studio-b")).toBe(true);

    // 2. Rename-hijack protection: rename original bot_remote -> "Reviewer Old", create a NEW bot named "Reviewer"!
    await b.hub.store.db.run("UPDATE bots SET name='Reviewer Old' WHERE id='bot_remote'");
    await b.hub.store.db.run("INSERT INTO bots(id,name,engine,secret_hash,online) VALUES('bot_impostor','Reviewer','codex','h',1)");

    const msg2 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_2",
      text: "Follow-up after rename",
      attachments: [],
    });
    const qAfterRename = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg2.message);
    expect(qAfterRename[0]!.status).toBe("delivered");
    // Verify it arrived strictly in original bot_remote's session, NEVER bot_impostor!
    const inboxRow = await b.hub.store.db.get<{ bot_id: string; session_id: string }>(
      "SELECT bot_id, session_id FROM group_mail_inbox WHERE request_id=?",
      [qAfterRename[0]!.requestId],
    );
    expect(inboxRow).toEqual({ bot_id: "bot_remote", session_id: remoteMember.sessionId });

    // 3. Whole-group stop marks unanswered remote question as stoppedUnanswered=true, yet late reply STILL lands!
    const stopRes = await a.hub.crossHostGroups.stopGroup("owner", group.id);
    expect(stopRes.stoppedUnansweredCount).toBe(1);
    expect(stopRes.questions[0]!.stoppedUnanswered).toBe(true);
    await b.hub.crossHostGroups.recordRemoteBotReply(qAfterRename[0]!.requestId, "b_reply_late", "Late answer after stop");
    const msgsAfterLate = await a.hub.store.db.all<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE conversation_id=?", [group.id]);
    expect(msgsAfterLate.some((m) => JSON.parse(m.blocks_json)[0]?.text === "Late answer after stop")).toBe(true);

    // 4. Uncertain state (mid-flight drop after Hub B accepted) + Hub B RESTART + idempotent recovery!
    const realDeliver = a.hub.crossHostGroups["transport"];
    a.hub.crossHostGroups.setTransport(async (peer, method, routePath, headers, body) => {
      if (routePath === "/api/group-mail/deliver") {
        await realDeliver(peer, method, routePath, headers, body);
        throw new Error("socket hang up");
      }
      return realDeliver(peer, method, routePath, headers, body);
    });
    const msg3 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_3",
      text: "Message during mid-flight drop",
      attachments: [],
    });
    const qUncertain = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg3.message);
    expect(qUncertain[0]!.status).toBe("uncertain");

    // Now SHUT DOWN Hub B completely (offline!) -> sending a new message fails cleanly with offline notice & zero loss!
    a.hub.crossHostGroups.setTransport(realDeliver);
    await b.hub.close();
    hubs.splice(hubs.indexOf(b.hub), 1);

    const msg4 = await a.hub.store.sendMessage("owner", {
      conversationId: group.id,
      clientMsgId: "u_msg_4",
      text: "Message while Hub B is offline",
      attachments: [],
    });
    const qFailed = await a.hub.crossHostGroups.sendToRemoteMembers("owner", group.id, group.id, msg4.message);
    expect(qFailed[0]!.status).toBe("failed");
    expect(qFailed[0]!.error).toContain("studio-b");

    // RESTART Hub B on the SAME stateDir (real restart recovery!)
    b = await startHub("studio-b", b.stateDir);
    linkPeers();

    // Reconcile uncertain msg3 (already persisted on Hub B before restart -> recovers as delivered with ZERO duplicate!)
    const recovered3 = await a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, qUncertain[0]!.id);
    expect(recovered3.status).toBe("delivered");
    // Retry failed msg4 now that Hub B is back -> succeeds cleanly!
    const retried4 = await a.hub.crossHostGroups.reconcileOrRetryQuestion("owner", group.id, qFailed[0]!.id);
    expect(retried4.status).toBe("delivered");

    // Verify zero duplicate messages in bot_remote's session for msg3!
    const remoteMsgs = await b.hub.store.db.all<{ client_msg_id: string | null }>(
      "SELECT client_msg_id FROM messages WHERE conversation_id=?",
      [remoteMember.sessionId],
    );
    expect(remoteMsgs.filter((m) => m.client_msg_id === `gmail_${qUncertain[0]!.requestId}`)).toHaveLength(1);

    // 5. New room allocates fresh sessions for every active member (local + remote)
    const { room, memberSessions } = await a.hub.crossHostGroups.createRoom("owner", group.id, { title: "Sprint 12 Room" });
    expect(room.parentId).toBe(group.id);
    expect(memberSessions).toHaveLength(2);
    expect(memberSessions.every((ms) => ms.sessionId !== remoteMember.sessionId)).toBe(true);
  });
});
