/** Slack event translation: deterministic ids, mrkdwn, threads, DMs, and dropped senders. */
import { describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { mrkdwnText, slackChannel, slackThreadId, slackTrigger, slackTriggerId } from '../src/sources/slack-trigger.ts'
import type { SlackProfile } from '../src/sources/slack-setup.ts'

const profile: SlackProfile = { cli: '/bin/false', teamId: 'T01234567', team: 'Acme', botId: 'B01234567', userId: 'U0BOT', name: 'superagent', url: 'https://acme.slack.com/' }
const bot = { botId: profile.botId, userId: profile.userId }
const message = (overrides: Record<string, unknown> = {}) => ({
  type: 'message', channel: 'C0123ABCD', channel_type: 'channel', user: 'U0123ABCD', text: 'hello', ts: '1712345678.000100', ...overrides,
})

describe('mrkdwnText', () => {
  it('translates Slack tokens and entities, leaving emphasis alone', () => {
    expect(mrkdwnText('Hi <@U0999> in <#C0123ABCD|general>, read <https://example.com|the docs> or <https://example.com>'))
      .toBe('Hi @U0999 in #general, read the docs (https://example.com) or https://example.com')
    expect(mrkdwnText('<@U0999> <!here> <!channel> <!everyone>', { U0999: 'Ada' })).toBe('@Ada @here @channel @everyone')
    expect(mrkdwnText('<!date^1712345678^{date_short}|May 5, 2024> *bold* _italic_ ~strike~'))
      .toBe('May 5, 2024 *bold* _italic_ ~strike~')
    expect(mrkdwnText('Tom &amp; Jerry &lt;3 &gt;.')).toBe('Tom & Jerry <3 >.')
  })
})

describe('slackTrigger', () => {
  it('translates an app_mention into one deterministic Trigger in the thread', () => {
    const event = message({ type: 'app_mention', text: '<@U0BOT> fix the title', thread_ts: '1712345000.000100', ts: '1712345678.000100' })
    const trigger = slackTrigger(event, bot, profile)!
    expect(trigger).toMatchObject({
      id: key('slack', 'C0123ABCD:1712345678.000100'),
      source: 'slack',
      threads: [{ source: 'slack', id: 'C0123ABCD:1712345000.000100' }],
      actor: { source: 'slack', id: 'U0123ABCD' },
      human: true,
      addressed: 'mention',
      at: '2024-04-05T19:34:38.000Z',
      text: '@U0BOT fix the title',
      channel: { source: 'slack', thread: 'slack:C0123ABCD', address: { conversation: 'C0123ABCD', ts: '1712345678.000100', thread_ts: '1712345000.000100' } },
      url: 'https://acme.slack.com/archives/C0123ABCD/p1712345678000100',
      meta: { conversation: 'C0123ABCD', teamId: 'T01234567', ts: '1712345678.000100', threadTs: '1712345000.000100', mentioned: true },
    })
    expect(slackTrigger(event, bot, profile)!.id).toBe(trigger.id)
  })

  it('starts a Thread at the message itself for a top-level message and marks a DM direct', () => {
    const root = slackTrigger(message(), bot, profile)!
    expect(root.threads).toEqual([{ source: 'slack', id: 'C0123ABCD:1712345678.000100' }])
    expect(root).not.toHaveProperty('addressed')
    expect(root.text).not.toContain('<@U0BOT>')
    const dm = slackTrigger(message({ channel: 'D0123ABCD', channel_type: 'im', user: 'U0999', text: 'hi there' }), bot, profile)!
    expect(dm).toMatchObject({
      addressed: 'direct',
      threads: [{ source: 'slack', id: 'D0123ABCD:1712345678.000100' }],
      channel: { thread: 'slack:D0123ABCD', address: { conversation: 'D0123ABCD', ts: '1712345678.000100', direct: 'true' } },
      meta: { conversation: 'D0123ABCD', direct: 'true', mentioned: false },
    })
  })

  it('marks a mention in an ordinary message and keeps another bot as a candidate', () => {
    expect(slackTrigger(message({ text: 'hey <@U0BOT> look' }), bot, profile)!.addressed).toBe('mention')
    const otherBot = slackTrigger(message({ subtype: 'bot_message', bot_id: 'B0999', user: undefined, text: 'build failed' }), bot, profile)!
    expect(otherBot).toMatchObject({ actor: { source: 'slack', id: 'B0999' }, human: false })
    expect(otherBot).not.toHaveProperty('addressed')
    expect(otherBot.meta).toMatchObject({ mentioned: false })
  })

  it('drops self-echo, edits, deletes, hidden messages, and unsupported event types', () => {
    expect(slackTrigger(message({ bot_id: profile.botId }), bot, profile)).toBeUndefined()
    expect(slackTrigger(message({ user: profile.userId }), bot, profile)).toBeUndefined()
    expect(slackTrigger(message({ subtype: 'message_changed', text: 'edited' }), bot, profile)).toBeUndefined()
    expect(slackTrigger(message({ subtype: 'message_deleted' }), bot, profile)).toBeUndefined()
    expect(slackTrigger(message({ hidden: true }), bot, profile)).toBeUndefined()
    expect(slackTrigger({ type: 'reaction_added', channel: 'C0123ABCD', ts: '1' }, bot, profile)).toBeUndefined()
    expect(slackTrigger(message({ channel_type: 'mpim' }), bot, profile)).toBeUndefined()
  })

  it('forms the documented ids and channel addresses', () => {
    expect(slackTriggerId('C0123ABCD', '1712345678.000100')).toBe(key('slack', 'C0123ABCD:1712345678.000100'))
    expect(slackThreadId('C0123ABCD', undefined, '1712345678.000100')).toBe('C0123ABCD:1712345678.000100')
    expect(slackThreadId('C0123ABCD', '1712345000.000100', '1712345678.000100')).toBe('C0123ABCD:1712345000.000100')
    expect(slackChannel('C0123ABCD', '1712345678.000100')).toEqual({ source: 'slack', thread: 'slack:C0123ABCD', address: { conversation: 'C0123ABCD', ts: '1712345678.000100' } })
    expect(slackChannel('D0123ABCD', '1712345678.000100', { direct: true })).toEqual({ source: 'slack', thread: 'slack:D0123ABCD', address: { conversation: 'D0123ABCD', ts: '1712345678.000100', direct: 'true' } })
  })
})
