/** Slack source kind definition and Cordis plugin entry. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Deployment } from '../deployment.ts'
import { sourceContext } from './host.ts'
import { resolveSlackProfile, slackProfile, type SlackProfile } from './slack-setup.ts'
import { sendSlack, slackLink } from './slack-channel.ts'
import { slackThreadContext } from './slack-read.ts'
import { refreshConversationNames } from './slack-history.ts'
import { SlackPolicySchema, syncSlackRoster } from './slack-policy.ts'
import { slackRepliesTo, slackScope, slackTerms } from './slack-trigger.ts'
import { runSlack } from './slack-loop.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export const ConversationSchema = z.object({
  conversationId: z.string().regex(/^[CG][A-Z0-9]{5,}$/, 'A Slack conversation ID starts with C or G followed by at least five uppercase letters or digits'),
  name: z.string().max(60).optional(),
  listen: z.enum(['mentions', 'all']),
}).strict()
export type Conversation = z.infer<typeof ConversationSchema>
export const SlackConfigSchema = z.object({
  cli: z.string().trim().default(''),
  chats: z.array(ConversationSchema)
    .refine(chats => new Set(chats.map(chat => chat.conversationId)).size === chats.length, 'Duplicate conversation IDs')
    .default([]),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
  readPageSize: z.number().int().min(10).max(100).default(50),
  backfillDays: z.number().int().min(1).max(14).default(14),
}).strict()
export type SlackConfig = z.infer<typeof SlackConfigSchema>

export const slackKind: SourceKind<SlackConfig> = {
  kind: 'slack',
  title: { zh: 'Slack', en: 'Slack' },
  description: {
    zh: '接收这些会话里提到机器人的消息；列出全部消息的会话里也接收其余消息。',
    en: 'Receives messages that mention the bot in these conversations, and the remaining messages in conversations listed for all messages.',
  },
  schema: SlackConfigSchema,
  setup: { fields: ['cli'], probe: ({ machine, config, run }) => resolveSlackProfile(machine, config, run) },
  facts: (deployment): Record<string, Localized | string> => {
    const profile = slackProfile(deployment)
    const name = profile?.name || profile?.botId
    return profile ? { bot: { zh: `已连接到 ${profile.team}，机器人 @${name}`, en: `Connected to ${profile.team} as @${name}` } } : {}
  },
  fields: [
    { key: 'bot', type: 'fact', label: { zh: 'Slack 连接', en: 'Slack connection' } },
    { key: 'cli', type: 'text', label: { zh: 'slack-bridge 路径', en: 'slack-bridge path' },
      hint: { zh: '命令名或绝对路径。保存时用 --version 检查桥，再用 bot token 读取工作区和机器人，然后重启 dsh-superagent。', en: 'A command name or absolute path. Saving checks the bridge with --version, reads the workspace and bot with the bot token, then restarts dsh-superagent.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的会话', en: 'Conversations' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息；“全部消息”也接收其余消息。', en: '"@ only" receives messages that mention the bot; "All" also receives the rest.' },
      columns: [
        { key: 'conversationId', type: 'text', label: { zh: '会话', en: 'Conversation' }, pattern: '[CG][A-Z0-9]{5,}' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other conversations' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Receive direct messages' } },
    { key: 'readPageSize', type: 'number', label: { zh: '每页消息数', en: 'Messages per page' }, min: 10, max: 100, advanced: true },
    { key: 'backfillDays', type: 'number', label: { zh: '补收天数', en: 'Days of backfill' }, min: 1, max: 14, advanced: true },
  ],
  health: ['slack', 'history:slack'],
  refreshLabels: (host, signal) => refreshConversationNames(sourceContext(host, slackKind), signal),
  scope: ({ meta }, config) => slackScope(meta, config),
  channel: {
    allowed: (address, config) => slackScope({ conversation: address.conversation ?? '', direct: address.direct === 'true' }, config).listened,
    send: sendSlack, words: 100, link: slackLink,
  },
  policy: {
    unnamed: { person: { zh: 'Slack 用户', en: 'Slack user' }, bot: { zh: 'Slack 机器人', en: 'Slack bot' } },
    schema: SlackPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Slack 用户', en: 'Slack users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '[UW][A-Z0-9]{5,}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'syncConversation', type: 'text', pattern: '[CG][A-Z0-9]{5,}', label: { zh: '同步来源会话', en: 'Sync conversation' },
        choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '同步时，名单变成这个公开会话的成员：新成员加入，离开的人移除，名字取 Slack 的显示名。启动时和点同步时进行。',
          en: 'Syncing makes the list the members of this public conversation: new members join, people who left are removed, and names follow Slack. It runs at startup and on Sync.' } },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        hint: { zh: '名单里的机器人在接收的会话里发的消息成为推断的候选，交给评估；它们不能发起明确的请求，也不能停止工单。',
          en: 'Messages of a bot on this list, in conversations the Source receives, become inferred candidates for an assessment; they never make an explicit request or stop a ticket.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '[UW][A-Z0-9]{5,}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。',
      en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = SlackConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.conversationId, label: chat.name || chat.conversationId,
          note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他会话', en: 'Other conversations' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => !!part.syncConversation,
      detail: part => `Synced ${part.allowed.length} people`,
      run: syncSlackRoster,
    },
  },
  threadContext: slackThreadContext,
  find: query => ({ threads: [], terms: slackTerms(query) }),
  repliesTo: slackRepliesTo,
}

/** The Slack profile resolved into the deployment's per-source slots, if the Slack probe succeeded. */
export { slackProfile, type SlackProfile } from './slack-setup.ts'

/** The Slack loop and its health rows live in `slack-loop.ts` to keep this module free of process code. */
export { runSlack, slackHealth } from './slack-loop.ts'

/** Returns the Slack Source's settings, falling back to schema defaults while the Slack plugin is disabled. */
export const slackSettings = (sources: SourceRegistry): SlackConfig =>
  sources.instance<SlackConfig>('slack')?.config ?? SlackConfigSchema.parse({})

export const name = 'dsh-superagent-slack'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(slackKind), 'slack: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runSlack(sourceContext(ctx.orchestrator, slackKind), controller.signal)
    return async () => { controller.abort(); await running }
  })
}
