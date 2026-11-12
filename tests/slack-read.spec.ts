/** Slack thread-context reads through a fake bridge: the five parts, pagination, and the top-level fallback. */
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { slackKind } from '../src/sources/slack.ts'
import { slackRead, slackReferences, slackThreadContext } from '../src/sources/slack-read.ts'
import { slackRef, slackRepliesTo, slackTerms, slackTrigger, slackTriggerId } from '../src/sources/slack-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const BOT = { botId: 'B01234567', userId: 'U0BOT' }
const PROFILE = { teamId: 'T01234567', url: 'https://acme.slack.com/' }
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A fake slack-bridge executable that answers `api` calls from canned Slack bodies keyed by method and page. */
function fakeBridge(answers: Record<string, unknown>, broken: { fail?: Record<string, string>; raw?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-read-'))
  directories.push(dir)
  const cli = join(dir, 'slack-bridge.cjs')
  const log = join(dir, 'calls.log')
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs')
const [, , mode, method, raw] = process.argv
if (mode !== 'api') process.exit(2)
fs.appendFileSync(${JSON.stringify(log)}, method + ' ' + raw + '\\n')
const params = JSON.parse(raw)
const key = method === 'conversations.history' ? method + (params.oldest ? ':message' : ':around')
  : method + (params.cursor ? ':' + params.cursor : '')
const failures = ${JSON.stringify(broken.fail ?? {})}
if (failures[key]) { process.stderr.write(failures[key] + '\\n'); process.exit(1) }
const raws = ${JSON.stringify(broken.raw ?? {})}
if (raws[key] !== undefined) { process.stdout.write(raws[key]); process.exit(0) }
const answers = ${JSON.stringify(answers)}
const body = answers[key] ?? answers[method]
if (body === undefined) { process.stderr.write('unexpected call: ' + key + '\\n'); process.exit(2) }
process.stdout.write(JSON.stringify(body))
`, { mode: 0o755 })
  chmodSync(cli, 0o755)
  const profile = { cli, teamId: 'T01234567', team: 'Acme', botId: 'B01234567', userId: 'U0BOT', name: 'superagent',
    url: 'https://acme.slack.com/' }
  const commands = new Commands(() => testDeployment({ sources: { slack: profile } }), {}, new AbortController().signal)
  return { dir, cli, commands, calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] }
}
const page = (messages: unknown[], next = '') => ({ ok: true, messages, has_more: !!next, response_metadata: { next_cursor: next } })
const message = (overrides: Record<string, unknown> = {}) => ({ type: 'message', channel: 'C0123ABCD', channel_type: 'channel',
  user: 'U0123ABCD', text: 'hello', ts: '1712345678.000100', ...overrides })
const trigger = (overrides: Record<string, unknown> = {}) => slackTrigger(message(overrides), BOT, PROFILE)!

describe('Slack trigger references', () => {
  it('anchors a top-level message to its conversation and timestamp', () => {
    expect(slackRef(trigger())).toEqual({ triggerId: slackTriggerId('C0123ABCD', '1712345678.000100'),
      conversation: 'C0123ABCD', ts: '1712345678.000100' })
  })

  it('keeps the thread root for a reply', () => {
    expect(slackRef(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' })))
      .toEqual({ triggerId: slackTriggerId('C0123ABCD', '1712345678.000200'), conversation: 'C0123ABCD',
        ts: '1712345678.000200', threadTs: '1712345678.000100' })
  })

  it('maps a reply to its parent Trigger and a top-level message to none', () => {
    expect(slackRepliesTo(trigger())).toBeUndefined()
    expect(slackRepliesTo(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' })))
      .toBe(slackTriggerId('C0123ABCD', '1712345678.000100'))
  })

  it('turns archive links into Trigger terms, ignoring other text and duplicates', () => {
    const link = 'https://acme.slack.com/archives/C0123ABCD/p1712345678000100?thread_ts=1712345678.000100'
    expect(slackTerms(`see ${link} and ${link}`)).toEqual([slackTriggerId('C0123ABCD', '1712345678.000100')])
  })

  it('finds no terms without an archive link', () => {
    expect(slackTerms('no link here')).toEqual([])
  })

  it('names the five read resources for a Trigger', () => {
    const id = slackTriggerId('C0123ABCD', '1712345678.000100')
    expect(slackReferences({ triggerId: id, conversation: 'C0123ABCD', ts: '1712345678.000100' }))
      .toEqual({ message: `slack/${id}/message`, root: `slack/${id}/root`, parent: `slack/${id}/parent`,
        thread: `slack/${id}/thread`, around: `slack/${id}/around` })
  })
})

describe('Slack message read', () => {
  it('fetches the trigger message alone and maps its text, sender, time and link', async () => {
    const bridge = fakeBridge({ 'conversations.history:message': page([{ type: 'message', user: 'U0123ABCD',
      text: 'the <@U0OTHER> message & <https://example.com|edited>', ts: '1712345678.000100' }]) })
    const ref = slackRef(trigger())!
    expect(await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message`, 50)).toEqual({
      status: 'available',
      message: { id: '1712345678.000100', from: 'U0123ABCD', at: '2024-04-05T19:34:38.000Z',
        text: 'the @U0OTHER message & edited (https://example.com)',
        url: 'https://acme.slack.com/archives/C0123ABCD/p1712345678000100' },
    })
    expect(bridge.calls()).toEqual([`conversations.history ${JSON.stringify({ channel: 'C0123ABCD',
      oldest: '1712345678.000100', latest: '1712345678.000100', inclusive: true, limit: 1 })}`])
  })

  it('reports a missing message as an empty read', async () => {
    const bridge = fakeBridge({ 'conversations.history:message': page([]) })
    const ref = slackRef(trigger())!
    expect(await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message`, 50))
      .toEqual({ status: 'missing', message: null })
  })

  it('reads a bot reply as a bot message carrying its thread root', async () => {
    const bridge = fakeBridge({ 'conversations.history:message': page([{ type: 'message', bot_id: 'B09999999',
      text: 'on it', ts: '1712345678.000200', thread_ts: '1712345678.000100' }]) })
    const ref = slackRef(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' }))!
    expect(await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message`, 50)).toEqual({
      status: 'available',
      message: { id: '1712345678.000200', from: 'B09999999', at: '2024-04-05T19:34:38.000Z', text: 'on it', bot: true,
        reply_to: '1712345678.000100', url: 'https://acme.slack.com/archives/C0123ABCD/p1712345678000200' },
    })
  })
})

