/** Slack policy schema, roster synchronization, and label refresh through a fake bridge. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { slackKind } from '../src/sources/slack.ts'
import { SlackPolicySchema, syncSlackRoster, type SlackPolicy } from '../src/sources/slack-policy.ts'
import type { SourceHost } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { fakeSlackBridge, type SlackPlan } from './fixtures/slack-bridge.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const PROFILE = { cli: '', teamId: 'T01234567', team: 'Acme', botId: 'B01234567', userId: 'U01234567', name: 'superagent', url: 'https://acme.slack.com/' }
const dirs = new Set<string>()
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.clear()
})

function policyHost(plan: SlackPlan) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-policy-'))
  dirs.add(dir)
  const bridge = fakeSlackBridge(dir, plan)
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { slack: { allowed: [{ id: 'U1AAAAAAA', name: 'Alice' }], syncConversation: 'C0SYNC123' } } },
    eval: { mode: 'auto' },
    sources: { slack: { enabled: true, config: { cli: bridge.cli, chats: [{ conversationId: 'C0PUBLIC1', listen: 'all' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(slackKind)
  const deployment = testDeployment({ sources: { slack: { ...PROFILE, cli: bridge.cli } } })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    problems: new Map(), ready: Promise.resolve(), configured: () => true, receive: async () => 'stored' as const, savePolicyPart: async () => {} }
  const host: SourceHost = { sources, context: kind => sourceContextOf(parts, kind) }
  return { host, store, bridge, calls: (method: string) => bridge.calls().filter(call => call.method === method) }
}

const part = (overrides: Partial<SlackPolicy> = {}): SlackPolicy => SlackPolicySchema.parse({
  allowed: [{ id: 'U2AAAAAAA', name: 'Old Bob' }, { id: 'U9GONE999', name: 'Gone' }, { id: 'U1AAAAAAA', name: 'Old Alice' }],
  syncConversation: 'C0SYNC123',
  bots: [{ id: 'U7BOTBOT', name: 'Helper' }],
  ...overrides,
})

describe('Slack policy', () => {
  it('accepts U and W ids, validates the workspace and conversation, and defaults empty lists', () => {
    expect(SlackPolicySchema.parse({})).toEqual({ teamId: '', allowed: [], syncConversation: '', bots: [] })
    expect(SlackPolicySchema.safeParse({ allowed: [{ id: 'X12345' }] }).success).toBe(false)
    expect(SlackPolicySchema.safeParse({ allowed: [{ id: 'U1AAAAAAA' }, { id: 'U1AAAAAAA' }] }).success).toBe(false)
    expect(SlackPolicySchema.safeParse({ teamId: 'T1AAAAAAA', syncConversation: 'C1AAAAAAA', bots: [{ id: 'W1AAAAAAA' }] }).success).toBe(true)
    expect(SlackPolicySchema.safeParse({ teamId: 'team' }).success).toBe(false)
    expect(SlackPolicySchema.safeParse({ syncConversation: 'oc_team' }).success).toBe(false)
  })

  it('fills the roster from members in stored order, appends new people sorted, and caches display names', async () => {
    const h = policyHost({
      'conversations.members:C0SYNC123': [
        { ok: true, members: ['U1AAAAAAA', 'U2AAAAAAA', 'U9GONE999', 'U6BOTBOT', 'U3CCCCCC', 'U4DDDDDD'], response_metadata: { next_cursor: 'more' } },
        { ok: true, members: ['U5EEEEEE'], response_metadata: { next_cursor: '' } },
      ],
      'users.info:U1AAAAAAA': [{ ok: true, user: { id: 'U1AAAAAAA', is_bot: false, deleted: false, profile: { display_name: 'Alice', real_name: 'Alice Real' } } }],
      'users.info:U2AAAAAAA': [{ ok: true, user: { id: 'U2AAAAAAA', is_bot: false, deleted: false, profile: { display_name: '', real_name: 'Bob' } } }],
      'users.info:U9GONE999': [{ ok: true, user: { id: 'U9GONE999', is_bot: false, deleted: true, real_name: 'Gone' } }],
      'users.info:U6BOTBOT': [{ ok: true, user: { id: 'U6BOTBOT', is_bot: true, deleted: false, real_name: 'Build bot' } }],
      'users.info:U3CCCCCC': [{ ok: true, user: { id: 'U3CCCCCC', is_bot: false, deleted: false, profile: { display_name: 'Carol' } } }],
      'users.info:U5EEEEEE': [{ ok: true, user: { id: 'U5EEEEEE', is_bot: false, deleted: false, profile: { display_name: 'Eve' } } }],
    })
    h.store.set(KV.slack.people, { U4DDDDDD: { name: 'Dave', bot: false, deleted: false } })
    const result = await syncSlackRoster(h.host, part(), new AbortController().signal)
    expect(result.allowed).toEqual([
      { id: 'U2AAAAAAA', name: 'Bob' }, { id: 'U1AAAAAAA', name: 'Alice' },
      { id: 'U3CCCCCC', name: 'Carol' }, { id: 'U4DDDDDD', name: 'Dave' }, { id: 'U5EEEEEE', name: 'Eve' },
    ])
    expect(result.teamId).toBe('T01234567')
    expect(result.bots).toEqual([{ id: 'U7BOTBOT', name: 'Helper' }])
    expect(h.calls('users.info').map(call => call.body.user)).toEqual(['U1AAAAAAA', 'U2AAAAAAA', 'U9GONE999', 'U6BOTBOT', 'U3CCCCCC', 'U5EEEEEE'])
    expect(h.store.get(KV.slack.people)).toMatchObject({
      U9GONE999: { deleted: true }, U6BOTBOT: { bot: true }, U4DDDDDD: { name: 'Dave' },
    })
  })

  it('reports an incomplete member list without touching the stored roster', async () => {
    const h = policyHost({
      'conversations.members:C0SYNC123': [
        { ok: true, members: ['U1AAAAAAA'], response_metadata: { next_cursor: 'more' } },
        { ok: false, error: 'ratelimited' },
      ],
    })
    await expect(syncSlackRoster(h.host, part(), new AbortController().signal)).rejects.toThrow('Slack returned an incomplete member list')
    expect(h.store.settings().policy.sources.slack).toMatchObject({ allowed: [{ id: 'U1AAAAAAA', name: 'Alice' }] })
    expect(h.store.get(KV.slack.people)).toBeUndefined()
  })

  it('reports readiness and the synced-people detail for the settings card', () => {
    const sync = slackKind.policy!.sync!
    expect(sync.ready(part({ syncConversation: '' }))).toBe(false)
    expect(sync.ready(part())).toBe(true)
    expect(sync.detail!(part())).toBe('Synced 3 people')
  })

  it('refreshes conversation names into the Slack label cache', async () => {
    const h = policyHost({
      'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
    })
    await slackKind.refreshLabels!(h.host)
    expect(h.store.get(KV.sources.labels('slack'))).toEqual({ C0PUBLIC1: 'general' })
  })
})
