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

// codex-cli 0.170.0 reports backend refusals on these two RPCs as JSON-RPC -32603 with fixed messages
// (recorded against a loopback backend). Only that code, the RPC that failed and the exact bounded
// prefix with the HTTP status in its own position are recognized; other -32603 failures, transport
// errors or a status mentioned in a response body stay ordinary native errors.
// - 401 on account/read or rateLimits/read: "sign in again".
// - 429 on rateLimits/read: rate limited. A 429 on account discovery reaches account/read only as
//   "workspace routing discovery failed" (status swallowed), so it is not identifiable and stays generic.
const NATIVE_FAILURES: Record<Parameters<CodexQuotaRequest>[0], Array<[RegExp, "login_required" | "rate_limited"]>> = {
  "account/read": [[/^workspace routing discovery unauthorized \(401\)$/, "login_required"]],
  "account/rateLimits/read": [
    [/^failed to fetch codex rate limits: GET [^\s;]{1,2048} failed: 401 Unauthorized(?:;|$)/, "login_required"],
    [/^failed to fetch codex rate limits: GET [^\s;]{1,2048} failed: 429 Too Many Requests(?:;|$)/, "rate_limited"],
  ],
};
function nativeQuotaFailure(method: Parameters<CodexQuotaRequest>[0], error: unknown): "login_required" | "rate_limited" | undefined {
  if (!(error instanceof Error) || (error as Error & { jsonRpcCode?: unknown }).jsonRpcCode !== -32603 || error.message.length > 8192) return undefined;
  return NATIVE_FAILURES[method].find(([pattern]) => pattern.test(error.message))?.[1];
}

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
      let response: unknown;
      try { response = await wait(() => options.request(method, params, { signal: abort.signal, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) })); }
      catch (error) { const reason = nativeQuotaFailure(method, error); if (reason) throw new QuotaReadError(reason); throw error; }
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
    // Neither the stable nor the experimental protocol scopes account/rateLimits/read to workspaceRouting;
    // the usage snapshot names its account only "when supplied by the backend". An account proof therefore
    // needs that account to be present AND to equal the routed workspace, which the identity comparison
    // above already holds equal across both account/read replies. Routing never fills in a missing usage account.
    const proof = afterMode.accountId && accountId === afterMode.accountId
      ? proveQuotaAccount(options.proofKey, { engine: "codex", scopeStamp: stamp, accountId, userId: afterMode.userId }) : undefined;
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
