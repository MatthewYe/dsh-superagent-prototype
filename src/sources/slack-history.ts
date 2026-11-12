/** Slack history backfill, public-conversation joining, and the conversation name cache. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { slackProfile, type SlackProfile } from './slack-setup.ts'
import { SOURCE, slackAdmitted, slackRef, slackScope, slackTrigger } from './slack-trigger.ts'
import type { SlackConfig } from './slack.ts'

/** The health row the background pass reports through. */
const HISTORY = 'history:slack'
/** Slack Web API page size for history and reply reads. */
const PAGE = 200
/** How often a configured Source checks for joins, names, and missed messages. */
const PASS_MS = 60_000
/** Oldest tracked thread root followed; older roots fall outside the backfill window. */
const THREAD_DAYS = 14
/** Most thread roots followed per conversation, newest engagement first. */
const THREAD_MAX = 100

const MessageSchema = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().optional(),
  ts: z.string(),
  thread_ts: z.string().optional(),
  reply_count: z.number().optional(),
  latest_reply: z.string().optional(),
  hidden: z.boolean().optional(),
  channel: z.string().optional(),
})
const HistorySchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  has_more: z.boolean().optional(),
  messages: z.array(MessageSchema).default([]),
  response_metadata: z.looseObject({ next_cursor: z.string().nullish() }).optional(),
})
const InfoSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  channel: z.looseObject({
    id: z.string().optional(),
    name: z.string().nullish(),
    is_member: z.boolean().optional(),
    is_private: z.boolean().optional(),
    is_archived: z.boolean().optional(),
  }).optional(),
})
const OkSchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() })

type SlackMessage = z.infer<typeof MessageSchema>
type SlackConversation = { id: string; name?: string; is_member?: boolean; is_private?: boolean; is_archived?: boolean }

/** Slack history bounds are epoch-second stamps, not ISO times. */
const slackStamp = (milliseconds: number): string => (milliseconds / 1000).toFixed(6)
/** Slack timestamps are epoch seconds with a fractional part; `Date.parse` cannot read them. */
const slackTime = (ts: string): number => Number(ts) * 1000
const rateLimited = (error: unknown): boolean => /rate.?limit/i.test(String(error))

/** Reads every page of `conversations.history` newest first; the caller sorts and replays ascending. */
async function historyPages(ctx: SourceContext, conversation: string, oldest: number, latest: number,
  signal: AbortSignal): Promise<SlackMessage[]> {
  const commands = ctx.commands.withSignal(signal)
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  for (;;) {
    if (signal.aborted) throw signal.reason
    const body: Record<string, unknown> = { channel: conversation, oldest: slackStamp(oldest), latest: slackStamp(latest), limit: PAGE, inclusive: true }
    if (cursor) body.cursor = cursor
    const page = HistorySchema.parse(await commands.slackJson(['api', 'conversations.history', JSON.stringify(body)], HistorySchema))
    if (!page.ok) throw new Error(`conversations.history failed: ${page.error ?? 'unknown error'}`)
    messages.push(...page.messages)
    if (!page.has_more) break
    cursor = page.response_metadata?.next_cursor ?? undefined
    if (!cursor) throw new Error('Slack returned an incomplete history page')
  }
  return messages
}

/** Reads every page of `conversations.replies` oldest first, optionally bounded by `oldest`. */
async function replyPages(ctx: SourceContext, conversation: string, root: string, latest: number, oldest: number | undefined,
  signal: AbortSignal): Promise<SlackMessage[]> {
  const commands = ctx.commands.withSignal(signal)
  const messages: SlackMessage[] = []
  let cursor: string | undefined
  for (;;) {
    if (signal.aborted) throw signal.reason
    const body: Record<string, unknown> = { channel: conversation, ts: root, latest: slackStamp(latest), limit: PAGE }
    if (oldest !== undefined) body.oldest = slackStamp(oldest)
    if (cursor) body.cursor = cursor
    const page = HistorySchema.parse(await commands.slackJson(['api', 'conversations.replies', JSON.stringify(body)], HistorySchema))
    if (!page.ok) throw new Error(`conversations.replies failed: ${page.error ?? 'unknown error'}`)
    messages.push(...page.messages)
    if (!page.has_more) break
    cursor = page.response_metadata?.next_cursor ?? undefined
    if (!cursor) throw new Error('Slack returned an incomplete reply page')
  }
  return messages
}

async function conversationInfo(ctx: SourceContext, conversation: string): Promise<SlackConversation | undefined> {
  try {
    const answer = InfoSchema.parse(await ctx.commands.slackJson(['api', 'conversations.info', JSON.stringify({ channel: conversation })], InfoSchema))
    if (!answer.ok || !answer.channel) return undefined
    return { ...answer.channel, id: answer.channel.id ?? conversation, name: answer.channel.name ?? undefined }
  } catch {
    // A name and membership check is an aid; a read failure leaves the stored name and does not fail the pass.
    return undefined
  }
}

