import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readDeepSeekCatalogConfig } from "../src/runtime/deepseek-model-discovery.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-bounds-")); roots.push(root); const file = path.join(root, "settings.yaml"); await fs.writeFile(file, "synthetic config"); return { root, file }; }
it("preserves exact small config bytes and rejects an oversized or non-file source", async () => {
  const { file, root } = await fixture();
  expect((await readDeepSeekCatalogConfig(file)).toString()).toBe("synthetic config");
  await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(readDeepSeekCatalogConfig(file)).rejects.toThrow("catalog_config_unavailable");
  await expect(readDeepSeekCatalogConfig(root)).rejects.toThrow();
});
it("caps the actual read when a file grows after its first stat and closes the descriptor", async () => {
  const { file } = await fixture(), originalOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
  let readBytes = 0, closed = false;
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
    handle.read = (async (...readArgs: any[]) => {
      if (!readBytes) await fs.writeFile(file, Buffer.alloc(3 * 1024 * 1024));
      const result = await (read as any)(...readArgs); readBytes += result.bytesRead; return result;
    }) as typeof handle.read;
    handle.close = async () => { closed = true; await close(); };
    return handle;
  });
  await expect(readDeepSeekCatalogConfig(file)).rejects.toThrow("catalog_config_unavailable");
  expect(readBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 1); expect(closed).toBe(true);
});
