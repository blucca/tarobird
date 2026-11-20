import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";

const registrationSchema = z.object({ toolVersion: z.string().min(1).max(256) }).nullable();
const registrationPath = (stateDir: string, id: string) => path.join(stateDir, "app-tool-threads", `${createHash("sha256").update(id).digest("hex")}.json`);
export const appToolRegistration = (stateDir: string, id: string) => new JsonStore(registrationPath(stateDir, id), value => registrationSchema.parse(value));

/** Missing is a legacy/native-only thread. Unreadable is not missing: a fork
 * must not silently lose the exact tool contract persisted by its source. */
export async function captureAppToolVersion(stateDir: string, source: string): Promise<string | null> {
  return (await appToolRegistration(stateDir, source).read(null))?.toolVersion ?? null;
}

/** Retryable local finalization, before the new App binding is made usable.
 * Copy only the version, never a turn context, permission or delivery receipt. */
export async function inheritAppToolVersion(stateDir: string, destination: string, version: string | null): Promise<void> {
  const target = registrationPath(stateDir, destination), store = appToolRegistration(stateDir, destination);
  await withFileMutex(target, async () => {
    const current = await store.read(null);
    if (current && current.toolVersion !== version) throw new Error("history_app_tools_conflict");
    if (!current && version !== null) await store.write({ toolVersion: version });
  }, { waitTimeoutMs: 10_000 });
}
