import { createHash } from "node:crypto";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isCredentialStylePath } from "../runtime/credential-files.js";
import {
  WORKSPACE_FILES_MAX_ENTRIES,
  WORKSPACE_FILES_MAX_IMAGE_BYTES,
  WORKSPACE_FILES_MAX_PDF_BYTES,
  WORKSPACE_FILES_MAX_TEXT_BYTES,
  workspaceFilePathSchema,
  workspacePreviewResponseSchema,
  workspaceRequiredPathSchema,
  workspaceTreeResponseSchema,
  type WorkspaceChangeBadge,
  type WorkspaceFileEntry,
  type WorkspacePreviewResponse,
  type WorkspaceTreeResponse,
} from "../client-protocol/workspace-files.js";
import { HubError } from "./store.js";
import type { HubWorkspaceDiff } from "./workspace-diff.js";

type Scope = { conversationId: string; botId: string };

const CONFIG_MAX_BYTES = 128 * 1024;
const HEAVY_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".next", ".nuxt", "dist", "build", "target", "__pycache__", ".venv", "venv"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const EXTENSION_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".sql": "sql",
  ".graphql": "graphql",
  ".dockerfile": "dockerfile",
  ".env": "dotenv",
  ".ini": "ini",
  ".txt": "text",
  ".log": "text",
  ".csv": "csv",
};

function within(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function detectLanguage(name: string): { language: string; markdown: boolean } {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return { language: "dockerfile", markdown: false };
  if (lower === "makefile") return { language: "makefile", markdown: false };
  if (lower.startsWith(".env")) return { language: "dotenv", markdown: false };
  const ext = path.extname(lower);
  const language = EXTENSION_LANGUAGE[ext] ?? "text";
  return { language, markdown: ext === ".md" || ext === ".markdown" || ext === ".mdx" };
}

function isSensitiveEntry(relPath: string, fullPath: string): boolean {
  if (isCredentialStylePath(relPath, fullPath)) return true;
  const base = path.posix.basename(relPath).toLowerCase();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === ".npmrc" || base === ".pypirc" || base === ".netrc") return true;
  return false;
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HubError("workspace_files_not_file", 400);
    const toRead = Math.min(info.size, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return { bytes: buf.subarray(0, offset), truncated: info.size > maxBytes };
  } finally {
    await handle.close();
  }
}

export class HubWorkspaceFiles {
  constructor(
    private readonly stateDirectory: (botId: string, remainingMs: number) => Promise<string>,
    private readonly workspaceDiff?: Pick<HubWorkspaceDiff, "list">,
  ) {}

  private async resolveWorkspaceRoot(scope: Scope, signal: AbortSignal): Promise<{ root: string; name: string }> {
    signal.throwIfAborted();
    const state = await this.stateDirectory(scope.botId, 8_000);
    signal.throwIfAborted();
    if (!path.isAbsolute(state)) throw new HubError("workspace_files_unavailable", 409);
    const canonicalState = await realpath(state);
    let config: Record<string, unknown> = {};
    const configPath = path.join(canonicalState, "config.json");
    try {
      const stat = await lstat(configPath);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= CONFIG_MAX_BYTES) {
        const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Missing config falls back to <stateDir>/workspace below.
    }
    const resume = config.resume && typeof config.resume === "object" && !Array.isArray(config.resume)
      ? config.resume as Record<string, unknown>
      : {};
    const configured = config.workspacePath ?? resume.workspacePath ?? path.join(canonicalState, "workspace");
    if (typeof configured !== "string" || !path.isAbsolute(configured)) {
      throw new HubError("workspace_files_unavailable", 409);
    }
    let root: string;
    try {
      root = await realpath(configured);
    } catch {
      throw new HubError("workspace_files_unavailable", 409);
    }
    const info = await lstat(root);
    if (root === path.parse(root).root || !info.isDirectory()) {
      throw new HubError("workspace_files_unavailable", 409);
    }
    return { root, name: path.basename(root) || "workspace" };
  }

