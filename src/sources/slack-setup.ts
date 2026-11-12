/** The Slack bridge profile probe and schema the Slack kind's deployment slot resolves. */
import { z } from 'zod'
import { executable, type Deployment, type Machine, type Probe } from '../deployment.ts'
import { workerBin } from '../infra/environment.ts'
import { SetupError } from '../setup.ts'

/** The bridge setting stored in `Deployment.sources.slack`; the bot token stays in the bridge's own config file. */
export const SlackBotSchema = z.object({ cli: z.string().trim().default('') })
export interface SlackProfile {
  cli: string
  teamId: string
  team: string
  botId: string
  userId: string
  /** Slack's `user` for the bot, which is the name the card shows; `botId` when Slack omits it. */
  name: string
  url: string
}

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const ResponseSchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() })
const IdentitySchema = z.object({
  ok: z.literal(true),
  url: z.string(),
  team: z.string().min(1),
  user: z.string().optional(),
  team_id: z.string().regex(/^T[A-Z0-9]{5,}$/),
  user_id: z.string().regex(/^[UW][A-Z0-9]{5,}$/),
  bot_id: z.string().regex(/^B[A-Z0-9]{5,}$/),
})
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * Resolve the Slack workspace and bot through the bridge: first prove the configured executable runs, then ask
 * `auth.test` with the bot token the bridge already stores. An empty `cli` means the operator has no Slack app yet,
 * so it resolves no profile instead of reporting a setup failure.
 */
export async function resolveSlackProfile(machine: Machine, slack: unknown, probe: Probe,
  path = process.env.PATH ?? ''): Promise<SlackProfile | undefined> {
  const { cli: name } = SlackBotSchema.parse(slack ?? {})
  if (!name) return undefined
  let cli: string
  try { cli = executable(name, path, workerBin(machine.stateDir)) }
  catch (error) { throw new SetupError('slackBridgeMissing', { output: reason(error) }) }
  try { await probe([cli, '--version']) }
  catch (error) { throw new SetupError('slackBridgeMissing', { output: reason(error) }) }
  let output: string
  try { output = await probe([cli, 'api', 'auth.test']) }
  catch (error) { throw new SetupError('slackBridgeMissing', { output: reason(error) }) }
  const response = parsed(ResponseSchema, output)
  if (!response) throw new SetupError('slackBridgeFailed', { output })
  if (!response.ok) throw new SetupError('slackAuthFailed', { error: response.error ?? 'unknown_error' })
  const identity = parsed(IdentitySchema, output)
  if (!identity) throw new SetupError('slackBridgeFailed', { output })
  return { cli, teamId: identity.team_id, team: identity.team, botId: identity.bot_id, userId: identity.user_id,
    name: identity.user || identity.bot_id, url: identity.url }
}

/** The Slack profile resolved into the deployment's per-source slots, if the Slack probe succeeded. */
export const slackProfile = (deployment: Deployment | undefined): SlackProfile | undefined => deployment?.sources.slack as SlackProfile | undefined
