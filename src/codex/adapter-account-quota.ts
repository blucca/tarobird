import { createHmac, randomBytes } from "node:crypto";
import { openSync, readSync, fstatSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { QuotaAuthMode, QuotaEngine, QuotaSnapshot } from "../client-protocol/engine-quota.js";
import type { QuotaAccountProof } from "../runtime/engine-quota-scope.js";
import { QUOTA_TTL_MS, unavailableQuota } from "./account-quota.js";

export type EngineQuotaReadOptions = { refresh: boolean; expectedRevision?: string; signal?: AbortSignal; timeoutMs?: number };
export type EngineQuotaReadResult = { revision: string; snapshot: QuotaSnapshot; proof?: QuotaAccountProof };
export type AdapterQuotaScope = { revision: string; credentialRevision: string; verifiable: boolean; authMode: QuotaAuthMode };

function readBounded(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("scope_unverifiable");
    const buffer = Buffer.allocUnsafe(Math.min(stat.size + 1, 1024 * 1024 + 1));
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, used);
      if (!count) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used > 1024 * 1024 || used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("scope_unverifiable");
    return buffer.toString("utf8", 0, used);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
    throw new Error("scope_unverifiable");
  } finally { if (fd !== undefined) closeSync(fd); }
}
function jsonRecord(text: string): Record<string, unknown> {
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("scope_unverifiable");
  return parsed;
}

/** Private in-memory scope guard. No credential values, hashes or file paths are emitted to logs/public DTOs. */
export class AdapterQuotaCache {
  readonly proofKey = randomBytes(32);
  private cached?: { revision: string; snapshot: QuotaSnapshot; proof?: QuotaAccountProof };
  constructor(private readonly engine: "codex" | "claude", private readonly executable: string, private readonly env: NodeJS.ProcessEnv, private readonly cwd?: string, private readonly configPath?: string) {}

