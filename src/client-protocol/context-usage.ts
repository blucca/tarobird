import { z } from "zod";

/** Advertised by a Bot worker that answers `context.usage`, and by a Host that serves
 * `GET /api/conversations/:id/context-usage`. Older peers simply have no reading. */
export const CONTEXT_USAGE_CAPABILITY = "conversations.context-usage.v1";

const tokens = z.number().int().nonnegative().max(2_000_000_000);
/** What the engine itself reports for this conversation's session; no estimate is made here.
 * `supported: false` means this engine has no source. Without the numbers there is no sample yet. */
export const contextUsageSchema = z.object({
  supported: z.boolean(),
  usedTokens: tokens.optional(),
  windowTokens: tokens.positive().optional(),
  /** Where the engine compacts by itself, when it says so. */
  autoCompactTokens: tokens.positive().optional(),
}).strict();
export type ContextUsage = z.infer<typeof contextUsageSchema>;