describe('Slack root and parent reads', () => {
  it('reads the thread root of a reply with limit one', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([{ type: 'message', user: 'U0ROOT',
      text: 'the ask', ts: '1712345678.000100' }]) })
    const ref = slackRef(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' }))!
    expect(await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/root`, 50)).toEqual({
      status: 'available',
      message: { id: '1712345678.000100', from: 'U0ROOT', at: '2024-04-05T19:34:38.000Z', text: 'the ask',
        url: 'https://acme.slack.com/archives/C0123ABCD/p1712345678000100' },
    })
    expect(bridge.calls()).toEqual([`conversations.replies ${JSON.stringify({ channel: 'C0123ABCD',
      ts: '1712345678.000100', limit: 1 })}`])
  })

  it('reads a top-level message as its own root', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([{ type: 'message', user: 'U0123ABCD',
      text: 'hello', ts: '1712345678.000100' }]) })
    const ref = slackRef(trigger())!
    expect((await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/root`, 50)).status).toBe('available')
    expect(bridge.calls()).toEqual([`conversations.replies ${JSON.stringify({ channel: 'C0123ABCD',
      ts: '1712345678.000100', limit: 1 })}`])
  })

  it('reports no root when Slack returns no messages', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([]) })
    const ref = slackRef(trigger())!
    expect(await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/root`, 50))
      .toEqual({ status: 'no_root', message: null })
  })

  it('reads the parent of a reply from its thread root and makes no call for a top-level message', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([{ type: 'message', user: 'U0ROOT',
      text: 'the ask', ts: '1712345678.000100' }]) })
    const reply = slackRef(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' }))!
    expect((await slackRead(bridge.commands, reply, `slack/${reply.triggerId}/parent`, 50)).status).toBe('available')
    expect(bridge.calls()).toHaveLength(1)
    const top = slackRef(trigger())!
    expect(await slackRead(bridge.commands, top, `slack/${top.triggerId}/parent`, 50))
      .toEqual({ status: 'no_parent', message: null })
    expect(bridge.calls()).toHaveLength(1)
  })
})

describe('Slack thread read', () => {
  const root = (ts = '1712345678.000100') => ({ type: 'message', user: 'U0ROOT', text: 'the ask', ts })
  const reply = (ts: string, text = `reply at ${ts}`) => ({ type: 'message', user: 'U0123ABCD', text, ts,
    thread_ts: '1712345678.000100' })

  it('reads one bounded page oldest first and points at the next cursor', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([reply('1712345678.000300'),
      root(), reply('1712345678.000200')], 'page-2') })
    const ref = slackRef(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' }))!
    const body = await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/thread`, 10)
    expect(body.status).toBe('available')
    expect('messages' in body ? body.messages.map(item => item.id) : [])
      .toEqual(['1712345678.000100', '1712345678.000200', '1712345678.000300'])
    expect('next_resource' in body ? body.next_resource : undefined).toBe(`slack/${ref.triggerId}/thread/page-2`)
    expect(bridge.calls()).toEqual([`conversations.replies ${JSON.stringify({ channel: 'C0123ABCD',
      ts: '1712345678.000100', limit: 10 })}`])
  })

  it('follows the cursor and stops when Slack has no more replies', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([reply('1712345678.000300'), root()], 'page-2'),
      'conversations.replies:page-2': page([reply('1712345678.000500'), reply('1712345678.000400')]) })
    const ref = slackRef(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' }))!
    const body = await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/thread/${encodeURIComponent('page-2')}`, 10)
    expect('messages' in body ? body.messages.map(item => item.id) : [])
      .toEqual(['1712345678.000400', '1712345678.000500'])
    expect('next_resource' in body ? body.next_resource : undefined).toBeNull()
    expect(bridge.calls()).toEqual([`conversations.replies ${JSON.stringify({ channel: 'C0123ABCD',
      ts: '1712345678.000100', limit: 10, cursor: 'page-2' })}`])
  })

  it('reports no_thread without calling Slack for a top-level message', async () => {
    const bridge = fakeBridge({})
    const ref = slackRef(trigger())!
    expect(await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/thread`, 10))
      .toEqual({ status: 'no_thread', messages: [], next_resource: null })
    expect(bridge.calls()).toEqual([])
  })
})

