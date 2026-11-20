import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import { queryPiCatalog } from "../src/codex/pi-rpc-client.js";
import { discoverPiModels, resetPiModelDiscoveryForTest } from "../src/runtime/pi-model-discovery.js";
vi.mock("../src/codex/pi-rpc-client.js", () => ({ queryPiCatalog: vi.fn() }));
const query = vi.mocked(queryPiCatalog);
const env = { PI_EXECUTABLE: "/fixture/bin/pi", PI_CODING_AGENT_DIR: "/fixture/pi", TAROBOT_MODEL_DISCOVERY: "1" };
beforeEach(() => { resetPiModelDiscoveryForTest(); query.mockReset(); });
afterEach(() => { vi.useRealTimers(); });
describe("native Pi model discovery", () => {
  it("uses the native provider identity, supported thinking and default without exposing raw model config", async () => {
    query.mockResolvedValue({ models: [
      { provider: "first", id: "org/model:latest", name: "Shared name", reasoning: true, thinkingLevelMap: { xhigh: null, max: "max" }, headers: { Authorization: "not-for-client" } },
      { provider: "second", id: "org/model:latest", name: "Shared name", reasoning: false, baseUrl: "https://private.invalid" },
    ], current: { provider: "second", modelId: "org/model:latest", thinkingLevel: "off" } });
    const result = await discoverPiModels(env, "/fixture/project");
    expect(result).toMatchObject({ status: "ready", defaultModel: "second/org/model:latest", models: [
      { id: "first/org/model:latest", provider: "first", efforts: ["", "off", "minimal", "low", "medium", "high", "max"] },
      { id: "second/org/model:latest", provider: "second", efforts: ["", "off"] },
    ] });
    expect(JSON.stringify(result)).not.toMatch(/not-for-client|private.invalid|Authorization|baseUrl/);
    expect(query).toHaveBeenCalledWith({ launch: { command: env.PI_EXECUTABLE, args: [] }, env, cwd: "/fixture/project", extraArgs: ["--no-mcp"] });
  });
  it("distinguishes missing native authentication from a transport error, and preserves a retry path", async () => {
    query.mockResolvedValueOnce({ models: [] }).mockRejectedValueOnce(new Error("private native error"));
    expect(await discoverPiModels(env, "/one")).toEqual({ status: "no-models", models: [] });
    expect(await discoverPiModels(env, "/two")).toEqual({ status: "unavailable", models: [] });
    expect(await discoverPiModels({ ...env, TAROBOT_MODEL_DISCOVERY: "0" }, "/one")).toEqual({ status: "unavailable", models: [] });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("coalesces overlapping readers but separates workspace/config roots and refreshes recent login changes", async () => {
    vi.useFakeTimers();
    let finish!: (value: { models: [] }) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ models: [] });
    const first = discoverPiModels(env, "/one"), second = discoverPiModels(env, "/one");
    expect(query).toHaveBeenCalledTimes(1); finish({ models: [] });
    await Promise.all([first, second]);
    await discoverPiModels(env, "/one"); expect(query).toHaveBeenCalledTimes(1);
    await discoverPiModels(env, "/two");
    await discoverPiModels({ ...env, PI_CODING_AGENT_DIR: "/different" }, "/one");
    expect(query).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1001);
    await discoverPiModels(env, "/one"); expect(query).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])("isolates workspace-free discovery and removes its directory after failure=%s", async failure => {
    let directory = "";
    query.mockImplementation(async input => {
      directory = input.cwd;
      expect(directory).not.toBe(os.tmpdir());
      const info = await stat(directory);
      expect(info.isDirectory()).toBe(true);
      if (process.platform !== "win32") expect(info.mode & 0o077).toBe(0);
      expect(input.extraArgs).toEqual(["--no-mcp"]);
      if (failure) throw new Error("unavailable");
      return { models: [] };
    });
    await Promise.all([discoverPiModels(env), discoverPiModels(env)]);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(access(directory)).rejects.toThrow();
  });
});