async function join(ctx: SourceContext, conversation: string): Promise<void> {
  const answer = OkSchema.parse(await ctx.commands.slackJson(['api', 'conversations.join', JSON.stringify({ channel: conversation })], OkSchema))
  if (!answer.ok) throw new Error(`conversations.join failed: ${answer.error ?? 'unknown error'}`)
}

/** Collects a translated Trigger when the configured scope admits it; deterministic IDs make overlap harmless. */
function collect(into: Map<string, Trigger>, input: unknown, config: SlackConfig, profile: SlackProfile): Trigger | undefined {
  const trigger = slackTrigger(input, { botId: profile.botId, userId: profile.userId }, { teamId: profile.teamId, url: profile.url })
  if (!trigger) return
  if (!slackAdmitted(slackScope(trigger.meta, config), trigger.addressed)) return
  into.set(trigger.id, trigger)
  return trigger
}

/** Bounds tracked roots by age and count, newest engagement first, so the follow-up cannot grow without limit. */
function boundThreads(threads: Record<string, string>, now: number): Record<string, string> {
  const cutoff = now - THREAD_DAYS * 86_400_000
  return Object.fromEntries(Object.entries(threads)
    .filter(([, at]) => { const time = Date.parse(at); return Number.isFinite(time) && time >= cutoff })
    .sort(([, left], [, right]) => Date.parse(right) - Date.parse(left))
    .slice(0, THREAD_MAX))
}

/**
 * Remembers the root of the thread a live Trigger belongs to, bounded by age and count. Called after admission so the
 * history pass only follows threads the agent is actually engaged in.
 */
export function rememberSlackThread(ctx: SourceContext, trigger: Trigger): void {
  const ref = slackRef(trigger)
  if (!ref) return
  const root = ref.threadTs ?? ref.ts
  const threads = ctx.state.get(KV.slack.threads(ref.conversation)) ?? {}
  ctx.state.set(KV.slack.threads(ref.conversation), boundThreads({ ...threads, [root]: new Date().toISOString() }, Date.now()))
}

/**
 * Backfills one conversation between its cursor and the pass start: newest-first history pages with a five-second overlap and
 * a `backfillDays` floor, followed by thread replies for roots with activity after the cursor. Triggers replay oldest first and
 * the cursor advances only after every read and intake succeeds.
 */
async function backfillConversation(ctx: SourceContext, config: SlackConfig, profile: SlackProfile, conversation: string,
  direct: boolean, cursor: string, started: string, signal: AbortSignal): Promise<void> {
  const latest = Date.parse(started)
  const oldest = Math.max(Date.parse(cursor) - 5_000, latest - config.backfillDays * 86_400_000)
  const messages = await historyPages(ctx, conversation, oldest, latest, signal)
  messages.sort((left, right) => Number(left.ts) - Number(right.ts))
  const stored = ctx.state.get(KV.slack.threads(conversation)) ?? {}
  const engaged = new Map(Object.entries(stored))
  const triggers = new Map<string, Trigger>()
  const event = (message: SlackMessage) => ({ ...message, channel: conversation, channel_type: direct ? 'im' : 'channel' })
  const remember = (trigger: Trigger | undefined): void => {
    if (!trigger) return
    const ref = slackRef(trigger)
    if (ref) engaged.set(ref.threadTs ?? ref.ts, started)
  }
  for (const message of messages) remember(collect(triggers, event(message), config, profile))
  const followed = new Set<string>()
  for (const root of messages) {
    if (signal.aborted) throw signal.reason
    const active = (root.reply_count ?? 0) > 0 || (root.latest_reply !== undefined && slackTime(root.latest_reply) > Date.parse(cursor))
    if (!active) continue
    followed.add(root.ts)
    const replies = await replyPages(ctx, conversation, root.ts, latest, undefined, signal)
    replies.sort((left, right) => Number(left.ts) - Number(right.ts))
    for (const reply of replies) {
      if (reply.ts === root.ts) continue
      if (slackTime(reply.ts) < oldest) continue
      remember(collect(triggers, event(reply), config, profile))
    }
  }
  // Roots first seen before this page may still receive replies; follow the bounded set of threads the agent engaged in.
  for (const root of Object.keys(boundThreads(Object.fromEntries(engaged), latest))) {
    if (followed.has(root)) continue
    if (signal.aborted) throw signal.reason
    const replies = await replyPages(ctx, conversation, root, latest, oldest, signal)
    replies.sort((left, right) => Number(left.ts) - Number(right.ts))
    for (const reply of replies) {
      if (reply.ts === root) continue
      if (slackTime(reply.ts) < oldest) continue
      remember(collect(triggers, event(reply), config, profile))
    }
  }
  const ordered = [...triggers.values()].sort((left, right) => Number(left.meta.ts) - Number(right.meta.ts))
  for (const trigger of ordered) {
    if (signal.aborted) throw signal.reason
    await ctx.receive(trigger)
  }
  ctx.state.set(KV.slack.history(conversation), started)
  // Merge again: live traffic may have tracked a thread while this pass was reading.
  const current = ctx.state.get(KV.slack.threads(conversation))
  const threads = boundThreads({ ...current, ...Object.fromEntries(engaged) }, latest)
  if (Object.keys(threads).length > 0 || current !== undefined) ctx.state.set(KV.slack.threads(conversation), threads)
}

