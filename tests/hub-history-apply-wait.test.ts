import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { HISTORY_RELEASE_AFTER_MS } from "../src/hub/conversation-history.js";

let root: string, hub: HubServer;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "history-wait-")); hub = await HubServer.start({ stateDir: root }); });
afterEach(async () => { vi.restoreAllMocks(); await hub.close(); await rm(root, { recursive: true, force: true }); });

/** The Hub's wait for one native fork or rewind. Codex alone allows 180 s for thread/fork and as long again to
 * read the fork back; a shorter wait reports a fork that succeeded as unknown and fences the chat meanwhile. */
it("waits for history.apply as long as an operation may stay unconfirmed, and keeps the default for reads", async () => {
  const callBot = vi.spyOn(hub as unknown as { callBot: (...args: unknown[]) => Promise<unknown> }, "callBot").mockResolvedValue({});
  const host = (hub as unknown as { conversationHistory: { host: { call: (botId: string, method: string, input: unknown) => Promise<unknown> } } }).conversationHistory.host;
  await host.call("bot_fixture", "history.apply", {});
  expect(callBot).toHaveBeenLastCalledWith("bot_fixture", "history.apply", {}, HISTORY_RELEASE_AFTER_MS);
  for (const method of ["history.snapshot", "history.receipt", "history.finalize"]) {
    await host.call("bot_fixture", method, {});
    expect(callBot).toHaveBeenLastCalledWith("bot_fixture", method, {}, undefined);
  }
});
