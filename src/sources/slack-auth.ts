/** The `auth.test` call shared by the Slack socket loop and the history pass. */
import { z } from 'zod'
import type { SourceContext } from './host.ts'

/** One `auth.test` reply: the workspace identity on success, or Slack's error code. */
export const SlackAuthReplySchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  team_id: z.string().optional(),
  team: z.string().optional(),
}).passthrough()
export type SlackAuthReply = z.infer<typeof SlackAuthReplySchema>

/** Calls `auth.test` through the bridge; the caller decides what an error reply means. */
export async function slackAuthTest(ctx: SourceContext): Promise<SlackAuthReply> {
  return ctx.commands.slackJson(['api', 'auth.test'], SlackAuthReplySchema)
}
