import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveBotTarget } from "../client-protocol/bot-messages.js";
import { networkCanonical } from "../client-protocol/private-network.js";
import { z } from "zod";
import {
  DISPATCH_ENGINES, dispatchEngineSchema, dispatchCapabilitiesRequestSchema, dispatcherSettingsSchema,
  crossHostDispatchGrantCommandSchema, dispatchSplitPlanRequestSchema, ticketBulkActionSchema,
  type DispatcherSettings,
} from "../client-protocol/dispatch.js";
import { requestTicketAssistanceSchema } from "../client-protocol/dispatch-assistance.js";
import { instanceEndpoint } from "./bot-messages.js";
import { HostCliError, LocalHostClient } from "./client.js";

export type TicketOptions = { bot?: string; engine?: string; title?: string; text?: string; "text-file"?: string; model?: string; effort?: string; force?: boolean; status?: string; note?: string;
  open?: boolean; match?: string; offset?: string; assist?: string; "request-id"?: string; "context-message"?: string; "dispatch-mode"?: string; "max-concurrent"?: string; allow?: string; revision?: string;
  host?: string; total?: string; "per-node"?: string; create?: boolean; dispatch?: boolean; action?: string; batch?: string; from?: string; allowed?: string };
const OWNER_ONLY = ["pause", "resume", "cancel", "accept", "remove", "engine-reset", "settings", "bulk-action", "allow-remote", "revoke-remote", "load", "remote-grants"];
function contextError(missing: boolean, status?: number): HostCliError {
  const error = new HostCliError("dispatch_context_not_active", status);
  error.message += missing
    ? ": 缺少当前轮次的消息标识，本次工单操作未发送。请从本轮指引取得 --context-message ID 后重试；持久会话不保证更新环境变量。"
    : ": 主机拒绝了本次工单操作：消息上下文未生效、已过期或不属于当前 Bot。请核对本轮指引的 --context-message ID；若本轮 ID 仍被拒绝，报告具体阻塞。";
  error.message += " 这不是工单接口未启用。不要猜测消息 ID、改用主人身份或移除 Bot 环境变量；不要直接启动引擎 CLI 绕过工单。已有操作编号须保留，结果不确定时先读取工单核对。";
  return error;
}
const required = (value: string | undefined, message: string) => { if (!value) throw new Error(message); return value; };
async function textOf(options: TicketOptions, name = "--text"): Promise<string | undefined> {
  if (options.text !== undefined && options["text-file"] !== undefined) throw new Error(`${name} 与 --text-file 只能选一个。`);
  return options["text-file"] !== undefined ? (await readFile(path.resolve(options["text-file"]), "utf8")).trim() : options.text;
}
/** "codex,claude" → engines; "all" → every installed engine CLI. */
export function allowedEnginesOption(value: string | undefined): DispatcherSettings["allowedEngines"] | "all" | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "all") return "all";
  return z.array(dispatchEngineSchema).min(1).parse(value.split(",").map(item => item.trim()).filter(Boolean));
}

/** `tarobot tickets …`. Inside a dispatcher Bot's turn this uses the Bot's own
 * identity and the turn context; otherwise it is the local owner controller. */
