import { useEffect, useState, useSyncExternalStore } from "react";
import { FileDiff } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import { runChangesSchema, type RunChanges } from "../../src/client-protocol/run-changes.js";
import type { HubConnection } from "./connection.js";
import { DiffViewerTrigger, recordedRunChanges } from "./DiffViewerTrigger.js";
import { readRunEvidence } from "./run-changes-read.js";
import { t } from "./i18n.js";

/** A narrow rail: three names say what a turn touched; the rest is a count. */
const NAMED = 3;
const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function Counts({ value }: { value: { additions: number | null; deletions: number | null } }) {
  return <span className="workspace-diff-counts"><span>+{value.additions ?? "—"}</span><span>−{value.deletions ?? "—"}</span></span>;
}

/** One reply's recorded changes in the workspace rail: its files by name, each with what was added and removed.
 *  The names are the Hub's record of that run. Until they arrive, or when they cannot be read (offline, an older
 *  Host), the totals saved on the reply stand in. Opening it shows the same recorded changes as the reply does. */
export function WorkspaceRunChanges({ connection, message }: { connection: HubConnection; message: Message }) {
  const state = useSyncExternalStore(cb => connection.subscribe(cb), () => connection.state);
  const { run, summary, partial } = recordedRunChanges(message);
  const [files, setFiles] = useState<RunChanges["items"]>();
  const runId = run?.id, revision = run?.revision, messageId = message.id, conversationId = message.conversationId, botId = message.authorId;
  const readable = !!summary && state.status === "online" && state.runChangesAvailable === true;
  useEffect(() => {
    setFiles(undefined);
    if (!runId || !readable) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ conversationId, botId, runId });
    void readRunEvidence(connection, `/api/messages/${encodeURIComponent(messageId)}/changes?${query}`, controller.signal).then(raw => {
      const value = runChangesSchema.parse(raw);
      if (controller.signal.aborted || value.messageId !== messageId || value.runId !== runId || value.state !== "recorded" || !value.items.length) return;
      setFiles(value.items);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [connection, messageId, conversationId, botId, runId, revision, readable]);
  if (!summary) return null;
  const named = files?.slice(0, NAMED), more = named ? Math.max(summary.files, files!.length) - named.length : 0;
  const note = [more > 0 ? t("还有 {0} 个文件", more) : "", partial ? t("部分记录") : ""].filter(Boolean).join(" · ");
  return <div className="workspace-diff-row"><DiffViewerTrigger connection={connection} message={message}>
    <span className="workspace-diff-files">
      {named ? named.map(file => <span key={file.key} className="workspace-diff-file"><FileDiff size={14} aria-hidden="true"/><span className="workspace-diff-name" title={file.path}>{fileName(file.path)}</span><Counts value={file}/></span>)
        : <span className="workspace-diff-file"><FileDiff size={14} aria-hidden="true"/><span className="workspace-diff-name">{t("改动 {0} 个文件", summary.files)}</span><Counts value={summary}/></span>}
      {note && <span className="workspace-diff-note">{note}</span>}
    </span>
  </DiffViewerTrigger></div>;
}