describe('Slack around read', () => {
  it('returns the page ending at a top-level message oldest first and pages older', async () => {
    const bridge = fakeBridge({ 'conversations.history:around': page([
      { type: 'message', user: 'U0BEFORE', text: 'third', ts: '1712345678.000090' },
      { type: 'message', user: 'U0BEFORE', text: 'second', ts: '1712345678.000080' },
      { type: 'message', user: 'U0BEFORE', text: 'first', ts: '1712345678.000070' },
    ], 'older') })
    const ref = slackRef(trigger())!
    const body = await slackRead(bridge.commands, ref, `slack/${ref.triggerId}/around`, 10)
    expect('messages' in body ? body.messages.map(item => [item.id, item.text]) : []).toEqual([
      ['1712345678.000070', 'first'], ['1712345678.000080', 'second'], ['1712345678.000090', 'third']])
    expect('next_resource' in body ? body.next_resource : undefined).toBe(`slack/${ref.triggerId}/around/older`)
    expect(bridge.calls()).toEqual([`conversations.history ${JSON.stringify({ channel: 'C0123ABCD',
      latest: '1712345678.000100', limit: 10 })}`])
  })
})

describe('Slack read failures', () => {
  it('names the conversation when Slack answers with an error', async () => {
    const bridge = fakeBridge({ 'conversations.history:message': { ok: false, error: 'channel_not_found' } })
    const ref = slackRef(trigger())!
    await expect(slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message`, 50))
      .rejects.toThrow('Slack read failed in C0123ABCD: channel_not_found')
  })

  it('names the conversation when the bridge cannot reach Slack', async () => {
    const bridge = fakeBridge({}, { fail: { 'conversations.history:message': 'Slack API request failed' } })
    const ref = slackRef(trigger())!
    await expect(slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message`, 50))
      .rejects.toThrow(/Slack read failed in C0123ABCD/)
  })

  it('rejects a bridge answer that is not JSON', async () => {
    const bridge = fakeBridge({}, { raw: { 'conversations.history:message': 'not json' } })
    const ref = slackRef(trigger())!
    await expect(slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message`, 50))
      .rejects.toThrow('Slack read failed in C0123ABCD: the bridge returned invalid JSON')
  })

  it('only accepts a cursor on thread and around, and only this Trigger', async () => {
    const bridge = fakeBridge({})
    const ref = slackRef(trigger())!
    await expect(slackRead(bridge.commands, ref, `slack/${ref.triggerId}/message/next`, 50)).rejects.toThrow(/follow returned next_resource/)
    await expect(slackRead(bridge.commands, { ...ref, triggerId: 'someone-else' }, `slack/${ref.triggerId}/message`, 50))
      .rejects.toThrow('A Slack source trigger is required')
  })
})

describe('Slack thread context', () => {
  it('reads the trigger message id from meta', () => {
    expect(slackThreadContext.messageId(trigger())).toBe('1712345678.000100')
  })

  it('decodes the next thread cursor and keeps the page body', async () => {
    const bridge = fakeBridge({ 'conversations.replies': page([{ type: 'message', user: 'U0ROOT', text: 'the ask',
      ts: '1712345678.000100' }], 'page/2') })
    const read = await slackThreadContext.read(bridge.commands, trigger({ thread_ts: '1712345678.000100',
      ts: '1712345678.000200' }), 'thread', undefined, { readPageSize: 10 })
    expect(read.messages.map(item => item.id)).toEqual(['1712345678.000100'])
    expect(read.next).toBe('page/2')
    expect(read.status).toBe('available')
    expect(read.body).toMatchObject({ status: 'available',
      next_resource: `slack/${slackTriggerId('C0123ABCD', '1712345678.000200')}/thread/page%2F2` })
  })

  it('falls back to the messages around a top-level message', async () => {
    const bridge = fakeBridge({ 'conversations.history:around': page([
      { type: 'message', user: 'U0BEFORE', text: 'before', ts: '1712345678.000090' }]) })
    const read = await slackThreadContext.read(bridge.commands, trigger(), 'thread', undefined, { readPageSize: 10 })
    expect(read.status).toBe('chat_neighbours')
    expect(read.next).toBeUndefined()
    expect(read.messages.map(item => [item.id, item.text])).toEqual([['1712345678.000090', 'before']])
    expect(read.body).toEqual({ status: 'chat_neighbours', messages: read.messages })
    expect(bridge.calls()).toEqual([`conversations.history ${JSON.stringify({ channel: 'C0123ABCD',
      latest: '1712345678.000100', limit: 10 })}`])
  })

  it('turns an archive link into a Thread search term and maps replies to parents', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(slackKind)
    expect(sources.find('see https://acme.slack.com/archives/C0123ABCD/p1712345678000100')).toEqual({
      threads: [], terms: [slackTriggerId('C0123ABCD', '1712345678.000100')] })
    expect(sources.repliesTo(trigger())).toBeUndefined()
    expect(sources.repliesTo(trigger({ thread_ts: '1712345678.000100', ts: '1712345678.000200' })))
      .toBe(slackTriggerId('C0123ABCD', '1712345678.000100'))
  })

  it('serves no images through the registry', async () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(slackKind)
    const context = sources.threadContext(trigger(), SettingsSchema.parse({ sources: { slack: { enabled: true, config: {} } } }))!
    expect(context.images('anything')).toEqual([])
    await expect(context.image(undefined as never, {} as never, { id: '1712345678.000100', text: 'x' }, 'key', '/tmp', new AbortController().signal))
      .rejects.toThrow('The slack Source has no images')
  })
})
