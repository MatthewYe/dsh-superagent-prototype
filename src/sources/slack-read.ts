/** Slack thread-context reads and the `slack/<trigger-id>/…` resources, served to assessments and the Executor. */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { mrkdwnText, slackRef, type SlackRef } from './slack-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

export type { SlackRef } from './slack-trigger.ts'

/** Slack returns Slack's own timestamp format: ten seconds digits, a dot, and six microsecond digits. */
const timestamp = z.string().regex(/^\d{10}\.\d{6}$/)
const messageSchema = z.object({
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  ts: timestamp,
  thread_ts: z.string().optional(),
  subtype: z.string().optional(),
}).passthrough()
type SlackMessage = z.infer<typeof messageSchema>
const answerSchema = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough()
const pageSchema = z.object({
  messages: z.array(z.unknown()), has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).passthrough().optional(),
}).passthrough()

export interface SlackPage { status: string; messages: ContextMessage[]; next_resource: string | null; skipped?: number }
export interface SlackOne { status: string; message: ContextMessage | null }

/** Resource references are anchored to an accepted Trigger instead of arbitrary conversation or message ids. */
export function slackReferences(ref: SlackRef) {
  const read = (section: string) => `slack/${ref.triggerId}/${section}`
  return { message: read('message'), root: read('root'), parent: read('parent'), thread: read('thread'), around: read('around') }
}

/** Validates a model-supplied resource string before any bridge call; only `thread` and `around` take pagination cursors. */
export function slackResource(resource: string) {
  const match = /^slack\/([^/]+)\/(message|root|parent|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] !== 'thread' && match[2] !== 'around')) {
    throw new Error('Use slack/<trigger-id>/message, /root, /parent, /thread or /around; follow returned next_resource for another page')
  }
  return { triggerId: match[1]!, section: match[2]!, cursor: match[3] ? decodeURIComponent(match[3]) : undefined }
}

/** Slack's microsecond timestamp as an ISO time, preserving milliseconds. */
function isoTime(ts: string): string {
  const [seconds = '0', micros = '0'] = ts.split('.')
  return new Date(Number(seconds) * 1000 + Number(micros.padEnd(6, '0').slice(0, 3))).toISOString()
}

function archiveUrl(commands: Commands, ref: SlackRef, ts: string): string | undefined {
  const profile = commands.deployment.sources.slack as { url?: string } | undefined
  return profile?.url ? `${profile.url.replace(/\/+$/, '')}/archives/${ref.conversation}/p${ts.replace('.', '')}` : undefined
}

/** Maps a Slack message to the context shape; edits are naturally visible and deleted text is kept as Slack returns it. */
export function slackView(message: SlackMessage, ref: SlackRef, commands: Commands): ContextMessage {
  const url = archiveUrl(commands, ref, message.ts)
  return {
    id: message.ts,
    from: message.user ?? message.bot_id ?? '',
    at: isoTime(message.ts),
    text: mrkdwnText(message.text ?? ''),
    ...(message.bot_id || message.subtype === 'bot_message' ? { bot: true as const } : {}),
    ...(message.subtype === 'tombstone' ? { deleted: true as const } : {}),
    ...(message.thread_ts && message.thread_ts !== message.ts ? { reply_to: message.thread_ts } : {}),
    ...(url ? { url } : {}),
  }
}

/** Reads one Slack Web API method through the bridge and fails with a message naming the conversation. */
async function readApi(commands: Commands, ref: SlackRef, method: string, params: Record<string, unknown>) {
  const where = `Slack read failed in ${ref.conversation}`
  let output: string
  try {
    output = await commands.slack(['api', method, JSON.stringify(params)])
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error(`${where}: the bridge returned invalid JSON`)
  }
  const answer = answerSchema.parse(parsed)
  if (!answer.ok) throw new Error(`${where}: ${answer.error ?? 'unknown Slack error'}`)
  return answer
}

/** Fetches one message or one bounded page of a Trigger's thread or neighbours, with explicit continuation. */
export async function slackRead(commands: Commands, ref: SlackRef, resource: string,
  pageSize: number): Promise<SlackPage | SlackOne> {
  const request = slackResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Slack source trigger is required')
  if (request.section === 'message') {
    const answer = await readApi(commands, ref, 'conversations.history', {
      channel: ref.conversation, oldest: ref.ts, latest: ref.ts, inclusive: true, limit: 1 })
    const first = pageSchema.parse(answer).messages[0]
    if (!first) return { status: 'missing', message: null }
    const message = slackView(messageSchema.parse(first), ref, commands)
    return { status: message.deleted ? 'deleted' : 'available', message }
  }
  if (request.section === 'thread' || request.section === 'around') {
    if (request.section === 'thread' && !ref.threadTs) return { status: 'no_thread', messages: [], next_resource: null }
    // The thread reads its root and replies; around reads the page ending at the trigger, without the trigger itself.
    const params = request.section === 'thread'
      ? { channel: ref.conversation, ts: ref.threadTs!, limit: pageSize }
      : { channel: ref.conversation, latest: ref.ts, limit: pageSize }
    const answer = await readApi(commands, ref, request.section === 'thread' ? 'conversations.replies' : 'conversations.history',
      { ...params, ...request.cursor ? { cursor: request.cursor } : {} })
    const parsed = pageSchema.parse(answer)
    const messages = parsed.messages.map(raw => slackView(messageSchema.parse(raw), ref, commands))
      .sort((a, b) => a.id.localeCompare(b.id))
    const next = parsed.has_more && parsed.response_metadata?.next_cursor
      ? `slack/${ref.triggerId}/${request.section}/${encodeURIComponent(parsed.response_metadata.next_cursor)}` : null
    return { status: 'available', messages, next_resource: next }
  }
  if (request.section === 'parent' && !ref.threadTs) return { status: 'no_parent', message: null }
  // `root` and `parent` both read the thread parent: for a reply that is its root; a top-level message is its own root.
  const answer = await readApi(commands, ref, 'conversations.replies', {
    channel: ref.conversation, ts: ref.threadTs ?? ref.ts, limit: 1 })
  const first = pageSchema.parse(answer).messages[0]
  if (!first) return { status: `no_${request.section}`, message: null }
  const message = slackView(messageSchema.parse(first), ref, commands)
  return { status: message.deleted ? 'deleted' : 'available', message }
}

/** The Kind's thread-context reader: a reply reads its thread, and a top-level message falls back to its neighbours. */
export const slackThreadContext: ThreadContext<{ readPageSize: number }> = {
  messageId: trigger => String(trigger.meta.ts ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    const ref = slackRef(trigger)
    if (!ref) throw new Error('A Slack source trigger is required')
    const resource = `slack/${ref.triggerId}/${part}${cursor ? '/' + encodeURIComponent(cursor) : ''}`
    const body = await slackRead(commands, ref, resource, config.readPageSize)
    if (part === 'thread' && body.status === 'no_thread') {
      // A top-level message has no thread: read the page before it instead, as Feishu reads chat neighbours.
      const around = await slackRead(commands, ref, `slack/${ref.triggerId}/around`, config.readPageSize) as SlackPage
      return { messages: around.messages, body: { status: 'chat_neighbours', messages: around.messages }, status: 'chat_neighbours' }
    }
    const messages = 'messages' in body ? body.messages : body.message ? [body.message] : []
    const next = 'next_resource' in body && body.next_resource ? decodeURIComponent(body.next_resource.split('/').at(-1)!) : undefined
    return { messages, next, body: { ...body }, status: body.status }
  },
}
