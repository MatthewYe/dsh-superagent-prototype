/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { health } from '../src/sources/host.ts'
import type { ChannelSendHost, SourceKind } from '../src/sources/kind.ts'
import { SlackSendError } from '../src/sources/slack-channel.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

const probe = (send: (host: ChannelSendHost, message: OutboundMessage) => Promise<'sent' | 'gone'>): SourceKind<Record<string, never>> => ({
  kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: ['probeHealth'],
  schema: z.object({}).strict(), fields: [],
  channel: { send, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) },
})

it('settles a permanent Channel rejection immediately and never retries it', async () => {
  let attempts = 0
  h.runtime.sources.register(probe(async () => { attempts++; throw new SlackSendError('msg_too_long', 'permanent') }))
  h.runtime.outbox.send({ id: 'permanent', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'too long', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('permanent'), attempts, h.runtime.store.receipts.get('permanent')?.dropped?.reason])
    .toEqual(['dropped', 1, 'channelGone'])
  await at(5000)
  expect(attempts).toBe(1)
})

it('settles a gone Channel immediately and never retries it', async () => {
  let attempts = 0
  h.runtime.sources.register(probe(async () => { attempts++; return 'gone' }))
  h.runtime.outbox.send({ id: 'gone', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'gone', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('gone'), attempts, h.runtime.store.receipts.get('gone')?.dropped?.reason])
    .toEqual(['dropped', 1, 'channelGone'])
  await at(5000)
  expect(attempts).toBe(1)
})

it('reports retryable Channel health and retries it', async () => {
  let attempts = 0
  h.runtime.sources.register(probe(async host => {
    attempts++
    host.report?.('probeHealth', health('error', 'slackTokenRevoked'))
    if (attempts === 1) throw new SlackSendError('invalid_auth', 'retryable', 'slackTokenRevoked')
    return 'sent'
  }))
  h.runtime.outbox.send({ id: 'auth', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'hello', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('auth'), attempts, h.runtime.health.probeHealth?.code])
    .toEqual(['pending', 1, 'slackTokenRevoked'])
  await at(5000)
  expect([h.runtime.outbox.status('auth'), attempts]).toEqual(['sent', 2])
})

it('keeps a recalled Feishu reply gone and a transport failure retryable', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockRejectedValueOnce(new CliError('message withdrawn', 230011))
  h.runtime.outbox.send({ id: 'feishu-gone', channel: feishu('1', 'x').channel!, text: 'gone', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('feishu-gone'), h.runtime.store.receipts.get('feishu-gone')?.dropped?.reason])
    .toEqual(['dropped', 'channelGone'])

  lark.mockRejectedValueOnce(new Error('network down'))
  h.runtime.outbox.send({ id: 'feishu-retry', channel: feishu('2', 'y').channel!, text: 'retry', kind: 'reply' })
  await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('feishu-retry')).toBe('pending')
  await at(5000)
  expect(h.runtime.outbox.status('feishu-retry')).toBe('sent')
})
