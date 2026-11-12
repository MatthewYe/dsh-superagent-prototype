/** Slack source kind definition and Cordis plugin entry. */
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { Deployment } from '../deployment.ts'
import type { SetupProblem } from '../setup.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { resolveSlackProfile, slackProfile, type SlackProfile } from './slack-setup.ts'
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
}

/**
 * The Slack health rows before the socket and backfill loops exist: a disabled Source, a missing bridge or a failed
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

/** The Slack profile resolved into the deployment's per-source slots, if the Slack probe succeeded. */
export { slackProfile, type SlackProfile } from './slack-setup.ts'

/** Returns the Slack Source's settings, falling back to schema defaults while the Slack plugin is disabled. */
export const slackSettings = (sources: SourceRegistry): SlackConfig =>
  sources.instance<SlackConfig>('slack')?.config ?? SlackConfigSchema.parse({})

/**
 * Report the Source's setup health until a later ticket starts its socket and backfill. The plugin effect keeps this
 * promise pending on the abort signal, so stopping the Source disposes nothing and restarting re-runs the check.
 */
export async function runSlack(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (signal.aborted) return
  const rows = slackHealth(ctx.config<SlackConfig>('slack'), slackProfile(ctx.deployment), ctx.problem)
  ctx.report('slack', rows.slack)
  ctx.report('history:slack', rows.history)
  await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}

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