  capture(workerGeneration: string): AdapterQuotaScope {
    const digest = (value: unknown) => createHmac("sha256", this.proofKey).update(JSON.stringify(value)).digest("hex");
    const home = this.env.HOME || this.env.USERPROFILE || homedir();
    const engineHome = this.engine === "codex" ? this.env.CODEX_HOME || path.join(home, ".codex") : this.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
    let authMode: QuotaAuthMode = "unknown", verifiable = false;
    let material: unknown;
    try {
      const configured = this.configPath ? readBounded(this.configPath) : "";
      if (this.engine === "codex") {
        const authText = readBounded(path.join(engineHome, "auth.json"));
        const config = readBounded(path.join(engineHome, "config.toml"));
        const project = this.cwd ? readBounded(path.join(this.cwd, ".codex", "config.toml")) : "";
        const account = jsonRecord(authText);
        const tokens = account.tokens && typeof account.tokens === "object" ? account.tokens as Record<string, unknown> : {};
        const env = Object.fromEntries(Object.entries(this.env).filter(([key]) => /^(OPENAI_|CODEX_|CHATGPT_)/.test(key)));
        authMode = typeof tokens.access_token === "string" && tokens.access_token ? "subscription" : this.env.OPENAI_API_KEY || account.OPENAI_API_KEY ? "api_key" : "unknown";
        // Keyring/auto, includes and external auth helpers are not proven by an auth.json file next to them.
        const opaque = /cli_auth_credentials_store\s*=\s*["'](?:keyring|auto)["']|(?:auth_command|credential_helper|include)\s*=/.test(`${config}\n${project}`);
        verifiable = !opaque && authMode !== "unknown";
        material = [this.executable, engineHome, configured, config, project, authText, env];
      } else {
        const authText = readBounded(path.join(engineHome, ".credentials.json"));
        const settings = readBounded(path.join(engineHome, "settings.json"));
        const project = this.cwd ? readBounded(path.join(this.cwd, ".claude", "settings.json")) + readBounded(path.join(this.cwd, ".claude", "settings.local.json")) : "";
        const account = jsonRecord(authText);
        const oauth = account.claudeAiOauth && typeof account.claudeAiOauth === "object" ? account.claudeAiOauth as Record<string, unknown> : {};
        const env = Object.fromEntries(Object.entries(this.env).filter(([key]) => /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|AZURE_)/.test(key)));
        const cloud = this.env.CLAUDE_CODE_USE_BEDROCK === "1" || this.env.CLAUDE_CODE_USE_VERTEX === "1" || this.env.CLAUDE_CODE_USE_FOUNDRY === "1";
        authMode = cloud ? "other" : this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_AUTH_TOKEN ? "api_key" : this.env.CLAUDE_CODE_OAUTH_TOKEN || (typeof oauth.accessToken === "string" && oauth.accessToken) ? "subscription" : "unknown";
        const opaque = /"apiKeyHelper"\s*:|"ANTHROPIC_|"CLAUDE_CODE_OAUTH_TOKEN"\s*:/.test(`${settings}\n${project}`);
        // The macOS CLI may prefer Keychain over the plaintext file. Only an explicit env token proves that source here.
        verifiable = !opaque && authMode !== "unknown" && (process.platform !== "darwin" || Boolean(this.env.CLAUDE_CODE_OAUTH_TOKEN || this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_AUTH_TOKEN) || cloud);
        material = [this.executable, engineHome, configured, settings, project, authText, env];
      }
    } catch {
      // A failed identity read invalidates the cache; it is never equivalent to an empty/default identity.
      material = [this.executable, engineHome, "unverifiable"];
      verifiable = false;
    }
    const credentialRevision = digest(material);
    return { credentialRevision, revision: digest([credentialRevision, workerGeneration]), verifiable, authMode };
  }
  response(scope: AdapterQuotaScope, options: EngineQuotaReadOptions): EngineQuotaReadResult | undefined {
    if (options.signal?.aborted) return this.failure(scope, "cancelled");
    if (options.expectedRevision && options.expectedRevision !== scope.revision) { this.cached = undefined; return this.failure(scope, "auth_changed"); }
    if (!scope.verifiable) {
      this.cached = undefined;
      // Codex's public account/read can still answer one explicit read: it reports "not signed in"
      // natively, and the before/after identity check binds that single reading to one account.
      // store() never retains it, because later reads cannot prove the opaque source is unchanged.
      if (this.engine === "codex" && options.refresh) return undefined;
      return this.failure(scope, "scope_unverifiable");
    }
    if (scope.authMode !== "subscription") { this.cached = undefined; return { revision: scope.revision, snapshot: unavailableQuota(this.engine, "mode_not_supported", Date.now(), scope.authMode) }; }
    if (this.cached?.revision !== scope.revision) this.cached = undefined;
    if (options.refresh && this.engine === "codex") return undefined;
    if (!this.cached) return this.failure(scope, this.engine === "claude" ? "no_passive_event" : "not_loaded");
    const value = structuredClone(this.cached);
    if (value.snapshot.observedAt && Date.now() - Date.parse(value.snapshot.observedAt) >= QUOTA_TTL_MS) value.snapshot.state = "stale";
    return value;
  }
  store(scope: AdapterQuotaScope, value: { snapshot: QuotaSnapshot; proof?: QuotaAccountProof }): EngineQuotaReadResult {
    // One-shot only: no cache and no account proof for a credential source this Host cannot verify.
    // The native reply must then identify the account itself: a stable user id and the billed account id
    // (both optional upstream). Type, plan or email alone cannot separate two accounts. Native
    // "not signed in", API-key and error answers carry no account values and pass unchanged.
    if (!scope.verifiable) {
      this.cached = undefined;
      const snapshot = value.snapshot;
      const carriesValues = snapshot.observedAt !== undefined || snapshot.pools.length > 0 || snapshot.constraints.length > 0 || snapshot.availability !== "unknown";
      if (carriesValues && !value.proof) return this.failure(scope, "scope_unverifiable");
      return { revision: scope.revision, snapshot: structuredClone(snapshot) };
    }
    const same = this.cached?.revision === scope.revision ? this.cached : undefined;
    if (same && same.snapshot.observedAt && ["unavailable", "offline"].includes(value.snapshot.state)) {
      this.cached = { ...same, snapshot: { ...same.snapshot, state: "stale", reason: value.snapshot.reason, lastAttemptAt: value.snapshot.lastAttemptAt } };
    } else this.cached = { revision: scope.revision, snapshot: structuredClone(value.snapshot), ...(value.proof ? { proof: structuredClone(value.proof) } : {}) };
    return structuredClone(this.cached);
  }
  failure(scope: AdapterQuotaScope, reason: Parameters<typeof unavailableQuota>[1]): EngineQuotaReadResult {
    return { revision: scope.revision, snapshot: unavailableQuota(this.engine, reason, Date.now(), scope.authMode) };
  }
  invalidate(): void { this.cached = undefined; }
}
