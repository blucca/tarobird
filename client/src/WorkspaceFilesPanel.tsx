import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  AtSign,
  ChevronRight,
  Code2,
  Eye,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GitBranch,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  workspacePreviewResponseSchema,
  workspaceTreeResponseSchema,
  type WorkspaceChangeBadge,
  type WorkspaceFileEntry,
  type WorkspacePreviewResponse,
  type WorkspaceTreeResponse,
} from "../../src/client-protocol/workspace-files.js";
import type { HubConnection } from "./connection.js";
import { MarkdownText } from "./MarkdownText.js";
import { CodeBlock } from "./CodeBlock.js";
import { t, useLocale } from "./i18n.js";
import { formatFileLimit } from "./files.js";
import "./workspace-files.css";

const PdfPreview = lazy(() => import("./PdfPreview.js"));

export const WORKSPACE_FILE_DRAG_MIME = "application/x-tarobird-workspace-file";

export function formatWorkspaceFileMention(relativePath: string): string {
  return /\s/.test(relativePath) ? `@"${relativePath}"` : `@${relativePath}`;
}

function changeBadgeLabel(status: WorkspaceChangeBadge): string {
  switch (status) {
    case "added": return "A";
    case "modified": return "M";
    case "deleted": return "D";
    case "untracked": return "U";
    case "conflicted": return "C";
    case "type_changed": return "T";
  }
}

function changeBadgeTitle(status: WorkspaceChangeBadge): string {
  switch (status) {
    case "added": return t("新增文件");
    case "modified": return t("已修改");
    case "deleted": return t("已删除");
    case "untracked": return t("未跟踪文件");
    case "conflicted": return t("存在冲突");
    case "type_changed": return t("类型变更");
  }
}

function entryIcon(entry: WorkspaceFileEntry, open: boolean) {
  if (entry.kind === "dir") return open ? <FolderOpen size={15}/> : <Folder size={15}/>;
  if (entry.sensitive) return <Lock size={14}/>;
  const lower = entry.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(lower)) return <FileImage size={14}/>;
  if (/\.(ts|tsx|mts|js|jsx|mjs|py|go|rs|java|kt|swift|c|cpp|h|css|scss|html|json|yaml|yml|toml|sh|sql)$/.test(lower)) return <FileCode2 size={14}/>;
  return <FileText size={14}/>;
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
  const [refreshing, setRefreshing] = useState(false);

  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<WorkspacePreviewResponse | undefined>(undefined);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
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
        setRootError(t("暂时无法读取当前工作区目录，请确认 Bot 在线后重试。"));
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
    setRawMarkdown(false);
    try {
      const qs = new URLSearchParams({ botId, path: filePath, ...(reveal ? { reveal: "1" } : {}) });
      const raw = await connection.http<unknown>(`/api/conversations/${conversationId}/workspace-files/preview?${qs}`, { signal });
      setPreview(workspacePreviewResponseSchema.parse(raw));
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") return;
      setPreview(undefined);
      setPreviewError(t("无法预览该文件，可能已被移动或超出工作区边界。"));
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
    setRootError("");
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

  const renderDir = (dirPath: string, depth: number) => {
    const list = nodes.get(dirPath);
    if (!list) return null;
    const visibleEntries = list.filter((entry) => {
      if (changedOnly && !entry.changed && !entry.hasChangedChildren) return false;
      if (normalizedFilter) {
        if (entry.kind === "dir") {
          return entry.name.toLowerCase().includes(normalizedFilter) || expanded.has(entry.path);
        }
        return entry.name.toLowerCase().includes(normalizedFilter) || entry.path.toLowerCase().includes(normalizedFilter);
      }
      return true;
    });
    if (!visibleEntries.length && depth === 0) {
      return <div className="wf-empty">{changedOnly ? t("本轮暂无改动文件") : normalizedFilter ? t("没有匹配的文件") : t("当前目录为空")}</div>;
    }
    return <ul className="wf-tree-list" role={depth === 0 ? "tree" : "group"}>
      {visibleEntries.map((entry) => {
        const isDir = entry.kind === "dir";
        const isOpen = isDir && expanded.has(entry.path);
        const isLoading = isDir && loadingDirs.has(entry.path);
        const isSelected = !isDir && selectedPath === entry.path;
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
              <span className={`wf-icon${isDir ? " is-dir" : ""}`} aria-hidden="true">{entryIcon(entry, isOpen)}</span>
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
          <div className="wf-state-box" role="alert">
            <p>{rootError}</p>
            <button type="button" onClick={() => void refreshExpanded()}>{t("重试")}</button>
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
            <button type="button" className="wf-back-btn" onClick={() => { setSelectedPath(undefined); setPreview(undefined); setPreviewError(""); }}>
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
          {previewError && <div className="wf-state-box" role="alert"><p>{previewError}</p></div>}

          {!previewLoading && !previewError && preview?.kind === "sensitive" && (
            <div className="wf-sensitive-gate">
              <ShieldAlert size={24} aria-hidden="true"/>
              <h3>{t("此文件可能包含敏感凭据")}</h3>
              <p>{t("为避免意外暴露密钥或令牌，{0} 默认不直接预览内容。", preview.name)}</p>
              <button type="button" className="primary" onClick={() => void fetchPreview(preview.path, true)}>
                {t("确认查看内容")}
              </button>
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
            <div className="wf-state-box">
              <FileText size={24} aria-hidden="true"/>
              <p>{preview.kind === "too_large" ? t("文件过大，暂不支持直接预览。") : t("此二进制文件暂不支持文本预览。")}</p>
              <small>{formatFileLimit(preview.size)}</small>
            </div>
          )}
        </div>
      )}
    </div>
  </aside>;
}
