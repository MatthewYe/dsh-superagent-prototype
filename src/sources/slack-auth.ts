/** The `auth.test` call shared by the Slack socket loop and the history pass, and the health it reports. */
import { z } from 'zod'
import { health, type SourceContext } from './host.ts'
import type { SlackProfile } from './slack-setup.ts'

/** One `auth.test` reply: the workspace identity on success, or Slack's error code. */
export const SlackAuthReplySchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().optional(),
  team_id: z.string().optional(),
  team: z.string().optional(),
}).passthrough()
export type SlackAuthReply = z.infer<typeof SlackAuthReplySchema>

/** Slack error codes meaning the bot token itself no longer authenticates. */
const REVOKED = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'])

/** Contexts whose current `slackTokenRevoked` error came from an `auth.test` check rather than a Slack event. */
const checked = new WeakSet<SourceContext>()

/** Calls `auth.test` through the bridge; the caller decides what an error reply means. */
export async function slackAuthTest(ctx: SourceContext): Promise<SlackAuthReply> {
  return ctx.commands.slackJson(['api', 'auth.test'], SlackAuthReplySchema)
}

/**
 * Mark that a Slack event, not a check, revoked the token: a later successful `auth.test` must not clear the event's
 * error, because a push notification outranks a poll that only proves the token still replies.
 */
export function markTokenEvent(ctx: SourceContext): void {
  checked.delete(ctx)
}

/**
 * Reports the Slack health row for an `auth.test` reply: a revoked token becomes `slackTokenRevoked`, and a success
 * clears that error when a check set it, without overwriting unrelated states (a removed app, another team, or a rate
 * limit).
 */
export function reportSlackToken(ctx: SourceContext, profile: SlackProfile, reply: SlackAuthReply): void {
  if (reply.ok === true) {
    if (checked.has(ctx) && ctx.healthOf('slack')?.code === 'slackTokenRevoked') {
      ctx.report('slack', health('ready', 'slackConnected', { team: profile.team, bot: profile.name || profile.botId }))
    }
    checked.delete(ctx)
    return
  }
  if (reply.error && REVOKED.has(reply.error)) {
    checked.add(ctx)
    ctx.report('slack', health('error', 'slackTokenRevoked'))
  }
}

/**
 * Checks the bot token through the bridge and reports its health. Returns false when Slack rejects the token or the
 * bridge does not answer, so a periodic round can stop before making calls that would fail the same way.
 */
export async function checkSlackToken(ctx: SourceContext, profile: SlackProfile): Promise<boolean> {
  let reply: SlackAuthReply
  try { reply = await slackAuthTest(ctx) } catch { return false }
  reportSlackToken(ctx, profile, reply)
  return reply.ok === true
}
