/** Slack outbound Channel: bridge argv, threaded replies, error mapping, and archive links. */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { sendSlack, slackGone, slackLink, SlackSendError } from '../src/sources/slack-channel.ts'
import { testDeployment } from './fixtures/deployment.ts'

const address = { conversation: 'C0123ABCD', ts: '1712345678.000100', thread_ts: '1712345000.000100' }
const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'reply-1', channel: { source: 'slack', thread: 'slack:C0123ABCD', address }, text: 'Fixed it.', kind: 'reply', ...overrides,
})
const host = (answer: unknown) => {
  const slack = vi.fn(async (_args: string[]) => JSON.stringify(answer))
  return { slack, host: { commands: { slack } as unknown as Commands } }
}

describe('sendSlack', () => {
  it('posts one threaded chat.postMessage through the bridge, without client ids or blocks', async () => {
    const { slack, host: h } = host({ ok: true, ts: '1712345679.000100' })
    await expect(sendSlack(h, message())).resolves.toBe('sent')
    const args = slack.mock.calls[0]![0]
    expect(args.slice(0, 2)).toEqual(['api', 'chat.postMessage'])
    expect(JSON.parse(args[2]!)).toEqual({ channel: 'C0123ABCD', text: 'Fixed it.', thread_ts: '1712345000.000100' })
    expect(args[2]).not.toContain('client_msg_id')
    expect(args[2]).not.toContain('blocks')
  })

  it('threads a top-level message under its own ts', async () => {
    const { slack, host: h } = host({ ok: true })
    await sendSlack(h, message({ channel: { source: 'slack', thread: 'slack:D0123ABCD', address: { conversation: 'D0123ABCD', ts: '1712345678.000100' } } }))
    expect(JSON.parse(slack.mock.calls[0]![0][2]!)).toMatchObject({ channel: 'D0123ABCD', thread_ts: '1712345678.000100' })
  })

  it('reports a permanently unreachable Channel as gone', async () => {
    for (const error of ['channel_not_found', 'not_in_channel', 'is_archived', 'channel_is_archived']) {
      const { host: h } = host({ ok: false, error })
      await expect(sendSlack(h, message())).resolves.toBe('gone')
      expect(slackGone(error)).toBe(true)
    }
    expect(slackGone('ratelimited')).toBe(false)
  })

  it('maps Slack error codes to retryable, permanent, and health outcomes', async () => {
    const failure = async (answer: Record<string, unknown>) => sendSlack(host(answer).host, message()).catch((error: unknown) => error)
    expect(await failure({ ok: false, error: 'msg_too_long' })).toMatchObject({ code: 'msg_too_long', outcome: 'permanent' })
    expect(await failure({ ok: false, error: 'invalid_arguments' })).toMatchObject({ code: 'invalid_arguments', outcome: 'permanent' })
    expect(await failure({ ok: false, error: 'invalid_blocks' })).toMatchObject({ code: 'invalid_blocks', outcome: 'permanent' })
    expect(await failure({ ok: false, error: 'invalid_auth' })).toMatchObject({ code: 'invalid_auth', outcome: 'retryable', health: 'slackTokenRevoked' })
    expect(await failure({ ok: false, error: 'token_revoked' })).toMatchObject({ code: 'token_revoked', outcome: 'retryable', health: 'slackTokenRevoked' })
    expect(await failure({ ok: false, error: 'ratelimited' })).toMatchObject({ code: 'ratelimited', outcome: 'retryable', health: 'slackRateLimited' })
    const scope = await failure({ ok: false, error: 'missing_scope', needed: 'chat:write' })
    expect(scope).toMatchObject({ code: 'missing_scope', outcome: 'permanent', health: 'slackTokenRevoked' })
    expect(String(scope)).toContain('chat:write')
    expect(await failure({ ok: false, error: 'some_new_error' })).toMatchObject({ code: 'some_new_error', outcome: 'retryable' })
    expect(await failure({ ok: false, error: 'some_new_error' })).toBeInstanceOf(SlackSendError)
  })

  it('rejects a reply with no conversation target and a bridge answer that is not JSON', async () => {
    const { host: h } = host({ ok: true })
    await expect(sendSlack(h, message({ channel: { source: 'slack', thread: 'slack:', address: {} } }))).rejects.toThrow('Missing Slack reply target')
    const bad = { commands: { slack: vi.fn(async () => 'not json') } as unknown as Commands }
    await expect(sendSlack(bad, message())).rejects.toThrow('Slack bridge returned no JSON')
  })
})

describe('slackLink', () => {
  it('builds the archive URL and Trigger id from the resolved workspace URL', () => {
    expect(slackLink(address, { sources: { slack: { url: 'https://acme.slack.com/' } } })).toEqual({
      url: 'https://acme.slack.com/archives/C0123ABCD/p1712345678000100',
      label: { zh: 'Slack 消息', en: 'Slack message' },
      triggerId: key('slack', 'C0123ABCD:1712345678.000100'),
    })
  })

  it('leaves the URL empty when the deployment has no workspace URL', () => {
    expect(slackLink(address, { sources: {} })).toEqual({ url: '', label: { zh: 'Slack 消息', en: 'Slack message' }, triggerId: key('slack', 'C0123ABCD:1712345678.000100') })
  })
})

describe('Commands.slack', () => {
  it('runs the configured bridge and parses its JSON answer', async () => {
    const commands = new Commands(() => ({ ...testDeployment(), sources: { slack: { cli: '/path/slack-bridge' } } }), {}, new AbortController().signal)
    const run = vi.spyOn(commands, 'run').mockResolvedValue('{"ok":true,"team":"Acme"}')
    await expect(commands.slackJson(['api', 'auth.test'], z.object({ ok: z.boolean(), team: z.string() }))).resolves.toEqual({ ok: true, team: 'Acme' })
    expect(run).toHaveBeenCalledWith('/path/slack-bridge', ['api', 'auth.test'])
    await expect(new Commands(() => ({ ...testDeployment(), sources: {} }), {}, new AbortController().signal).slack(['auth'])).rejects.toThrow('The Slack Source has no working bridge')
  })
})
