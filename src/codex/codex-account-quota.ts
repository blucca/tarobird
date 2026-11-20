import type { QuotaSnapshot } from "../client-protocol/engine-quota.js";
import { proveQuotaAccount } from "../runtime/engine-quota-scope.js";
import type { QuotaAccountProof } from "../runtime/engine-quota-scope.js";
import { codexAccountMode, parseCodexQuota, QuotaReadError, quotaNativeIdentity, quotaObject, unavailableQuota } from "./account-quota.js";

export type CodexQuotaRequest = (
  method: "account/read" | "account/rateLimits/read",
  params: { refreshToken: false } | { excludeResetCreditDetails: true },
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<unknown>;
export type CodexQuotaReadResult = { snapshot: QuotaSnapshot; proof?: QuotaAccountProof };

/** Does not start/stop the worker. Cancelling this read must never destroy a shared chatting worker. */
export async function readCodexAccountQuota(options: {
  request: CodexQuotaRequest;
  captureScope: () => string | Promise<string>;
  proofKey: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<CodexQuotaReadResult> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("invalid_quota_timeout");
  const abort = new AbortController();
  let timedOut = false;
  const cancel = () => abort.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  const checkAbort = () => { if (abort.signal.aborted) throw new QuotaReadError(timedOut ? "timeout" : "cancelled"); };
  function wait<T>(factory: () => T | Promise<T>): Promise<T> {
    checkAbort();
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(new QuotaReadError(timedOut ? "timeout" : "cancelled"));
      abort.signal.addEventListener("abort", cancelled, { once: true });
      // Defer factory so synchronous exceptions and late rejection are always observed.
      Promise.resolve().then(() => { checkAbort(); return factory(); }).then(resolve, reject)
        .finally(() => abort.signal.removeEventListener("abort", cancelled));
    });
  }
  try {
    const stamp = await wait(options.captureScope);
    if (!stamp || typeof stamp !== "string") throw new QuotaReadError("scope_unverifiable");
    const checkScope = async () => {
      if (await wait(options.captureScope) !== stamp) throw new QuotaReadError("auth_changed");
      checkAbort();
    };
    const read = async (method: Parameters<CodexQuotaRequest>[0], params: Parameters<CodexQuotaRequest>[1]) => {
      await checkScope();
      const response = await wait(() => options.request(method, params, { signal: abort.signal, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) }));
      await checkScope();
      // A native transport must bound its input too; this caps data handed to the pure parser.
      if (Buffer.byteLength(JSON.stringify(response) ?? "", "utf8") > 256 * 1024) throw new QuotaReadError("invalid_response");
      return response;
    };
    const before = await read("account/read", { refreshToken: false });
    const beforeMode = codexAccountMode(before);
    if (beforeMode.authMode !== "subscription") return { snapshot: unavailableQuota("codex", "mode_not_supported", now(), beforeMode.authMode) };
    const limits = await read("account/rateLimits/read", { excludeResetCreditDetails: true });
    const after = await read("account/read", { refreshToken: false });
    const afterMode = codexAccountMode(after);
    if (beforeMode.identity !== afterMode.identity) throw new QuotaReadError("auth_changed");
    const snapshot = parseCodexQuota(after, limits, now());
    const accountId = quotaNativeIdentity(quotaObject(limits).accountId);
    if (afterMode.accountId && accountId && afterMode.accountId !== accountId) throw new QuotaReadError("auth_changed");
    const proof = proveQuotaAccount(options.proofKey, { engine: "codex", scopeStamp: stamp, accountId, userId: afterMode.userId });
    await checkScope();
    return { snapshot, ...(proof ? { proof } : {}) };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const reason = abort.signal.aborted ? timedOut ? "timeout" : "cancelled" : error instanceof QuotaReadError ? error.reason
      : code === 401 || code === "unauthorized" ? "login_required" : code === 429 || code === "rate_limited" ? "rate_limited" : "native_error";
    // Never return native stderr/messages: they can contain login URLs, paths or account identifiers.
    return { snapshot: unavailableQuota("codex", reason, now()) };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
