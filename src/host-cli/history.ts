import { idSchema } from "../client-protocol/index.js";
import { CONVERSATION_HISTORY_CAPABILITY, historyAnchorPageSchema, historyChangeSchema, historyOperationSchema, historySnapshotSchema } from "../client-protocol/conversation-history.js";
import type { LocalHostClient } from "./client.js";

export async function runHistoryCommand(client: Pick<LocalHostClient, "request" | "supports">, command: string | undefined, conversationId: string | undefined,
  options: { bot?: string; anchor?: string; message?: string; cursor?: string; revision?: string; requestId?: string; title?: string; action?: string }) {
  if (!client.supports(CONVERSATION_HISTORY_CAPABILITY)) throw new Error("此主机尚不支持原生会话历史操作，请先更新主机。");
  const conversation = idSchema.parse(conversationId), botId = idSchema.parse(options.bot);
  const base = `/api/conversations/${conversation}/history`, botQuery = `botId=${botId}`;
  if (command === "snapshot") return historySnapshotSchema.parse(await client.request(`${base}?${botQuery}`));
  if (command === "anchors") return historyAnchorPageSchema.parse(await client.request(`${base}/anchors?${botQuery}${options.message ? `&messageId=${idSchema.parse(options.message)}` : ""}${options.cursor ? `&cursor=${idSchema.parse(options.cursor)}` : ""}`));
  if (command === "status") return historyOperationSchema.parse(await client.request(`${base}/operations/${idSchema.parse(options.requestId)}?${botQuery}`));
  const kind = command === "reconcile" ? options.action : command;
  if (kind !== "rewind" && kind !== "fork") throw new Error("history 支持 snapshot、anchors、rewind、fork、status、reconcile；reconcile 需要原 --action rewind|fork。");
  if (!options.revision || !options.requestId) throw new Error("历史操作需要 --revision 和 --request-id；结果未知时保留原参数，用 history status 查询或 history reconcile 核对，不要换编号重试。");
  const action = kind === "rewind" ? { kind: "rewind", anchorId: idSchema.parse(options.anchor) }
    : options.anchor ? { kind: "fork", scope: "anchor", anchorId: idSchema.parse(options.anchor), title: options.title }
      : { kind: "fork", scope: "whole", title: options.title };
  const input = historyChangeSchema.parse({ botId, requestId: options.requestId, expectedRevision: options.revision, action });
  return historyOperationSchema.parse(await client.request(command === "reconcile" ? `${base}/operations/${input.requestId}/reconcile` : `${base}/operations`, "POST", input));
}
