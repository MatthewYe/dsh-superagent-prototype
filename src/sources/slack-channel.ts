/** Slack outbound Channel: one threaded `chat.postMessage` through the bridge, error mapping, and archive links. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { health } from './host.ts'
import { ChannelSendError, type ChannelLink, type ChannelLinks, type ChannelSendHost } from './kind.ts'
import type { SlackProfile } from './slack-setup.ts'
import { slackTriggerId } from './slack-trigger.ts'

/** Slack answers `ok: false` with a machine-readable error code; `needed` names a missing scope. */
const AnswerSchema = z.object({ ok: z.boolean(), error: z.string().optional(), needed: z.string().optional() }).passthrough()
/** Codes meaning the target can never receive this message; the Outbox settles the receipt as gone. */
const GONE = new Set(['channel_not_found', 'not_in_channel', 'is_archived', 'channel_is_archived'])
/** A reply this wrong is a bug: retrying cannot help, so the error is permanent. */
const PERMANENT = new Set(['msg_too_long', 'invalid_blocks', 'invalid_arguments', 'missing_scope'])
/** Token failures are retryable because a reinstall may fix them, but the operator must be told. */
const AUTH = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed'])
export type SlackFailure = 'permanent' | 'retryable'
export type SlackHealthCode = 'slackTokenRevoked' | 'slackRateLimited'

/** A Slack answer that did not accept the message, classified so the Outbox and health reporting can tell failures apart. */
export class SlackSendError extends ChannelSendError {
  override name = 'SlackSendError'
  constructor(readonly code: string, outcome: SlackFailure, readonly health?: SlackHealthCode, readonly needed?: string) {
    super(`Slack rejected the reply: ${code}${needed ? ` (needs ${needed})` : ''}`, outcome)
  }
}

export const slackGone = (error: string | undefined): boolean => !!error && GONE.has(error)

/**
 * Posts one reply with `chat.postMessage`, always in the thread of the request: `thread_ts` when the request was in a
 * thread, otherwise the message's own `ts`. No `client_msg_id`, blocks, or `chat.update`.
 */
export async function sendSlack(host: ChannelSendHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, ts, thread_ts } = message.channel.address
  if (!conversation || !ts) throw new Error('Missing Slack reply target')
  const body = { channel: conversation, text: message.text, thread_ts: thread_ts ?? ts }
  const output = await host.commands.slack(['api', 'chat.postMessage', JSON.stringify(body)])
  let answer: z.infer<typeof AnswerSchema>
  try { answer = AnswerSchema.parse(JSON.parse(output)) }
  catch { throw new Error('Slack bridge returned no JSON') }
  if (answer.ok) return 'sent'
  const code = answer.error ?? 'unknown_error'
  if (slackGone(code)) return 'gone'
  const outcome: SlackFailure = PERMANENT.has(code) ? 'permanent' : 'retryable'
  const healthCode: SlackHealthCode | undefined = code === 'ratelimited' ? 'slackRateLimited'
    : AUTH.has(code) || code === 'missing_scope' ? 'slackTokenRevoked' : undefined
  if (healthCode === 'slackRateLimited') host.report?.('slack', health('ready', healthCode))
  else if (healthCode === 'slackTokenRevoked') {
    const report = health('error', healthCode)
    host.report?.('slack', code === 'missing_scope' && answer.needed
      ? { ...report, detail: `${report.detail}: missing scope ${answer.needed}` }
      : report)
  }
  throw new SlackSendError(code, outcome, healthCode, answer.needed)
}

/** Archive URL on the resolved workspace; empty when the profile has no workspace URL, so callers use the read resource instead. */
export const slackLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => {
  const profile = links.sources.slack as SlackProfile | undefined
  const conversation = address.conversation ?? ''
  const ts = address.ts ?? ''
  const url = profile?.url && conversation && ts ? `${profile.url.replace(/\/+$/, '')}/archives/${conversation}/p${ts.replace('.', '')}` : ''
  return {
    url,
    label: { zh: 'Slack 消息', en: 'Slack message' },
    ...ts ? { triggerId: slackTriggerId(conversation, ts) } : {},
  }
}
