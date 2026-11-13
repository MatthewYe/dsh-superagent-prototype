/** Slack loop end to end: a fake bridge feeds events through the supervised socket, admission, Intake, and the Outbox. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { Effects } from '../src/app/effects.ts'
import { Outbox } from '../src/app/outbox.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { slackKind } from '../src/sources/slack.ts'
import { runSlack } from '../src/sources/slack-loop.ts'
import { reportSlackToken } from '../src/sources/slack-auth.ts'
import type { SlackProfile } from '../src/sources/slack-setup.ts'
import { KV } from '../src/kv.ts'
import { slackTriggerId } from '../src/sources/slack-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const BOT = 'U01234567'
const BRIDGE = `#!/bin/sh
if [ "$1" = "listen" ]; then
  echo start >> "$BRIDGE_LOG"
  printf '%s\\n' "[socket] ready" >&2
  cat "$BRIDGE_EVENTS"
  exec sleep 60
elif [ "$1" = "api" ]; then
  if [ -n "$3" ]; then printf '%s %s\\n' "$2" "$3" >> "$BRIDGE_API"; else printf '%s %s\\n' "$2" '{}' >> "$BRIDGE_API"; fi
  if [ "$2" = "auth.test" ]; then
    printf '%s\\n' '{"ok":true,"team_id":"T01234567","team":"Acme","user_id":"U01234567","bot_id":"B01234567","url":"https://acme.slack.com/"}'
  else
    printf '%s\\n' '{"ok":true}'
  fi
else
  exit 2
fi`

const EXITS = `#!/bin/sh
if [ "$1" = "listen" ]; then
  echo start >> "$BRIDGE_LOG"
  if [ "$(grep -c start "$BRIDGE_LOG")" -eq 1 ]; then
    printf '%s\\n' "[socket] ready" >&2
    sleep 0.2
    exit 1
  fi
  exec sleep 60
fi
exit 2`
const REVOKED = `#!/bin/sh
if [ "$1" = "listen" ]; then
  echo start >> "$BRIDGE_LOG"
  printf '%s\\n' "[socket] ready" >&2
  cat "$BRIDGE_EVENTS"
  exec sleep 60
elif [ "$1" = "api" ]; then
  if [ -n "$3" ]; then printf '%s %s\\n' "$2" "$3" >> "$BRIDGE_API"; else printf '%s %s\\n' "$2" '{}' >> "$BRIDGE_API"; fi
  if [ "$2" = "auth.test" ]; then printf '%s\\n' '{"ok":false,"error":"invalid_auth"}'; else printf '%s\\n' '{"ok":true}'; fi
else
  exit 2
fi`
const RECONNECT = `#!/bin/sh
if [ "$1" = "listen" ]; then
  echo start >> "$BRIDGE_LOG"
  printf '%s\\n' "[socket] ready" >&2
  if [ "$(grep -c start "$BRIDGE_LOG")" -eq 1 ]; then sleep 1; exit 1; fi
  cat "$BRIDGE_EVENTS"
  exec sleep 60
elif [ "$1" = "api" ]; then
  if [ -n "$3" ]; then printf '%s %s\\n' "$2" "$3" >> "$BRIDGE_API"; else printf '%s %s\\n' "$2" '{}' >> "$BRIDGE_API"; fi
  if [ "$2" = "auth.test" ]; then
    if [ "$(grep -c auth.test "$BRIDGE_API")" -le 3 ]; then
      printf '%s\\n' '{"ok":true,"team_id":"T01234567","team":"Acme","user_id":"U01234567","bot_id":"B01234567","url":"https://acme.slack.com/"}'
    else
      printf '%s\\n' '{"ok":false,"error":"invalid_auth"}'
    fi
  else printf '%s\\n' '{"ok":true}'; fi
else
  exit 2
fi`
const PROFILE: SlackProfile = { cli: '', teamId: 'T01234567', team: 'Acme', botId: 'B01234567', userId: BOT, name: 'superagent',
  url: 'https://acme.slack.com/' }
let seq = 0
const mention = (overrides: Record<string, unknown> = {}) => ({ type: 'app_mention', channel: 'C0123ABCD', channel_type: 'channel',
  user: 'U0123ABCD', text: `<@${BOT}> can you look?`, ts: '1712345678.000100', ...overrides })
const message = (overrides: Record<string, unknown> = {}) => ({ type: 'message', channel: 'C0123ABCD', channel_type: 'channel',
  user: 'U0123ABCD', text: 'hello', ts: '1712345678.000100', ...overrides })
const envelope = (event: Record<string, unknown>, team = 'T01234567') =>
  ({ type: 'events_api', envelope_id: `env-${++seq}`, payload: { team_id: team, event_id: `ev-${++seq}`, event } })
const hello = () => ({ type: 'hello' })

type Harness = ReturnType<typeof loopHost>
function loopHost({ events, chats = [{ conversationId: 'C0123ABCD', listen: 'mentions' as const }], otherChats = 'none' as const,
  directMessages = true, platform, teamId = '' }: { events: Record<string, unknown>[]; chats?: { conversationId: string; listen: 'mentions' | 'all' }[];
  otherChats?: 'none' | 'mentions'; directMessages?: boolean; platform?: string; teamId?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-loop-'))
  const cli = join(dir, 'slack-bridge')
  const eventsPath = join(dir, 'events.ndjson')
  const logPath = join(dir, 'bridge.log')
  const apiPath = join(dir, 'api.log')
  const script = (platform ?? BRIDGE).replaceAll('$BRIDGE_EVENTS', eventsPath).replaceAll('$BRIDGE_LOG', logPath).replaceAll('$BRIDGE_API', apiPath)
  writeFileSync(cli, script, { mode: 0o755 })
  chmodSync(cli, 0o755)
  writeFileSync(eventsPath, events.map(event => JSON.stringify(event)).join('\n') + '\n')
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { slack: { teamId, allowed: [{ id: 'U0123ABCD', name: 'Alice' }] } } },
    eval: { mode: 'auto' },
    sources: { slack: { enabled: true, config: { cli, chats, otherChats, directMessages } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ sources: { slack: { cli, teamId: 'T01234567', team: 'Acme', botId: 'B01234567',
    userId: BOT, name: 'superagent', url: 'https://acme.slack.com/' } } })
  sources.register(slackKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const port = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox: port })
  const commands = new Commands(() => deployment, { BRIDGE_EVENTS: eventsPath, BRIDGE_LOG: logPath, BRIDGE_API: apiPath }, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const savePolicyPart = vi.fn(async (id: string, part: Record<string, unknown>) => {
    const current = store.settings()
    store.saveSettings(SettingsSchema.parse({ ...current, policy: { ...current.policy,
      sources: { ...current.policy.sources, [id]: part } } }))
  })
  const parts: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
    problems: new Map(), ready: Promise.resolve(), configured: () => true, receive, savePolicyPart }
  const context = sourceContextOf(parts, { kind: 'slack', health: ['slack', 'history:slack'] })
  const lines = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
  return { dir, cli, eventsPath, logPath, apiPath, store, board, sources, engine, commands, context, receive, executor, savePolicyPart,
    api: () => lines(apiPath).map(line => { const at = line.indexOf(' '); return { method: line.slice(0, at), body: JSON.parse(line.slice(at + 1)) as Record<string, unknown> } }),
    starts: () => lines(logPath).length }
}
async function start(h: Harness): Promise<{ stop: () => Promise<void> }> {
  const controller = new AbortController()
  const running = runSlack(h.context, controller.signal)
  return { stop: async () => { controller.abort(); await running } }
}

const running = new Set<{ stop: () => Promise<void> }>()
afterEach(async () => { for (const run of running) await run.stop(); running.clear() })
const boot = async (h: Harness): Promise<void> => {
  const handle = await start(h); running.add(handle)
}

describe('Slack socket loop', () => {
  it('turns a mention into one Trigger and reports the socket ready', async () => {
    const h = loopHost({ events: [hello(), envelope(mention())] })
    await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: slackTriggerId('C0123ABCD', '1712345678.000100'), source: 'slack', addressed: 'mention' })
    expect(h.store.get(KV.slack.threads('C0123ABCD'))).toMatchObject({ '1712345678.000100': expect.any(String) })
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'ready', detail: 'Connected to Acme as @superagent' }))
    await vi.waitFor(() => expect(h.board.all['history:slack']).toMatchObject({ state: 'ready', detail: 'Up to date' }))
  })

  it('starts the bridge again after it exits and reports the failed poll', async () => {
    const h = loopHost({ events: [], platform: EXITS })
    const handle = await start(h); running.add(handle)
    await vi.waitFor(() => expect(h.starts()).toBeGreaterThanOrEqual(2), { timeout: 10_000 })
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'pollFailures' }), { timeout: 10_000 })
  })

  it('admits a DM and drops unaddressed messages in unlisted conversations', async () => {
    const h = loopHost({ events: [hello(), envelope(mention()),
      envelope(message({ channel: 'D0123ABCD', channel_type: 'im', ts: '1712345679.000200' })),
      envelope(message({ channel: 'C0999ZZZZ', text: `<@${BOT}> ignored`, ts: '1712345680.000300' }))] })
    await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    const triggers = h.receive.mock.calls.map(call => call[0] as Trigger)
    const direct = triggers.find(trigger => trigger.addressed === 'direct')
    expect(direct?.threads[0]?.id).toBe('D0123ABCD:1712345679.000200')
    expect(direct?.channel?.thread).toBe('slack:D0123ABCD')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(h.receive).toHaveBeenCalledTimes(2)
  })

  it('stops and reports when the app is uninstalled', async () => {
    const h = loopHost({ events: [hello(), envelope({ type: 'app_uninstalled' })] })
    const handle = await start(h); running.add(handle)
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackAppUninstalled' }), { timeout: 10_000 })
    await handle.stop()
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(h.starts()).toBe(1)
  })

  it('stops and reports when the bot token is revoked', async () => {
    const h = loopHost({ events: [hello(), envelope({ type: 'tokens_revoked', tokens: { bot: [BOT] } })] })
    const handle = await start(h); running.add(handle)
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackTokenRevoked' }), { timeout: 10_000 })
    await handle.stop()
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(h.starts()).toBe(1)
  })

  it('reports a rate-limited app without dropping the socket', async () => {
    const h = loopHost({ events: [hello(), envelope({ type: 'app_rate_limited' })] })
    await boot(h)
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'ready', code: 'slackRateLimited' }), { timeout: 10_000 })
  })

  it('ignores frames from another team', async () => {
    const h = loopHost({ events: [hello(), envelope(mention(), 'T99999999')] })
    await boot(h)
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackTeamChanged' }), { timeout: 10_000 })
    expect(h.receive).not.toHaveBeenCalled()
  })

  it('opens one Ticket and sends one threaded reply for a mention and a DM through the Outbox', async () => {
    const h = loopHost({ events: [hello(), envelope(mention({ thread_ts: '1712345000.000100' })),
      envelope(mention({ thread_ts: '1712345000.000100' })),
      envelope(message({ channel: 'D0123ABCD', channel_type: 'im', ts: '1712345679.000200' }))] })
    await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(3), { timeout: 10_000 })
    const triggers = new Map(h.receive.mock.calls.map(call => { const trigger = call[0] as Trigger; return [trigger.id, trigger] as const }))
    expect(triggers.size).toBe(2)
    for (const trigger of triggers.values()) {
      const candidate = h.engine.candidate(trigger.id)
      h.engine.decide(trigger.id, { kind: 'accept', title: 'Fix the bug', scope: 'small', reason: 'requested', acknowledgement: 'On it',
        ...candidate ? { evalId: candidate.evalId } : {} })
    }
    expect(h.store.tickets.open()).toHaveLength(2)
    const effects = new Effects(h.store, h.board); effects.start()
    const outbox = new Outbox({ store: h.store, effects, sources: h.sources, commands: h.commands, paused: () => false })
    for (const [index, trigger] of [...triggers.values()].entries()) outbox.send({ id: `reply-${index}`, channel: trigger.channel!, text: 'Done', kind: 'reply' })
    await outbox.sent()
    await effects.drain()
    const sent = h.api().filter(item => item.method === 'chat.postMessage')
    expect(sent).toHaveLength(2)
    expect(sent[0]!.body).toMatchObject({ channel: 'C0123ABCD', thread_ts: '1712345000.000100' })
    expect(sent[1]!.body).toMatchObject({ channel: 'D0123ABCD', thread_ts: '1712345679.000200' })
  })

  it('enforces the Slack reply limit before calling the bridge', async () => {
    const h = loopHost({ events: [] })
    const effects = new Effects(h.store, h.board); effects.start()
    const outbox = new Outbox({ store: h.store, effects, sources: h.sources, commands: h.commands, paused: () => false })
    const channel = { source: 'slack', thread: 'slack:C0123ABCD', address: { conversation: 'C0123ABCD', ts: '1712345678.000100' } }
    const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ')
    expect(() => outbox.send({ id: 'too-long', channel, text: words(101), kind: 'reply' }))
      .toThrow('IM message has 101 words; maximum is 100.')
    outbox.send({ id: 'exact', channel, text: words(100), kind: 'reply' })
    await outbox.sent()
    await effects.drain()
    expect(h.api().map(item => item.method)).toEqual(['chat.postMessage'])
  })

  it('records the workspace on first use and continues', async () => {
    const h = loopHost({ events: [hello(), envelope(mention())] })
    await boot(h)
    await vi.waitFor(() => expect(h.store.settings().policy.sources.slack).toMatchObject({ teamId: 'T01234567' }), { timeout: 10_000 })
    expect(h.savePolicyPart).toHaveBeenCalledTimes(1)
    expect(h.savePolicyPart.mock.calls[0]![0]).toBe('slack')
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), { timeout: 10_000 })
  })

  it('keeps the stored workspace when auth.test agrees', async () => {
    const h = loopHost({ events: [hello(), envelope(mention())], teamId: 'T01234567' })
    await boot(h)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(1), { timeout: 10_000 })
    expect(h.savePolicyPart).not.toHaveBeenCalled()
  })

  it('refuses Triggers when auth.test reports another workspace', async () => {
    const h = loopHost({ events: [hello(), envelope(mention())], teamId: 'T99999999' })
    await boot(h)
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackTeamChanged' }), { timeout: 10_000 })
    expect(h.board.all.slack?.detail).toContain('T01234567')
    expect(h.board.all.slack?.detail).toContain('T99999999')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(h.starts()).toBe(0)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.savePolicyPart).not.toHaveBeenCalled()
  })

  it('reports a revoked token at startup and keeps the socket running for recovery', async () => {
    const h = loopHost({ events: [], platform: REVOKED })
    await boot(h)
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackTokenRevoked' }), { timeout: 10_000 })
    expect(h.starts()).toBe(1)
  })

  it('reports a revoked token when the socket restarts', async () => {
    const h = loopHost({ events: [], platform: RECONNECT })
    await boot(h)
    await vi.waitFor(() => expect(h.starts()).toBeGreaterThanOrEqual(2), { timeout: 15_000 })
    await vi.waitFor(() => expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackTokenRevoked' }), { timeout: 10_000 })
  })

  it('clears the revoked-token error once auth.test succeeds', async () => {
    const h = loopHost({ events: [] })
    reportSlackToken(h.context, PROFILE, { ok: false, error: 'token_revoked' })
    expect(h.board.all.slack).toMatchObject({ state: 'error', code: 'slackTokenRevoked' })
    reportSlackToken(h.context, PROFILE, { ok: true, team_id: 'T01234567' })
    expect(h.board.all.slack).toMatchObject({ state: 'ready', detail: 'Connected to Acme as @superagent' })
  })
})
