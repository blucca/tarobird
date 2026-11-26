import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { blocksText, uploadSchema } from "../src/client-protocol/index.js";
import { isRecordedVoiceBlock } from "../src/client-protocol/voice-presentation.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { PiRpcAdapter } from "../src/codex/pi-rpc-adapter.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { createDefaultTranscribeVoice } from "../src/core/voice.js";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { Bridge } from "../src/runtime/bridge.js";
import { transcribeViaTingwuCloud } from "../src/runtime/asr-cloud.js";
import { SessionManager } from "../src/runtime/session-manager.js";
import { SessionStore } from "../src/state/session-store.js";
import { uploadFile } from "../client/src/files.js";
import { markRecordedVoiceFile } from "../client/src/voice-recording-marker.js";
import { fakePiModel, fakePiSpawner } from "./helpers/pi-fake-rpc.js";

vi.mock("../src/runtime/asr-cloud.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runtime/asr-cloud.js")>(),
  transcribeViaTingwuCloud: vi.fn(),
}));

class FakeStream extends EventEmitter {
  emitData(chunk: string) { this.emit("data", chunk); }
}
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) this.lines.push(text);
    callback?.(null);
    return true;
  }
}
class FakeClaudeChild extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  kill() { return true; }
  frames() { return this.stdin.lines.map((line) => JSON.parse(line) as Record<string, any>); }
  emitJson(value: object) { this.stdout.emitData(JSON.stringify(value) + "\n"); }
}

const access = {
  load: async () => ({ multiChat: true, policy: "allowlist" as const, allowlist: [] as number[], pendingPairs: [], pairedUsers: [] }),
  issuePairingCode: async () => ({ code: "000000" }),
};

