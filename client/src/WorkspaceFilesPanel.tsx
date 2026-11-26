import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  AtSign,
  ChevronRight,
  Code2,
  Eye,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  workspacePreviewResponseSchema,
  workspaceTreeResponseSchema,
  type WorkspaceFileEntry,
  type WorkspacePreviewResponse,
  type WorkspaceTreeResponse,
} from "../../src/client-protocol/workspace-files.js";
import type { HubConnection } from "./connection.js";
import { MarkdownText } from "./MarkdownText.js";
import { CodeBlock } from "./CodeBlock.js";
import { t, useLocale } from "./i18n.js";
import { formatFileLimit } from "./files.js";
import {
  changeBadgeLabel,
  changeBadgeTitle,
  classifyWorkspaceEntry,
  entryToneClass,
  formatSafeWorkspaceErrorHint,
} from "./workspace-files-meta.js";
import "./workspace-files.css";

const PdfPreview = lazy(() => import("./PdfPreview.js"));

export const WORKSPACE_FILE_DRAG_MIME = "application/x-tarobird-workspace-file";

export function formatWorkspaceFileMention(relativePath: string): string {
  return /\s/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
}

export { changeBadgeLabel, classifyWorkspaceEntry } from "./workspace-files-meta.js";

function entryIcon(entry: WorkspaceFileEntry, open: boolean) {
  const kind = classifyWorkspaceEntry(entry);
  const toneClass = entryToneClass(kind);
  switch (kind) {
    case "dir":
      return { icon: open ? <FolderOpen size={15}/> : <Folder size={15}/>, toneClass };
    case "sensitive":
      return { icon: <Lock size={14}/>, toneClass };
    case "image":
      return { icon: <FileImage size={14}/>, toneClass };
    case "sheet":
      return { icon: <FileSpreadsheet size={14}/>, toneClass };
    case "pdf":
    case "doc":
      return { icon: <FileText size={14}/>, toneClass };
    case "code":
      return { icon: <FileCode2 size={14}/>, toneClass };
    case "file":
      return { icon: <File size={14}/>, toneClass };
  }
}

