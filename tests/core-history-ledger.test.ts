import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { withChannelProfile } from "../src/gateway/platform-profile.js";
import { HISTORY_LEDGER_UNBOUND_SESSION, readHistoryLedger } from "../src/runtime/history-ledger.js";
import { fakeChannel, fakeLarkMessage } from "./helpers/core-compat-fixtures.js";

// Synthetic messages; the Bridge is a stub that reports native turns.
const KEY = "lark:oc_chat";
type TurnInput = Parameters<CoreBridgeLike["handleAuthorizedMessage"]>[0];

describe("Core history ledger (#53)", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "core-history-ledger-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", locale: "en" }));
  });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });
  const gateway = (bridge: CoreBridgeLike, messageId: string, content = "fix the build") =>
    withChannelProfile("gateway", () => handleCoreMessage({ channel: { ...fakeChannel(), profile: "gateway" as const }, bridge, runtime: createCoreServiceRuntime(), stateDir, message: fakeLarkMessage({ messageId, content }) }));

  it("records an ordinary message run: Hub id to the engine, first and last turn, outcome", async () => {
    const calls: TurnInput[] = [];
    const bridge = { handleAuthorizedMessage: vi.fn(async (input: TurnInput) => {
      calls.push(input);
      await input.onTurnAnchor?.({ sessionId: "thr-1", turnId: "t1" });
      // An automatic recovery continuation is another turn of the same run.
      await input.onTurnAnchor?.({ sessionId: "thr-1", turnId: "t2" });
      await input.onEngineEvent?.({ type: "turn_anchor", sessionId: "thr-1", turnId: "t2" });
      return { text: "done" };
    }) };
    await gateway(bridge, "msg_a");
    expect(calls[0]!.sourceMessageId).toBe("msg_a");
    const [run] = await readHistoryLedger(stateDir, KEY);
    expect(run!.first.sessionId).toBe(HISTORY_LEDGER_UNBOUND_SESSION);
    expect(run!.last).toMatchObject({ sourceMessageId: "msg_a", engine: "codex", sessionId: "thr-1", anchor: { firstTurnId: "t1", lastTurnId: "t2" }, outcome: "ok" });
    expect(run!.last.endedAt).toBeGreaterThanOrEqual(run!.last.startedAt);
  });

  it("records a failed run with its failure category", async () => {
    const bridge = { handleAuthorizedMessage: vi.fn(async (input: TurnInput) => {
      await input.onTurnAnchor?.({ sessionId: "thr-1", turnId: "t9" });
      throw new Error("You've hit your usage limit.");
    }) };
    await gateway(bridge, "msg_b");
    const [run] = await readHistoryLedger(stateDir, KEY);
    expect(run!.last).toMatchObject({ sourceMessageId: "msg_b", anchor: { firstTurnId: "t9", lastTurnId: "t9" }, outcome: "failed:engine-quota" });
  });

  it("writes nothing for slash commands, command-shaped input or the Feishu profile", async () => {
    const bridge = { handleAuthorizedMessage: vi.fn(async (input: TurnInput) => { await input.onTurnAnchor?.({ sessionId: "thr-1", turnId: "t1" }); return { text: "ok" }; }) };
    await gateway(bridge, "msg_c", "/help");
    // Unknown to Core, so the engine gets it, but the Hub never takes it for an anchor.
    await gateway(bridge, "msg_u", "/unknowncmd do it");
    await handleCoreMessage({ channel: fakeChannel(), bridge, runtime: createCoreServiceRuntime(), stateDir, message: fakeLarkMessage({ messageId: "om_feishu" }) });
    expect(await readHistoryLedger(stateDir, KEY)).toEqual([]);
    for (const call of bridge.handleAuthorizedMessage.mock.calls) expect(call[0]).not.toHaveProperty("sourceMessageId");
  });

  it("records what the Hub accepts as an anchor: delegated Bot input and slash text that is not a command", async () => {
    const bridge = { handleAuthorizedMessage: vi.fn(async (input: TurnInput) => { await input.onTurnAnchor?.({ sessionId: "thr-1", turnId: `t-${input.sourceMessageId}` }); return { text: "ok" }; }) };
    const botSource = { hostId: "host_1", botId: "bot_2", requestId: "req_1", hops: 1 };
    await withChannelProfile("gateway", () => handleCoreMessage({ channel: { ...fakeChannel(), profile: "gateway" as const }, bridge, runtime: createCoreServiceRuntime(), stateDir,
      message: { ...fakeLarkMessage({ messageId: "msg_d", content: "summarize the report" }), botSource } as never }));
    await gateway(bridge, "msg_p", "/Users/a/b 是什么");
    const runs = await readHistoryLedger(stateDir, KEY);
    expect(runs.map(run => [run.last.sourceMessageId, run.last.anchor?.firstTurnId])).toEqual([["msg_d", "t-msg_d"], ["msg_p", "t-msg_p"]]);
    expect(bridge.handleAuthorizedMessage.mock.calls.map(call => call[0].sourceMessageId)).toEqual(["msg_d", "msg_p"]);
  });
});
