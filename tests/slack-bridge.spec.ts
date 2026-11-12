/** Tests for the slack-bridge CLI: argv, the Web API passthrough, auth and Socket Mode framing, all offline. */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createWebApi, main, SlackRateLimitedError, SlackTransportError,
  type BridgeDeps, type BridgeIo, type SlackApi, type SlackSocket, type SocketEvent,
} from '../src/sources/slack-bridge.ts'

interface HarnessOptions {
  env?: Record<string, string | undefined>
  stdin?: string
  webApi?: (token: string) => SlackApi
  socket?: SlackSocket
  sleep?: (ms: number) => Promise<void>
  version?: string
  onSignal?: (handler: () => void) => () => void
}

/** One CLI run with captured streams, a fake Web API and a fake socket. Every default is offline. */
function harness(options: HarnessOptions = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const sleeps: number[] = []
  const tokens: string[] = []
  const opened: string[] = []
  const closed: string[] = []
  let signal: (() => void) | undefined
  const io: BridgeIo = {
    out: line => stdout.push(line),
    err: line => stderr.push(line),
    stdin: async () => options.stdin ?? '',
  }
  const deps: BridgeDeps = {
    env: options.env ?? {},
    version: options.version ?? '0.1.0',
    createWebApi: token => {
      tokens.push(token)
      return options.webApi?.(token) ?? { call: async () => ({ ok: true }) }
    },
    createSocket: () => options.socket ?? quietSocket(),
    openSocketUrl: url => {
      opened.push(url)
      return { close: () => { closed.push(url) } }
    },
    sleep: async ms => { sleeps.push(ms); await options.sleep?.(ms) },
    now: () => new Date('2026-11-12T08:00:00.000Z'),
    onSignal: handler => {
      signal = handler
      return () => { signal = undefined }
    },
  }
  return {
    io, deps, stdout, stderr, sleeps, tokens, opened, closed,
    signal: () => signal?.(),
    listening: () => signal !== undefined,
  }
}

/** A socket that connects and then waits for a signal, so listen returns only on a signal. */
function quietSocket(events: SocketEvent[] = []): SlackSocket {
  let listener: ((event: SocketEvent) => void) | undefined
  return {
    start: async () => { for (const event of events) listener?.(event) },
    stop: async () => {},
    onEvent: next => { listener = next },
  }
}

const env = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' }

describe('argv', () => {
  it('prints usage on stderr and exits 2 with no command', async () => {
    const h = harness()
    expect(await main([], h.io, h.deps)).toBe(2)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/usage/i)
  })

  it('prints the version on stdout and exits 0', async () => {
    const h = harness({ version: '9.8.7' })
    expect(await main(['--version'], h.io, h.deps)).toBe(0)
    expect(h.stdout).toEqual(['9.8.7'])
    expect(h.stderr).toEqual([])
  })

  it('rejects unknown commands with usage on stderr and exit 2', async () => {
    const h = harness()
    expect(await main(['watch'], h.io, h.deps)).toBe(2)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/usage/i)
  })
})

