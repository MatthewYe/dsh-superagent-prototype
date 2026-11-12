/** Slack history backfill, join, and name cache, driven through a fake bridge and the real socket loop. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { slackKind } from '../src/sources/slack.ts'
import { runSlack } from '../src/sources/slack-loop.ts'
import { KV } from '../src/kv.ts'
import { slackTriggerId } from '../src/sources/slack-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { fakeSlackBridge, type SlackPlan } from './fixtures/slack-bridge.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const BOT = 'U01234567'
const PROFILE = { cli: '', teamId: 'T01234567', team: 'Acme', botId: 'B01234567', userId: BOT, name: 'superagent', url: 'https://acme.slack.com/' }
const message = (ts: string, overrides: Record<string, unknown> = {}) => ({ type: 'message', user: 'U0123ABCD', text: 'hello', ts, channel: 'C0PUBLIC1', ...overrides })
// One epoch-second base for every sample, so timestamps baked into a plan match the ones asserted later.
const BASE = Math.floor(Date.now() / 1000)
const seconds = (offset: number): string => `${BASE + offset}.000100`
const emptyHistory = { ok: true, has_more: false, messages: [], response_metadata: { next_cursor: '' } }

type Harness = ReturnType<typeof historyHost>
function historyHost({ plan, chats = [{ conversationId: 'C0PUBLIC1', listen: 'all' as const }], stored = {}, cursors = {} }: {
  plan: SlackPlan
  chats?: { conversationId: string; listen: 'mentions' | 'all' }[]
  stored?: Record<string, boolean>
  cursors?: Record<string, string>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-backfill-'))
  dirs.add(dir)
  const bridge = fakeSlackBridge(dir, plan)
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { slack: { allowed: [{ id: 'U0123ABCD', name: 'Alice' }] } } },
    eval: { mode: 'auto' },
    sources: { slack: { enabled: true, config: { cli: bridge.cli, chats, otherChats: 'none', directMessages: true } } },
  }))
  if (Object.keys(stored).length) store.set(KV.slack.conversations, stored)
  for (const [conversation, at] of Object.entries(cursors)) store.set(KV.slack.history(conversation), at)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ sources: { slack: { ...PROFILE, cli: bridge.cli } } })
  sources.register(slackKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    problems: new Map(), ready: Promise.resolve(), configured: () => true, receive }
  const context = sourceContextOf(parts, { kind: 'slack', health: ['slack', 'history:slack'] })
  const calls = (method: string) => bridge.calls().filter(call => call.method === method)
  const history = () => calls('conversations.history')
  const start = async () => {
    const controller = new AbortController()
    const running = runSlack(context, controller.signal)
    return { stop: async () => { controller.abort(); await running } }
  }
  const settled = async (): Promise<void> => {
    await vi.waitFor(() => expect(['ready', 'error']).toContain(board.all['history:slack']?.state), { timeout: 10_000 })
  }
  return { dir, store, board, context, engine, receive, calls, history, start, settled }
}

const running = new Set<{ stop: () => Promise<void> }>()
const dirs = new Set<string>()
afterEach(async () => {
  for (const run of running) await run.stop()
  running.clear()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.clear()
})
async function boot(h: Harness): Promise<{ stop: () => Promise<void> }> {
  const handle = await h.start()
  running.add(handle)
  return handle
}

describe('Slack history backfill', () => {
  it('reads nothing on first sight, records cursors for configured and known conversations, and caches names', async () => {
    const h = historyHost({
      chats: [{ conversationId: 'C0PUBLIC1', listen: 'all' }],
      stored: { C0STORED2: false },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.info:C0STORED2': [{ ok: true, channel: { id: 'C0STORED2', name: 'random', is_member: true, is_private: false } }],
      },
    })
    const run = await boot(h)
    await h.settled()
    expect(h.history()).toEqual([])
    expect(Number.isFinite(Date.parse(h.store.get(KV.slack.history('C0PUBLIC1'))!))).toBe(true)
    expect(Number.isFinite(Date.parse(h.store.get(KV.slack.history('C0STORED2'))!))).toBe(true)
    expect(h.store.get(KV.sources.labels('slack'))).toMatchObject({ C0PUBLIC1: 'general', C0STORED2: 'random' })
    expect(h.board.all['history:slack']).toMatchObject({ state: 'ready', detail: 'Up to date' })
    await run.stop()
  })

  it('reads from five seconds before the cursor, follows pages, and replays newest-first pages oldest-first', async () => {
    const cursor = new Date(Date.now() - 60_000).toISOString()
    const h = historyHost({
      cursors: { C0PUBLIC1: cursor },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.history:C0PUBLIC1': [
          { ok: true, has_more: true, messages: [message(seconds(-10)), message(seconds(-20))], response_metadata: { next_cursor: 'page-2' } },
          { ok: true, has_more: false, messages: [message(seconds(-30))], response_metadata: { next_cursor: '' } },
        ],
      },
    })
    const run = await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(3), { timeout: 10_000 })
    const replayed = h.receive.mock.calls.map(call => (call[0] as Trigger).meta.ts)
    expect(replayed).toEqual([seconds(-30), seconds(-20), seconds(-10)])
    const pages = h.history()
    expect(pages).toHaveLength(2)
    expect(Math.abs(Number(pages[0]!.body.oldest) * 1000 - (Date.parse(cursor) - 5000))).toBeLessThan(2000)
    expect(Math.abs(Number(pages[0]!.body.latest) * 1000 - Date.now())).toBeLessThan(5000)
    expect(pages[0]!.body.limit).toBe(200)
    expect(pages[1]!.body.cursor).toBe('page-2')
    expect(h.board.all['history:slack']).toMatchObject({ state: 'ready', detail: 'Up to date' })
    await run.stop()
  })

  it('caps a very old cursor at the configured backfill window', async () => {
    const cursor = new Date(Date.now() - 20 * 24 * 3600_000).toISOString()
    const h = historyHost({
      cursors: { C0PUBLIC1: cursor },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.history:C0PUBLIC1': [emptyHistory],
      },
    })
    const run = await boot(h)
    await h.settled()
    const [request] = h.history()
    expect(Math.abs(Number(request!.body.oldest) * 1000 - (Date.now() - 14 * 24 * 3600_000))).toBeLessThan(3000)
    await run.stop()
  })

  it('follows a thread with activity after the cursor without replaying its older replies', async () => {
    const cursor = new Date(Date.now() - 60_000).toISOString()
    const root = seconds(-30)
    const h = historyHost({
      cursors: { C0PUBLIC1: cursor },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.history:C0PUBLIC1': [{ ok: true, has_more: false, messages: [
          message(root, { text: 'root', reply_count: 2, latest_reply: seconds(-10) }),
        ], response_metadata: { next_cursor: '' } }],
        [`conversations.replies:C0PUBLIC1:${root}`]: [{ ok: true, has_more: false, messages: [
          message(root, { text: 'root', thread_ts: root }),
          message(seconds(-120), { text: 'old reply', thread_ts: root }),
          message(seconds(-10), { text: 'new reply', thread_ts: root }),
        ], response_metadata: { next_cursor: '' } }],
      },
    })
    const run = await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    const replayed = h.receive.mock.calls.map(call => (call[0] as Trigger).meta.ts)
    expect(replayed).toEqual([root, seconds(-10)])
    const replies = h.calls('conversations.replies')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.body).toMatchObject({ ts: root, limit: 200 })
    await run.stop()
  })

  it('keeps the cursor and reports the failure when a conversation read fails', async () => {
    const cursor = new Date(Date.now() - 3_600_000).toISOString()
    const h = historyHost({
      cursors: { C0PUBLIC1: cursor },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.history:C0PUBLIC1': [{ ok: false, error: 'internal_error' }],
      },
    })
    const run = await boot(h)
    await h.settled()
    expect(h.board.all['history:slack']).toMatchObject({ state: 'error', detail: expect.stringContaining('C0PUBLIC1: Error: conversations.history failed: internal_error') })
    expect(h.store.get(KV.slack.history('C0PUBLIC1'))).toBe(cursor)
    await run.stop()
  })

  it('reports a rate limit as a ready detail and does not advance the cursor', async () => {
    const cursor = new Date(Date.now() - 3_600_000).toISOString()
    const h = historyHost({
      cursors: { C0PUBLIC1: cursor },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.history:C0PUBLIC1': [{ ok: false, error: 'ratelimited' }],
      },
    })
    const run = await boot(h)
    await h.settled()
    expect(h.board.all['history:slack']).toMatchObject({ state: 'ready', code: 'slackRateLimited' })
    expect(h.store.get(KV.slack.history('C0PUBLIC1'))).toBe(cursor)
    await run.stop()
  })

  it('does not replay an already-admitted message when a window is read again', async () => {
    const cursor = new Date(Date.now() - 60_000).toISOString()
    const ts = seconds(-30)
    const h = historyHost({
      cursors: { C0PUBLIC1: cursor },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: true, is_private: false } }],
        'conversations.history:C0PUBLIC1': [{ ok: true, has_more: false, messages: [message(ts)], response_metadata: { next_cursor: '' } }],
      },
    })
    const first = await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    await first.stop()
    h.store.set(KV.slack.history('C0PUBLIC1'), cursor)
    const second = await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(h.store.triggers.get(slackTriggerId('C0PUBLIC1', ts))).toBeDefined()
    await second.stop()
  })

  it('joins a listed public conversation it is not in, never a private one, and keeps the private failure visible', async () => {
    const h = historyHost({
      chats: [{ conversationId: 'C0PUBLIC1', listen: 'all' }, { conversationId: 'G0PRIVATE1', listen: 'all' }],
      cursors: { C0PUBLIC1: new Date(Date.now() - 60_000).toISOString() },
      plan: {
        'conversations.info:C0PUBLIC1': [{ ok: true, channel: { id: 'C0PUBLIC1', name: 'general', is_member: false, is_private: false } }],
        'conversations.info:G0PRIVATE1': [{ ok: true, channel: { id: 'G0PRIVATE1', name: 'secret', is_member: false, is_private: true } }],
        'conversations.join:C0PUBLIC1': [{ ok: true }],
        'conversations.history:C0PUBLIC1': [emptyHistory],
      },
    })
    const run = await boot(h)
    await h.settled()
    expect(h.calls('conversations.join').map(call => call.body.channel)).toEqual(['C0PUBLIC1'])
    expect(h.history().map(call => call.body.channel)).toEqual(['C0PUBLIC1'])
    expect(h.board.all['history:slack']).toMatchObject({ state: 'error', code: 'slackNotAMember',
      detail: expect.stringContaining('G0PRIVATE1') })
    expect(h.store.get(KV.slack.history('C0PUBLIC1'))).toBeDefined()
    expect(h.store.get(KV.slack.history('G0PRIVATE1'))).toBeDefined()
    await run.stop()
  })

  it('reports a failed join as not-a-member while the other conversations keep backfilling', async () => {
    const h = historyHost({
      chats: [{ conversationId: 'C0ARCHIVED', listen: 'all' }, { conversationId: 'C0GOOD123', listen: 'all' }],
      cursors: { C0GOOD123: new Date(Date.now() - 60_000).toISOString() },
      plan: {
        'conversations.info:C0ARCHIVED': [{ ok: true, channel: { id: 'C0ARCHIVED', name: 'old', is_member: false, is_private: false, is_archived: true } }],
        'conversations.info:C0GOOD123': [{ ok: true, channel: { id: 'C0GOOD123', name: 'good', is_member: false, is_private: false } }],
        'conversations.join:C0ARCHIVED': [{ ok: false, error: 'is_archived' }],
        'conversations.join:C0GOOD123': [{ ok: true }],
        'conversations.history:C0GOOD123': [emptyHistory],
      },
    })
    const run = await boot(h)
    await h.settled()
    expect(h.calls('conversations.join').map(call => call.body.channel)).toEqual(['C0ARCHIVED', 'C0GOOD123'])
    expect(h.history().map(call => call.body.channel)).toEqual(['C0GOOD123'])
    expect(h.board.all['history:slack']).toMatchObject({ state: 'error', code: 'slackNotAMember',
      detail: expect.stringContaining('C0ARCHIVED') })
    expect(h.store.get(KV.slack.history('C0GOOD123'))).toBeDefined()
    await run.stop()
  })
})
