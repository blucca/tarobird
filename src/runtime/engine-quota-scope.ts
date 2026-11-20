import { createHmac } from "node:crypto";
import type { QuotaEngine } from "../client-protocol/engine-quota.js";

export type QuotaScopeGenerations = {
  engine: QuotaEngine;
  configurationGeneration: string;
  credentialGeneration: string;
  workerGeneration: string;
};
// Private, ephemeral evidence: never add this object to a client-protocol reply.
export type QuotaAccountProof = { engine: QuotaEngine; accountKey: string; scopeStamp: string };

function digest(key: Uint8Array, values: string[]): string {
  if (key.byteLength < 32 || values.some(value => !value || value.length > 65536)) throw new Error("scope_unverifiable");
  return createHmac("sha256", key).update(JSON.stringify(values)).digest("hex");
}

/** Generations must represent current effective configuration/auth, not just the path of a home directory. */
export function createQuotaScopeStamp(key: Uint8Array, parts: QuotaScopeGenerations): string {
  return digest(key, ["quota-scope-v1", parts.engine, parts.configurationGeneration, parts.credentialGeneration, parts.workerGeneration]);
}

/** Valid only while the caller can still prove scopeStamp is current. A user alone does not identify the billed workspace. */
export function proveQuotaAccount(key: Uint8Array, parts: {
  engine: QuotaEngine; scopeStamp: string; accountId: string | null | undefined; userId: string | null | undefined;
}): QuotaAccountProof | undefined {
  if (!parts.accountId || !parts.userId || !parts.scopeStamp) return undefined;
  return { engine: parts.engine, scopeStamp: parts.scopeStamp, accountKey: digest(key, ["quota-account-v1", parts.engine, parts.accountId, parts.userId]) };
}
