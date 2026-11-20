import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SessionStore } from "../src/state/session-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.doUnmock("../src/state/schema-version.js");
  vi.doUnmock("../src/state/session-state-schema.js");
  vi.resetModules();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("makes an old reader refuse a pending history before its parser can strip the fence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-downgrade-")); roots.push(root);
  const file = path.join(root, "session.json"), current = new SessionStore(file);
  const source = { telegramChatId: 7, conversationKey: "lark:source", codexSessionId: "native-source", status: "idle" as const, updatedAt: "2026-01-01T00:00:00.000Z" };
  await current.upsert(source);
  const binding = (await current.inspectHistory(source.conversationKey))!;
  await current.reserveHistory(source.conversationKey, binding.record.historyRevision!, "operation-fixture");
  const before = await readFile(file, "utf8");
  // Reproduce the previous reader's supported version and stripping parser.
  // The same JsonStore gate must reject it before parsing or mutating data.
  vi.resetModules();
  vi.doMock("../src/state/schema-version.js", async () => ({
    ...await vi.importActual<object>("../src/state/schema-version.js"), CURRENT_SCHEMA_VERSION: 1,
  }));
  vi.doMock("../src/state/session-state-schema.js", async () => {
    const original = await vi.importActual<typeof import("../src/state/session-state-schema.js")>("../src/state/session-state-schema.js");
    return { ...original, SessionStateSchema: z.object({ schemaVersion: z.number().optional(), chats: z.array(original.SessionRecordSchema.omit({ historyGeneration: true, historyRevision: true, historyFence: true, historyLastOperation: true })) }) };
  });
  const { SessionStore: OldReader } = await import("../src/state/session-store.js");
  const previous = new OldReader(file);
  await expect(previous.load()).rejects.toThrow("supports up to 1");
  await expect(previous.upsert(source)).rejects.toThrow("supports up to 1");
  expect(await readFile(file, "utf8")).toBe(before);
});
