import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { promisify } from "node:util";
import { quotaSnapshotSchema, type QuotaPool, type QuotaSnapshot, type QuotaWindow } from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError } from "./account-quota.js";

const execFileAsync = promisify(execFile);

const SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const LOCAL_TIMEOUT_MS = 2_500;

export type LocalExecFn = (file: string, args: string[]) => Promise<{ stdout: string }>;
export type LocalConnectRequestFn = (
  port: number,
  tls: boolean,
  pathName: string,
  body: string,
  csrf?: string,
) => Promise<{ status: number; text: string } | null>;

export type AntigravityLocalProbeDeps = {
  execFile: LocalExecFn;
  request: LocalConnectRequestFn;
  platform: NodeJS.Platform;
};

type CandidateProcess = {
  pid: string;
  cli: boolean;
  csrf?: string;
  extPort?: number;
};

const LANGUAGE_SERVER_RE = /language[_-]server(_macos)?(_arm)?/;
const IDE_MARKER_RE = /antigravity[-_]ide/i;
const CLI_MARKER_RE = /antigravity[-_]cli/i;
const AGY_BINARY_RE = /(^|\/|\s)agy(\s|$)/;
const APP_MARKER_RE = /--app_data_dir[= ]"?antigravity(?![\w-])|\/antigravity\//i;

function flagValue(line: string, flag: string): string | undefined {
  const match = line.match(new RegExp(`${flag}[= ]([^\\s]+)`));
  return match?.[1];
}

export function classifyAntigravityProcessLine(line: string): CandidateProcess | null {
  const isServer = LANGUAGE_SERVER_RE.test(line);
  const isCli = !isServer && (CLI_MARKER_RE.test(line) || AGY_BINARY_RE.test(line));
  if (!isServer && !isCli) return null;
  const pid = line.trim().match(/^(\d+)/)?.[1];
  if (!pid) return null;
  if (!isCli && (!APP_MARKER_RE.test(line) || IDE_MARKER_RE.test(line))) return null;
  const csrf = flagValue(line, "--csrf_token");
  if (!isCli && !csrf) return null;
  const extPort = Number(flagValue(line, "--extension_server_port"));
  return {
    pid,
    cli: isCli,
    csrf,
    extPort: Number.isFinite(extPort) && extPort > 0 ? extPort : undefined,
  };
}

export function parseNetstatListeningPorts(stdout: string, pid: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP$/i.test(parts[0]!) || parts[parts.length - 1] !== pid) continue;
    const port = Number(parts[1]!.split(":").pop());
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return [...ports];
}

export function parseLsofListeningPorts(stdout: string): number[] {
  const ports = [...stdout.matchAll(/:(\d+)\s/g)].map(match => Number(match[1]));
  return [...new Set(ports)].filter(port => Number.isFinite(port) && port > 0);
}

function postLoopbackConnect(
  port: number,
  tls: boolean,
  pathName: string,
  body: string,
  csrf?: string,
): Promise<{ status: number; text: string } | null> {
  return new Promise(resolve => {
    const req = (tls ? https : http).request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: pathName,
        ...(tls ? { rejectUnauthorized: false } : {}),
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          ...(csrf ? { "X-Codeium-Csrf-Token": csrf } : {}),
        },
        timeout: LOCAL_TIMEOUT_MS,
      },
      res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          if (text.length <= 256 * 1024) text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end(body);
  });
}

function poolHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function parseIsoReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const iso = new Date(ms).toISOString();
    return Number.isFinite(Date.parse(iso)) ? iso : undefined;
  }
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function parseGroupModels(name: string, description: unknown): string[] {
  const listed = typeof description === "string"
    ? /^Models within this group:[ \t]*([^\x00-\x1f\x7f]+)$/.exec(description)?.[1]?.split(",").map(s => s.trim()).filter(Boolean)
    : undefined;
  return listed?.length && listed.length <= 32 && listed.every(s => s.length <= 120) ? listed : [name];
}

function inferWindowMeta(bucketId: string, displayName: string): { label: string; periodSeconds?: number } {
  const lower = `${bucketId} ${displayName}`.toLowerCase();
  if (lower.includes("5h") || lower.includes("five hour") || lower.includes("5 hour")) {
    return { label: "5 hours", periodSeconds: 18_000 };
  }
  if (lower.includes("week")) {
    return { label: "7 days", periodSeconds: 604_800 };
  }
  return { label: displayName.slice(0, 120) || bucketId.slice(0, 120) || "Quota" };
}

