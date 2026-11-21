// `/effort` with the Pi engine (CC1 2026-11-21, item 7): pinned from source, then made explicit in the reply.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { handleCoreMessage } from "../src/core/message-handler.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { discoverPiModels } from "../src/runtime/pi-model-discovery.js";
import { parsePiModels } from "../src/codex/pi-models.js";
import { fakeChannel, fakeLarkMessage, type FakeLarkChannel } from "./helpers/core-compat-fixtures.js";
vi.mock("../src/runtime/pi-model-discovery.js", () => ({ discoverPiModels: vi.fn() }));

const replies = (channel: FakeLarkChannel) => (channel.send.mock.calls as unknown[][])
  .map(call => (call[1] as { markdown?: unknown } | undefined)?.markdown).filter((value): value is string => typeof value === "string").join("\n");

it.each(["en", "zh"] as const)("changes the Bot-wide Pi default and says so (%s)", async locale => {
  vi.mocked(discoverPiModels).mockResolvedValue({ status: "ready", defaultModel: "fixture/reasoning", models: parsePiModels([{ provider: "fixture", id: "reasoning", reasoning: true }]) });
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "pi-effort-command-"));
  const config = () => readFile(path.join(stateDir, "config.json"), "utf8").then(text => JSON.parse(text) as Record<string, unknown>);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ locale, engine: "pi", model: "fixture/reasoning", effort: "medium" }));
  const bridge = { checkAccess: vi.fn(async () => ({ kind: "allow" as const })), handleAuthorizedMessage: vi.fn(async () => ({ text: "unused" })) };
  let sequence = 0;
  const send = async (text: string) => {
    const channel = fakeChannel();
    await handleCoreMessage({ channel, bridge, runtime: createCoreServiceRuntime(), stateDir, message: fakeLarkMessage({ messageId: `om_effort_${++sequence}`, content: text }) });
    return replies(channel);
  };
  try {
    // What the source does: the Bot's own config.json, for every conversation that follows it.
    const set = await send("/effort high");
    expect((await config()).effort).toBe("high");
    const shown = await send("/effort");
    const cleared = await send("/effort default");
    expect((await config()).effort).toBeUndefined();
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    // What the reply says is the rule pinned in pi-default-order.test.ts: a Bot effort change replaces the level
    // in every conversation from its next turn, a /thinking choice included; clearing it undoes only what the Bot set.
    const rule = locale === "en"
      ? /all of this Bot's conversations use it from their next turn, including ones that chose a level with \/thinking/
      : /这个 Bot 的所有对话从下一轮起都改用这一档，包括在对话里用 \/thinking 选过档位的/;
    expect(set).toMatch(rule);
    expect(shown).toMatch(locale === "en" ? /a change replaces the level in all of this Bot's conversations from their next turn/ : /改动后，这个 Bot 的所有对话从下一轮起都改用新档位/);
    expect(cleared).toMatch(locale === "en" ? /conversations still on the level the Bot set go back to the level they had before; a level chosen with \/thinking stays/ : /仍在用 Bot 所设档位的对话恢复到之前的档位；用 \/thinking 自己选的保持不变/);
    for (const reply of [set, shown, cleared]) { expect(reply).toMatch(/\/thinking/); expect(reply).not.toMatch(/not chosen their own|没有自选/); }
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
