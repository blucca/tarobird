import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  terminalConfigureSchema,
  terminalConfigureText,
  terminalCreateSchema,
  terminalInputSchema,
  terminalOutputSchema,
  terminalPolicySchema,
  terminalResizeSchema,
  terminalStatusSchema,
  type TerminalConfigure,
  type TerminalCreate,
  type TerminalOutput,
  type TerminalPolicy,
  type TerminalSessionInfo,
  type TerminalStatus,
} from "../client-protocol/host-terminal.js";
import type { DeviceActionProof } from "../client-protocol/device-actions.js";
import { killProcessTree } from "../codex/process-tree.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import { hashSecret, type AuthSession, type HubAuth } from "./auth.js";
import { HubError, type HubStore } from "./store.js";

const TERMINAL_POLICY_KEY = "terminal-policy:v1";
const MAX_TERMINALS_PER_CONVERSATION = 8;
const MAX_TOTAL_TERMINALS = 24;
const MAX_SCROLLBACK_BYTES = 256 * 1024;
const MAX_LONG_POLL_MS = 8_000;

export interface TerminalProcessHandle {
  pid?: number;
  shell: string;
  backend: "node-pty" | "pty-script" | "pipe";
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(): Promise<void>;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface HostTerminalOptions {
  store: HubStore;
  auth: HubAuth;
  stateDir: string;
  defaultWorkspace?: string;
  spawnProcess?: (options: { cwd: string; cols: number; rows: number }) => Promise<TerminalProcessHandle>;
}

interface LiveTerminal {
  id: string;
  conversationId: string;
  ownerDeviceId: string;
  ownerPublicKey: string;
  userId: string;
  title: string;
  cwd: string;
  shell: string;
  backend: "node-pty" | "pty-script" | "pipe";
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
  lastActivityAt: number;
  seq: number;
  chunks: Array<{ seq: number; data: string; bytes: number }>;
  totalBytes: number;
  waiters: Set<() => void>;
  handle: TerminalProcessHandle;
  closedAudited: boolean;
}

function defaultShell(platform: NodeJS.Platform): { command: string; args: string[]; label: string } {
  if (platform === "win32") {
    const comspec = process.env.ComSpec || "powershell.exe";
    if (/powershell/i.test(comspec)) return { command: comspec, args: ["-NoLogo"], label: "powershell" };
    return { command: comspec, args: [], label: path.basename(comspec) };
  }
  const shell = process.env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return { command: shell, args: ["-i"], label: path.basename(shell) };
}

async function trySpawnNodePty(cwd: string, cols: number, rows: number): Promise<TerminalProcessHandle | undefined> {
  try {
    const specifier = "node-pty";
    const mod = await import(/* @vite-ignore */ specifier) as {
      spawn?: (file: string, args: string[], opts: Record<string, unknown>) => {
        pid: number;
        write(data: string): void;
        resize(cols: number, rows: number): void;
        kill(): void;
        onData(cb: (data: string) => void): void;
        onExit(cb: (ev: { exitCode: number }) => void): void;
      };
    };
    if (typeof mod.spawn !== "function") return undefined;
    const { command, args, label } = defaultShell(process.platform);
    const pty = mod.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    return {
      pid: pty.pid,
      shell: label,
      backend: "node-pty",
      write: (data) => pty.write(data),
      resize: (c, r) => pty.resize(c, r),
      kill: async () => { try { pty.kill(); } catch { /* ignore */ } },
      onData: (cb) => pty.onData(cb),
      onExit: (cb) => pty.onExit(({ exitCode }) => cb(exitCode)),
    };
  } catch {
    return undefined;
  }
}

async function spawnFallbackShell(cwd: string, cols: number, rows: number): Promise<TerminalProcessHandle> {
  const { command, label } = defaultShell(process.platform);
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
  };
  const spawnArgs = process.platform === "win32"
    ? (/powershell/i.test(command) ? ["-NoLogo", "-NoExit"] : [])
    : [];
  const child: ChildProcess = spawn(command, spawnArgs, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  const backend = "pipe" as const;

  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(code: number | null) => void>();
  const emit = (buf: Buffer) => {
    const text = buf.toString("utf8");
    for (const cb of dataListeners) cb(text);
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  let exited = false;
  const finish = (code: number | null) => {
    if (exited) return;
    exited = true;
    for (const cb of exitListeners) cb(code);
  };
  child.once("exit", (code) => finish(code));
  child.once("error", () => finish(1));

  return {
    pid: child.pid,
    shell: label,
    backend,
    write: (data) => {
      if (!child.killed && child.stdin?.writable) child.stdin.write(data);
    },
    kill: async () => {
      if (child.pid) {
        await killProcessTree(child.pid).catch(() => undefined);
      } else {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }
    },
    onData: (cb) => { dataListeners.add(cb); },
    onExit: (cb) => { exitListeners.add(cb); },
  };
}

export class HubHostTerminal {
  private readonly sessions = new Map<string, LiveTerminal>();
  private policy?: TerminalPolicy;
  private serialCount = 0;

  constructor(private readonly options: HostTerminalOptions) {}

  private async readPolicy(): Promise<TerminalPolicy> {
    if (this.policy) return this.policy;
    const row = await this.options.store.db.serial(() =>
      this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [TERMINAL_POLICY_KEY]),
    );
    try {
      return this.policy = row ? terminalPolicySchema.parse(JSON.parse(row.value)) : { revision: 0, enabled: false, grants: [] };
    } catch {
      throw new HubError("terminal_policy_invalid", 503);
    }
  }

  private async deviceForSession(session: AuthSession): Promise<{ id: string; name: string; platform: string; public_key: string; role: string }> {
    const row = await this.options.store.db.serial(() =>
      this.options.store.db.get<{ id: string; name: string; platform: string; public_key: string; role: string }>(
        "SELECT d.id, d.name, d.platform, d.public_key, u.role FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.revoked=0",
        [session.deviceId],
      ),
    );
    if (!row) throw new HubError("device_revoked", 401);
    return row;
  }

  private isGranted(policy: TerminalPolicy, device: { id: string; public_key: string }): boolean {
    return policy.enabled && policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.public_key);
  }