/** Decode Connect-RPC `RetrieveUserQuotaSummary` response into TaroBird `QuotaSnapshot`,
 * matching the exact group/window structure produced by `agy -p /usage --output-format json`. */
export function decodeAntigravityLocalSummary(body: unknown, now = Date.now()): QuotaSnapshot | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const nested = data.response && typeof data.response === "object" ? data.response as Record<string, unknown> : data;
  if (!Array.isArray(nested.groups) || nested.groups.length === 0) return null;

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const pools: QuotaPool[] = [];

  for (const [groupIndex, rawGroup] of nested.groups.slice(0, 64).entries()) {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
    const group = rawGroup as Record<string, unknown>;
    const name = typeof group.displayName === "string" ? group.displayName.trim()
      : typeof group.name === "string" ? group.name.trim() : "";
    if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) continue;
    if (!Array.isArray(group.buckets)) continue;

    const windows: QuotaWindow[] = [];
    for (const [bucketIndex, rawBucket] of group.buckets.slice(0, 32).entries()) {
      if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) continue;
      const bucket = rawBucket as Record<string, unknown>;
      const rawId = typeof bucket.bucketId === "string" ? bucket.bucketId.trim()
        : typeof bucket.id === "string" ? bucket.id.trim() : `bucket-${bucketIndex}`;
      const id = /^[a-zA-Z0-9_.:-]{1,128}$/.test(rawId) ? rawId : poolHash(`${rawId}:${bucketIndex}`);
      const displayName = typeof bucket.displayName === "string" ? bucket.displayName.trim()
        : typeof bucket.name === "string" ? bucket.name.trim() : rawId;
      const meta = inferWindowMeta(rawId, displayName);
      const remainingObj = bucket.remaining && typeof bucket.remaining === "object" ? bucket.remaining as Record<string, unknown> : undefined;
      const rem = bucket.remainingFraction ?? remainingObj?.remainingFraction;
      const reset = parseIsoReset(bucket.resetTime ?? remainingObj?.resetTime);
      const common = {
        id,
        label: meta.label,
        ...(meta.periodSeconds ? { periodSeconds: meta.periodSeconds } : {}),
        ...(reset ? { resetsAt: reset } : {}),
        availability: "unknown" as const,
        observedAt,
        expiresAt,
      };
      if (typeof rem === "number" && Number.isFinite(rem) && rem >= 0 && rem <= 1) {
        const usedPercent = Math.round((1 - rem) * 10_000) / 100;
        windows.push({ ...common, metric: "percent", usedPercent });
      } else {
        windows.push({ ...common, metric: "unknown" });
      }
    }

    if (windows.length > 0) {
      pools.push({
        id: poolHash(`${name}:${groupIndex}`),
        label: name,
        models: parseGroupModels(name, group.description),
        sharing: "model",
        availability: "unknown",
        windows,
        balances: [],
        constraints: [],
      });
    }
  }

  if (pools.length === 0) return null;
  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: "ready",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools,
    constraints: [],
    help: "antigravity_usage",
  };
  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

/** Decode legacy `GetUserStatus` flat model configs into TaroBird `QuotaSnapshot`. */
export function decodeAntigravityLocalStatus(body: unknown, now = Date.now()): QuotaSnapshot | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const userStatus = (body as Record<string, unknown>).userStatus;
  if (!userStatus || typeof userStatus !== "object") return null;
  const cascade = (userStatus as Record<string, unknown>).cascadeModelConfigData;
  if (!cascade || typeof cascade !== "object") return null;
  const configs = (cascade as Record<string, unknown>).clientModelConfigs;
  if (!Array.isArray(configs) || configs.length === 0) return null;

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const pools: QuotaPool[] = [];

  for (const [index, raw] of configs.slice(0, 64).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const cfg = raw as Record<string, unknown>;
    const name = typeof cfg.label === "string" && cfg.label.trim() ? cfg.label.trim()
      : typeof cfg.modelName === "string" ? cfg.modelName.trim() : "";
    if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) continue;
    const qi = cfg.quotaInfo && typeof cfg.quotaInfo === "object" ? cfg.quotaInfo as Record<string, unknown> : undefined;
    const rem = qi?.remainingFraction;
    if (typeof rem !== "number" || !Number.isFinite(rem) || rem < 0 || rem > 1) continue;
    const resetsAt = parseIsoReset(qi?.resetTime);
    const usedPercent = Math.round((1 - rem) * 10_000) / 100;
    pools.push({
      id: poolHash(`${name}:${index}`),
      label: name,
      models: [name],
      sharing: "model",
      availability: "unknown",
      windows: [{
        id: `status-${poolHash(`${name}:${index}`)}`,
        label: "Quota",
        metric: "percent",
        usedPercent,
        availability: "unknown",
        observedAt,
        expiresAt,
        ...(resetsAt ? { resetsAt } : {}),
      }],
      balances: [],
      constraints: [],
    });
  }

  if (pools.length === 0) return null;
  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: "ready",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools,
    constraints: [],
    help: "antigravity_usage",
  };
  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

