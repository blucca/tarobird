import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ModelCatalogCache } from "../src/hub/model-catalog-cache.js";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

it("stays within its entry limit when a read is also filed under the state its CLI left", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "catalog-bound-"));
  await mkdir(path.join(root, ".codex"), { recursive: true });
  const auth = path.join(root, ".codex", "auth.json");
  let token = 0;
  // Every read refreshes the sign-in file, as a CLI renewing its token does.
  const cache = new ModelCatalogCache({}, async () => { await writeFile(auth, JSON.stringify({ token: ++token })); return { choices: [{ id: "", efforts: [""] }], answered: true }; });
  for (let index = 0; index < 80; index++) await cache.get("codex", { HOME: root, USERPROFILE: root, PATH: "", FIXTURE: String(index) }, "codex", undefined);
  expect((cache as unknown as { entries: Map<string, unknown> }).entries.size).toBeLessThanOrEqual(64);
});
