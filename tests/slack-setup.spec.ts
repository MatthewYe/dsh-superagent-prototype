/** The Slack Source's configuration and bridge probe. */
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import type { Probe } from '../src/deployment.ts'
import { resolveSlackProfile } from '../src/sources/slack-setup.ts'
import { SlackConfigSchema, inject, name, slackHealth, slackKind, slackProfile } from '../src/sources/slack.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { SettingsSchema } from '../src/policy.ts'
import { resolveSourceProfiles } from '../src/app/setup.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

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
    expect(() => SlackConfigSchema.parse({ chats: [{ conversationId, listen: 'all' }] })).toThrow('Slack conversation ID')
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

it('declares the settings fields, setup field, health rows and resolved bot fact', () => {
  expect(slackKind.setup?.fields).toEqual(['cli'])
  expect(slackKind.fields.map(field => field.key)).toEqual(['bot', 'cli', 'chats', 'otherChats', 'directMessages', 'readPageSize', 'backfillDays'])
  expect(slackKind.fields[0]).toMatchObject({ type: 'fact' })
  expect(slackKind.health).toEqual(['slack', 'history:slack'])
  const deployment = testDeployment({ sources: { slack: { cli: '/opt/bin/slack-bridge', teamId: 'T01234567', team: 'Acme',
    botId: 'B01234567', userId: 'U01234567', name: 'superagent', url: 'https://acme.slack.com/' } } })
  expect(slackKind.facts?.(deployment)).toEqual({ bot: { zh: '已连接到 Acme，机器人 @superagent', en: 'Connected to Acme as @superagent' } })
})

it('stores the Slack and Feishu profiles in their own deployment slots', async () => {
  const slackCli = answer(identity)
  const feishuCli = bridge(`if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"appId":"cli_bot","brand":"feishu","identities":{"bot":{"status":"ready"}}}'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "strict-mode" ]; then echo 'strict-mode: bot'; exit 0; fi
if [ "$1" = "api" ]; then echo '{"bot":{"open_id":"ou_bot","app_name":"Widgets Bot"}}'; exit 0; fi
exit 2`)
  const settings = SettingsSchema.parse({ sources: {
    slack: { enabled: true, config: { cli: slackCli, chats: [{ conversationId: 'C01234567', listen: 'all' }] } },
    feishu: { enabled: true, config: { cli: feishuCli } },
  } })
  const resolved = await resolveSourceProfiles({ machine: testMachine(), settings, kinds: [slackKind, feishuKind],
    run: execute, signal: new AbortController().signal })
  expect(resolved.problems.size).toBe(0)
  expect(resolved.sources.slack).toEqual({ cli: slackCli, teamId: 'T01234567', team: 'Acme', botId: 'B01234567',
    userId: 'U01234567', name: 'superagent', url: 'https://acme.slack.com/' })
  expect(resolved.sources.feishu).toEqual({ cli: feishuCli, appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot',
    name: 'Widgets Bot' })
  expect(resolved.sources).not.toHaveProperty('feishu.cli', slackCli)
  expect(slackProfile(testDeployment({ sources: resolved.sources }))).toMatchObject({ team: 'Acme', name: 'superagent',
    botId: 'B01234567', userId: 'U01234567', url: 'https://acme.slack.com/' })
}, 20_000)

it('words the Slack health rows from what the setup resolved', () => {
  const profile = { cli: '/opt/bin/slack-bridge', teamId: 'T01234567', team: 'Acme', botId: 'B01234567',
    userId: 'U01234567', name: 'superagent', url: 'https://acme.slack.com/' }
  expect(slackHealth(undefined, undefined)).toMatchObject({ slack: { state: 'paused', code: 'sourceOff' },
    history: { state: 'paused', code: 'sourceOff' } })
  expect(slackHealth(SlackConfigSchema.parse({}), undefined)).toMatchObject({ slack: { state: 'paused',
    code: 'slackBridgeUnset' }, history: { state: 'paused', code: 'slackBridgeUnset' } })
  expect(slackHealth(SlackConfigSchema.parse({ cli: '/opt/bin/slack-bridge' }), undefined)).toMatchObject({
    slack: { state: 'paused', code: 'setupPending' }, history: { state: 'paused', code: 'setupPending' } })
  expect(slackHealth(SlackConfigSchema.parse({ cli: '/opt/bin/slack-bridge' }), profile)).toMatchObject({
    slack: { state: 'ready', detail: 'Connected to Acme as @superagent', code: 'slackConnected' },
    history: { state: 'starting', detail: 'Waiting for the first history pass', code: 'slackFirstPass' } })
})

it('ships the Slack kind as a plugin entry that waits for the orchestrator', () => {
  expect(name).toBe('dsh-superagent-slack')
  expect(inject).toEqual(['orchestrator'])
})

it('pauses only Slack when its probe fails, leaving the other Sources resolved', async () => {
  const feishuCli = bridge(`if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"appId":"cli_bot","brand":"feishu","identities":{"bot":{"status":"ready"}}}'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "strict-mode" ]; then echo 'strict-mode: bot'; exit 0; fi
if [ "$1" = "api" ]; then echo '{"bot":{"open_id":"ou_bot","app_name":"Widgets Bot"}}'; exit 0; fi
exit 2`)
  const settings = SettingsSchema.parse({ sources: {
    slack: { enabled: true, config: { cli: join(tmpdir(), 'no-such-slack-bridge') } },
    feishu: { enabled: true, config: { cli: feishuCli } },
  } })
  const resolved = await resolveSourceProfiles({ machine: testMachine(), settings, kinds: [slackKind, feishuKind],
    run: execute, signal: new AbortController().signal })
  expect(resolved.problems.get('slack')).toMatchObject({ place: 'slack', code: 'slackBridgeMissing' })
  expect(resolved.problems.has('feishu')).toBe(false)
  expect(resolved.sources.slack).toBeUndefined()
  expect(resolved.sources.feishu).toMatchObject({ botId: 'ou_bot', name: 'Widgets Bot' })
  expect(slackHealth(SlackConfigSchema.parse({ cli: '/opt/bin/slack-bridge' }), undefined,
    resolved.problems.get('slack'))).toMatchObject({ slack: { state: 'paused', detail: expect.stringContaining('no-such-slack-bridge') } })
})
