import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus, Terminal as TerminalIcon, Trash2, X } from "lucide-react";
import type { TerminalPolicy, TerminalSessionInfo, TerminalStatus } from "../../src/client-protocol/host-terminal.js";
import type { HubConnection } from "./connection.js";
import { t, useLocale } from "./i18n.js";
import "./terminal.css";

interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

const ANSI_COLORS: Record<number, string> = {
  30: "#52525b", 31: "#f87171", 32: "#4ade80", 33: "#facc15",
  34: "#60a5fa", 35: "#c084fc", 36: "#22d3ee", 37: "#e4e4e7",
  90: "#71717a", 91: "#fca5a5", 92: "#86efac", 93: "#fde047",
  94: "#93c5fd", 95: "#d8b4fe", 96: "#67e8f9", 97: "#ffffff",
};

/** Parse basic ANSI SGR escape sequences and strip unsupported OSC/CSI control codes safely. */
export function parseAnsiOutput(raw: string): AnsiSegment[] {
  // Handle clear-screen sequences by keeping content after the last full clear
  const clearIdx = Math.max(raw.lastIndexOf("\x1b[2J"), raw.lastIndexOf("\x1bc"));
  const sliced = clearIdx >= 0 ? raw.slice(clearIdx + (raw[clearIdx + 1] === "c" ? 2 : 4)) : raw;
  // Strip OSC title sequences (\x1b]...\x07 or \x1b]...\x1b\\) and \r before \n
  const cleaned = sliced
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\x1b\[\?[0-9;]*[hl]/g, "");

  const segments: AnsiSegment[] = [];
  const regex = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let lastIndex = 0;
  let color: string | undefined;
  let bold = false;
  let dim = false;

  const pushText = (text: string) => {
    if (!text) return;
    // Apply simple backspace and carriage-return overwrites within lines
    const normalized = text.replace(/[^\n]\x08/g, "");
    segments.push({ text: normalized, ...(color ? { color } : {}), ...(bold ? { bold } : {}), ...(dim ? { dim } : {}) });
  };

  let match: RegExpExecArray | null;
  while ((match = regex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) pushText(cleaned.slice(lastIndex, match.index));
    lastIndex = regex.lastIndex;
    if (match[2] === "m") {
      const codes = (match[1] || "0").split(";").map((n) => Number(n));
      for (const code of codes) {
        if (code === 0) { color = undefined; bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 39) color = undefined;
        else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
      }
    }
  }
  if (lastIndex < cleaned.length) pushText(cleaned.slice(lastIndex));
  return segments;
}