  private async requireAuthorized(session: AuthSession): Promise<{ device: { id: string; name: string; platform: string; public_key: string; role: string }; policy: TerminalPolicy }> {
    const [device, policy] = await Promise.all([this.deviceForSession(session), this.readPolicy()]);
    if (!this.isGranted(policy, device)) throw new HubError("terminal_not_authorized", 403);
    return { device, policy };
  }

  private toInfo(term: LiveTerminal): TerminalSessionInfo {
    return {
      id: term.id,
      conversationId: term.conversationId,
      title: term.title,
      cwd: term.cwd,
      shell: term.shell,
      backend: term.backend,
      running: term.running,
      exitCode: term.exitCode,
      createdAt: term.createdAt,
      lastActivityAt: term.lastActivityAt,
      cols: term.cols,
      rows: term.rows,
    };
  }

  async status(session: AuthSession): Promise<TerminalStatus> {
    const [device, policy] = await Promise.all([this.deviceForSession(session), this.readPolicy()]);
    const canManage = device.role === "owner";
    const allowed = this.isGranted(policy, device);
    let devices: TerminalStatus["devices"];
    if (canManage) {
      const rows = await this.options.store.db.serial(() =>
        this.options.store.db.all<{ id: string; name: string; platform: string; public_key: string }>(
          "SELECT id, name, platform, public_key FROM devices WHERE revoked=0 ORDER BY created_at ASC LIMIT 256",
        ),
      );
      devices = rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, publicKey: r.public_key }));
    }
    const visibleSessions = allowed
      ? [...this.sessions.values()].filter((t) => t.userId === session.userId).map((t) => this.toInfo(t))
      : [];
    return terminalStatusSchema.parse({
      supported: true,
      enabled: policy.enabled,
      allowed,
      canManage,
      ...(canManage ? { policy, devices } : {}),
      sessions: visibleSessions,
    });
  }

  async configure(session: AuthSession, rawCommand: unknown, proof: DeviceActionProof | undefined): Promise<TerminalPolicy> {
    const command: TerminalConfigure = terminalConfigureSchema.parse(rawCommand);
    const target = hashSecret(terminalConfigureText(command));

    const next = await this.options.store.db.transaction(async () => {
      await this.options.auth.consumeBotMessageGrant(session, target, proof);
      const stored = await this.options.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [TERMINAL_POLICY_KEY]);
      const current = stored ? terminalPolicySchema.parse(JSON.parse(stored.value)) : { revision: 0, enabled: false, grants: [] };
      if (command.expectedRevision !== current.revision) throw new HubError("terminal_policy_changed", 409);

      const grants: TerminalPolicy["grants"] = [];
      for (const grant of command.grants) {
        const device = await this.options.store.db.get<{ id: string; public_key: string; revoked: number }>(
          "SELECT id, public_key, revoked FROM devices WHERE id=?",
          [grant.deviceId],
        );
        if (!device || device.revoked || device.public_key !== grant.publicKey) continue;
        if (!grants.some((g) => g.deviceId === grant.deviceId)) grants.push(grant);
      }
      const updated = terminalPolicySchema.parse({
        revision: current.revision + 1,
        enabled: command.enabled,
        grants,
      });
      await this.options.store.db.run(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [TERMINAL_POLICY_KEY, JSON.stringify(updated)],
      );
      return updated;
    });

    this.policy = next;
    await this.options.store.audit("terminal.policy", session.deviceId, {
      revision: next.revision,
      enabled: next.enabled,
      grants: next.grants.length,
    });

    // Immediately terminate live terminals belonging to any revoked or disabled device.
    for (const term of [...this.sessions.values()]) {
      if (!next.enabled || !next.grants.some((g) => g.deviceId === term.ownerDeviceId && g.publicKey === term.ownerPublicKey)) {
        await this.terminateSession(term, session.deviceId, "permission_revoked");
      }
    }
    return next;
  }

  private async resolveWorkspace(userId: string, conversationId: string): Promise<string> {
    const conversations = await this.options.store.conversations(userId);
    const conversation = conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new HubError("conversation_forbidden", 403);

    for (const botId of conversation.botIds) {
      const botDir = path.join(this.options.stateDir, "bots", botId);
      try {
        const config = await loadInstanceConfig(botDir);
        const resolved = resolveInstanceWorkspacePath(config);
        if (resolved && await stat(resolved).then((s) => s.isDirectory(), () => false)) {
          return resolved;
        }
      } catch { /* fall through to bot workspace dir */ }
      const fallbackBotWorkspace = path.join(botDir, "workspace");
      if (await stat(fallbackBotWorkspace).then((s) => s.isDirectory(), () => false)) {
        return fallbackBotWorkspace;
      }
    }
    if (this.options.defaultWorkspace && await stat(this.options.defaultWorkspace).then((s) => s.isDirectory(), () => false)) {
      return this.options.defaultWorkspace;
    }
    return this.options.stateDir;
  }

  async list(session: AuthSession, conversationId: string): Promise<TerminalSessionInfo[]> {
    await this.requireAuthorized(session);
    const conversations = await this.options.store.conversations(session.userId);
    if (!conversations.some((c) => c.id === conversationId)) throw new HubError("conversation_forbidden", 403);
    return [...this.sessions.values()]
      .filter((t) => t.userId === session.userId && t.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => this.toInfo(t));
  }

  async create(session: AuthSession, raw: unknown): Promise<TerminalSessionInfo> {
    const { device } = await this.requireAuthorized(session);
    const input: TerminalCreate = terminalCreateSchema.parse(raw);

    if (this.sessions.size >= MAX_TOTAL_TERMINALS) throw new HubError("terminal_limit_reached", 429);
    const convCount = [...this.sessions.values()].filter((t) => t.conversationId === input.conversationId).length;
    if (convCount >= MAX_TERMINALS_PER_CONVERSATION) throw new HubError("terminal_limit_reached", 429);

    const cwd = await this.resolveWorkspace(session.userId, input.conversationId);
    const handle = this.options.spawnProcess
      ? await this.options.spawnProcess({ cwd, cols: input.cols, rows: input.rows })
      : (await trySpawnNodePty(cwd, input.cols, input.rows)) ?? (await spawnFallbackShell(cwd, input.cols, input.rows));

    const id = `term_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = Date.now();
    const index = ++this.serialCount;
    const term: LiveTerminal = {
      id,
      conversationId: input.conversationId,
      ownerDeviceId: device.id,
      ownerPublicKey: device.public_key,
      userId: session.userId,
      title: input.title ?? `${handle.shell} #${index}`,
      cwd,
      shell: handle.shell,
      backend: handle.backend,
      cols: input.cols,
      rows: input.rows,
      running: true,
      exitCode: null,
      createdAt: now,
      lastActivityAt: now,
      seq: 0,
      chunks: [],
      totalBytes: 0,
      waiters: new Set(),
      handle,
      closedAudited: false,
    };

    const wake = () => {
      for (const resolve of term.waiters) resolve();
      term.waiters.clear();
    };

    handle.onData((chunk) => {
      if (!chunk) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      term.seq += 1;
      term.lastActivityAt = Date.now();
      term.chunks.push({ seq: term.seq, data: chunk, bytes });
      term.totalBytes += bytes;
      while (term.totalBytes > MAX_SCROLLBACK_BYTES && term.chunks.length > 1) {
        const dropped = term.chunks.shift()!;
        term.totalBytes -= dropped.bytes;
      }
      wake();
    });

    handle.onExit((code) => {
      term.running = false;
      term.exitCode = code ?? 0;
      term.lastActivityAt = Date.now();
      wake();
    });

    this.sessions.set(id, term);
    await this.options.store.audit("terminal.opened", device.id, {
      terminalId: id,
      conversationId: input.conversationId,
      cwd,
      shell: handle.shell,
      backend: handle.backend,
    });
    return this.toInfo(term);
  }

  private async requireOwnedTerminal(session: AuthSession, id: string): Promise<LiveTerminal> {
    await this.requireAuthorized(session);
    const term = this.sessions.get(id);
    if (!term || term.userId !== session.userId) throw new HubError("terminal_not_found", 404);
    return term;
  }

  async readOutput(session: AuthSession, id: string, after: number, waitMs = 0): Promise<TerminalOutput> {
    const term = await this.requireOwnedTerminal(session, id);
    const boundedWait = Math.min(Math.max(0, waitMs), MAX_LONG_POLL_MS);
    if (term.seq <= after && term.running && boundedWait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          term.waiters.delete(done);
          resolve();
        }, boundedWait);
        timer.unref?.();
        const done = () => {
          clearTimeout(timer);
          term.waiters.delete(done);
          resolve();
        };
        term.waiters.add(done);
      });
    }
    const chunks = term.chunks.filter((c) => c.seq > after).map(({ seq, data }) => ({ seq, data }));
    return terminalOutputSchema.parse({
      id: term.id,
      seq: term.seq,
      running: term.running,
      exitCode: term.exitCode,
      chunks,
    });
  }

  async writeInput(session: AuthSession, id: string, raw: unknown): Promise<{ ok: true }> {
    const term = await this.requireOwnedTerminal(session, id);
    const { data } = terminalInputSchema.parse(raw);
    if (!term.running) throw new HubError("terminal_closed", 409);
    term.lastActivityAt = Date.now();
    term.handle.write(data);
    return { ok: true };
  }

  async resize(session: AuthSession, id: string, raw: unknown): Promise<{ ok: true }> {
    const term = await this.requireOwnedTerminal(session, id);
    const { cols, rows } = terminalResizeSchema.parse(raw);
    term.cols = cols;
    term.rows = rows;
    term.handle.resize?.(cols, rows);
    return { ok: true };
  }

  private async terminateSession(term: LiveTerminal, actor: string, reason: string): Promise<void> {
    this.sessions.delete(term.id);
    const wasRunning = term.running;
    term.running = false;
    for (const resolve of term.waiters) resolve();
    term.waiters.clear();
    if (wasRunning) {
      await term.handle.kill().catch(() => undefined);
    }
    if (!term.closedAudited) {
      term.closedAudited = true;
      await this.options.store.audit("terminal.closed", actor, {
        terminalId: term.id,
        conversationId: term.conversationId,
        reason,
        ...(term.exitCode !== null ? { exitCode: term.exitCode } : {}),
      }).catch(() => undefined);
    }
  }

  async close(session: AuthSession, id: string): Promise<{ ok: true }> {
    const term = await this.requireOwnedTerminal(session, id);
    await this.terminateSession(term, session.deviceId, "tab_closed");
    return { ok: true };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    for (const term of [...this.sessions.values()]) {
      if (term.ownerDeviceId === deviceId) {
        await this.terminateSession(term, "hub", "device_revoked");
      }
    }
  }

  async dispose(): Promise<void> {
    for (const term of [...this.sessions.values()]) {
      await this.terminateSession(term, "hub", "hub_shutdown");
    }
  }
}
