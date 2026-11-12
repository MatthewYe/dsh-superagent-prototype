/** Slack kind scope and admission: which conversations are listened to, which messages are admitted, and the reply limit. */
import { describe, expect, it } from 'vitest'
import { SlackConfigSchema, slackKind } from '../src/sources/slack.ts'
import { slackAdmitted, slackScope } from '../src/sources/slack-trigger.ts'

const config = SlackConfigSchema.parse({
  chats: [{ conversationId: 'C0123ABCD', listen: 'mentions' }, { conversationId: 'C0456EFGH', listen: 'all' }],
  otherChats: 'mentions', directMessages: true,
})
const scope = (meta: Record<string, unknown>) => slackScope(meta, config)

describe('slackKind.scope', () => {
  it('reports the row and whether unaddressed messages are observed', () => {
    expect(scope({ conversation: 'C0123ABCD' })).toEqual({ listened: true, observed: false, row: 'C0123ABCD' })
    expect(scope({ conversation: 'C0456EFGH' })).toEqual({ listened: true, observed: true, row: 'C0456EFGH' })
    expect(scope({ conversation: 'C0999ZZZZ' })).toEqual({ listened: true, observed: false, row: 'other' })
    expect(scope({ conversation: 'D0123ABCD', direct: 'true' })).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(scope({ conversation: 'D0123ABCD', direct: true })).toEqual({ listened: true, observed: false, row: 'direct' })
  })

  it('refuses direct messages and unlisted conversations when their switches are off', () => {
    const off = SlackConfigSchema.parse({ directMessages: false, otherChats: 'none' })
    expect(slackScope({ conversation: 'D0123ABCD', direct: 'true' }, off)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(slackScope({ conversation: 'C0999ZZZZ' }, off)).toEqual({ listened: false, reason: 'conversation_not_allowed' })
  })

  it('is wired into the kind and channel.allowed agrees with it', () => {
    expect(slackKind.scope!({ meta: { conversation: 'C0456EFGH' } }, config)).toEqual(scope({ conversation: 'C0456EFGH' }))
    expect(slackKind.channel!.allowed!({ conversation: 'C0123ABCD' }, config)).toBe(true)
    expect(slackKind.channel!.allowed!({ conversation: 'C0999ZZZZ' }, config)).toBe(true)
    expect(slackKind.channel!.allowed!({ conversation: 'D0123ABCD', direct: 'true' }, config)).toBe(true)
    expect(slackKind.channel!.allowed!({ conversation: 'C0999ZZZZ' }, { ...config, otherChats: 'none' })).toBe(false)
    expect(slackKind.channel!.allowed!({ conversation: 'D0123ABCD', direct: 'true' }, { ...config, directMessages: false })).toBe(false)
    expect(slackKind.channel!.words).toBe(100)
  })
})

describe('slackAdmitted', () => {
  it('admits unaddressed messages only where the row observes them', () => {
    expect(slackAdmitted(scope({ conversation: 'C0123ABCD' }), undefined)).toBe(false)
    expect(slackAdmitted(scope({ conversation: 'C0123ABCD' }), 'mention')).toBe(true)
    expect(slackAdmitted(scope({ conversation: 'C0456EFGH' }), undefined)).toBe(true)
    expect(slackAdmitted(scope({ conversation: 'C0999ZZZZ' }), undefined)).toBe(false)
    expect(slackAdmitted(scope({ conversation: 'C0999ZZZZ' }), 'mention')).toBe(true)
    expect(slackAdmitted(scope({ conversation: 'D0123ABCD', direct: 'true' }), 'direct')).toBe(true)
    expect(slackAdmitted({ listened: false, reason: 'direct_messages_not_allowed' }, 'direct')).toBe(false)
  })
})
