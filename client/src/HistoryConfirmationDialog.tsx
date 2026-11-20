import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { Conversation, Message } from "../../src/client-protocol/index.js";
import type { HistoryOperation, HistoryStatus } from "../../src/client-protocol/history.js";
import type { HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { CreationDialog } from "./CreationDialog.js";
import { ExplanationList } from "./ExplanationList.js";
import { ReferencePreview } from "./BotReferences.js";
import { messageExcerpt } from "./MessageReference.js";
import { computeRewindSummary, historyErrorKey } from "./conversation-history.js";
import { t, useLocale } from "./i18n.js";

export type HistoryConfirmationRequest =
  | { kind: "rewind"; message: Message }
  | { kind: "fork"; mode: "turn"; message: Message }
  | { kind: "fork"; mode: "head" };

type Phase = "idle" | "submitting" | "polling" | "disconnected" | "unknown";

const POLL_INTERVAL_MS = 2_000;
const newHistoryRequestId = () => `hreq_${crypto.randomUUID().replaceAll("-", "")}`;

export function HistoryConfirmationDialog({
  connection,
  conversation,
  botId,
  messages,
  status,
  request,
  returnFocus,
  close,
  onRewound,
  onForked,
}: {
  connection: HubConnection;
  conversation: Conversation;
  botId: string;
  messages: readonly Message[];
  status?: HistoryStatus;
  request: HistoryConfirmationRequest;
  returnFocus?: RefObject<HTMLElement | null>;
  close: () => void;
  onRewound: (operation: HistoryOperation) => void;
  onForked: (conversationId: string, operation: HistoryOperation) => void;
}) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const online = state.status === "online" && !connection.isReadOnly;

  // Capture expectedLastMessageId at confirmation open (§4.1 / §7.2). Only
  // refresh it after an explicit `history_changed` receipt so concurrent
  // arrivals while this dialog is open ask the user to confirm once more.
  const latestVisibleId = useMemo(
    () => messages.filter(m => m.status !== "deleted").at(-1)?.id ?? "",
    [messages],
  );
  const [expectedLastMessageId, setExpectedLastMessageId] = useState(latestVisibleId);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [summaryVersion, setSummaryVersion] = useState(0);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const aliveRef = useRef(true);
  const requestIdRef = useRef<string | undefined>(undefined);
  const expectedRef = useRef(expectedLastMessageId);
  expectedRef.current = expectedLastMessageId;
  const latestVisibleRef = useRef(latestVisibleId);
  latestVisibleRef.current = latestVisibleId;
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollInflightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimeout(pollTimerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // Rewind summary reflects the snapshot when opened and recalculates on `history_changed`.
  const rewindSummary = useMemo(() => {
    if (request.kind !== "rewind") return undefined;
    return computeRewindSummary(messages, request.message.id, status, conversation.history?.rewinds);
    // Intentionally pinned to snapshot + `summaryVersion` updates so the number
    // stays stable until the user is explicitly notified of `history_changed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.kind === "rewind" ? request.message.id : "", summaryVersion, status?.sinceMessageId]);

  const waitForCachedCompletion = useCallback(async (op: HistoryOperation) => {
    const deadline = Date.now() + 4_000;
    while (aliveRef.current && Date.now() < deadline) {
      if (op.kind === "fork" && op.conversationId) {
        const created = await connection.cache.conversation(op.conversationId).catch(() => undefined);
        if (created) return;
      } else if (op.kind === "rewind" && op.rewind) {
        const updated = await connection.cache.conversation(conversation.id).catch(() => undefined);
        if (updated?.history?.rewinds?.some(range => range.id === op.rewind!.id)) return;
      } else {
        return;
      }
      if (connection.state.status !== "online") return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  }, [connection, conversation.id]);

  const schedulePollRef = useRef<() => void>(() => {});

  const handleReceipt = useCallback(async (op: HistoryOperation) => {
    if (!aliveRef.current) return;
    if (op.state === "completed") {
      clearTimeout(pollTimerRef.current);
      await waitForCachedCompletion(op);
      if (!aliveRef.current) return;
      requestIdRef.current = undefined;
      if (op.kind === "rewind") {
        onRewound(op);
      } else if (op.conversationId) {
        onForked(op.conversationId, op);
      } else {
        setPhase("idle");
        setError(t("操作失败，请重试。"));
      }
      return;
    }
    if (op.state === "failed") {
      clearTimeout(pollTimerRef.current);
      // Terminal failure: next attempt starts a new operation with a new requestId (§4.1).
      requestIdRef.current = undefined;
      setPhase("idle");
      setNotice("");
      if (op.error === "already_rewound") {
        close();
        return;
      }
      if (op.error === "history_changed") {
        setExpectedLastMessageId(latestVisibleRef.current);
        setSummaryVersion(v => v + 1);
        setError(t("对话有新消息，请再确认一次。"));
        return;
      }
      setError(op.error ? t(historyErrorKey(op.error)) : t("操作失败，请重试。"));
      return;
    }
    if (op.state === "unknown") {
      clearTimeout(pollTimerRef.current);
      // Keep the SAME requestId so clicking Retry resumes this exact operation (§4.1 / §4.4).
      setPhase("unknown");
      setNotice("");
      setError(t("未确认操作结果，请点击重试核对。"));
      return;
    }
    // `started`: keep busy and poll every 2s + on conversation.updated (§4.1 / §4.4).
    setPhase("polling");
    setError("");
    setNotice("");
    schedulePollRef.current();
  }, [waitForCachedCompletion, onRewound, onForked, close]);

  const sendPost = useCallback(async (requestId: string): Promise<HistoryOperation> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (request.kind === "rewind") {
      return connection.historyRewind(conversation.id, {
        botId,
        requestId,
        beforeMessageId: request.message.id,
        expectedLastMessageId: expectedRef.current,
      }, controller.signal);
    }
    return connection.historyFork(conversation.id, {
      botId,
      requestId,
      ...(request.mode === "turn" ? { throughMessageId: request.message.id } : {}),
      expectedLastMessageId: expectedRef.current,
    }, controller.signal);
  }, [connection, conversation.id, botId, request]);

  const isBrowserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

  const pollOnce = useCallback(async (allowResendOnNotFound = false) => {
    const requestId = requestIdRef.current;
    if (!aliveRef.current || !requestId || pollInflightRef.current) return;
    if (connection.state.status !== "online" || connection.isReadOnly || !isBrowserOnline()) {
      setPhase("disconnected");
      setError("");
      setNotice(t("连接已断开，恢复后将自动继续…"));
      return;
    }
    pollInflightRef.current = true;
    try {
      const op = await connection.historyOperation(conversation.id, requestId);
      if (!aliveRef.current) return;
      await handleReceipt(op);
    } catch (cause) {
      if (!aliveRef.current) return;
      if (cause instanceof HubHttpError && cause.status === 404 && allowResendOnNotFound) {
        // The earlier POST never reached the Hub before the network dropped.
        // Re-submit with the exact same requestId.
        setPhase("submitting");
        setError("");
        setNotice("");
        try {
          const op = await sendPost(requestId);
          if (!aliveRef.current) return;
          await handleReceipt(op);
        } catch (retryCause) {
          if (!aliveRef.current) return;
          if (connection.state.status !== "online" || !isBrowserOnline()) {
            setPhase("disconnected");
            setNotice(t("连接已断开，恢复后将自动继续…"));
          } else {
            setPhase("unknown");
            setNotice("");
            setError(retryCause instanceof HubHttpError && retryCause.status >= 400 && retryCause.status < 500
              ? t("操作未能完成，请重试。")
              : t("未确认操作结果，请点击重试核对。"));
          }
        }
        return;
      }
      if (connection.state.status !== "online" || !isBrowserOnline()) {
        setPhase("disconnected");
        setError("");
        setNotice(t("连接已断开，恢复后将自动继续…"));
      } else if (phaseRef.current === "polling") {
        schedulePollRef.current();
      } else {
        setPhase("unknown");
        setNotice("");
        setError(t("未确认操作结果，请点击重试核对。"));
      }
    } finally {
      pollInflightRef.current = false;
    }
  }, [connection, conversation.id, handleReceipt, sendPost]);

  schedulePollRef.current = () => {
    clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      if (aliveRef.current && phaseRef.current === "polling") void pollOnce(false);
    }, POLL_INTERVAL_MS);
  };

  // Wake polling immediately on `conversation.updated` for this conversation (§4.1).
  useEffect(() => {
    return connection.subscribeHistoryInvalidation(targetId => {
      if (!aliveRef.current || !requestIdRef.current) return;
      if (targetId && targetId !== conversation.id) return;
      if (phaseRef.current === "polling") {
        clearTimeout(pollTimerRef.current);
        void pollOnce(false);
      }
    });
  }, [connection, conversation.id, pollOnce]);

  // Recover automatically with the SAME requestId when connectivity returns (§4.1 / §5.2 / §7.2).
  useEffect(() => {
    const resume = () => {
      if (!aliveRef.current || !requestIdRef.current || connection.state.status !== "online" || connection.isReadOnly || !isBrowserOnline()) return;
      if (phaseRef.current === "disconnected" || phaseRef.current === "polling") {
        clearTimeout(pollTimerRef.current);
        void pollOnce(phaseRef.current === "disconnected");
      }
    };
    if (online && requestIdRef.current && (phase === "disconnected" || phase === "polling")) resume();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, [online, phase, connection, pollOnce]);

  const submit = async () => {
    if (phase === "submitting" || phase === "polling") return;
    if (!expectedRef.current) {
      setError(t("请先和 Bot 聊一轮后再操作。"));
      return;
    }
    if (!online || !isBrowserOnline()) {
      if (requestIdRef.current) {
        setPhase("disconnected");
        setError("");
        setNotice(t("连接已断开，恢复后将自动继续…"));
      } else {
        setError(t("连接恢复后即可操作"));
      }
      return;
    }
    // Reuse requestId when retrying an unconfirmed/unknown operation; mint a
    // fresh one only for a brand new attempt or after a terminal `failed`.
    const requestId = requestIdRef.current ?? newHistoryRequestId();
    requestIdRef.current = requestId;
    setPhase("submitting");
    setError("");
    setNotice("");
    try {
      const op = await sendPost(requestId);
      if (!aliveRef.current) return;
      await handleReceipt(op);
    } catch (cause) {
      if (!aliveRef.current) return;
      if (cause instanceof HubHttpError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        requestIdRef.current = undefined;
        setPhase("idle");
        setError(
          cause.status === 403 ? t("当前账号没有执行此操作的权限。")
            : cause.code === "history_unavailable" ? t("当前引擎或对话不支持此操作，请检查主机版本。")
              : cause.code === "idempotency_conflict" ? t("操作参数已变化，请重试。")
                : t("操作失败，请重试。"),
        );
        return;
      }
      // Network loss, abort, 502/503/504, or timeout: keep the SAME requestId!
      if (connection.state.status !== "online" || !isBrowserOnline()) {
        setPhase("disconnected");
        setError("");
        setNotice(t("连接已断开，恢复后将自动继续…"));
        return;
      }
      // Online but HTTP response dropped: check whether the Hub already recorded this requestId.
      await pollOnce(false);
    }
  };

  const busy = phase === "submitting" || phase === "polling" || phase === "disconnected";
  const isRewind = request.kind === "rewind";
  const title = isRewind
    ? t("回退到这条消息之前")
    : request.mode === "turn"
      ? t("从这一轮分叉")
      : t("分叉当前对话");
  const closeLabel = isRewind ? t("关闭回退确认") : t("关闭分叉确认");
  const subject = isRewind || request.mode === "turn"
    ? <ReferencePreview text={messageExcerpt(request.message)}/>
    : conversation.title;
  const lead = isRewind
    ? rewindSummary?.isFirstInContext
      ? t("这条消息之前没有更早的上下文，回退后 Bot 从新的上下文开始。")
      : t("这条消息和它之后的 {0} 条消息将离开 Bot 的上下文。下一条消息从它之前接着聊。", rewindSummary?.laterCount ?? 0)
    : request.mode === "turn"
      ? t("新建一个对话，带上截至这一轮（含 Bot 的回复）的上下文。原对话不受影响。")
      : t("新建一个对话，带上当前的全部上下文。原对话不受影响。");

  const items = isRewind
    ? [
        { label: t("文件改动"), description: t("不会撤销。Bot 已经写入、修改或删除的文件保持现状。") },
        { label: t("聊天记录"), description: t("仍然保留，标记为「已回退」。") },
        { label: t("无法撤销"), description: t("回退后不能把这些消息放回上下文。") },
      ]
    : [
        { label: t("文件"), description: t("两个对话共用同一个工作目录。文件不会复制，也不会回到当时的状态。") },
        { label: t("聊天记录"), description: t("留在原对话，新对话顶部会标注来源。") },
        { label: t("不带过去"), description: t("排队消息、目标、旁路对话。") },
      ];

  const actionLabel = busy
    ? isRewind ? t("正在回退…") : t("正在分叉…")
    : phase === "unknown"
      ? t("重试")
      : isRewind ? t("回退") : t("分叉");

  return (
    <CreationDialog
      title={title}
      className="confirmation-dialog history-confirmation-dialog"
      closeLabel={closeLabel}
      close={close}
      busy={busy}
      returnFocus={returnFocus}
      initialFocus={cancelRef}
    >
      <h3 className="confirmation-subject">{subject}</h3>
      <p className="confirmation-lead">{lead}</p>
      <ExplanationList items={items}/>
      {!online && !busy && <p className="muted" role="status">{t("连接恢复后即可操作")}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="confirmation-actions">
        <button ref={cancelRef} type="button" disabled={busy} onClick={close}>{t("取消")}</button>
        <button
          type="button"
          className={isRewind ? "text-danger" : "primary"}
          disabled={busy || (!online && phase !== "unknown")}
          onClick={() => { void submit(); }}
        >
          {actionLabel}
        </button>
      </div>
    </CreationDialog>
  );
}
