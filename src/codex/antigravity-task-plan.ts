export type AntigravityTodoStatus = "pending" | "in_progress" | "completed";

export interface AntigravityTodoItem {
  content: string;
  status: AntigravityTodoStatus;
}

export interface AntigravityTaskPlanExtraction {
  isTaskArtifact: boolean;
  markdown?: string;
  todos: AntigravityTodoItem[];
}

const MAX_TODOS = 80;
const MAX_TODO_CHARS = 320;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizePath(raw: string): string {
  return raw.replaceAll("\\", "/");
}

function isTaskArtifactPath(candidate: string, sessionId: string, hasArtifactMetadata: boolean): boolean {
  const normalized = normalizePath(candidate).trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (!lower.endsWith("/task.md") && lower !== "task.md") return false;
  const cleanSession = sessionId.trim().toLowerCase();
  if (cleanSession && lower.includes(`/${cleanSession}/task.md`)) return true;
  if (lower.includes("/brain/") && lower.endsWith("/task.md")) return true;
  return hasArtifactMetadata;
}

/**
 * Parse Markdown task list items from Antigravity's `task.md` artifact.
 * Supports `- [ ]` (pending), `- [/]` / `- [-]` / `- [~]` (in_progress),
 * and `- [x]` / `- [X]` (completed), while ignoring fenced code blocks.
 */
export function parseAntigravityTaskMarkdown(markdown: string): AntigravityTodoItem[] {
  const todos: AntigravityTodoItem[] = [];
  let inFence = false;
  let fenceChar = "";
  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const fence = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) { inFence = true; fenceChar = marker; }
      else if (fenceChar === marker) { inFence = false; fenceChar = ""; }
      continue;
    }
    if (inFence) continue;
    const match = rawLine.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX/~-])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const mark = match[1]!;
    const content = match[2]!.replace(/\s*<!--[\s\S]*?-->\s*/g, " ").trim().slice(0, MAX_TODO_CHARS);
    if (!content) continue;
    const status: AntigravityTodoStatus =
      mark === "x" || mark === "X" ? "completed"
        : mark === "/" || mark === "~" || mark === "-" ? "in_progress"
          : "pending";
    todos.push({ content, status });
    if (todos.length >= MAX_TODOS) break;
  }
  return todos;
}

/** Parse native ACP `plan` sessionUpdate entries if a future `agy` CLI emits them. */
export function parseAcpPlanEntries(entries: unknown): AntigravityTodoItem[] {
  if (!Array.isArray(entries)) return [];
  const todos: AntigravityTodoItem[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    const text = typeof entry?.content === "string" ? entry.content.trim() : typeof entry?.text === "string" ? entry.text.trim() : "";
    if (!text) continue;
    const rawStatus = typeof entry?.status === "string" ? entry.status.toLowerCase() : "pending";
    const status: AntigravityTodoStatus =
      rawStatus === "completed" || rawStatus === "done" ? "completed"
        : rawStatus === "in_progress" || rawStatus === "inprogress" || rawStatus === "running" ? "in_progress"
          : "pending";
    todos.push({ content: text.slice(0, MAX_TODO_CHARS), status });
    if (todos.length >= MAX_TODOS) break;
  }
  return todos;
}

/**
 * Inspect an ACP `tool_call` / `tool_call_update` payload for Antigravity's
 * internal `task.md` artifact updates (written via `write_file` / `edit_file`).
 */
export function extractAntigravityTaskPlan(
  update: Record<string, unknown>,
  sessionId: string,
  previousMarkdown?: string,
): AntigravityTaskPlanExtraction | undefined {
  const rawInput = asRecord(update.rawInput);
  const hasArtifactMetadata = Boolean(asRecord(rawInput?.ArtifactMetadata));
  const candidatePaths: string[] = [];
  let diffNewText: string | undefined;

  if (Array.isArray(update.content)) {
    for (const item of update.content) {
      const rec = asRecord(item);
      if (typeof rec?.path === "string") candidatePaths.push(rec.path);
      if (rec?.type === "diff" && typeof rec.newText === "string") diffNewText = rec.newText;
    }
  }
  if (typeof rawInput?.Path === "string") candidatePaths.push(rawInput.Path);
  if (typeof rawInput?.path === "string") candidatePaths.push(rawInput.path);
  if (typeof update.title === "string") candidatePaths.push(update.title);

  const isTaskArtifact = candidatePaths.some((candidate) => isTaskArtifactPath(candidate, sessionId, hasArtifactMetadata));
  if (!isTaskArtifact) return undefined;

  let markdown = diffNewText;
  if (markdown === undefined && typeof rawInput?.Content === "string") {
    markdown = rawInput.Content;
  }
  if (
    markdown === undefined &&
    previousMarkdown !== undefined &&
    typeof rawInput?.Target === "string" &&
    typeof rawInput?.Replacement === "string" &&
    rawInput.Target.length > 0 &&
    previousMarkdown.includes(rawInput.Target)
  ) {
    markdown = previousMarkdown.replaceAll(rawInput.Target, rawInput.Replacement);
  }
  const todos = markdown !== undefined ? parseAntigravityTaskMarkdown(markdown) : [];
  return { isTaskArtifact: true, ...(markdown !== undefined ? { markdown } : {}), todos };
}