const until = async (check: () => Promise<boolean> | boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("audio recording vs uploaded file distinction", () => {
  let root: string;
  let hub: HubServer;
  let gateway: GatewayChannel | undefined;

  beforeEach(async () => {
    vi.mocked(transcribeViaTingwuCloud).mockReset().mockRejectedValue(new Error("cloud ASR must not run"));
    root = await mkdtemp(path.join(os.tmpdir(), "audio-recording-vs-upload-"));
    hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  });

  afterEach(async () => {
    await gateway?.disconnect();
    gateway = undefined;
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });

  async function sendAttachment(conversationId: string, clientMsgId: string, name: string, mime: string, text: string, recording?: boolean) {
    const bytes = Buffer.from(`audio-fixture-${clientMsgId}-${name}`);
    const upload = await hub.attachments.create("owner", {
      conversationId,
      name,
      mime,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ...(recording !== undefined ? { recording } : {}),
    });
    await hub.attachments.putChunk("owner", upload.id, 0, bytes);
    await hub.attachments.complete("owner", upload.id);
    return hub.store.sendMessage("owner", { conversationId, clientMsgId, text, attachments: [upload.id] });
  }

  function cloudConfiguredLocalTranscriber(stateDir: string) {
    const fetchImpl = vi.fn(async () => ({ ok: true, text: async () => "这是语音录音转写文本" }));
    const transcribe = createDefaultTranscribeVoice({
      httpUrl: "http://127.0.0.1:8412/transcribe",
      cliPython: "",
      cliScript: "",
      fetchImpl: fetchImpl as never,
      watchdog: { recordSuccess: vi.fn(), recordFailure: vi.fn().mockResolvedValue(undefined) } as never,
      execFileImpl: ((file: string, args: string[], _opts: unknown, cb: (err: Error | null, out: string, errout: string) => void) => {
        if (file === "ffprobe") cb(null, args.includes("stream=codec_type") ? JSON.stringify({ streams: [{ codec_type: "audio" }] }) : "5", "");
        else cb(new Error("unexpected command"), "", "");
      }) as never,
      chunkAfterSeconds: 100_000,
      maxAudioSeconds: 100_000,
      env: { TINGWU_ASR_DIR: path.join(root, "tingwu"), ASR_CLOUD_MODE: "cloud" },
      stateDir,
    });
    return { transcribe, fetchImpl };
  }

  it("delivers uploaded audio files to Pi without transcription while transcribing recordings", async () => {
    const stateDir = path.join(root, "pi-bot");
    const workspace = path.join(stateDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "pi", workspace, locale: "zh", approvalMode: "bypass" }));
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('pi_bot','Pi Bot',?)", [hashSecret(secret)]);

    const prompts: string[] = [];
    const spawner = fakePiSpawner(() => ({
      model: fakePiModel("anthropic", "claude-sonnet-4-5"),
      onPrompt: (run) => {
        prompts.push(String(run.command.message));
        run.reply("Pi handled input");
        run.finish();
      },
    }));
    const adapter = new PiRpcAdapter({
      launch: { command: "pi", args: [] },
      workspacePath: workspace,
      stateDir,
      configPath: path.join(stateDir, "config.json"),
      childEnv: { PI_CODING_AGENT_DIR: path.join(root, "pi-agent") },
      bridgeExtensionPath: null,
      spawnFn: spawner.spawn,
      killProcessTreeFn: () => undefined,
      queryCatalogFn: async () => ({ models: [], current: { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "medium" } }),
      idleSweepIntervalMs: 0,
      startupTimeoutMs: 500,
    });
    const bridge = new Bridge(access, new SessionManager(new SessionStore(path.join(stateDir, "session.json")), adapter), adapter);
    const transcribeHook = vi.fn(async () => "录音转写内容");
    gateway = await attachGateway({
      stateDir,
      botId: "pi_bot",
      secret,
      engine: "pi",
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      bridge,
      runtime: createCoreServiceRuntime({ transcribeMedia: transcribeHook }),
    });

    const conv = await hub.store.createConversation("owner", ["pi_bot"], "Pi Audio", "pi-audio");
    // 1. Uploaded audio files: .m4a (explicit recording: false), .mp3 (omitted/legacy), and a file named voice-<ts>.m4a (recording: false)
    await sendAttachment(conv.id, "pi-m4a", "meeting.m4a", "audio/mp4", "原样保留附件", false);
    await sendAttachment(conv.id, "pi-mp3", "podcast.mp3", "audio/mpeg", "原样保留mp3");
    await sendAttachment(conv.id, "pi-named-upload", "voice-1791780593981.m4a", "audio/mp4", "这是上传的录音文件", false);
    await until(async () => (await hub.store.pendingForBot("pi_bot")).length === 0 && prompts.length === 3);

    expect(transcribeHook).not.toHaveBeenCalled();
    expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
    expect(prompts[0]).toContain("Attachment: ");
    expect(prompts[0]).toMatch(/meeting\.m4a/);
    expect(prompts[1]).toMatch(/podcast\.mp3/);
    expect(prompts[2]).toMatch(/voice-1791780593981\.m4a/);
    expect(prompts.every((p) => !p.includes("[Bridge media transcription completed]"))).toBe(true);

    // 2. Recorded voice messages: explicit recording: true and legacy App fallback voice-<ts>.webm
    await sendAttachment(conv.id, "pi-rec", "voice-1791780593999.m4a", "audio/mp4", "", true);
    await sendAttachment(conv.id, "pi-legacy-rec", "voice-1791780594000.webm", "audio/webm", "");
    await until(async () => (await hub.store.pendingForBot("pi_bot")).length === 0 && prompts.length === 5);

    expect(transcribeHook).toHaveBeenCalledTimes(2);
    expect(prompts[3]).toContain("[Bridge media transcription completed]");
    expect(prompts[3]).toContain("录音转写内容");
    expect(prompts[4]).toContain("[Bridge media transcription completed]");

    const messages = (await hub.store.snapshot("owner", conv.id)).messages;
    const userBlocks = messages.filter((m) => m.authorType === "user").map((m) => m.blocks);
    expect(userBlocks[0]!.some((b) => b.type === "file" && b.name === "meeting.m4a")).toBe(true);
    expect(userBlocks[1]!.some((b) => b.type === "file" && b.name === "podcast.mp3")).toBe(true);
    expect(userBlocks[2]!.some((b) => b.type === "file" && b.name === "voice-1791780593981.m4a")).toBe(true);
    expect(userBlocks[3]!.some((b) => b.type === "audio" && b.recording === true)).toBe(true);
    expect(userBlocks[4]!.some((b) => b.type === "audio" && b.name === "voice-1791780594000.webm")).toBe(true);
    await adapter.destroy();
  });

  it("delivers uploaded audio files to Claude Code without transcription while transcribing recordings", async () => {
    const stateDir = path.join(root, "claude-bot");
    const workspace = path.join(stateDir, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", workspace, locale: "en", approvalMode: "bypass" }));
    const secret = randomBytes(32).toString("base64url");
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('claude_bot','Claude Bot',?)", [hashSecret(secret)]);

    const children: FakeClaudeChild[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      workspacePath: workspace,
      spawnFn: (() => {
        const child = new FakeClaudeChild();
        children.push(child);
        const origWrite = child.stdin.write.bind(child.stdin);
        let initialized = false;
        child.stdin.write = (chunk: string, cb?: (err?: Error | null) => void) => {
          const ok = origWrite(chunk, cb);
          try {
            const frame = JSON.parse(chunk.toString().trim()) as { type?: string; request_id?: string; request?: { subtype?: string } };
            if (frame.type === "control_request" && frame.request?.subtype === "initialize" && frame.request_id) {
              queueMicrotask(() => {
                child.emitJson({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
                child.emitJson({ type: "control_request", request_id: "mcp-list-1", request: { subtype: "mcp_message", server_name: "tarocub_app", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } } });
              });
            }
            if (frame.type === "user") {
              queueMicrotask(() => {
                if (!initialized) {
                  initialized = true;
                  child.emitJson({ type: "system", subtype: "init", session_id: "sess-claude-1" });
                }
                child.emitJson({ type: "assistant", session_id: "sess-claude-1", message: { content: [{ type: "text", text: "Claude ack" }] } });
                child.emitJson({ type: "result", session_id: "sess-claude-1", subtype: "success", is_error: false, result: "Claude ack" });
              });
            }
          } catch { /* ignore */ }
          return ok;
        };
        return child;
      }) as never,
    });
    const bridge = new Bridge(access, new SessionManager(new SessionStore(path.join(stateDir, "session.json")), adapter), adapter);
    const transcribeHook = vi.fn(async () => "Claude recording transcript");
    gateway = await attachGateway({
      stateDir,
      botId: "claude_bot",
      secret,
      engine: "claude",
      url: hub.instanceUrl.replace("http", "ws") + "/instance",
      bridge,
      runtime: createCoreServiceRuntime({ transcribeMedia: transcribeHook }),
    });

    const conv = await hub.store.createConversation("owner", ["claude_bot"], "Claude Audio", "claude-audio");
    const userFrames = () => children[0]?.frames().filter((f) => f.type === "user") ?? [];
    await sendAttachment(conv.id, "cl-wav", "clip.wav", "audio/wav", "Pass this wav file", false);
    await until(async () => (await hub.store.pendingForBot("claude_bot")).length === 0 && userFrames().length >= 1);

    expect(transcribeHook).not.toHaveBeenCalled();
    expect(transcribeViaTingwuCloud).not.toHaveBeenCalled();
    const firstTurnText = JSON.stringify(userFrames()[0]);
    expect(firstTurnText).toContain("Attachment: ");
    expect(firstTurnText).toContain("clip.wav");
    expect(firstTurnText).not.toContain("Bridge media transcription completed");

    await sendAttachment(conv.id, "cl-rec", "voice-1791780594111.m4a", "audio/mp4", "", true);
    await until(async () => (await hub.store.pendingForBot("claude_bot")).length === 0 && userFrames().length >= 2);
    expect(transcribeHook).toHaveBeenCalledTimes(1);
    const secondTurnText = JSON.stringify(userFrames()[1]);
    expect(secondTurnText).toContain("Bridge media transcription completed");
    expect(secondTurnText).toContain("Claude recording transcript");
    await adapter.destroy();
  });

  it("preserves Feishu/Lark forwarded audio file transcription and cloud-only no-retry behavior", async () => {
    const stateDir = path.join(root, "lark-bot");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
    vi.mocked(transcribeViaTingwuCloud).mockRejectedValueOnce(new Error("fixture cloud failure"));
    const { transcribe, fetchImpl } = cloudConfiguredLocalTranscriber(stateDir);
    const engine = vi.fn(async () => ({ text: "notified" }));
    const channel = {
      send: vi.fn(async () => ({ messageId: "m_reply" })),
      stream: vi.fn(async () => ({ messageId: "m_stream" })),
      downloadResource: vi.fn(async () => Buffer.from("forwarded audio")),
    };

    await withChannelProfile("feishu", async () => {
      await handleCoreMessage({
        channel,
        bridge: { handleAuthorizedMessage: engine },
        runtime: createCoreServiceRuntime({ transcribeMedia: transcribe }),
        stateDir,
        message: {
          messageId: "om_fwd",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "帮我看看这段转发录音",
          rawContentType: "file",
          resources: [{ type: "file", fileKey: "fk_fwd", fileName: "forwarded-meeting.m4a" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: true,
          createTime: Date.now(),
        },
      });
    });

    expect(transcribeViaTingwuCloud).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledTimes(1);
    expect((engine.mock.calls[0] as any[])[0].text).toContain("Do not automatically re-upload");
  });

  it("client uploadFile marks only recorded voice files on capable Hosts and omits the field on older Hosts", async () => {
    const oldUploadSchema = z.object({
      conversationId: uploadSchema.shape.conversationId,
      name: uploadSchema.shape.name,
      size: uploadSchema.shape.size,
      mime: uploadSchema.shape.mime,
      sha256: uploadSchema.shape.sha256,
    }).strict();

    const createPayloads: Array<Record<string, unknown>> = [];
    const makeConnection = (audioRecordingMarkerAvailable: boolean) => ({
      state: { status: "online" as const, audioRecordingMarkerAvailable },
      subscribe: () => () => undefined,
      resume: () => undefined,
      isClosed: false,
      beginFileTransfer: () => () => undefined,
      http: async (url: string, init?: { method?: string; body?: unknown }) => {
        if (url === "/api/uploads" && init?.method === "POST") {
          const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
          createPayloads.push(parsed);
          return { id: `att_${createPayloads.length}` };
        }
        if (url.endsWith("/complete")) return { id: "att_done", sha256: "0".repeat(64), size: 3 };
        if (init?.method === "PUT") return { ok: true };
        return { complete: true, chunks: [0] };
      },
    });

    const recorded = markRecordedVoiceFile(new File([new Uint8Array([1, 2, 3])], "voice-1791780593981.m4a", { type: "audio/mp4" }));
    const uploadedPicker = new File([new Uint8Array([1, 2, 3])], "voice-1791780593981.m4a", { type: "audio/mp4" });
    const uploadedShare = {
      name: "shared.mp3",
      size: 3,
      type: "audio/mpeg",
      readChunk: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" }),
    };

    const modern = makeConnection(true);
    await uploadFile(modern as never, "conv_1", recorded, () => undefined);
    await uploadFile(modern as never, "conv_1", uploadedPicker, () => undefined);
    await uploadFile(modern as never, "conv_1", uploadedShare, () => undefined);
    expect(createPayloads.slice(0, 3).map((p) => p.recording)).toEqual([true, false, false]);

    const legacy = makeConnection(false);
    await uploadFile(legacy as never, "conv_1", recorded, () => undefined);
    await uploadFile(legacy as never, "conv_1", uploadedPicker, () => undefined);
    for (const payload of createPayloads.slice(3)) {
      expect("recording" in payload).toBe(false);
      expect(() => oldUploadSchema.parse(payload)).not.toThrow();
    }
  });

  it("isRecordedVoiceBlock uses explicit flag first and falls back only to legacy voice-<timestamp> filenames", () => {
    expect(isRecordedVoiceBlock({ type: "audio", name: "custom.m4a", recording: true })).toBe(true);
    expect(isRecordedVoiceBlock({ type: "audio", name: "voice-1791780593981.m4a", recording: false })).toBe(false);
    expect(isRecordedVoiceBlock({ type: "audio", name: "voice-1791780593981.webm" })).toBe(true);
    expect(isRecordedVoiceBlock({ type: "audio", name: "song.mp3" })).toBe(false);
    expect(isRecordedVoiceBlock({ type: "file", name: "voice-1791780593981.m4a" })).toBe(false);
  });
});
