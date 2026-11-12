/** Slack socket loop: run the bridge, translate admitted events, and report health. */
import { z } from 'zod'
import type { SetupProblem } from '../setup.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { ConsumerFatal, supervise, type Consumer } from './loop.ts'
import { slackProfile, type SlackProfile } from './slack-setup.ts'
import { SOURCE, slackAdmitted, slackScope, slackTrigger } from './slack-trigger.ts'
import type { SlackConfig } from './slack.ts'

/** One bridge frame: `events_api` carries a team and an event; socket lifecycle frames carry only a type. */
const SlackFrameSchema = z.object({
  type: z.string(),
  reason: z.string().optional(),
  payload: z.object({
    team_id: z.string(),
    event_id: z.string().optional(),
    event: z.object({ type: z.string() }).passthrough(),
  }).passthrough().optional(),
}).passthrough()

const RevokedSchema = z.object({ bot: z.array(z.string()).optional() }).passthrough()

/**
 * The Slack health rows for the current configuration and setup state: an unconfigured Source pauses both, a failed
 * profile check pauses both, a resolved profile connects `slack` and leaves `history:slack` waiting for its first pass.
 */
export function slackHealth(config: SlackConfig | undefined, profile: SlackProfile | undefined,
  problem?: SetupProblem): { slack: Health; history: Health } {
  if (!config) return { slack: health('paused', 'sourceOff'), history: health('paused', 'sourceOff') }
  if (!config.cli) return { slack: health('paused', 'slackBridgeUnset'), history: health('paused', 'slackBridgeUnset') }
  if (!profile) return { slack: problem ? { state: 'paused', detail: problem.detail } : health('paused', 'setupPending'),
    history: health('paused', 'setupPending') }
  return { slack: health('ready', 'slackConnected', { team: profile.team, bot: profile.name || profile.botId }),
    history: health('starting', 'slackFirstPass') }
}

/** Handles one parsed bridge frame; throws `ConsumerFatal` when Slack says the app or its tokens are gone. */
export async function handleFrame(ctx: SourceContext, frame: unknown, config: SlackConfig, profile: SlackProfile): Promise<void> {
  const parsed = SlackFrameSchema.safeParse(frame)
  if (!parsed.success) throw new Error('The slack-bridge printed a frame that is not a Slack event')
  const value = parsed.data
  if (value.type === 'disconnect') {
    ctx.report('slack', { state: 'starting', detail: `Slack socket disconnected (${value.reason ?? 'unknown'}); reconnecting` })
    return
  }
  if (value.type === 'app_rate_limited') {
    ctx.report('slack', { state: 'ready', detail: 'Slack rate limited the app; the bridge is waiting to retry', code: 'slackRateLimited' })
    return
  }
  if (value.type !== 'events_api' || !value.payload) return
  if (value.payload.team_id !== profile.teamId) {
    ctx.report('slack', health('error', 'slackTeamChanged'))
    return
  }
  const event = value.payload.event
  if (event.type === 'app_uninstalled') {
    ctx.report('slack', health('error', 'slackAppUninstalled'))
    throw new ConsumerFatal('The Slack app was uninstalled')
  }
  if (event.type === 'tokens_revoked') {
    const revoked = RevokedSchema.safeParse(event.tokens)
    const bot = revoked.success ? revoked.data.bot ?? [] : []
    if (bot.includes(profile.userId) || bot.includes(profile.botId)) {
      ctx.report('slack', health('error', 'slackTokenRevoked'))
      throw new ConsumerFatal('The Slack bot token was revoked')
    }
    return
  }
  if (event.type === 'app_rate_limited') {
    ctx.report('slack', { state: 'ready', detail: 'Slack rate limited the app; the bridge is waiting to retry', code: 'slackRateLimited' })
    return
  }
  const trigger = slackTrigger(event, { botId: profile.botId, userId: profile.userId },
    { teamId: profile.teamId, url: profile.url })
  if (!trigger) return
  if (!slackAdmitted(slackScope(trigger.meta, config), trigger.addressed)) return
  await ctx.receive(trigger)
}

/** Builds the supervised consumer that runs `slack-bridge listen` and lets `handleFrame` translate its stdout. */
export function slackConsumer(config: SlackConfig, profile: SlackProfile, line: Consumer['line']): Consumer {
  return {
    kind: SOURCE, name: 'Slack socket', command: config.cli, args: ['listen'], env: {},
    ready: '[socket] ready', listening: `Connected to ${profile.team} as @${profile.name || profile.botId}`,
    oversized: 'The slack-bridge printed a line over 1 MiB',
    line,
  }
}

/** Reports the starting or paused health rows and, once a profile exists, supervises the socket. */
export async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (signal.aborted) return
  const config = ctx.config<SlackConfig>(SOURCE)
  const profile = slackProfile(ctx.deployment)
  const rows = slackHealth(config, profile, ctx.problem)
  if (rows.slack.state !== 'ready') {
    ctx.report('slack', rows.slack)
    ctx.report('history:slack', rows.history)
    return
  }
  ctx.report('slack', { state: 'starting', detail: `Connecting to ${profile!.team}` })
  ctx.report('history:slack', rows.history)
  const consumer = slackConsumer(config!, profile!, line => handleFrame(ctx, JSON.parse(line) as unknown, config!, profile!))
  await supervise(ctx, consumer, signal)
}

/** The Slack Source runs its socket loop; history backfill arrives in a later ticket. */
export const runSlack = async (ctx: SourceContext, signal: AbortSignal): Promise<void> => {
  await Promise.allSettled([watch(ctx, signal)])
}
