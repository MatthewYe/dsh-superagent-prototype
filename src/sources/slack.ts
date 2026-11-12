/** Slack source kind definition and Cordis plugin entry. */
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'
import { resolveSlackProfile, slackProfile } from './slack-setup.ts'
import type { Localized, SourceKind } from './kind.ts'

export const ConversationSchema = z.object({
  conversationId: z.string().regex(/^[CG][A-Z0-9]{5,}$/),
  name: z.string().trim().max(60).optional(),
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
    return profile ? { bot: { zh: `当前机器人 ${name}`, en: `Current bot ${name}` } } : {}
  },
  fields: [
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
}

/** The Slack profile resolved into the deployment's per-source slots, if the Slack probe succeeded. */
export { slackProfile, type SlackProfile } from './slack-setup.ts'