  /**
   * Resolve a relative path component-by-component inside `root`, rejecting any
   * symlink or traversal that leaves the canonical workspace root.
   */
  private async resolveInsideRoot(root: string, relPath: string): Promise<{ resolved: string; isSymlink: boolean }> {
    const clean = workspaceFilePathSchema.parse(relPath);
    if (!clean) return { resolved: root, isSymlink: false };
    let current = root;
    const segments = clean.split("/");
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const next = path.join(current, segment);
      let stat;
      try {
        stat = await lstat(next);
      } catch {
        throw new HubError("workspace_files_not_found", 404);
      }
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(next);
        } catch {
          throw new HubError("workspace_files_outside_root", 403);
        }
        if (!within(root, target)) {
          throw new HubError("workspace_files_outside_root", 403);
        }
        if (index === segments.length - 1) {
          return { resolved: target, isSymlink: true };
        }
        current = target;
      } else {
        if (!within(root, next)) throw new HubError("workspace_files_outside_root", 403);
        current = next;
      }
    }
    const finalReal = await realpath(current);
    if (!within(root, finalReal)) throw new HubError("workspace_files_outside_root", 403);
    return { resolved: finalReal, isSymlink: false };
  }

  private async readChangedFiles(
    scope: Scope,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ): Promise<Array<{ path: string; status: WorkspaceChangeBadge }>> {
    if (!this.workspaceDiff) return [];
    try {
      const changes = await this.workspaceDiff.list(scope, signal, authorize);
      return changes.items.slice(0, 200).map((item) => ({ path: item.path, status: item.status }));
    } catch {
      return [];
    }
  }

  async list(
    scope: Scope,
    relPath: string,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ): Promise<WorkspaceTreeResponse> {
    await authorize();
    const cleanPath = workspaceFilePathSchema.parse(relPath);
    const { root, name } = await this.resolveWorkspaceRoot(scope, signal);
    const { resolved } = await this.resolveInsideRoot(root, cleanPath);
    const dirInfo = await lstat(resolved);
    if (!dirInfo.isDirectory()) throw new HubError("workspace_files_not_directory", 400);

    const changedFiles = await this.readChangedFiles(scope, signal, authorize);
    const changedMap = new Map<string, WorkspaceChangeBadge>();
    const changedDirs = new Set<string>();
    for (const item of changedFiles) {
      changedMap.set(item.path, item.status);
      const parts = item.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        changedDirs.add(parts.slice(0, i).join("/"));
      }
    }

    const entries: WorkspaceFileEntry[] = [];
    let truncated = false;
    const handle = await opendir(resolved);
    try {
      for await (const dirent of handle) {
        signal.throwIfAborted();
        if (entries.length >= WORKSPACE_FILES_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        const entryName = dirent.name;
        if (!entryName || entryName === "." || entryName === ".." || entryName.includes("/") || entryName.includes("\\")) {
          continue;
        }
        const entryRel = cleanPath ? `${cleanPath}/${entryName}` : entryName;
        if (!workspaceRequiredPathSchema.safeParse(entryRel).success) continue;
        const entryFull = path.join(resolved, entryName);
        let stat;
        try {
          stat = await lstat(entryFull);
        } catch {
          continue;
        }
        let kind: "dir" | "file" | "symlink";
        if (stat.isSymbolicLink()) {
          // Only expose symlinks whose real target remains strictly inside the workspace root.
          try {
            const target = await realpath(entryFull);
            if (!within(root, target)) continue;
            const targetStat = await lstat(target);
            kind = targetStat.isDirectory() ? "dir" : "symlink";
          } catch {
            continue;
          }
        } else if (stat.isDirectory()) {
          kind = "dir";
        } else if (stat.isFile()) {
          kind = "file";
        } else {
          continue;
        }
        const sensitive = isSensitiveEntry(entryRel, entryFull);
        const heavy = kind === "dir" && HEAVY_DIRS.has(entryName);
        const changed = changedMap.get(entryRel);
        const hasChangedChildren = kind === "dir" && changedDirs.has(entryRel);
        entries.push({
          name: entryName,
          path: entryRel,
          kind,
          size: kind === "file" ? stat.size : null,
          mtimeMs: Math.max(0, Math.floor(stat.mtimeMs)),
          sensitive,
          heavy,
          ...(changed ? { changed } : {}),
          ...(hasChangedChildren ? { hasChangedChildren: true } : {}),
        });
      }
    } finally {
      await handle.close().catch(() => undefined);
    }

    entries.sort((a, b) => {
      const aDir = a.kind === "dir" ? 0 : 1;
      const bDir = b.kind === "dir" ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

    const fingerprint = createHash("sha1")
      .update(entries.map((entry) => `${entry.path}:${entry.kind}:${entry.size ?? ""}:${entry.mtimeMs ?? ""}:${entry.changed ?? ""}:${entry.hasChangedChildren ? 1 : 0}`).join("\n"))
      .digest("hex")
      .slice(0, 20);

    await authorize();
    return workspaceTreeResponseSchema.parse({
      workspaceName: name,
      path: cleanPath,
      entries,
      truncated,
      changedFiles,
      fingerprint,
    });
  }

  async preview(
    scope: Scope,
    relPath: string,
    revealSensitive: boolean,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ): Promise<WorkspacePreviewResponse> {
    await authorize();
    const cleanPath = workspaceRequiredPathSchema.parse(relPath);
    const { root } = await this.resolveWorkspaceRoot(scope, signal);
    const { resolved } = await this.resolveInsideRoot(root, cleanPath);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new HubError("workspace_files_not_file", 400);

    const name = path.posix.basename(cleanPath);
    const size = info.size;
    const mtimeMs = Math.max(0, Math.floor(info.mtimeMs));
    const sensitive = isSensitiveEntry(cleanPath, resolved);

    if (sensitive && !revealSensitive) {
      return workspacePreviewResponseSchema.parse({ kind: "sensitive", path: cleanPath, name, size, mtimeMs });
    }

    const ext = path.extname(name).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    if (imageMime && !sensitive) {
      if (size > WORKSPACE_FILES_MAX_IMAGE_BYTES) {
        return workspacePreviewResponseSchema.parse({ kind: "too_large", path: cleanPath, name, size, mtimeMs });
      }
      const { bytes } = await readBoundedFile(resolved, WORKSPACE_FILES_MAX_IMAGE_BYTES);
      await authorize();
      return workspacePreviewResponseSchema.parse({
        kind: "image",
        path: cleanPath,
        name,
        size,
        mtimeMs,
        mime: imageMime,
        dataUrl: `data:${imageMime};base64,${bytes.toString("base64")}`,
      });
    }

    if (ext === ".pdf" && !sensitive) {
      if (size > WORKSPACE_FILES_MAX_PDF_BYTES) {
        return workspacePreviewResponseSchema.parse({ kind: "too_large", path: cleanPath, name, size, mtimeMs });
      }
      const { bytes } = await readBoundedFile(resolved, WORKSPACE_FILES_MAX_PDF_BYTES);
      await authorize();
      return workspacePreviewResponseSchema.parse({
        kind: "pdf",
        path: cleanPath,
        name,
        size,
        mtimeMs,
        mime: "application/pdf",
        base64: bytes.toString("base64"),
      });
    }

    const { bytes, truncated } = await readBoundedFile(resolved, WORKSPACE_FILES_MAX_TEXT_BYTES);
    if (bytes.includes(0)) {
      return workspacePreviewResponseSchema.parse({ kind: "binary", path: cleanPath, name, size, mtimeMs });
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    } catch {
      return workspacePreviewResponseSchema.parse({ kind: "binary", path: cleanPath, name, size, mtimeMs });
    }
    const { language, markdown } = detectLanguage(name);
    const lines = content ? content.split("\n").length : 0;
    await authorize();
    return workspacePreviewResponseSchema.parse({
      kind: "text",
      path: cleanPath,
      name,
      size,
      mtimeMs,
      language,
      markdown,
      sensitive,
      content,
      lines,
      truncated,
    });
  }
}
