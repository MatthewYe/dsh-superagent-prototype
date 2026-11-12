/** The Slack Source's configuration and bridge probe. */
import { expect, it } from 'vitest'
import { SlackConfigSchema } from '../src/sources/slack.ts'

const conversation = { conversationId: 'C01234567', name: 'General', listen: 'mentions' as const }

it('defaults a Slack Source to no bridge, no chats, mentions only, direct messages and the documented read sizes', () => {
  expect(SlackConfigSchema.parse({})).toEqual({ cli: '', chats: [], otherChats: 'none', directMessages: true,
    readPageSize: 50, backfillDays: 14 })
  expect(SlackConfigSchema.parse({ cli: ' slack-bridge ', chats: [conversation], otherChats: 'mentions' })).toMatchObject({
    cli: 'slack-bridge', chats: [conversation], otherChats: 'mentions' })
})

it('refuses configuration keys a Slack Source does not use', () => {
  expect(() => SlackConfigSchema.parse({ channel: 'C01234567' })).toThrow()
})

it('refuses duplicate conversations and conversation ids Slack cannot use', () => {
  expect(() => SlackConfigSchema.parse({ chats: [conversation, conversation] })).toThrow('Duplicate conversation IDs')
  for (const conversationId of ['c01234567', 'general', 'C0123', 'D01234567'])
    expect(() => SlackConfigSchema.parse({ chats: [{ conversationId, listen: 'all' }] })).toThrow()
})

it('bounds the history pages and the days of backfill', () => {
  expect(() => SlackConfigSchema.parse({ readPageSize: 9 })).toThrow()
  expect(() => SlackConfigSchema.parse({ readPageSize: 101 })).toThrow()
  expect(() => SlackConfigSchema.parse({ backfillDays: 0 })).toThrow()
  expect(() => SlackConfigSchema.parse({ backfillDays: 15 })).toThrow()
})
