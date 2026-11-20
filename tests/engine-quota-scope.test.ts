import { expect, it } from "vitest";
import { createQuotaScopeStamp, proveQuotaAccount } from "../src/runtime/engine-quota-scope.js";

it("uses host-secret keyed opaque scopes, not paths or raw identities", () => {
  const key = Buffer.alloc(32, 1);
  const parts = { engine: "codex" as const, configurationGeneration: "config-v1", credentialGeneration: "auth-v1", workerGeneration: "worker-v1" };
  const stamp = createQuotaScopeStamp(key, parts);
  expect(stamp).toMatch(/^[a-f0-9]{64}$/);
  expect(createQuotaScopeStamp(key, { ...parts, credentialGeneration: "auth-v2" })).not.toBe(stamp);
  expect(createQuotaScopeStamp(Buffer.alloc(32, 2), parts)).not.toBe(stamp);
  const proof = proveQuotaAccount(key, { engine: "codex", scopeStamp: stamp, accountId: "private-account", userId: "private-user" });
  expect(JSON.stringify(proof)).not.toContain("private");
  expect(proveQuotaAccount(key, { engine: "codex", scopeStamp: stamp, accountId: "private-account", userId: "other-user" })?.accountKey).not.toBe(proof?.accountKey);
});
it("requires current verified generation and both account and user identity to merge", () => {
  const key = Buffer.alloc(32, 1);
  expect(proveQuotaAccount(key, { engine: "codex", scopeStamp: "v1", accountId: "x", userId: null })).toBeUndefined();
  expect(() => createQuotaScopeStamp(key, { engine: "codex", configurationGeneration: "same-path", credentialGeneration: "", workerGeneration: "v1" })).toThrow("scope_unverifiable");
  expect(() => createQuotaScopeStamp(Buffer.alloc(4), { engine: "codex", configurationGeneration: "v1", credentialGeneration: "v1", workerGeneration: "v1" })).toThrow("scope_unverifiable");
});
