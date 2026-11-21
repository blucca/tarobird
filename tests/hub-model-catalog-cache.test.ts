import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MODEL_CATALOG_FRESH_MS, MODEL_CATALOG_RETRY_MS, MODEL_CATALOG_STALE_MS, ModelCatalogCache } from "../src/hub/model-catalog-cache.js";
import type { ModelCatalogOptions, ModelCatalogRead } from "../src/runtime/model-catalog.js";

let root: string, env: NodeJS.ProcessEnv, clock: number;
const answer = (id: string): ModelCatalogRead => ({ choices: [{ id: "", efforts: [""] }, { id, efforts: [""] }], answered: true });
const unanswered: ModelCatalogRead = { choices: [{ id: "", efforts: [""] }], answered: false };
type Call = { engine: string; fresh: boolean; options: ModelCatalogOptions; resolve: (value: ModelCatalogRead) => void };
function reader() {
  const calls: Call[] = [];
  const read = (engine: string, _env: NodeJS.ProcessEnv, _cwd: string | undefined, fresh: boolean, options: ModelCatalogOptions) =>
    new Promise<ModelCatalogRead>(resolve => { calls.push({ engine, fresh, options, resolve }); });
  return { calls, read };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "catalog-cache-"));
  // An isolated home: the signature files are this test's own.
  env = { HOME: root, USERPROFILE: root, PATH: "" };
  clock = 1_000_000;
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("serves a fresh answer without starting another read, and coalesces concurrent reads", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const first = cache.get("codex", env, "codex", undefined), second = cache.get("codex", env, "codex", undefined);
  await settle(); expect(calls).toHaveLength(1);
  // Every read bypasses the engine's own short cache; the Hub decides freshness.
  expect(calls[0]!.options).toMatchObject({ reread: true });
  calls[0]!.resolve(answer("gpt-a"));
  expect((await first).choices[1]!.id).toBe("gpt-a"); expect((await second).choices[1]!.id).toBe("gpt-a");
  clock += MODEL_CATALOG_FRESH_MS - 1;
  const again = await cache.get("codex", env, "codex", undefined);
  expect(again).toMatchObject({ choices: [{}, { id: "gpt-a" }] }); expect(again.stale).toBeUndefined();
  expect(calls).toHaveLength(1);
});

it("serves an older answer at once, marked stale, while one background read replaces it", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const pending = cache.get("claude", env, "claude", undefined); await settle(); calls[0]!.resolve(answer("old"));
  const first = await pending;
  clock += MODEL_CATALOG_FRESH_MS + 1;
  const stale = await cache.get("claude", env, "claude", undefined);
  expect(stale).toMatchObject({ stale: true, choices: [{}, { id: "old" }], readAt: first.readAt });
  // A second request while the replacement runs does not start another.
  expect((await cache.get("claude", env, "claude", undefined)).stale).toBe(true);
  expect(calls).toHaveLength(2); expect(calls[1]!.fresh).toBe(false);
  // The follow-up waits for the replacement and returns it.
  const followUp = cache.get("claude", env, "claude", undefined, { after: stale.readAt });
  clock += 10; calls[1]!.resolve(answer("new"));
  expect(await followUp).toMatchObject({ choices: [{}, { id: "new" }] });
  expect((await followUp).stale).toBeUndefined();
  // Past the stale window an old answer is not shown: the caller waits for a read.
  clock += MODEL_CATALOG_STALE_MS + 1;
  const late = cache.get("claude", env, "claude", undefined); await settle();
  expect(calls).toHaveLength(3); calls[2]!.resolve(answer("newest"));
  expect((await late).choices[1]!.id).toBe("newest");
});

it("keeps an earlier answer when a passive replacement goes unanswered, but an explicit reread reports it", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const pending = cache.get("antigravity", env, "agy", undefined); await settle(); calls[0]!.resolve(answer("argon"));
  await pending;
  clock += MODEL_CATALOG_FRESH_MS + 1;
  const stale = await cache.get("antigravity", env, "agy", undefined);
  calls[1]!.resolve(unanswered); await settle();
  // The follow-up returns the earlier answer unmarked, so the client does not loop.
  const followUp = await cache.get("antigravity", env, "agy", undefined, { after: stale.readAt });
  expect(followUp).toMatchObject({ choices: [{}, { id: "argon" }] }); expect(followUp.stale).toBeUndefined();
  expect(calls).toHaveLength(2);
  // The owner's reread is a real read whose result is shown, even unanswered.
  const reread = cache.get("antigravity", env, "agy", undefined, { refresh: true }); await settle();
  expect(calls).toHaveLength(3); expect(calls[2]!.fresh).toBe(true);
  calls[2]!.resolve(unanswered);
  expect(await reread).toMatchObject({ answered: false, choices: [{ id: "" }] });
});

