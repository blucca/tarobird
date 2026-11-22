import { expect, it } from "vitest";
import { DeepSeekHarnessAdapter } from "../src/codex/deepseek-harness-adapter.js";

/**
 * Sessions of one Bot share one read of DeepSeek's default model. A stop in
 * the session that began the read must not fail another session waiting on it.
 */
it("does not let one session's stop fail another session's wait for the default model", async () => {
  let answer!: (value: unknown) => void;
  const gateway = {
    request: (method: string, _params: unknown, signal?: AbortSignal) => new Promise((resolve, reject) => {
      if (method !== "settings.describe") { reject(new Error(`unexpected ${method}`)); return; }
      signal?.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true });
      answer = resolve;
    }),
  };
  const adapter = Object.assign(Object.create(DeepSeekHarnessAdapter.prototype), { gateway }) as { loadHostDefaultModel(signal?: AbortSignal): Promise<unknown> };
  const first = new AbortController(), second = new AbortController();
  const stopped = adapter.loadHostDefaultModel(first.signal).then(() => "read", error => (error as Error).name);
  const waiting = adapter.loadHostDefaultModel(second.signal).then(value => value, error => error as Error);
  first.abort();
  expect(await stopped).toBe("AbortError");
  answer({ namespaces: [{ ns: "agent-default-model", value: { provider: "alpha", model: "family/model" } }] });
  expect(await waiting).toMatchObject({ provider: "alpha" });
});