describe('api', () => {
  it('calls one method with the bot token, prints the response and exits 0', async () => {
    const calls: { token: string; method: string; args: Record<string, unknown> }[] = []
    const h = harness({
      env,
      webApi: token => ({
        call: async (method, args) => {
          calls.push({ token, method, args })
          return { ok: true, ts: '1700000000.000001' }
        },
      }),
    })
    const code = await main(['api', 'chat.postMessage', '{"channel":"C1","text":"hi"}'], h.io, h.deps)
    expect(code).toBe(0)
    expect(calls).toEqual([{ token: 'xoxb-test', method: 'chat.postMessage', args: { channel: 'C1', text: 'hi' } }])
    expect(h.stdout).toEqual([JSON.stringify({ ok: true, ts: '1700000000.000001' })])
    expect(h.stderr).toEqual([])
  })

  it('defaults the body to {} and prints an ok:false answer with exit 0', async () => {
    const calls: Record<string, unknown>[] = []
    const h = harness({
      env,
      webApi: () => ({ call: async (_method, args) => { calls.push(args); return { ok: false, error: 'channel_not_found' } } }),
    })
    expect(await main(['api', 'conversations.info'], h.io, h.deps)).toBe(0)
    expect(calls).toEqual([{}])
    expect(h.stdout).toEqual([JSON.stringify({ ok: false, error: 'channel_not_found' })])
    expect(h.stderr).toEqual([])
  })

  it('exits 1 with a sentence on stderr and no JSON on a transport failure', async () => {
    const h = harness({ env, webApi: () => ({ call: async () => { throw new SlackTransportError('socket hang up') } }) })
    expect(await main(['api', 'chat.postMessage', '{}'], h.io, h.deps)).toBe(1)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/could not reach slack/i)
  })

  it('waits Retry-After seconds, capped at 60, and retries at most twice', async () => {
    let calls = 0
    const h = harness({
      env,
      webApi: () => ({ call: async () => { calls += 1; throw new SlackRateLimitedError(calls === 1 ? 120 : 30) } }),
    })
    expect(await main(['api', 'chat.postMessage', '{}'], h.io, h.deps)).toBe(1)
    expect(calls).toBe(3)
    expect(h.sleeps).toEqual([60_000, 30_000])
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/rate limit/i)
  })

  it('prints the answer after a 429 when the retry succeeds', async () => {
    let calls = 0
    const h = harness({
      env,
      webApi: () => ({ call: async () => { calls += 1; if (calls < 3) throw new SlackRateLimitedError(1); return { ok: true } } }),
    })
    expect(await main(['api', 'chat.postMessage', '{}'], h.io, h.deps)).toBe(0)
    expect(h.sleeps).toEqual([1_000, 1_000])
    expect(h.stdout).toEqual([JSON.stringify({ ok: true })])
    expect(h.stderr).toEqual([])
  })

  it('exits 2 on a missing method, malformed JSON, or a non-object body', async () => {
    for (const argv of [['api'], ['api', 'chat.postMessage', '{'], ['api', 'chat.postMessage', '[]'], ['api', 'chat.postMessage', 'null']]) {
      const h = harness({ env })
      expect(await main(argv, h.io, h.deps)).toBe(2)
      expect(h.stdout).toEqual([])
      expect(h.stderr.join('\n')).toMatch(/usage|json/i)
    }
  })

  it('exits 2 with a clear message when no bot token is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const h = harness({ env: { HOME: home } })
    expect(await main(['api', 'chat.postMessage'], h.io, h.deps)).toBe(2)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/slack-bridge auth|SLACK_BOT_TOKEN/i)
  })
})

describe('tokens', () => {
  it('reads the config file from SLACK_BRIDGE_CONFIG when no token env is set', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const file = join(home, 'config.json')
    writeFileSync(file, JSON.stringify({ version: 1, bot_token: 'xoxb-file', app_token: 'xapp-file' }))
    const seen: string[] = []
    const h = harness({ env: { HOME: home, SLACK_BRIDGE_CONFIG: file }, webApi: token => { seen.push(token); return { call: async () => ({ ok: true }) } } })
    expect(await main(['api', 'auth.test'], h.io, h.deps)).toBe(0)
    expect(seen).toEqual(['xoxb-file'])
  })

  it('lets env tokens replace the config file without reading it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const file = join(home, 'config.json')
    writeFileSync(file, 'not json at all')
    const seen: string[] = []
    const h = harness({ env: { ...env, SLACK_BRIDGE_CONFIG: file }, webApi: token => { seen.push(token); return { call: async () => ({ ok: true }) } } })
    expect(await main(['api', 'auth.test'], h.io, h.deps)).toBe(0)
    expect(seen).toEqual(['xoxb-test'])
  })

  it('requires both tokens when env tokens are set and the file is not read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const file = join(home, 'config.json')
    writeFileSync(file, JSON.stringify({ version: 1, bot_token: 'xoxb-file', app_token: 'xapp-file' }))
    const h = harness({ env: { HOME: home, SLACK_BRIDGE_CONFIG: file, SLACK_APP_TOKEN: 'xapp-env' } })
    expect(await main(['api', 'auth.test'], h.io, h.deps)).toBe(2)
    expect(h.stderr.join('\n')).toMatch(/SLACK_BOT_TOKEN/i)
  })

  it('exits 2 when the config file is malformed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const file = join(home, 'config.json')
    writeFileSync(file, '{ nope')
    const h = harness({ env: { HOME: home, SLACK_BRIDGE_CONFIG: file } })
    expect(await main(['api', 'auth.test'], h.io, h.deps)).toBe(2)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/config/i)
  })
})