const WINDOWS_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like '*antigravity*' -or $_.CommandLine -like '*language_server*' -or $_.CommandLine -like '*agy*') } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
].join("; ");

async function listListeningPorts(deps: AntigravityLocalProbeDeps, pid: string): Promise<number[]> {
  try {
    if (deps.platform === "win32") {
      const { stdout } = await deps.execFile("netstat.exe", ["-ano", "-p", "TCP"]);
      return parseNetstatListeningPorts(stdout, pid);
    }
    const { stdout } = await deps.execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid]);
    return parseLsofListeningPorts(stdout);
  } catch {
    return [];
  }
}

async function discoverLocalCandidates(deps: AntigravityLocalProbeDeps, preferredPids: readonly number[]): Promise<CandidateProcess[]> {
  const candidates: CandidateProcess[] = [];
  const seen = new Set<string>();
  for (const pid of preferredPids) {
    if (Number.isInteger(pid) && pid > 0) {
      const id = String(pid);
      if (!seen.has(id)) {
        seen.add(id);
        candidates.push({ pid: id, cli: true });
      }
    }
  }
  try {
    const stdout = deps.platform === "win32"
      ? (await deps.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_PROCESS_SCRIPT])).stdout
      : (await deps.execFile("ps", ["-ax", "-o", "pid=,command="])).stdout;
    const discovered: CandidateProcess[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const c = classifyAntigravityProcessLine(line);
      if (!c || seen.has(c.pid)) continue;
      seen.add(c.pid);
      discovered.push(c);
    }
    // Prefer running `agy` CLI candidates we own first, then desktop language servers, then other CLI instances.
    discovered.sort((a, b) => Number(a.cli) - Number(b.cli));
    candidates.push(...discovered);
  } catch { /* ignore process listing failure */ }
  return candidates;
}

/** Probe a running `agy acp` process or local Antigravity language server over loopback
 * without spawning a new `agy` process. Returns null when no local server answers so the
 * caller can fall back to `agy -p /usage`. */
export async function probeAntigravityLocalServerQuota(options: {
  preferredPids?: readonly number[];
  signal?: AbortSignal;
  now?: () => number;
  deps?: Partial<AntigravityLocalProbeDeps>;
} = {}): Promise<QuotaSnapshot | null> {
  if (options.signal?.aborted) return null;
  const now = options.now ?? Date.now;
  const deps: AntigravityLocalProbeDeps = {
    execFile: options.deps?.execFile ?? (async (file, args) => {
      const res = await execFileAsync(file, args, { timeout: LOCAL_TIMEOUT_MS, maxBuffer: 512 * 1024, encoding: "utf8" });
      return { stdout: String(res.stdout ?? "") };
    }),
    request: options.deps?.request ?? postLoopbackConnect,
    platform: options.deps?.platform ?? process.platform,
  };

  const candidates = await discoverLocalCandidates(deps, options.preferredPids ?? []);
  for (const candidate of candidates) {
    if (options.signal?.aborted) return null;
    const ports = await listListeningPorts(deps, candidate.pid);
    if (candidate.extPort !== undefined && !ports.includes(candidate.extPort)) ports.push(candidate.extPort);
    for (const port of ports) {
      if (options.signal?.aborted) return null;
      for (const tls of [false, true]) {
        const summaryRes = await deps.request(port, tls, SUMMARY_PATH, "{}", candidate.csrf);
        if (summaryRes?.status === 200) {
          try {
            const snapshot = decodeAntigravityLocalSummary(JSON.parse(summaryRes.text), now());
            if (snapshot) return snapshot;
          } catch { /* try next */ }
        }
        const statusRes = await deps.request(port, tls, STATUS_PATH, "{}", candidate.csrf);
        if (statusRes?.status === 200) {
          try {
            const snapshot = decodeAntigravityLocalStatus(JSON.parse(statusRes.text), now());
            if (snapshot) return snapshot;
          } catch { /* try next */ }
        }
      }
    }
  }
  return null;
}