it("retries an unanswered read only after a short wait", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const pending = cache.get("pi", env, "pi", undefined); await settle(); calls[0]!.resolve(unanswered);
  expect((await pending).answered).toBe(false);
  clock += MODEL_CATALOG_RETRY_MS - 1;
  expect((await cache.get("pi", env, "pi", undefined)).answered).toBe(false); expect(calls).toHaveLength(1);
  clock += 2;
  const retried = cache.get("pi", env, "pi", undefined); await settle(); expect(calls).toHaveLength(2);
  calls[1]!.resolve(answer("p/m")); expect((await retried).answered).toBe(true);
});

it("answers a hung engine with its fallback at the deadline, and the read still fills the cache", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const started = Date.now();
  const timedOut = await cache.get("codex", env, "codex", undefined, { deadlineMs: 50 });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(timedOut).toMatchObject({ timedOut: true, answered: false });
  // Codex's fallback is its built-in list, never another engine's or an empty one.
  expect(timedOut.choices.length).toBeGreaterThan(1);
  calls[0]!.resolve(answer("late")); await settle();
  expect((await cache.get("codex", env, "codex", undefined, { deadlineMs: 50 })).choices[1]!.id).toBe("late");
  expect(calls).toHaveLength(1);
});

it("reads again at once when the engine's sign-in or configuration changes", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const pending = cache.get("codex", env, "codex", undefined); await settle(); calls[0]!.resolve(answer("signed-out"));
  await pending;
  await mkdir(path.join(root, ".codex"), { recursive: true });
  await writeFile(path.join(root, ".codex", "auth.json"), "{\"fixture\":true}");
  const changed = cache.get("codex", env, "codex", undefined); await settle();
  expect(calls).toHaveLength(2); calls[1]!.resolve(answer("signed-in"));
  expect((await changed).choices[1]!.id).toBe("signed-in");
  // An engine's settings path is part of the entry too.
  const moved = cache.get("codex", { ...env, CODEX_HOME: path.join(root, "elsewhere") }, "codex", undefined); await settle();
  expect(calls).toHaveLength(3); calls[2]!.resolve(answer("elsewhere")); await moved;
});

it("files an answer under the state its CLI left, so a sign-in refreshed while answering is not read again", async () => {
  await mkdir(path.join(root, ".codex"), { recursive: true });
  await writeFile(path.join(root, ".codex", "auth.json"), "{\"token\":1}");
  const { calls, read } = reader(), cache = new ModelCatalogCache({}, read, () => clock);
  const pending = cache.get("codex", env, "codex", undefined); await settle();
  await writeFile(path.join(root, ".codex", "auth.json"), "{\"token\":2,\"refreshed\":true}");
  calls[0]!.resolve(answer("gpt-a")); await pending;
  expect((await cache.get("codex", env, "codex", undefined)).choices[1]!.id).toBe("gpt-a");
  expect(calls).toHaveLength(1);
});

it("keeps workspaces apart only for the engines that read one, and passes the DeepSeek catalog home", async () => {
  const { calls, read } = reader(), cache = new ModelCatalogCache({ deepseekCatalogHome: path.join(root, "catalog") }, read, () => clock);
  const a = cache.get("claude", env, "claude", path.join(root, "a")); await settle(); calls[0]!.resolve(answer("c"));
  await a; await cache.get("claude", env, "claude", path.join(root, "b"));
  expect(calls).toHaveLength(1);
  const pa = cache.get("pi", env, "pi", path.join(root, "a")), pb = cache.get("pi", env, "pi", path.join(root, "b")); await settle();
  expect(calls).toHaveLength(3);
  calls[1]!.resolve(answer("pa")); calls[2]!.resolve(answer("pb")); await Promise.all([pa, pb]);
  const ds = cache.get("deepseek", env, "dsh", undefined); await settle();
  expect(calls[3]!.options).toEqual({ reread: true, deepseekCatalogHome: path.join(root, "catalog") });
  calls[3]!.resolve(answer("d")); await ds;
});