describe('auth', () => {
  it('validates both tokens, writes 0700/0600 config and prints identity without tokens', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const calls: { token: string; method: string }[] = []
    const h = harness({
      env: { HOME: home },
      stdin: JSON.stringify({ bot_token: 'xoxb-secret', app_token: 'xapp-secret' }),
      webApi: token => ({
        call: async method => {
          calls.push({ token, method })
          return method === 'auth.test'
            ? { ok: true, url: 'https://acme.slack.com/', team: 'Acme', team_id: 'T1', user_id: 'U1', bot_id: 'B1' }
            : { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=abc' }
        },
      }),
    })
    expect(await main(['auth'], h.io, h.deps)).toBe(0)
    expect(calls).toEqual([
      { token: 'xoxb-secret', method: 'auth.test' },
      { token: 'xapp-secret', method: 'apps.connections.open' },
    ])
    expect(h.opened).toEqual(['wss://wss-primary.slack.com/link/?ticket=abc'])
    expect(h.closed).toEqual(h.opened)
    const file = join(home, '.slack-dsh-superagent', 'config.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ version: 1, bot_token: 'xoxb-secret', app_token: 'xapp-secret', team: 'Acme', team_id: 'T1', bot_id: 'B1', user_id: 'U1', url: 'https://acme.slack.com/', created_at: '2026-11-12T08:00:00.000Z' })
    expect(statSync(join(home, '.slack-dsh-superagent')).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(h.stdout).toEqual([JSON.stringify({ ok: true, team: 'Acme', team_id: 'T1', bot_id: 'B1', user_id: 'U1', url: 'https://acme.slack.com/' })])
    const printed = h.stdout.join('\n') + h.stderr.join('\n')
    expect(printed).not.toContain('xoxb-secret')
    expect(printed).not.toContain('xapp-secret')
  })

  it('accepts the camelCase spelling as well', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const h = harness({
      env: { HOME: home },
      stdin: JSON.stringify({ botToken: 'xoxb-camel', appToken: 'xapp-camel' }),
      webApi: () => ({ call: async method => method === 'auth.test' ? { ok: true, team: 'Acme', team_id: 'T1', bot_id: 'B1', user_id: 'U1', url: 'https://acme.slack.com/' } : { ok: true, url: 'wss://example' } }),
    })
    expect(await main(['auth'], h.io, h.deps)).toBe(0)
    expect(JSON.parse(readFileSync(join(home, '.slack-dsh-superagent', 'config.json'), 'utf8'))).toMatchObject({ bot_token: 'xoxb-camel', app_token: 'xapp-camel' })
  })

  it('rewrites an existing wider file to 0600 and leaves no temporary file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const dir = join(home, '.slack-dsh-superagent')
    mkdirSync(dir, { mode: 0o755 })
    const file = join(dir, 'config.json')
    writeFileSync(file, '{"version":0}', { mode: 0o644 })
    const h = harness({
      env: { HOME: home },
      stdin: JSON.stringify({ bot_token: 'xoxb-a', app_token: 'xapp-a' }),
      webApi: () => ({ call: async method => method === 'auth.test' ? { ok: true, team: 'Acme', team_id: 'T1', bot_id: 'B1', user_id: 'U1', url: 'https://acme.slack.com/' } : { ok: true, url: 'wss://example' } }),
    })
    expect(await main(['auth'], h.io, h.deps)).toBe(0)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(dir).isDirectory()).toBe(true)
    const names = [...new Set(readdirSync(dir))]
    expect(names).toEqual(['config.json'])
  })

  it('prints the Slack error code and exits 1 when a token is rejected, writing nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const h = harness({
      env: { HOME: home },
      stdin: JSON.stringify({ bot_token: 'xoxb-bad', app_token: 'xapp-bad' }),
      webApi: () => ({ call: async () => ({ ok: false, error: 'invalid_auth' }) }),
    })
    expect(await main(['auth'], h.io, h.deps)).toBe(1)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toContain('invalid_auth')
    expect(h.stderr.join('\n')).not.toContain('xoxb-bad')
    expect(h.stderr.join('\n')).not.toContain('xapp-bad')
  })

  it('exits 2 on malformed stdin', async () => {
    for (const stdin of ['', 'nope', '[]', '{"bot_token":"xoxb-a"}', '{"bot_token":"xoxb-a","app_token":"not-app"}']) {
      const h = harness({ env: {}, stdin })
      expect(await main(['auth'], h.io, h.deps)).toBe(2)
      expect(h.stdout).toEqual([])
    }
  })
})