export async function runTicketsCommand(directory: string, sub: string | undefined, argument: string | undefined, options: TicketOptions, receipt: (id: string) => void): Promise<unknown> {
  const commands = ["list", "show", "targets", "nodes", "plan", "capabilities", "create", "dispatch", "update", "assist", "assist-status", "assists", "engines", ...OWNER_ONLY];
  if (!sub || !commands.includes(sub)) throw new Error(`请使用 tickets ${commands.join("|")}。`);
  const capabilityQuery = sub === "capabilities" ? dispatchCapabilitiesRequestSchema.parse({ engine: required(options.engine, "缺少 --engine。"), ...(options.match !== undefined ? { match: options.match } : {}), ...(options.offset !== undefined ? { offset: Number(options.offset) } : {}) }) : undefined;
  const botId = process.env.TAROBOT_ACTIVE_INSTANCE ?? process.env.TAROBOT_INSTANCE;
  if (botId) {
    if (OWNER_ONLY.includes(sub)) throw new Error(`tickets ${sub} 只能由主人在本机 CLI 或 App 中执行。`);
    if (options.bot && options.bot !== botId) throw new Error("调度 Bot 只能管理自己的工单；不要传 --bot。");
    const contextMessage = options["context-message"] ?? process.env.TAROBOT_MESSAGE_ID;
    if ((["create", "dispatch", "update", "assist", "assist-status"].includes(sub) || (sub === "plan" && (options.create || options.dispatch))) && !contextMessage) throw contextError(true);
    const endpoint = await instanceEndpoint(directory, botId);
    const call = async (operation: string, data: Record<string, unknown> = {}) => {
      try { return await endpoint.post("/api/instance/tickets", { operation, ...(contextMessage ? { contextMessage } : {}), data }); }
      catch (error) {
        if (error instanceof HostCliError && error.code === "dispatch_context_not_active" && error.status === 403) throw contextError(false, error.status);
        throw error;
      }
    };
    if (sub === "list") return call("list", options.open ? { open: true } : {});
    if (sub === "engines") return { engines: (await call("list", { open: true })).engines };
    if (sub === "show") return call("show", { ticketId: required(argument, "缺少工单 ID。") });
    if (sub === "targets") return call("targets");
    if (sub === "nodes") return call("nodes");
    if (sub === "assist-status") return call("assist-status");
    if (sub === "assists") return call("assists", { ticketId: required(argument, "缺少工单 ID。") });
    if (capabilityQuery) return call("capabilities", capabilityQuery);
    return call(sub, await mutation(sub, argument, options, receipt));
  }
  if (sub === "assist" || sub === "assist-status") throw new Error(`tickets ${sub} 只供正在执行工单的 Worker 使用；请从幕僚长对话安排任务，或用 tickets assists 工单ID 查看协助记录。`);
  const client = await LocalHostClient.connect(directory);
  try {
    if (sub === "load") return client.request("/api/dispatch/load");
    if (sub === "remote-grants") return client.request("/api/dispatch/cross-host-grants");
    if (sub === "allow-remote" || sub === "revoke-remote") {
      const command = crossHostDispatchGrantCommandSchema.parse({
        operation: "cross-host-dispatch-grant",
        sourceHost: required(options.from, "缺少 --from（远端主机 ID，如 hub_...）。"),
        sourceBot: required(options.bot, "缺少 --bot（远端幕僚长 Bot ID）。"),
        allowed: sub === "allow-remote",
      });
      const proof = await client.deviceAction({ operation: "bot-message-grant", target: createHash("sha256").update(networkCanonical(command)).digest("hex") });
      return client.request("/api/dispatch/cross-host-grants", "POST", { command, proof });
    }
    const dispatchers = client.ready.bots.filter(bot => bot.role === "dispatcher" && !bot.deletedAt);
    const dispatcher = () => {
      if (options.bot) return resolveBotTarget(options.bot, dispatchers, "dispatcher");
      if (dispatchers.length === 1) return dispatchers[0]!;
      throw new Error(dispatchers.length ? "有多个调度 Bot，请用 --bot 指定。" : "本机还没有调度 Bot。创建时使用 bots create --role dispatcher。");
    };
    const ticketRoute = (id: string) => `/api/tickets/${encodeURIComponent(id)}`;
    if (sub === "engines") return { engines: (await client.request<{ engines: unknown[] }>(`/api/bots/${dispatcher().id}/tickets?open=1`)).engines };
    if (sub === "engine-reset") {
      const engine = required(argument, `缺少引擎名称：${DISPATCH_ENGINES.join("|")}。`);
      return { engines: await client.request(`/api/dispatch/engines/${encodeURIComponent(engine)}/reset`, "POST", {}) };
    }
    if (sub === "list") return client.request(`/api/bots/${dispatcher().id}/tickets${options.open ? "?open=1" : ""}`);
    if (sub === "show") return client.request(ticketRoute(required(argument, "缺少工单 ID。")));
    if (sub === "assists") return client.request(`${ticketRoute(required(argument, "缺少工单 ID。"))}/assists`);
    if (sub === "targets") return client.request(`/api/bots/${dispatcher().id}/dispatch-targets`);
    if (sub === "nodes") return client.request(`/api/bots/${dispatcher().id}/dispatch-nodes`);
    if (capabilityQuery) {
      const query = new URLSearchParams({ engine: capabilityQuery.engine, offset: String(capabilityQuery.offset), ...(capabilityQuery.match !== undefined ? { match: capabilityQuery.match } : {}) });
      return client.request(`/api/bots/${dispatcher().id}/dispatch-capabilities?${query}`);
    }
    if (sub === "bulk-action") {
      const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
      const body = ticketBulkActionSchema.parse({
        requestId,
        action: required(options.action, "缺少 --action（pause|resume|cancel）。"),
        ...(options.host !== undefined ? { hostId: options.host } : {}),
        ...(options.batch !== undefined ? { batchId: options.batch } : {}),
      });
      return client.request(`/api/bots/${dispatcher().id}/tickets/bulk-action`, "POST", body);
    }
    if (["pause", "resume", "cancel", "accept", "remove"].includes(sub)) {
      const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
      return client.request(`${ticketRoute(required(argument, "缺少工单 ID。"))}/action`, "POST", { requestId, action: sub });
    }
    if (sub === "settings") {
      const id = dispatcher().id, current = await client.request<{ settings: DispatcherSettings; revision: string }>(`/api/bots/${id}/dispatcher`);
      const allow = allowedEnginesOption(options.allow);
      if (options.host !== undefined) {
        const hostId = options.host.trim();
        const enabledVal = options.allowed === undefined ? undefined
          : ["1", "true", "on", "yes"].includes(options.allowed.trim().toLowerCase()) ? true
            : ["0", "false", "off", "no"].includes(options.allowed.trim().toLowerCase()) ? false
              : (() => { throw new Error("--allowed 仅支持 on|off|true|false。"); })();
        if (enabledVal === undefined && options["max-concurrent"] === undefined && allow === undefined) return current;
        const existingNodes = current.settings.nodes ?? [];
        const prev = existingNodes.find(node => node.hostId === hostId) ?? {
          hostId,
          enabled: true,
          maxConcurrent: current.settings.maxConcurrent,
          preference: "normal" as const,
        };
        const { allowedEngines: _prevAllow, ...prevRest } = prev;
        const nextNode = {
          ...(allow === "all" ? prevRest : prev),
          ...(Array.isArray(allow) ? { allowedEngines: allow } : {}),
          ...(enabledVal !== undefined ? { enabled: enabledVal } : {}),
          ...(options["max-concurrent"] !== undefined ? { maxConcurrent: Number(options["max-concurrent"]) } : {}),
        };
        const settings = dispatcherSettingsSchema.parse({
          ...current.settings,
          nodes: [...existingNodes.filter(node => node.hostId !== hostId), nextNode],
        });
        return client.request(`/api/bots/${id}/dispatcher`, "PUT", { settings, expectedRevision: options.revision ?? current.revision });
      }
      if (options["dispatch-mode"] === undefined && options["max-concurrent"] === undefined && allow === undefined) return current;
      const { allowedEngines: _all, ...rest } = current.settings;
      const settings = dispatcherSettingsSchema.parse({ ...(allow === "all" ? rest : current.settings), ...(Array.isArray(allow) ? { allowedEngines: allow } : {}),
        ...(options["dispatch-mode"] !== undefined ? { mode: options["dispatch-mode"] } : {}), ...(options["max-concurrent"] !== undefined ? { maxConcurrent: Number(options["max-concurrent"]) } : {}) });
      return client.request(`/api/bots/${id}/dispatcher`, "PUT", { settings, expectedRevision: options.revision ?? current.revision });
    }
    const id = dispatcher().id;
    const body = await mutation(sub, argument, options, receipt);
    return client.request(`/api/bots/${id}/tickets${sub === "create" ? "" : `/${sub}`}`, "POST", body);
  } finally { client.close(); }
}

