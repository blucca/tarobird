import { useEffect, useState } from "react";
import { Shuffle } from "lucide-react";
import { botMessageSteeringSnapshotSchema, supportsBotMessageSteerEngine, type BotMessageSteeringSnapshot } from "../../src/client-protocol/bot-message-delivery.js";
import type { Bot, HubConnection } from "./connection.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import "./bot-steering.css";

/** Receiving owner's switch (issue #62): may other Bots merge a message into
 * this Bot's live reply. Owner-only and shown only for engines that can steer
 * (Codex, Claude Code). An older Host without the route shows nothing. */
export function BotSteeringControl({ connection, bot, owner }: { connection: HubConnection; bot: Bot; owner: boolean }) {
  useLocale();
  const [snapshot, setSnapshot] = useState<BotMessageSteeringSnapshot>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [hidden, setHidden] = useState(false);
  const steerable = supportsBotMessageSteerEngine(bot.engine ?? "");
  const load = (signal?: AbortSignal) => connection.http(`/api/bot-messages/steering?botId=${encodeURIComponent(bot.id)}`, { signal })
    .then(raw => { if (!signal?.aborted) { setSnapshot(botMessageSteeringSnapshotSchema.parse(raw)); setError(undefined); } })
    .catch((cause: unknown) => {
      if (signal?.aborted) return;
      if (cause instanceof HubHttpError && cause.status === 404) setHidden(true);
      else setError(t("无法读取引导设置，连接恢复后重试。"));
    });
  useEffect(() => {
    setSnapshot(undefined); setError(undefined); setHidden(false);
    if (!owner || !steerable) return;
    const controller = new AbortController(); void load(controller.signal);
    return () => controller.abort();
  }, [connection, bot.id, owner, steerable]);
  if (!owner || !steerable || hidden || snapshot && !snapshot.supported) return null;
  const change = async (allowed: boolean) => {
    setBusy(true); setError(undefined);
    try { setSnapshot(await connection.saveBotMessageSteering({ botId: bot.id, allowed })); }
    catch { setError(t("未能确认设置结果，请重新读取后核对。不会自动重试保存。")); await load(); }
    finally { setBusy(false); }
  };
  const label = t("允许其他 Bot 引导这个 Bot");
  return <div className="bot-steering-setting">
    <label className="bot-steering-toggle"><Shuffle size={18} aria-hidden="true"/>
      <span><strong>{label}</strong><small>{t("其他 Bot 发来的补充可以并入正在进行的回复；关闭后一律排队。")}</small></span>
      <input type="checkbox" role="switch" aria-label={label} checked={snapshot?.allowed ?? true} disabled={!snapshot || busy} onChange={event => void change(event.target.checked)}/>
    </label>
    {error && <p role="alert" className="error-text">{error}</p>}
  </div>;
}