/** Friendly spot illustrations for Workspace Files empty, error, and sensitive states. */
function WorkspaceFileStateArt({ kind }: { kind: "changed" | "search" | "empty" | "error" | "sensitive" | "file" }) {
  if (kind === "changed") {
    return (
      <svg className="wf-state-art is-changed" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M16 9a3.5 3.5 0 0 1 3.5-3.5h15l9 9V38.5a3.5 3.5 0 0 1-3.5 3.5h-20.5A3.5 3.5 0 0 1 16 38.5V9Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <path d="M34.5 5.5v9h9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M24.5 26.5l4.2 4.2 8.8-8.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    );
  }
  if (kind === "search") {
    return (
      <svg className="wf-state-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M13 13a4 4 0 0 1 4-4h9l3.5 3.5H45a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H17a4 4 0 0 1-4-4V13Z" fill="currentColor" fillOpacity="0.09" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <circle cx="31" cy="24.5" r="6.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.6"/>
        <path d="M35.8 29.3l4.7 4.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      </svg>
    );
  }
  if (kind === "error") {
    return (
      <svg className="wf-state-art is-error" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <circle cx="32" cy="24" r="16" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.6"/>
        <path d="M32 16v10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
        <circle cx="32" cy="31.5" r="1.6" fill="currentColor"/>
      </svg>
    );
  }
  if (kind === "sensitive") {
    return (
      <svg className="wf-state-art is-sensitive" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M32 6.5 18 12v11.5c0 9.2 5.9 16.5 14 19 8.1-2.5 14-9.8 14-19V12L32 6.5Z" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <rect x="26.5" y="21.5" width="11" height="9.5" rx="2.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.5"/>
        <path d="M29 21.5v-2.8a3 3 0 0 1 6 0v2.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="32" cy="26.3" r="1.1" fill="currentColor"/>
      </svg>
    );
  }
  if (kind === "file") {
    return (
      <svg className="wf-state-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
        <path d="M18 8.5a3.5 3.5 0 0 1 3.5-3.5h14l9 9v25.5a3.5 3.5 0 0 1-3.5 3.5h-19.5A3.5 3.5 0 0 1 18 39.5V8.5Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
        <path d="M35.5 5v9h9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M25 25.5h14M25 31h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.65"/>
      </svg>
    );
  }
  return (
    <svg className="wf-state-art" viewBox="0 0 64 48" width="56" height="42" fill="none" aria-hidden="true">
      <path d="M12 14a4 4 0 0 1 4-4h10l4 4h18a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V14Z" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
      <path d="M24 26h16M24 31h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.7"/>
      <circle cx="48" cy="11" r="2.2" fill="currentColor" fillOpacity="0.5"/>
    </svg>
  );
}

function decodeBase64Blob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function WorkspaceFilesPanel({
  id,
  connection,
  conversationId,
  botId,
  visible,
  phone,
  turnVersion,
  onMentionFile,
  onClose,
}: {
  id: string;
  connection: HubConnection;
  conversationId: string;
  botId: string;
  visible: boolean;
  phone: boolean;
  /** Increments when new messages/turns arrive so the tree auto-refreshes. */
  turnVersion: number;
  onMentionFile: (relativePath: string) => void;
  onClose: () => void;
}) {
  useLocale();
  const [workspaceName, setWorkspaceName] = useState("workspace");
  const [nodes, setNodes] = useState<ReadonlyMap<string, WorkspaceFileEntry[]>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([""]));
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(() => new Set());
  const [changedFiles, setChangedFiles] = useState<WorkspaceTreeResponse["changedFiles"]>([]);
  const [changedOnly, setChangedOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const [rootError, setRootError] = useState("");
  const [rootErrorHint, setRootErrorHint] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<WorkspacePreviewResponse | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewErrorHint, setPreviewErrorHint] = useState("");
  const [rawMarkdown, setRawMarkdown] = useState(false);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  const fingerprints = useRef(new Map<string, string>());

  const fetchDir = useCallback(async (dirPath: string, signal?: AbortSignal) => {
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const qs = new URLSearchParams({ botId, path: dirPath });
      const raw = await connection.http<unknown>(`/api/conversations/${conversationId}/workspace-files/tree?${qs}`, { signal });
      const parsed = workspaceTreeResponseSchema.parse(raw);
      fingerprints.current.set(dirPath, parsed.fingerprint);
      if (dirPath === "") {
        setWorkspaceName(parsed.workspaceName);
        setChangedFiles(parsed.changedFiles);
        setRootError("");
        setRootErrorHint("");
      }
      setNodes((prev) => {
        const next = new Map(prev);
        next.set(dirPath, parsed.entries);
        return next;
      });
      return parsed;
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return undefined;
      if (dirPath === "") {
        setRootError(t("暂时读不到工作区文件，可以点一下重试。"));
        setRootErrorHint(formatSafeWorkspaceErrorHint(error, "tree_unavailable"));
      }
      return undefined;
    } finally {
      setLoadingDirs((prev) => {
        if (!prev.has(dirPath)) return prev;
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [botId, connection, conversationId]);

  const fetchPreview = useCallback(async (filePath: string, reveal = false, signal?: AbortSignal) => {
    setSelectedPath(filePath);
    setPreviewLoading(true);
    setPreviewError("");
    setPreviewErrorHint("");
    setRawMarkdown(false);
    try {
      const qs = new URLSearchParams({ botId, path: filePath, ...(reveal ? { reveal: "1" } : {}) });
      const raw = await connection.http<unknown>(`/api/conversations/${conversationId}/workspace-files/preview?${qs}`, { signal });
      setPreview(workspacePreviewResponseSchema.parse(raw));
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      setPreview(undefined);
      setPreviewError(t("暂时打不开这个文件预览，可以点一下重试。"));
      setPreviewErrorHint(formatSafeWorkspaceErrorHint(error, "preview_unavailable"));
    } finally {
      setPreviewLoading(false);
    }
  }, [botId, connection, conversationId]);

  const refreshExpanded = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const dirs = ["", ...[...expandedRef.current].filter((dir) => dir !== "")];
      await Promise.all(dirs.map((dir) => fetchDir(dir, signal)));
    } finally {
      setRefreshing(false);
    }
  }, [fetchDir]);

  // Reset state when switching conversation or bot
  useEffect(() => {
    setNodes(new Map());
    setExpanded(new Set([""]));
    setSelectedPath(undefined);
    setPreview(undefined);
    setPreviewError("");
    setPreviewErrorHint("");
    setRootError("");
    setRootErrorHint("");
    setFilter("");
    setChangedOnly(false);
    fingerprints.current.clear();
  }, [conversationId, botId]);

  // Initial load & refresh on new turns while visible
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    void refreshExpanded(controller.signal);
    return () => controller.abort();
  }, [visible, conversationId, botId, turnVersion, refreshExpanded]);

  // Periodic background auto-refresh while visible & foregrounded
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshExpanded();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [visible, refreshExpanded]);

  const toggleDir = (entry: WorkspaceFileEntry) => {
    const isOpen = expanded.has(entry.path);
    if (isOpen) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
    } else {
      setExpanded((prev) => new Set(prev).add(entry.path));
      if (!nodes.has(entry.path)) void fetchDir(entry.path);
    }
  };

  const openPathFromBreadcrumb = (targetPath: string) => {
    if (!targetPath) {
      setSelectedPath(undefined);
      setPreview(undefined);
      return;
    }
    // Expand all ancestors of targetPath and clear preview if it's a directory
    const parts = targetPath.split("/");
    const ancestors = new Set(expanded);
    ancestors.add("");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      ancestors.add(prefix);
      if (!nodes.has(prefix)) void fetchDir(prefix);
    }
    setExpanded(ancestors);
    if (targetPath !== selectedPath) {
      setSelectedPath(undefined);
      setPreview(undefined);
    }
  };

  const breadcrumbs = useMemo(() => {
    const active = selectedPath ?? "";
    const segments = active ? active.split("/") : [];
    return segments.map((label, index) => ({
      label,
      path: segments.slice(0, index + 1).join("/"),
      isLast: index === segments.length - 1,
    }));
  }, [selectedPath]);

  const pdfBlob = useMemo(() => {
    if (preview?.kind !== "pdf") return undefined;
    try { return decodeBase64Blob(preview.base64, preview.mime); } catch { return undefined; }
  }, [preview]);

  const normalizedFilter = filter.trim().toLowerCase();

  const dirHasLoadedMatch = (dirPath: string): boolean => {
    const children = nodes.get(dirPath);
    if (!children) return false;
    return children.some((child) => {
      if (changedOnly && !child.changed && !child.hasChangedChildren) return false;
      if (child.name.toLowerCase().includes(normalizedFilter) || child.path.toLowerCase().includes(normalizedFilter)) {
        return true;
      }
      return child.kind === "dir" && expanded.has(child.path) && dirHasLoadedMatch(child.path);
    });
  };

  const renderDir = (dirPath: string, depth: number) => {
    const list = nodes.get(dirPath);
    if (!list) return null;
    const visibleEntries = list.filter((entry) => {
      if (changedOnly && !entry.changed && !entry.hasChangedChildren) return false;
      if (normalizedFilter) {
        if (entry.kind === "dir") {
          return (
            entry.name.toLowerCase().includes(normalizedFilter)
            || entry.path.toLowerCase().includes(normalizedFilter)
            || (expanded.has(entry.path) && dirHasLoadedMatch(entry.path))
          );
        }
        return entry.name.toLowerCase().includes(normalizedFilter) || entry.path.toLowerCase().includes(normalizedFilter);
      }
      return true;
    });
    if (!visibleEntries.length && depth === 0) {
      const emptyKind = normalizedFilter ? "search" : changedOnly ? "changed" : "empty";
      return (
        <div className="wf-state-card" role="status">
          <WorkspaceFileStateArt kind={emptyKind}/>
          <p className="wf-state-title">
            {normalizedFilter ? t("没有匹配的文件") : changedOnly ? t("本轮暂无改动文件") : t("当前目录为空")}
          </p>
          <p className="wf-state-detail">
            {normalizedFilter
              ? t("试试换个关键词，或清空筛选查看全部文件。")
              : changedOnly
                ? t("Bot 新建或修改文件后，这里会自动标出变化。")
                : t("工作区里新增文件后，点一下刷新就会出现在这里。")}
          </p>
          {normalizedFilter && (
            <button type="button" className="wf-secondary-btn" onClick={() => setFilter("")}>
              {t("清空筛选")}
            </button>
          )}
          {!normalizedFilter && changedOnly && (
            <button type="button" className="wf-secondary-btn" onClick={() => setChangedOnly(false)}>
              {t("查看全部文件")}
            </button>
          )}
        </div>
      );
    }
    if (!visibleEntries.length && depth > 0 && !changedOnly && !normalizedFilter) {
      return <div className="wf-empty-sub" style={{ paddingInlineStart: `${30 + depth * 15}px` }}>{t("空文件夹")}</div>;
    }
    return <ul className="wf-tree-list" role={depth === 0 ? "tree" : "group"}>
      {visibleEntries.map((entry) => {
        const isDir = entry.kind === "dir";
        const isOpen = isDir && expanded.has(entry.path);
        const isLoading = isDir && loadingDirs.has(entry.path);
        const isSelected = !isDir && selectedPath === entry.path;
        const { icon, toneClass } = entryIcon(entry, isOpen);
        return <li key={entry.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={isSelected}>
          <div
            className={`wf-row${isSelected ? " is-selected" : ""}${entry.heavy ? " is-heavy" : ""}${entry.sensitive ? " is-sensitive" : ""}`}
            style={{ paddingInlineStart: `${10 + depth * 15}px` }}
            draggable={!phone}
            onDragStart={(event) => {
              event.dataTransfer.setData(WORKSPACE_FILE_DRAG_MIME, entry.path);
              event.dataTransfer.setData("text/plain", formatWorkspaceFileMention(entry.path));
              event.dataTransfer.effectAllowed = "copy";
            }}
          >
            <button
              type="button"
              className="wf-row-main"
              onClick={() => isDir ? toggleDir(entry) : void fetchPreview(entry.path, false)}
              title={entry.path}
            >
              <span className={`wf-caret${isDir ? "" : " is-leaf"}${isOpen ? " is-open" : ""}`} aria-hidden="true">
                {isLoading ? <LoaderCircle size={12} className="spin"/> : isDir ? <ChevronRight size={13}/> : null}
              </span>
              <span className={`wf-icon ${toneClass}`} aria-hidden="true">{icon}</span>
              <span className="wf-name">{entry.name}</span>
              {entry.sensitive && <span className="wf-tag is-sensitive" title={t("可能包含敏感凭据")}>{t("敏感")}</span>}
              {entry.changed && <span className={`wf-git-badge is-${entry.changed}`} title={changeBadgeTitle(entry.changed)}>{changeBadgeLabel(entry.changed)}</span>}
              {!entry.changed && entry.hasChangedChildren && <span className="wf-git-dot" title={t("包含改动文件")} aria-label={t("包含改动文件")}/>}
            </button>
            <button
              type="button"
              className="wf-mention-btn"
              aria-label={t("引用文件：{0}", entry.path)}
              title={t("引用给 Bot")}
              onClick={(event) => { event.stopPropagation(); onMentionFile(entry.path); }}
            >
              <AtSign size={13}/>
            </button>
          </div>
          {isDir && isOpen && renderDir(entry.path, depth + 1)}
        </li>;
      })}
    </ul>;
  };

  const showingPreview = Boolean(selectedPath);

  return <aside
    id={id}
    className={`workspace-files-panel${phone ? " workspace-files-phone" : " conversation-side-panel"}`}
    hidden={!visible}
    aria-label={t("工作区文件")}
  >
    <header className="wf-header">
      <div className="wf-header-title">
        <FolderTree size={16} aria-hidden="true"/>
        <h2>{t("文件")}</h2>
        <span className="wf-readonly-badge">{t("只读")}</span>
      </div>
      <div className="wf-header-actions">
        <button
          type="button"
          className="icon-button"
          aria-label={t("刷新文件树")}
          title={t("刷新文件树")}
          onClick={() => void refreshExpanded()}
        >
          <RefreshCw size={15} className={refreshing ? "spin" : undefined}/>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={t("关闭文件面板")}
          title={t("关闭")}
          onClick={onClose}
        >
          <X size={16}/>
        </button>
      </div>
    </header>

    <nav className="wf-breadcrumbs" aria-label={t("文件路径")}>
      <button type="button" className={`wf-crumb${!selectedPath ? " is-current" : ""}`} onClick={() => openPathFromBreadcrumb("")}>
        {workspaceName}
      </button>
      {breadcrumbs.map((crumb) => <span key={crumb.path} className="wf-crumb-sep-wrap">
        <ChevronRight size={12} aria-hidden="true"/>
        <button
          type="button"
          className={`wf-crumb${crumb.isLast ? " is-current" : ""}`}
          onClick={() => !crumb.isLast && openPathFromBreadcrumb(crumb.path)}
          disabled={crumb.isLast}
        >
          {crumb.label}
        </button>
      </span>)}
    </nav>

    {!showingPreview && <div className="wf-toolbar">
      <label className="wf-search">
        <Search size={13} aria-hidden="true"/>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("筛选文件…")}
          aria-label={t("筛选文件")}
        />
      </label>
      <button
        type="button"
        className={`wf-filter-pill${changedOnly ? " is-active" : ""}`}
        aria-pressed={changedOnly}
        onClick={() => setChangedOnly((value) => !value)}
        title={t("仅显示有改动的文件")}
      >
        <GitBranch size={12} aria-hidden="true"/>
        <span>{changedFiles.length ? t("改动 {0}", changedFiles.length) : t("改动")}</span>
      </button>
    </div>}

    <div className="wf-body">
      {!showingPreview ? (
        rootError ? (
          <div className="wf-state-card is-error" role="alert">
            <WorkspaceFileStateArt kind="error"/>
            <p className="wf-state-title">{rootError}</p>
            <p className="wf-state-detail">{t("请确认 Bot 在线并且工作区目录可访问。")}</p>
            <button type="button" className="wf-retry-btn" onClick={() => void refreshExpanded()}>{t("重试")}</button>
            {rootErrorHint && <small className="wf-error-code">{rootErrorHint}</small>}
          </div>
        ) : !nodes.has("") ? (
          <div className="wf-state-box" role="status">
            <LoaderCircle size={18} className="spin" aria-hidden="true"/>
            <span>{t("正在加载工作区文件…")}</span>
          </div>
        ) : renderDir("", 0)
      ) : (
        <div className="wf-preview">
          <div className="wf-preview-bar">
            <button type="button" className="wf-back-btn" onClick={() => { setSelectedPath(undefined); setPreview(undefined); setPreviewError(""); setPreviewErrorHint(""); }}>
              <ArrowLeft size={14}/>
              <span>{t("返回目录")}</span>
            </button>
            <div className="wf-preview-bar-actions">
              {preview?.kind === "text" && preview.markdown && (
                <button type="button" className="wf-mini-btn" onClick={() => setRawMarkdown((value) => !value)}>
                  {rawMarkdown ? <Eye size={13}/> : <Code2 size={13}/>}
                  <span>{rawMarkdown ? t("渲染") : t("源码")}</span>
                </button>
              )}
              <button type="button" className="wf-mini-btn is-primary" onClick={() => selectedPath && onMentionFile(selectedPath)}>
                <AtSign size={13}/>
                <span>{t("引用给 Bot")}</span>
              </button>
            </div>
          </div>

          {previewLoading && <div className="wf-state-box" role="status"><LoaderCircle size={18} className="spin"/><span>{t("正在加载预览…")}</span></div>}
          {previewError && (
            <div className="wf-state-card is-error" role="alert">
              <WorkspaceFileStateArt kind="error"/>
              <p className="wf-state-title">{previewError}</p>
              <p className="wf-state-detail">{t("文件可能已经被移动、删除，或超出了当前工作区范围。")}</p>
              {selectedPath && (
                <button type="button" className="wf-retry-btn" onClick={() => void fetchPreview(selectedPath, false)}>
                  {t("重试")}
                </button>
              )}
              {previewErrorHint && <small className="wf-error-code">{previewErrorHint}</small>}
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "sensitive" && (
            <div className="wf-state-card is-sensitive">
              <WorkspaceFileStateArt kind="sensitive"/>
              <h3 className="wf-state-title">{t("此文件可能包含敏感凭据")}</h3>
              <p className="wf-state-detail">{t("为避免意外暴露密钥或令牌，{0} 默认不直接预览内容。", preview.name)}</p>
              <button type="button" className="wf-retry-btn" onClick={() => void fetchPreview(preview.path, true)}>
                {t("确认查看内容")}
              </button>
              <small className="wf-state-hint">{t("仅在本地只读查看，不会自动发送给其他人。")}</small>
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "text" && (
            <div className="wf-preview-content">
              <div className="wf-preview-meta">
                <span>{formatFileLimit(preview.size)}</span>
                <span>·</span>
                <span>{t("{0} 行", preview.lines)}</span>
                {preview.truncated && <span className="wf-truncated-note">{t("文件较大，仅展示前 512 KB")}</span>}
              </div>
              {preview.markdown && !rawMarkdown
                ? <div className="wf-markdown-body"><MarkdownText text={preview.content}/></div>
                : <CodeBlock text={preview.content} language={preview.language} className="wf-code-block" copyLabel={t("复制内容")}/>}
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "image" && (
            <div className="wf-preview-content wf-preview-image">
              <div className="wf-preview-meta"><span>{preview.mime}</span><span>·</span><span>{formatFileLimit(preview.size)}</span></div>
              <img src={preview.dataUrl} alt={preview.name}/>
            </div>
          )}

          {!previewLoading && !previewError && preview?.kind === "pdf" && pdfBlob && (
            <div className="wf-preview-content wf-preview-pdf">
              <Suspense fallback={<div className="wf-state-box"><LoaderCircle size={18} className="spin"/></div>}>
                <PdfPreview blob={pdfBlob} name={preview.name}/>
              </Suspense>
            </div>
          )}

          {!previewLoading && !previewError && (preview?.kind === "binary" || preview?.kind === "too_large") && (
            <div className="wf-state-card">
              <WorkspaceFileStateArt kind="file"/>
              <p className="wf-state-title">{preview.kind === "too_large" ? t("文件过大，暂不支持直接预览。") : t("此二进制文件暂不支持文本预览。")}</p>
              <p className="wf-state-detail">{preview.kind === "too_large" ? t("仅支持预览 10 MB 以内的常见文本、图片或 PDF 文件。") : t("你可以先把它引用给 Bot，由 Bot 在工作区里读取或处理。")}</p>
              <small className="wf-error-code">{formatFileLimit(preview.size)}</small>
            </div>
          )}
        </div>
      )}
    </div>
  </aside>;
}
