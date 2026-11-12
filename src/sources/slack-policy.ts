/** Slack policy schema and roster synchronization from one conversation's members. */
import { z } from 'zod'
import { KV } from '../kv.ts'
import { sourceContext, type SourceHost } from './host.ts'
import { slackProfile } from './slack-setup.ts'

const SLACK_KIND = { kind: 'slack', health: ['slack', 'history:slack'] } as const

const PersonSchema = z.object({
  id: z.string().regex(/^[UW][A-Z0-9]{5,}$/, 'A Slack user ID starts with U or W followed by at least five uppercase letters or digits'),
  name: z.string().trim().max(100).optional(),
}).strict()

/** The Slack part of the Policy: who may originate work, the conversation rosters sync from, and listed bots. */
export const SlackPolicySchema = z.object({
  teamId: z.string().regex(/^T[A-Z0-9]{5,}$/, 'A Slack workspace ID starts with T followed by at least five uppercase letters or digits')
    .or(z.literal('')).default(''),
  allowed: z.array(PersonSchema).refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate user IDs')
    .default([]),
  syncConversation: z.string().regex(/^[CG][A-Z0-9]{5,}$/, 'A Slack conversation ID starts with C or G followed by at least five uppercase letters or digits')
    .or(z.literal('')).default(''),
  bots: z.array(PersonSchema).refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate bot IDs')
    .default([]),
}).strict()
export type SlackPolicy = z.infer<typeof SlackPolicySchema>

const MembersPageSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  members: z.array(z.string()).optional(),
  response_metadata: z.looseObject({ next_cursor: z.string().nullish() }).optional(),
})
const UserSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
  user: z.looseObject({
    id: z.string().optional(),
    name: z.string().optional(),
    real_name: z.string().nullish(),
    is_bot: z.boolean().optional(),
    deleted: z.boolean().optional(),
    profile: z.looseObject({ display_name: z.string().nullish(), real_name: z.string().nullish() }).optional(),
  }).optional(),
})

type Person = { name?: string; bot?: boolean; deleted?: boolean }

/** Fails when Slack cannot return the whole member list, so a partial roster never replaces the stored one. */
const incomplete = (): Error => new Error('Slack returned an incomplete member list')

/**
 * Rebuilds `allowed` from `syncConversation`'s members: known people keep their order and receive refreshed names, new people
 * are appended sorted by ID, and bots and deleted users are dropped. Names and flags are cached in `KV.slack.people`.
 */
export async function syncSlackRoster(host: SourceHost, part: SlackPolicy, signal: AbortSignal): Promise<SlackPolicy> {
  const ctx = sourceContext(host, SLACK_KIND)
  const commands = ctx.commands.withSignal(signal)
  const conversation = part.syncConversation
  if (!conversation) return part
  const members: string[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    if (signal.aborted) throw signal.reason
    const body: Record<string, unknown> = { channel: conversation, limit: 200 }
    if (cursor) body.cursor = cursor
    const page = MembersPageSchema.parse(await commands.slackJson(['api', 'conversations.members', JSON.stringify(body)], MembersPageSchema))
    if (!page.ok || !page.members) throw incomplete()
    members.push(...page.members)
    const next = page.response_metadata?.next_cursor ?? undefined
    if (!next) break
    if (cursors.has(next)) throw incomplete()
    cursors.add(next)
    cursor = next
  }
  const people = { ...(ctx.state.get(KV.slack.people) ?? {}) }
  for (const id of new Set(members)) {
    if (people[id]) continue
    if (signal.aborted) throw signal.reason
    const answer = UserSchema.parse(await commands.slackJson(['api', 'users.info', JSON.stringify({ user: id })], UserSchema))
    if (!answer.ok || !answer.user) throw new Error(`users.info failed for ${id}: ${answer.error ?? 'unknown error'}`)
    const display = answer.user.profile?.display_name?.trim() || answer.user.profile?.real_name?.trim() || answer.user.real_name?.trim()
    people[id] = { ...(display ? { name: display } : {}), bot: answer.user.is_bot === true, deleted: answer.user.deleted === true }
  }
  ctx.state.set(KV.slack.people, people)
  const humans = new Set([...new Set(members)].filter(id => people[id] && !people[id]!.bot && !people[id]!.deleted))
  const person = (id: string): { id: string; name?: string } => ({ id, ...(people[id]?.name ? { name: people[id]!.name } : {}) })
  // Keep the stored order so the policy hash does not change on every sync; only append new members, sorted by ID.
  const existing = part.allowed.filter(entry => humans.has(entry.id)).map(entry => person(entry.id))
  const known = new Set(existing.map(entry => entry.id))
  const added = [...humans].filter(id => !known.has(id)).sort().map(id => person(id))
  const profile = slackProfile(ctx.deployment)
  return { ...part, teamId: profile?.teamId || part.teamId, allowed: [...existing, ...added] }
}
