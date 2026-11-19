import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_LEDGER_UNBOUND_SESSION, HistoryLedgerRun, appendHistoryLedgerLine, findHistoryLedgerRun, historyLedgerPath, historyLedgerSinceMessageId, readHistoryLedger,
} from "../src/runtime/history-ledger.js";

// Synthetic ids only.
const KEY = "lark:gw_chat";

describe("history ledger (#53)", () => {
  let stateDir: string;
  beforeEach(async () => { stateDir = await mkdtemp(path.join(os.tmpdir(), "history-ledger-")); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  it("stores one file per conversation under a hashed name and lets the last line of a run win", async () => {
    let now = 1_000;
    const run = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: "msg_a", engine: "codex", runId: "run-a", now: () => now });
    await run.start("thr-1");
    now = 2_000; await run.anchor({ sessionId: "thr-1", turnId: "t1" });
    now = 3_000; await run.anchor({ sessionId: "thr-1", turnId: "t2" });
    await run.anchor({ sessionId: "thr-1", turnId: "t2" }); // same turn: no extra line
    now = 4_000; await run.finish("ok");
    await run.finish("failed:unknown"); // once
    const file = historyLedgerPath(stateDir, KEY);
    expect(path.basename(path.dirname(file))).toBe("history-ledger");
    expect(path.basename(file)).toMatch(/^[a-f0-9]{64}\.jsonl$/);
    expect(path.basename(file)).not.toContain("gw_chat");
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const runs = await readHistoryLedger(stateDir, KEY);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.first).toMatchObject({ sessionId: "thr-1", startedAt: 1_000 });
    expect(runs[0]!.last).toEqual({ v: 1, sourceMessageId: "msg_a", runId: "run-a", engine: "codex", sessionId: "thr-1",
      anchor: { firstTurnId: "t1", lastTurnId: "t2" }, startedAt: 1_000, endedAt: 4_000, outcome: "ok" });
  });

  it("keeps one anchor per session when a run continues in a replacement thread", async () => {
    const run = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: "msg_a", engine: "codex" });
    await run.start(undefined);
    await run.anchor({ sessionId: "thr-old", turnId: "t1" });
    await run.anchor({ sessionId: "thr-new", turnId: "t9" });
    await run.anchor({ sessionId: "thr-new", turnId: "t10" });
    await run.finish("failed:engine-invalid-request");
    const [record] = await readHistoryLedger(stateDir, KEY);
    expect(record!.first.sessionId).toBe(HISTORY_LEDGER_UNBOUND_SESSION);
    expect(record!.last).toMatchObject({ sessionId: "thr-new", anchor: { firstTurnId: "t9", lastTurnId: "t10" }, outcome: "failed:engine-invalid-request" });
  });

  it("skips a torn tail and invalid lines; a later append starts on a fresh line", async () => {
    const one = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: "msg_a", engine: "codex", runId: "run-a" });
    await one.start("thr-1"); await one.anchor({ sessionId: "thr-1", turnId: "t1" });
    const file = historyLedgerPath(stateDir, KEY);
    // Crash mid-write, then garbage from an older build.
    await appendFile(file, `\n{"v":1,"sourceMessageId":"msg_b","runId":"run-b","eng`);
    const two = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: "msg_c", engine: "codex", runId: "run-c" });
    await two.start("thr-1"); await two.anchor({ sessionId: "thr-1", turnId: "t2" }); await two.finish("ok");
    await appendFile(file, `\n{"v":2,"oops":true}\nnot json`);
    const runs = await readHistoryLedger(stateDir, KEY);
    expect(runs.map(run => run.runId)).toEqual(["run-a", "run-c"]);
    expect(findHistoryLedgerRun(runs, "msg_a")?.last.anchor).toEqual({ firstTurnId: "t1", lastTurnId: "t1" });
    expect(findHistoryLedgerRun(runs, "msg_b")).toBeUndefined();
  });

  it("never throws when the ledger cannot be written", async () => {
    // A file where the directory should be makes every append fail.
    await writeFile(path.join(stateDir, "history-ledger"), "not a directory");
    expect(await appendHistoryLedgerLine(stateDir, KEY, { v: 1, sourceMessageId: "msg_a", runId: "r", engine: "codex", sessionId: "s", startedAt: 1 })).toBe(false);
    const run = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: "msg_a", engine: "codex" });
    await expect(run.start("thr-1")).resolves.toBeUndefined();
    await expect(run.anchor({ sessionId: "thr-1", turnId: "t1" })).resolves.toBeUndefined();
    await expect(run.finish("ok")).resolves.toBeUndefined();
    // Only a missing file reads as empty; another read failure is reported.
    await expect(readHistoryLedger(stateDir, KEY)).rejects.toThrow();
  });

  it("rejects lines outside the shared schema", async () => {
    expect(await appendHistoryLedgerLine(stateDir, KEY, { v: 1, sourceMessageId: "bad id", runId: "r", engine: "codex", sessionId: "s", startedAt: 1 })).toBe(false);
    expect(await readHistoryLedger(stateDir, KEY)).toEqual([]);
  });

  it("names the message that created the current session, only when the ledger saw it", async () => {
    const write = async (messageId: string, start: string | undefined, sessionId: string) => {
      const run = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: messageId, engine: "codex" });
      await run.start(start); await run.anchor({ sessionId, turnId: `${messageId}-t` }); await run.finish("ok");
    };
    await write("msg_1", undefined, "thr-1");
    await write("msg_2", "thr-1", "thr-1");
    await write("msg_3", undefined, "thr-2"); // after /reset
    const runs = await readHistoryLedger(stateDir, KEY);
    expect(historyLedgerSinceMessageId(runs, "thr-1")).toBe("msg_1");
    expect(historyLedgerSinceMessageId(runs, "thr-2")).toBe("msg_3");
    expect(historyLedgerSinceMessageId(runs, "thr-bound-from-elsewhere")).toBeUndefined();
  });

  it("writes nothing for a run that never started", async () => {
    const run = new HistoryLedgerRun({ stateDir, conversationKey: KEY, sourceMessageId: "msg_a", engine: "claude" });
    await run.finish("failed:interrupted");
    await mkdir(path.join(stateDir, "history-ledger"), { recursive: true });
    expect(await readHistoryLedger(stateDir, KEY)).toEqual([]);
  });
});