describe('listen', () => {
  it('prints hello and events, acks before printing, logs one ready line and stops on a signal', async () => {
    const order: string[] = []
    const frame = { type: 'events_api', envelope_id: 'e1', payload: { event: { type: 'app_mention' } } }
    let listener: ((event: SocketEvent) => void) | undefined
    const socket: SlackSocket = {
      start: async () => {
        listener?.({ type: 'frame', frame: { type: 'hello' } })
        listener?.({ type: 'frame', frame, ack: async () => { order.push('ack') } })
      },
      stop: async () => { order.push('stop') },
      onEvent: next => { listener = next },
    }
    const h = harness({ env, socket })
    h.io.out = line => { order.push(`out:${line}`); h.stdout.push(line) }
    const run = main(['listen'], h.io, h.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.listening()).toBe(true)
    h.signal()
    expect(await run).toBe(0)
    expect(h.stdout).toEqual([JSON.stringify({ type: 'hello' }), JSON.stringify(frame)])
    expect(h.stderr).toEqual(['[socket] ready'])
    expect(order).toEqual(['out:{"type":"hello"}', 'ack', `out:${JSON.stringify(frame)}`, 'stop'])
  })

  it('prints each frame as one JSON line and no other stdout', async () => {
    const frames = [
      { type: 'hello' },
      { type: 'events_api', envelope_id: 'e1', payload: { event: { type: 'app_mention' } } },
      { type: 'disconnect', reason: 'warning' },
    ]
    let listener: ((event: SocketEvent) => void) | undefined
    const socket: SlackSocket = { start: async () => { for (const frame of frames) listener?.({ type: 'frame', frame, ack: async () => {} }) }, stop: async () => {}, onEvent: next => { listener = next } }
    const h = harness({ env, socket })
    const run = main(['listen'], h.io, h.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    h.signal()
    expect(await run).toBe(0)
    expect(() => h.stdout.forEach(line => JSON.parse(line))).not.toThrow()
    expect(h.stdout).toEqual(frames.map(frame => JSON.stringify(frame)))
    expect(h.stderr).toContain('[socket] ready')
    expect(h.stderr).toContain('[socket] reconnecting warning')
  })

  it('logs a closed connection and keeps waiting for a reconnect', async () => {
    let listener: ((event: SocketEvent) => void) | undefined
    const socket: SlackSocket = {
      start: async () => {
        listener?.({ type: 'frame', frame: { type: 'hello' } })
        listener?.({ type: 'closed', reason: 'connection_closed' })
        listener?.({ type: 'frame', frame: { type: 'hello' } })
      },
      stop: async () => {},
      onEvent: next => { listener = next },
    }
    const h = harness({ env, socket })
    const run = main(['listen'], h.io, h.deps)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.stderr).toEqual(['[socket] ready', '[socket] closed connection_closed'])
    expect(h.stdout).toEqual([JSON.stringify({ type: 'hello' }), JSON.stringify({ type: 'hello' })])
    h.signal()
    expect(await run).toBe(0)
  })

  it('prints [socket] disabled and exits 1 on link_disabled', async () => {
    let listener: ((event: SocketEvent) => void) | undefined
    const socket: SlackSocket = {
      start: async () => {
        listener?.({ type: 'frame', frame: { type: 'hello' } })
        listener?.({ type: 'frame', frame: { type: 'disconnect', reason: 'link_disabled' } })
      },
      stop: async () => {},
      onEvent: next => { listener = next },
    }
    const h = harness({ env, socket })
    expect(await main(['listen'], h.io, h.deps)).toBe(1)
    expect(h.stdout).toEqual([JSON.stringify({ type: 'hello' }), JSON.stringify({ type: 'disconnect', reason: 'link_disabled' })])
    expect(h.stderr).toEqual(['[socket] ready', '[socket] disabled'])
  })

  it('exits 1 with a sentence when the socket cannot start', async () => {
    const socket: SlackSocket = { start: async () => { throw new Error('invalid_auth') }, stop: async () => {}, onEvent: () => {} }
    const h = harness({ env, socket })
    expect(await main(['listen'], h.io, h.deps)).toBe(1)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/\[socket\] closed/i)
    expect(h.stderr.join('\n')).toContain('invalid_auth')
    expect(h.stderr.join('\n')).not.toContain('xapp-test')
  })

  it('exits 2 when the app token is missing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'slack-bridge-home-'))
    const h = harness({ env: { HOME: home, SLACK_BOT_TOKEN: 'xoxb-test' } })
    expect(await main(['listen'], h.io, h.deps)).toBe(2)
    expect(h.stdout).toEqual([])
    expect(h.stderr.join('\n')).toMatch(/SLACK_APP_TOKEN/i)
  })
})