/**
 * One pass over every configured and previously seen conversation: refresh names, join listed public conversations the bot is
 * not in, and backfill each conversation it can read. Join and history failures are reported without stopping the pass.
 */
export async function slackHistoryPass(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  const config = ctx.config<SlackConfig>(SOURCE)
  const profile = slackProfile(ctx.deployment)
  if (!config || !profile) return
  const started = new Date().toISOString()
  const configured = new Map(config.chats.map(chat => [chat.conversationId, chat.listen]))
  const targets = new Map<string, { direct: boolean; listed: boolean }>()
  for (const [conversation, direct] of Object.entries(ctx.state.get(KV.slack.conversations) ?? {})) {
    targets.set(conversation, { direct, listed: configured.has(conversation) })
  }
  for (const conversation of configured.keys()) targets.set(conversation, { direct: false, listed: true })
  const names = { ...(ctx.state.get(KV.sources.labels(SOURCE)) ?? {}) }
  const behind: string[] = []
  const members: string[] = []
  let limited = false
  for (const [conversation, target] of targets) {
    if (signal.aborted) return
    const info = await conversationInfo(ctx, conversation)
    if (info?.name) names[conversation] = info.name
    const privateConversation = info?.is_private === true || conversation.startsWith('G')
    if (target.listed && !privateConversation && info?.is_member === false) {
      try {
        await join(ctx, conversation)
        info.is_member = true
      } catch (error) {
        members.push(`${conversation}: ${String(error)}`)
        continue
      }
    }
    const cursor = ctx.state.get(KV.slack.history(conversation))
    if (cursor === undefined) ctx.state.set(KV.slack.history(conversation), started)
    if (info?.is_member === false) {
      members.push(`${conversation}: ${privateConversation
        ? 'the bot is not a member of a private conversation; invite it to receive messages'
        : 'the bot is not a member'}`)
      continue
    }
    if (cursor === undefined) continue
    try {
      await backfillConversation(ctx, config, profile, conversation, target.direct, cursor, started, signal)
    } catch (error) {
      if (signal.aborted) return
      if (rateLimited(error)) limited = true
      else behind.push(`${conversation}: ${String(error)}`)
    }
  }
  const previous = ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
  if (JSON.stringify(previous) !== JSON.stringify(names)) ctx.state.set(KV.sources.labels(SOURCE), names)
  if (signal.aborted) return
  if (limited && !behind.length && !members.length) {
    ctx.report(HISTORY, health('ready', 'slackRateLimited'))
  } else if (behind.length || members.length) {
    const detail = [...members, ...behind].join('; ')
    ctx.report(HISTORY, { state: 'error', ...(members.length ? { code: 'slackNotAMember' as const } : {}),
      detail: `${behind.length + members.length} conversations behind: ${detail}`, at: new Date().toISOString() })
  } else {
    ctx.report(HISTORY, { state: 'ready', detail: 'Up to date', at: new Date().toISOString() })
  }
}

/** Refreshes the display names of configured and previously seen conversations; a failed lookup keeps the stored name. */
export async function refreshConversationNames(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const config = ctx.config<SlackConfig>(SOURCE)
  if (!config) return ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
  const configured = new Set(config.chats.map(chat => chat.conversationId))
  const conversations = new Set([...Object.keys(ctx.state.get(KV.slack.conversations) ?? {}), ...configured])
  const names = { ...(ctx.state.get(KV.sources.labels(SOURCE)) ?? {}) }
  for (const conversation of conversations) {
    if (signal?.aborted) break
    const info = await conversationInfo(ctx, conversation)
    if (info?.name) names[conversation] = info.name
  }
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}

/** Runs the first pass immediately, then one every minute; a disabled Source reports paused and waits for re-enablement. */
export async function runSlackHistory(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // `slackHealth` already reports paused/setup states while the bridge is missing; the history row stays with it.
  if (!ctx.configured() || !slackProfile(ctx.deployment) || !ctx.config<SlackConfig>(SOURCE)?.cli) return
  while (!signal.aborted) {
    const config = ctx.config<SlackConfig>(SOURCE)
    if (!config) {
      ctx.report(HISTORY, health('paused', 'sourceOff'))
      await delay(PASS_MS, undefined, { signal }).catch(() => {})
      continue
    }
    try {
      await slackHistoryPass(ctx, signal)
    } catch (error) {
      if (!signal.aborted) ctx.report(HISTORY, { state: 'error', detail: String(error), at: new Date().toISOString() })
    }
    await delay(PASS_MS, undefined, { signal }).catch(() => {})
  }
}
