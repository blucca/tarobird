import { z } from "zod";

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Advertised in `ready.serverCapabilities` by Hubs that expose live
 * conversation Bot-to-Bot and Agent Bus communication traces. */
export const CONVERSATION_BOT_COMMS_CAPABILITY = "conversations.bot-comms.v1";

export const botCommKindSchema = z.enum(["outgoing_bot_message", "incoming_bot_message", "agent_bus_stage"]);
export const botCommDirectionSchema = z.enum(["outgoing", "incoming"]);
export const botCommStatusSchema = z.enum(["queued", "running", "steered", "needs_approval", "replied", "failed", "cancelled", "uncertain"]);
export const botCommDeliverySchema = z.enum(["queued", "steered", "fell_back_to_queue", "not_delivered", "steer_uncertain", "pending"]);

export const botCommPendingApprovalSchema = z.object({
  messageId: idSchema,
  title: z.string().max(160).optional(),
  detail: z.string().max(320).optional(),
}).strict();

export const botCommItemSchema = z.object({
  id: z.string().min(1).max(160),
  kind: botCommKindSchema,
  direction: botCommDirectionSchema,
  requestId: z.string().max(128).optional(),
  sourceHostId: z.string().max(128).optional(),
  sourceHostName: z.string().max(128),
  sourceBotId: z.string().max(128).optional(),
  sourceBotName: z.string().max(128),
  targetHostId: z.string().max(128).optional(),
  targetHostName: z.string().max(128),
  targetBotId: z.string().max(128).optional(),
  targetBotName: z.string().max(128),
  crossHost: z.boolean(),
  status: botCommStatusSchema,
  delivery: botCommDeliverySchema.optional(),
  deliveryReason: z.string().max(64).optional(),
  targetConversationId: idSchema.optional(),
  targetConversationTitle: z.string().max(256).optional(),
  targetMessageId: idSchema.optional(),
  canJumpToTarget: z.boolean(),
  hops: z.number().int().min(1).max(10).optional(),
  sentExcerpt: z.string().max(400).optional(),
  replyExcerpt: z.string().max(600).optional(),
  pendingApproval: botCommPendingApprovalSchema.optional(),
  workspaceName: z.string().max(160).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  finishedAt: z.number().optional(),
}).strict();

/** The Host returns this many items at most, newest first; the App says so when the list is full. */
export const BOT_COMMS_LIMIT = 60;

export const conversationBotCommsSchema = z.object({
  conversationId: idSchema,
  items: z.array(botCommItemSchema).max(BOT_COMMS_LIMIT),
  summary: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    needsApproval: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export type BotCommKind = z.infer<typeof botCommKindSchema>;
export type BotCommDirection = z.infer<typeof botCommDirectionSchema>;
export type BotCommStatus = z.infer<typeof botCommStatusSchema>;
export type BotCommDelivery = z.infer<typeof botCommDeliverySchema>;
export type BotCommPendingApproval = z.infer<typeof botCommPendingApprovalSchema>;
export type BotCommItem = z.infer<typeof botCommItemSchema>;
export type ConversationBotComms = z.infer<typeof conversationBotCommsSchema>;
