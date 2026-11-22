import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { contextUsageSchema, type ContextUsage } from "../client-protocol/context-usage.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import type { CoreBridgeLike } from "../core/types.js";
import type { GatewayChannel } from "./channel.js";

/** The engine's own context accounting for one conversation. Reading it never
 * creates or resumes a session and never asks the model anything. */
export function gatewayContextUsage(bridge: CoreBridgeLike, channel: Pick<GatewayChannel, "canSteerConversation">) {
  return async (raw: unknown): Promise<ContextUsage> => {
    const { conversationId } = z.object({ conversationId: idSchema }).strict().parse(raw);
    if (!bridge.getContextUsage) return { supported: false };
    // A conversation whose native session binding is not applied here has no session of its own to report.
    if (!await channel.canSteerConversation?.(conversationId)) return { supported: true };
    const conversationKey = buildCoreConversationKey(conversationId);
    let usage: Awaited<ReturnType<NonNullable<CoreBridgeLike["getContextUsage"]>>>;
    try {
      usage = await bridge.getContextUsage({ chatId: stableCoreNumericId(conversationKey), conversationKey });
    } catch {
      // The adapter of this runtime has no source; that is not an error for the caller.
      return { supported: false };
    }
    const count = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
    const used = count(usage?.projectedTokens ?? usage?.pressureTokens), window = count(usage?.contextWindow), compact = count(usage?.autoCompactTokens);
    // The binding may have moved to another session while the engine was answering.
    if (used === undefined || !window || !await channel.canSteerConversation?.(conversationId)) return { supported: true };
    return contextUsageSchema.parse({ supported: true, usedTokens: used, windowTokens: window, ...(compact && compact < window ? { autoCompactTokens: compact } : {}) });
  };
}
