/** Validates Slack Socket Mode events, translates them into Triggers, and normalizes Slack mrkdwn. */
import { z } from 'zod'
import { key, type ChannelRef, type ScopeResult, type Trigger } from '../core/index.ts'

export const SOURCE = 'slack'

/** The message-shaped event inside an `events_api` envelope; Slack adds fields per event type. */
export const SlackEventSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  channel: z.string(),
  channel_type: z.string().optional(),
  hidden: z.boolean().optional(),
  deleted_ts: z.string().optional(),
  files: z.array(z.unknown()).optional(),
}).passthrough()
export type SlackEvent = z.infer<typeof SlackEventSchema>

/** The full frame the bridge prints; only `events_api` frames carry events. */
export const SlackEnvelopeSchema = z.object({
  type: z.literal('events_api'),
  envelope_id: z.string(),
  payload: z.object({
    team_id: z.string(),
    event_id: z.string().optional(),
    event: SlackEventSchema,
  }).passthrough(),
}).passthrough()
export type SlackEnvelope = z.infer<typeof SlackEnvelopeSchema>

/** The bot identity from `auth.test`; `userId` is also the id Slack uses in mention tokens. */
export interface SlackIdentity {
  botId: string
  userId: string
}

/** The configuration fields that decide whether a conversation is listened to. */
export interface SlackScopeConfig {
  chats: { conversationId: string; listen: 'mentions' | 'all' }[]
  otherChats: 'none' | 'mentions'
  directMessages: boolean
}

/**
 * Classifies a Trigger's conversation into the design's scope rows: a listed conversation, `other`, or `direct`.
 * A listed row reports whether it observes unaddressed messages (`listen: 'all'`); the other rows do not.
 */
export function slackScope(meta: Record<string, unknown>, config: SlackScopeConfig): ScopeResult {
  if (meta.direct === true || meta.direct === 'true') {
    return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
  }
  const conversation = typeof meta.conversation === 'string' ? meta.conversation : ''
  const chat = config.chats.find(item => item.conversationId === conversation)
  if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.conversationId }
  return config.otherChats === 'mentions'
    ? { listened: true, observed: false, row: 'other' }
    : { listened: false, reason: 'conversation_not_allowed' }
}

/** Admits a listened Trigger when it addresses the bot, or when its row observes unaddressed messages. */
export const slackAdmitted = (scope: ScopeResult, addressed: Trigger['addressed']): boolean =>
  scope.listened && (addressed === 'mention' || addressed === 'direct' || scope.observed)

/** Deterministic Trigger id; a redelivered Slack event carries the same message coordinates. */
export const slackTriggerId = (conversation: string, ts: string): string => key(SOURCE, `${conversation}:${ts}`)

/** Thread id in the Feishu convention `<conversation>:<root ts>`; a top-level message is its own root. */
export const slackThreadId = (conversation: string, threadTs: string | undefined, ts: string): string => `${conversation}:${threadTs ?? ts}`

/** Builds a reply address; an in-thread message keeps `thread_ts` so the reply lands under the root. */
export const slackChannel = (conversation: string, ts: string, options: { threadTs?: string; direct?: boolean } = {}): ChannelRef => ({
  source: SOURCE,
  thread: `${SOURCE}:${conversation}`,
  address: {
    conversation,
    ts,
    ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
    ...(options.direct ? { direct: 'true' } : {}),
  },
})

/** Converts Slack mrkdwn tokens to plain text; unresolved mentions stay ids so the assessment can see them. */
export function mrkdwnText(text: string, people: Record<string, string> = {}): string {
  return text.replace(/<([^<>]+)>/g, (match, inner: string) => {
    if (inner.startsWith('@')) {
      const id = inner.slice(1).split('|')[0] ?? ''
      return `@${people[id] ?? id}`
    }
    if (inner.startsWith('#')) {
      const [id = '', label] = inner.slice(1).split('|')
      return label ? `#${label}` : `#${id}`
    }
    if (inner.startsWith('!')) {
      const command = inner.slice(1)
      const [kind, label] = command.split('|')
      if (kind === 'here' || kind === 'channel' || kind === 'everyone') return `@${kind}`
      if (kind?.startsWith('date^')) return label ?? match
      return label ?? match
    }
    const [url = '', label] = inner.split('|')
    return label ? `${label} (${url})` : url
  })
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

const mentionPattern = /<@([^>|]+)(?:\|[^>]*)?>/g
const hasMention = (text: string, userId: string): boolean => [...text.matchAll(mentionPattern)].some(([, id]) => id === userId)

/**
 * Translates one `events_api` event payload into a Trigger.
 * Returns undefined for self-echo, edited/deleted/hidden messages, and event types Slack sends that are not requests.
 */
export function slackTrigger(input: unknown, bot: SlackIdentity, profile: { teamId: string; url: string }, people: Record<string, string> = {}): Trigger | undefined {
  const event = SlackEventSchema.parse(input)
  if (event.hidden === true) return
  if (event.type !== 'message' && event.type !== 'app_mention') return
  if (event.type === 'message' && event.subtype === 'message_changed') return
  if (event.type === 'message' && event.subtype === 'message_deleted') return
  if (event.type === 'message' && !['channel', 'group', 'im'].includes(event.channel_type ?? 'channel')) return
  if (event.bot_id === bot.botId || event.user === bot.userId) return
  const actor = event.user ?? event.bot_id
  if (!actor) return
  const direct = event.channel_type === 'im'
  const mentioned = event.type === 'app_mention' || hasMention(event.text ?? '', bot.userId)
  const addressed = direct ? 'direct' : mentioned ? 'mention' : undefined
  return {
    id: slackTriggerId(event.channel, event.ts),
    source: SOURCE,
    threads: [{ source: SOURCE, id: slackThreadId(event.channel, event.thread_ts, event.ts) }],
    actor: { source: SOURCE, id: actor },
    human: !!event.user && !event.bot_id,
    ...(addressed ? { addressed } : {}),
    at: new Date(Number(event.ts) * 1000).toISOString(),
    text: mrkdwnText(event.text ?? '', people),
    channel: slackChannel(event.channel, event.ts, { threadTs: event.thread_ts, direct }),
    url: `${profile.url.replace(/\/+$/, '')}/archives/${event.channel}/p${event.ts.replace('.', '')}`,
    meta: {
      conversation: event.channel,
      teamId: profile.teamId,
      ts: event.ts,
      ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
      ...(direct ? { direct: 'true' } : {}),
      mentioned,
    },
  }
}
