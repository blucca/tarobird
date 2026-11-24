import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { promisify } from "node:util";
import {
  cloudflareCommands,
  cloudflareConfigSchema,
  cloudflareOriginSchema,
  cloudflareUpdateSchema,
  cloudflareViewSchema,
  type CloudflareConfig,
  type CloudflareProtocol,
  type CloudflareView,
} from "../client-protocol/cloudflare.js";
import { HubError, type HubStore } from "./store.js";

const execFileAsync = promisify(execFile);
export const CLOUDFLARE_META_KEY = "cloudflare-tunnel:v1";
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export type CloudflaredBinary = { installed: boolean; path?: string; version?: string };

const CANDIDATE_PATHS = [
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
  "/usr/bin/cloudflared",
  "cloudflared",
];

function findCloudflaredPath(): string | undefined {
  for (const candidate of CANDIDATE_PATHS) {
    if (candidate === "cloudflared") return candidate;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return undefined;
}

export async function detectCloudflared(): Promise<CloudflaredBinary> {
  const bin = findCloudflaredPath() ?? "cloudflared";
  try {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], { timeout: 3000, windowsHide: true });
    const line = (stdout || stderr).trim().split(/\r?\n/)[0]?.slice(0, 120);
    return { installed: true, path: bin, ...(line ? { version: line } : {}) };
  } catch {
    return { installed: false };
  }
}

export function defaultCloudflareConfig(): CloudflareConfig {
  return { v: 1, mode: "named", protocol: "http2", origins: [] };
}

function envAllowedOrigins(): string[] {
  const raw = process.env.TAROBOT_CLOUDFLARE_ORIGINS ?? "";
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const parsed = cloudflareOriginSchema.safeParse(part.trim());
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

export interface HubCloudflareOptions {
  store: HubStore;
  loopbackTarget: () => string;
  detect?: () => Promise<CloudflaredBinary>;
}

/** Host-side DIY Cloudflare Tunnel configuration, origin allowlist for
 * `/api/edge-identity`, diagnostics and optional Quick Tunnel helper. */
export class HubCloudflareTunnel {
  private config: CloudflareConfig = defaultCloudflareConfig();
  private loaded = false;
  private cachedBinary?: { value: CloudflaredBinary; until: number };
  private child?: ChildProcess;
  private activeUrl?: string;
  private lastError?: string;
  private readonly detect: () => Promise<CloudflaredBinary>;

  constructor(private readonly options: HubCloudflareOptions) {
    this.detect = options.detect ?? detectCloudflared;
  }

  async load(): Promise<CloudflareConfig> {
    if (this.loaded) return this.config;
    const row = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [CLOUDFLARE_META_KEY]);
    if (row) {
      try { this.config = cloudflareConfigSchema.parse(JSON.parse(row.value)); }
      catch { this.config = defaultCloudflareConfig(); }
    }
    this.loaded = true;
    return this.config;
  }

  private async persist(next: CloudflareConfig): Promise<void> {
    const parsed = cloudflareConfigSchema.parse(next);
    await this.options.store.db.serial(() =>
      this.options.store.db.run(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [CLOUDFLARE_META_KEY, JSON.stringify(parsed)],
      ),
    );
    this.config = parsed;
    this.loaded = true;
  }

  /** Strictly checks whether `origin` is authorized on this Host for edge-terminated
   * TLS identity proofs. Never authorizes arbitrary origins. */
  isOriginAllowed(origin: string): boolean {
    const parsed = cloudflareOriginSchema.safeParse(origin);
    if (!parsed.success) return false;
    const canonical = parsed.data;
    if (this.activeUrl === canonical) return true;
    if (this.config.origins.includes(canonical)) return true;
    return envAllowedOrigins().includes(canonical);
  }

  private async binary(): Promise<CloudflaredBinary> {
    const now = Date.now();
    if (this.cachedBinary && this.cachedBinary.until > now) return this.cachedBinary.value;
    const value = await this.detect();
    this.cachedBinary = { value, until: now + 30_000 };
    return value;
  }

  async view(): Promise<CloudflareView> {
    const [config, bin] = await Promise.all([this.load(), this.binary()]);
    const loopbackTarget = this.options.loopbackTarget();
    return cloudflareViewSchema.parse({
      v: 1,
      installed: bin.installed,
      ...(bin.version ? { version: bin.version } : {}),
      running: !!this.child && !this.child.killed && this.child.exitCode === null,
      ...(this.activeUrl ? { activeUrl: this.activeUrl } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      mode: config.mode,
      protocol: config.protocol,
      origins: config.origins,
      loopbackTarget,
      commands: cloudflareCommands(loopbackTarget),
    });
  }

  async update(raw: unknown): Promise<CloudflareView> {
    const patch = cloudflareUpdateSchema.parse(raw);
    const current = await this.load();
    await this.persist({
      v: 1,
      mode: patch.mode ?? current.mode,
      protocol: patch.protocol ?? current.protocol,
      origins: patch.origins ?? current.origins,
    });
    return this.view();
  }

  async startQuickTunnel(protocol?: CloudflareProtocol): Promise<CloudflareView> {
    const config = await this.load();
    const chosen = protocol ?? config.protocol;
    if (chosen !== config.protocol || config.mode !== "quick") {
      await this.persist({ ...config, mode: "quick", protocol: chosen });
    }
    if (this.child && !this.child.killed && this.child.exitCode === null && this.activeUrl) {
      return this.view();
    }
    await this.stopQuickTunnel();
    const bin = await this.detect();
    this.cachedBinary = { value: bin, until: Date.now() + 30_000 };
    if (!bin.installed || !bin.path) throw new HubError("cloudflared_not_installed", 409);

    const target = new URL(this.options.loopbackTarget()).origin;
    const args = ["tunnel", "--no-autoupdate", "--protocol", chosen];
    if (target.startsWith("https://")) args.push("--no-tls-verify");
    args.push("--url", target);

    this.lastError = undefined;
    const child = spawn(bin.path, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.lastError = "Timed out waiting for trycloudflare.com URL";
        void this.stopQuickTunnel();
        reject(new HubError("cloudflared_start_timeout", 504));
      }, 20_000);
      const inspect = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const match = text.match(TRYCLOUDFLARE_RE);
        if (match && !settled) {
          const parsed = cloudflareOriginSchema.safeParse(match[0]);
          if (parsed.success) {
            settled = true;
            clearTimeout(timer);
            resolve(parsed.data);
          }
        }
      };
      child.stdout?.on("data", inspect);
      child.stderr?.on("data", inspect);
      child.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lastError = err.message.slice(0, 200);
        this.child = undefined;
        reject(new HubError("cloudflared_start_failed", 502));
      });
      child.once("exit", (code) => {
        if (this.child === child) { this.child = undefined; this.activeUrl = undefined; }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.lastError = `cloudflared exited with code ${code ?? "unknown"}`;
          reject(new HubError("cloudflared_start_failed", 502));
        }
      });
    });

    this.activeUrl = url;
    return this.view();
  }

  async stopQuickTunnel(): Promise<CloudflareView> {
    const child = this.child;
    this.child = undefined;
    this.activeUrl = undefined;
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
      });
    }
    return this.view();
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.activeUrl = undefined;
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }
}