/** A loopback Slack stand-in: the real WebClient talks to it, so no Slack endpoint is involved. */
async function withStandInHttp(
  handler: (response: ServerResponse, count: number) => void,
  run: (apiUrl: string) => Promise<void>,
): Promise<void> {
  let count = 0
  const server = createServer((request, response) => {
    request.resume()
    count += 1
    handler(response, count)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}/api/`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('real Web API wiring', () => {
  it('retries a real 429 with Retry-After and prints the answered call', async () => {
    await withStandInHttp((response, count) => {
      if (count === 1) {
        response.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: false, error: 'ratelimited' }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true, ts: '1700000000.000001' }))
    }, async apiUrl => {
      const h = harness({ env, webApi: token => createWebApi(token, { apiUrl }) })
      expect(await main(['api', 'chat.postMessage', '{"channel":"C1"}'], h.io, h.deps)).toBe(0)
      expect(h.stdout).toEqual([JSON.stringify({ ok: true, ts: '1700000000.000001' })])
      expect(h.stderr).toEqual([])
      expect(h.sleeps).toEqual([0])
    })
  })

  it('prints a real ok:false answer and exits 0', async () => {
    await withStandInHttp(response => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'invalid_auth' }))
    }, async apiUrl => {
      const h = harness({ env, webApi: token => createWebApi(token, { apiUrl }) })
      expect(await main(['api', 'auth.test', '{}'], h.io, h.deps)).toBe(0)
      expect(h.stdout).toEqual([JSON.stringify({ ok: false, error: 'invalid_auth' })])
      expect(h.stderr).toEqual([])
    })
  })

  it('exits 1 without JSON when the answer is not a Slack response', async () => {
    await withStandInHttp(response => {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
      response.end('not a Slack answer')
    }, async apiUrl => {
      const h = harness({ env, webApi: token => createWebApi(token, { apiUrl }) })
      expect(await main(['api', 'auth.test', '{}'], h.io, h.deps)).toBe(1)
      expect(h.stdout).toEqual([])
      expect(h.stderr.join('\n')).toMatch(/could not reach slack/i)
    })
  })
})