export function TerminalPanel({
  connection,
  conversationId,
  hostName,
  visible,
  close,
}: {
  connection: HubConnection;
  conversationId: string;
  hostName: string;
  visible: boolean;
  close: () => void;
}) {
  useLocale();
  const [tabs, setTabs] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [commandInput, setCommandInput] = useState("");
  const seqRef = useRef<Record<string, number>>({});
  const screenRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeId) ?? tabs[0], [tabs, activeId]);

  const refreshTabs = useCallback(async (autoCreate: boolean) => {
    if (!conversationId || connection.state.status !== "online") return;
    setBusy(true);
    setError("");
    try {
      const list = await connection.terminalList(conversationId);
      if (list.length === 0 && autoCreate) {
        const created = await connection.terminalCreate({ conversationId, cols: 100, rows: 28 });
        setTabs([created]);
        setActiveId(created.id);
      } else {
        setTabs(list);
        setActiveId((prev) => (prev && list.some((t) => t.id === prev) ? prev : list[0]?.id));
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message === "terminal_not_authorized"
        ? t("此设备尚未获得主机终端权限。")
        : t("无法连接到主机终端，请确认主机在线且已启用终端权限。"));
    } finally {
      setBusy(false);
    }
  }, [connection, conversationId]);

  useEffect(() => {
    if (!visible) return;
    void refreshTabs(true);
  }, [visible, conversationId, refreshTabs]);

  // Stream output for the active tab while panel is visible; closing panel pauses
  // polling without stopping the Host shell so it keeps running in the background.
  useEffect(() => {
    if (!visible || !activeTab) return;
    let cancelled = false;
    const termId = activeTab.id;
    const poll = async () => {
      while (!cancelled) {
        try {
          const after = seqRef.current[termId] ?? 0;
          const out = await connection.terminalReadOutput(termId, after, after === 0 ? 500 : 6000);
          if (cancelled) return;
          if (out.chunks.length > 0) {
            seqRef.current[termId] = out.seq;
            const appended = out.chunks.map((c) => c.data).join("");
            setBuffers((old) => ({ ...old, [termId]: ((old[termId] ?? "") + appended).slice(-120_000) }));
          }
          setTabs((old) => old.map((item) => item.id === termId ? { ...item, running: out.running, exitCode: out.exitCode } : item));
          if (!out.running) return;
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [visible, activeTab?.id, connection]);

  useEffect(() => {
    if (screenRef.current) screenRef.current.scrollTop = screenRef.current.scrollHeight;
  }, [buffers[activeTab?.id ?? ""], activeTab?.id]);

  const createTab = async () => {
    if (busy || !conversationId) return;
    setBusy(true);
    setError("");
    try {
      const created = await connection.terminalCreate({ conversationId, cols: 100, rows: 28 });
      setTabs((old) => [...old, created]);
      setActiveId(created.id);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      setError(t("无法新建终端标签页。"));
    } finally {
      setBusy(false);
    }
  };

  const closeTab = async (id: string) => {
    setError("");
    try {
      await connection.terminalClose(id);
      delete seqRef.current[id];
      setBuffers((old) => { const next = { ...old }; delete next[id]; return next; });
      setTabs((old) => {
        const remaining = old.filter((item) => item.id !== id);
        if (activeId === id) setActiveId(remaining[0]?.id);
        return remaining;
      });
    } catch {
      setError(t("关闭终端失败，请重试。"));
    }
  };

  const sendRaw = async (data: string) => {
    if (!activeTab || !activeTab.running) return;
    try {
      await connection.terminalWriteInput(activeTab.id, data);
    } catch {
      setError(t("发送终端输入失败。"));
    }
  };

  const submitCommand = async () => {
    if (!activeTab || !activeTab.running) return;
    const text = commandInput;
    setCommandInput("");
    await sendRaw(text + "\n");
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitCommand();
    } else if (event.ctrlKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void sendRaw("\x03");
    } else if (event.ctrlKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      void sendRaw("\x04");
    } else if (event.ctrlKey && event.key.toLowerCase() === "l") {
      event.preventDefault();
      if (activeTab) setBuffers((old) => ({ ...old, [activeTab.id]: "" }));
    }
  };

  const rendered = useMemo(() => parseAnsiOutput(buffers[activeTab?.id ?? ""] ?? ""), [buffers, activeTab?.id]);

  if (!visible) return null;

  return (
    <aside className="terminal-panel" aria-label={t("主机终端")}>
      <header className="terminal-header">
        <div className="terminal-heading">
          <TerminalIcon size={16} aria-hidden="true" />
          <strong>{t("终端")}</strong>
          <span className="terminal-host-badge">{hostName}</span>
        </div>
        <div className="terminal-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("新建终端")}
            title={t("新建终端")}
            disabled={busy}
            onClick={() => void createTab()}
          >
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("隐藏终端面板")}
            title={t("隐藏面板（终端继续在后台运行）")}
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="terminal-tabs" role="tablist" aria-label={t("终端标签页")}>
        {tabs.map((tab) => {
          const selected = tab.id === activeTab?.id;
          return (
            <div key={tab.id} className={`terminal-tab${selected ? " is-active" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="terminal-tab-select"
                onClick={() => setActiveId(tab.id)}
              >
                <i className={`terminal-tab-dot ${tab.running ? "is-live" : "is-exited"}`} aria-hidden="true" />
                <span>{tab.title}</span>
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={t("关闭并结束 {0}", tab.title)}
                title={t("关闭标签页并结束该终端")}
                onClick={() => void closeTab(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {activeTab && (
        <div className="terminal-meta">
          <span className="terminal-cwd" title={activeTab.cwd}>{activeTab.cwd}</span>
          <span className="terminal-state">
            {activeTab.running ? t("运行中") : t("已退出 ({0})", activeTab.exitCode ?? 0)}
          </span>
        </div>
      )}

      {error && <p className="terminal-error" role="alert">{error}</p>}

      <div
        ref={screenRef}
        className="terminal-screen"
        tabIndex={0}
        onClick={() => inputRef.current?.focus()}
      >
        {!activeTab ? (
          <div className="terminal-empty">
            <p>{t("当前对话尚无运行中的终端。")}</p>
            <button type="button" className="primary" disabled={busy} onClick={() => void createTab()}>
              <Plus size={14} />{t("新建终端")}
            </button>
          </div>
        ) : (
          <pre className="terminal-output">
            {rendered.length > 0 ? rendered.map((seg, i) => (
              <span
                key={i}
                style={{
                  ...(seg.color ? { color: seg.color } : {}),
                  ...(seg.bold ? { fontWeight: 600 } : {}),
                  ...(seg.dim ? { opacity: 0.7 } : {}),
                }}
              >
                {seg.text}
              </span>
            )) : <span className="terminal-placeholder">{t("已连接到主机工作区，输入命令并按回车执行…")}</span>}
          </pre>
        )}
      </div>

      {activeTab && (
        <div className="terminal-input-bar">
          <span className="terminal-prompt" aria-hidden="true">$</span>
          <input
            ref={inputRef}
            type="text"
            className="terminal-input"
            aria-label={t("终端命令输入")}
            placeholder={activeTab.running ? t("输入命令，按回车执行（Ctrl+C 中断）") : t("此终端已退出")}
            disabled={!activeTab.running}
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <button
            type="button"
            className="terminal-ctrl-btn"
            disabled={!activeTab.running}
            title="Ctrl+C"
            onClick={() => void sendRaw("\x03")}
          >
            Ctrl+C
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("清空输出")}
            title={t("清空输出")}
            onClick={() => setBuffers((old) => ({ ...old, [activeTab.id]: "" }))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </aside>
  );
}

/** Owner-only per-device Host terminal permission control (off by default). */
export function HostTerminalSettings({
  connection,
  onChanged,
}: {
  connection: HubConnection;
  onChanged?: (status: TerminalStatus) => void;
}) {
  useLocale();
  const [status, setStatus] = useState<TerminalStatus>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (connection.state.status !== "online" || !connection.state.hostTerminalAvailable) return;
    try {
      const next = await connection.terminalStatus();
      setStatus(next);
      onChanged?.(next);
      setError("");
    } catch {
      setError(t("暂时无法读取主机终端权限设置。"));
    }
  }, [connection, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!connection.state.hostTerminalAvailable || !status?.canManage || !status.policy) return null;

  const policy: TerminalPolicy = status.policy;
  const devices = status.devices ?? [];

  const savePolicy = async (enabled: boolean, grants: TerminalPolicy["grants"]) => {
    setSaving(true);
    setError("");
    try {
      await connection.terminalConfigure({
        expectedRevision: policy.revision,
        enabled,
        grants,
      });
      await load();
    } catch {
      setError(t("保存主机终端权限失败，请重试。"));
    } finally {
      setSaving(false);
    }
  };

  const toggleDevice = (device: { id: string; publicKey: string }) => {
    const exists = policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.publicKey);
    const nextGrants = exists
      ? policy.grants.filter((g) => !(g.deviceId === device.id && g.publicKey === device.publicKey))
      : [...policy.grants, { deviceId: device.id, publicKey: device.publicKey }];
    void savePolicy(policy.enabled, nextGrants);
  };

  return (
    <section className="terminal-settings-card" aria-label={t("主机终端权限")}>
      <div className="terminal-settings-head">
        <div>
          <strong>{t("主机终端")}</strong>
          <p className="settings-note muted">
            {t("默认关闭。开启后仅被授权的电脑设备可在对话工作区中打开主机 Shell，所有开启和关闭记录均写入审计日志。")}
          </p>
        </div>
        <label className="terminal-settings-toggle">
          <input
            type="checkbox"
            checked={policy.enabled}
            disabled={saving}
            onChange={(e) => void savePolicy(e.target.checked, policy.grants)}
          />
          <span>{t("允许主机终端")}</span>
        </label>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {policy.enabled && (
        <div className="terminal-settings-devices">
          <small className="muted">{t("按设备授权（仅电脑端显示终端入口）")}</small>
          {devices.map((device) => {
            const granted = policy.grants.some((g) => g.deviceId === device.id && g.publicKey === device.publicKey);
            return (
              <label key={device.id} className="terminal-settings-device-row">
                <input
                  type="checkbox"
                  checked={granted}
                  disabled={saving}
                  onChange={() => toggleDevice(device)}
                />
                <span>{device.name}</span>
                <small className="muted">{device.platform}</small>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
