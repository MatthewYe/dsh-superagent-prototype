/** The Slack Source's configuration and bridge probe. */
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import type { Probe } from '../src/deployment.ts'
import { resolveSlackProfile } from '../src/sources/slack-setup.ts'
import { SlackConfigSchema } from '../src/sources/slack.ts'
import { testMachine } from './fixtures/deployment.ts'

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

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
/** A fake bridge executable, so the probe runs a real file instead of Slack. */
function bridge(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'slack-bridge-'))
  directories.push(directory)
  const file = join(directory, 'slack-bridge')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return file
}
const execute: Probe = async argv => {
  const [file, ...args] = argv
  return (await promisify(execFile)(file!, args)).stdout
}
const identity = { ok: true, url: 'https://acme.slack.com/', team: 'Acme', user: 'superagent', team_id: 'T01234567',
  user_id: 'U01234567', bot_id: 'B01234567' }
const answer = (value: unknown) => bridge(`if [ "$1" = "--version" ]; then echo 0.1.0; exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "auth.test" ]; then printf '%s' '${JSON.stringify(value)}'; exit 0; fi
exit 2`)

it('resolves the workspace and bot through the bridge, including the bot name the card shows', async () => {
  const cli = answer(identity)
  expect(await resolveSlackProfile(testMachine(), { cli }, execute, '')).toEqual({ cli, teamId: 'T01234567', team: 'Acme',
    botId: 'B01234567', userId: 'U01234567', name: 'superagent', url: 'https://acme.slack.com/' })
})

it('treats an empty bridge path as no Slack app, without running anything', async () => {
  let ran = false
  expect(await resolveSlackProfile(testMachine(), { cli: '' }, async () => { ran = true; return '' }, '')).toBeUndefined()
  expect(ran).toBe(false)
})

it('reports a missing or unusable bridge as one typed problem', async () => {
  await expect(resolveSlackProfile(testMachine(), { cli: join(tmpdir(), 'no-such-slack-bridge') }, execute, ''))
    .rejects.toMatchObject({ code: 'slackBridgeMissing', place: 'slack' })
  const broken = bridge(`if [ "$1" = "--version" ]; then echo 'cannot start' >&2; exit 1; fi\nexit 2`)
  await expect(resolveSlackProfile(testMachine(), { cli: broken }, execute, '')).rejects.toMatchObject({ code: 'slackBridgeMissing' })
})

it('reports an answer it cannot read as one typed problem', async () => {
  const cli = bridge(`if [ "$1" = "--version" ]; then echo 0.1.0; exit 0; fi\nif [ "$1" = "api" ]; then echo 'not json'; exit 0; fi\nexit 2`)
  await expect(resolveSlackProfile(testMachine(), { cli }, execute, '')).rejects.toMatchObject({ code: 'slackBridgeFailed' })
})

it('reports a token Slack rejects with Slack\'s error', async () => {
  const cli = answer({ ok: false, error: 'invalid_auth' })
  await expect(resolveSlackProfile(testMachine(), { cli }, execute, '')).rejects.toMatchObject({ code: 'slackAuthFailed',
    values: { error: 'invalid_auth' } })
})