async function mutation(sub: string, argument: string | undefined, options: TicketOptions, receipt: (id: string) => void): Promise<Record<string, unknown>> {
  if (sub === "assist") {
    if (argument || options.force || options.status || options.title || options.assist !== undefined) throw new Error("tickets assist 不接受工单 ID、--force、--status、--title 或 --assist；主机自动绑定当前工单。");
    const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
    return requestTicketAssistanceSchema.parse({ requestId,
      engine: required(options.engine, "缺少 --engine。"), text: required(await textOf(options), "缺少 --text 或 --text-file（协助内容）。"),
      note: required(options.note, "缺少 --note（请求协助的原因）。"),
      ...(options.model !== undefined ? { model: options.model } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}),
    });
  }
  if (sub === "create") {
    const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
    return { requestId, title: required(options.title, "缺少 --title。"), request: required(await textOf(options), "缺少 --text 或 --text-file（工单要求）。") };
  }
  if (sub === "plan") {
    const requestId = options["request-id"] ?? randomUUID();
    if (options.create || options.dispatch) receipt(requestId);
    const request = required(await textOf(options), "缺少 --text 或 --text-file（待拆分任务要求）。");
    const hostIds = options.host !== undefined ? options.host.split(",").map(item => item.trim()).filter(Boolean) : undefined;
    return dispatchSplitPlanRequestSchema.parse({
      requestId,
      request,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.engine !== undefined ? { engine: dispatchEngineSchema.parse(options.engine) } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.total !== undefined ? { totalItems: Number(options.total) } : {}),
      ...(options["per-node"] !== undefined ? { perNode: Number(options["per-node"]) } : {}),
      ...(hostIds?.length ? { hostIds } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.create ? { create: true } : {}),
      ...(options.dispatch ? { dispatch: true } : {}),
    });
  }
  if (sub === "dispatch") {
    const requestId = options["request-id"] ?? randomUUID(); receipt(requestId);
    const text = await textOf(options);
    return { requestId, ticketId: required(argument, "缺少工单 ID。"), engine: dispatchEngineSchema.parse(required(options.engine, `缺少 --engine（${DISPATCH_ENGINES.join("|")}）。`)),
      ...(options.host !== undefined ? { hostId: options.host } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}), ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(text ? { text } : {}), ...(options.force ? { force: true } : {}),
      ...(options.assist !== undefined ? { assist: z.number().int().min(0).max(2).parse(Number(options.assist)) } : {}) };
  }
  if (options.status === undefined && options.note === undefined) throw new Error("tickets update 需要 --status 或 --note。");
  return { ticketId: required(argument, "缺少工单 ID。"), ...(options.status !== undefined ? { status: options.status } : {}), ...(options.note !== undefined ? { note: options.note } : {}) };
}
