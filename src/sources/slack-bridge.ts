#!/usr/bin/env node
/**
 * The `slack-bridge` executable: one Socket Mode listener, one Web API call, or the token setup.
 *
 * The bridge is the only module that imports Slack's SDKs. Its `main` takes the Web API and socket
 * factories as dependencies so tests can drive the protocol without Slack, and stdout carries JSON
 * lines only: every diagnostic goes to stderr.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LogLevel, SocketModeClient, type Logger, type SocketModeOptions } from '@slack/socket-mode'
import { WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError, WebAPIRequestError, WebClient } from '@slack/web-api'

/** Slack's answer to one Web API call, including `{ ok: false, error }`; transport failures throw instead. */
export interface SlackApiResponse {
  ok?: boolean
  [key: string]: unknown
}

/** The one Web API call the bridge and the setup validation need, so tests can answer without HTTP. */
export interface SlackApi {
  call: (method: string, args: Record<string, unknown>) => Promise<SlackApiResponse>
}

/** One Socket Mode frame, with the ack the bridge must send before it prints the frame. */
export type SocketEvent =
  | { type: 'frame'; frame: Record<string, unknown>; ack?: () => Promise<void> }
  | { type: 'closed'; reason: string }

/** The slice of a Socket Mode client the listener uses; the real one wraps `@slack/socket-mode`. */
export interface SlackSocket {
  start: () => Promise<void>
  stop: () => Promise<void>
  onEvent: (listener: (event: SocketEvent) => void) => void
}

/** The process streams the CLI reads and writes. */
export interface BridgeIo {
  out: (line: string) => void
  err: (line: string) => void
  stdin: () => Promise<string>
}

/** Everything the CLI touches outside its own code, so tests never read the real home or reach Slack. */
export interface BridgeDeps {
  env: Record<string, string | undefined>
  version: string
  createWebApi: (token: string) => SlackApi
  createSocket: (appToken: string) => SlackSocket
  sleep: (milliseconds: number) => Promise<void>
  now: () => Date
  onSignal: (handler: () => void) => () => void
}

/** A 429 from Slack: the bridge waits `retryAfterSeconds` and retries, at most twice. */
export class SlackRateLimitedError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(`Slack rate limited the call for ${retryAfterSeconds} seconds`)
    this.name = 'SlackRateLimitedError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Slack did not answer, or its answer could not be read; the CLI exits 1 without JSON. */
export class SlackTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackTransportError'
  }
}

/** The CLI was called wrongly, or its configuration is missing; the CLI exits 2. */
class UsageError extends Error {}

/** A logger that keeps the SDKs' own diagnostics off stdout and stderr; the bridge writes its own. */
const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setLevel: () => {},
  getLevel: () => LogLevel.ERROR,
  setName: () => {},
}

/**
 * A Socket Mode client that also exposes the frames the SDK consumes itself: `hello` and
 * `disconnect`. The SDK emits `slack_event` for other frames before this hook runs, so the ack it
 * carries is available when the bridge reads the frame.
 */
class CapturingSocketModeClient extends SocketModeClient {
  readonly #onFrame: (event: SocketEvent) => void
  readonly #acks = new Map<string, () => Promise<void>>()

  constructor(options: SocketModeOptions, onFrame: (event: SocketEvent) => void) {
    super(options)
    this.#onFrame = onFrame
    this.on('slack_event', (event: { envelope_id?: string; ack?: () => Promise<void> }) => {
      if (typeof event.envelope_id === 'string' && event.ack) this.#acks.set(event.envelope_id, async () => event.ack!())
    })
  }

  protected override async onWebSocketMessage(data: string | ArrayBuffer, isBinary: boolean): Promise<void> {
    if (isBinary) {
      await super.onWebSocketMessage(data, isBinary)
      return
    }
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
    let frame: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>
    } catch {
      frame = undefined
    }
    if (!frame) {
      await super.onWebSocketMessage(data, isBinary)
      return
    }
    // The SDK consumes hello and disconnect without exposing them; pass them on before it acts.
    if (frame.type === 'hello' || frame.type === 'disconnect') {
      this.#onFrame({ type: 'frame', frame })
      await super.onWebSocketMessage(data, isBinary)
      return
    }
    await super.onWebSocketMessage(data, isBinary)
    const envelope = typeof frame.envelope_id === 'string' ? frame.envelope_id : undefined
    const ack = envelope === undefined ? undefined : this.#acks.get(envelope)
    if (envelope !== undefined) this.#acks.delete(envelope)
    this.#onFrame({ type: 'frame', frame, ack })
  }
}

/**
 * The real Web API adapter. Slack's `{ ok: false }` answers are returned for the caller to print;
 * only a 429, a transport failure or an unreadable answer throws.
 */
export function createWebApi(token: string, options: { apiUrl?: string } = {}): SlackApi {
  const client = new WebClient(token, {
    slackApiUrl: options.apiUrl,
    logger: silentLogger,
    logLevel: LogLevel.ERROR,
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
  })
  return {
    call: async (method, args) => {
      try {
        return withoutEmptyMetadata(checkedResponse(await client.apiCall(method, args)))
      } catch (error) {
        if (error instanceof WebAPIPlatformError) return withoutEmptyMetadata(checkedResponse(error.data))
        if (error instanceof WebAPIRateLimitedError) throw new SlackRateLimitedError(error.retryAfter)
        if (error instanceof WebAPIHTTPError) throw new SlackTransportError(describeHttpError(error))
        if (error instanceof WebAPIRequestError) throw new SlackTransportError(describeRequestError(error))
        throw new SlackTransportError(messageOf(error))
      }
    },
  }
}

/**
 * The real Socket Mode adapter. It keeps Slack's own reconnects, reports a closed connection, and
 * silences the SDK logger so stdout remains JSON only.
 */
export function createSocket(appToken: string): SlackSocket {
  let listener: ((event: SocketEvent) => void) | undefined
  let stopping = false
  const client = new CapturingSocketModeClient({
    appToken,
    autoReconnectEnabled: true,
    logger: silentLogger,
    logLevel: LogLevel.ERROR,
  }, event => {
    if (!stopping) listener?.(event)
  })
  client.on('close', (socket: unknown) => {
    if (!stopping && socket === client.websocket) listener?.({ type: 'closed', reason: 'connection_closed' })
  })
  return {
    start: async () => { await client.start() },
    stop: async () => {
      stopping = true
      await client.disconnect()
    },
    onEvent: next => { listener = next },
  }
}

/** The process's streams; stdin is read whole because `auth` takes exactly one JSON object. */
export function processIo(): BridgeIo {
  return {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    stdin: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

/** The production dependencies, including the package version and the two signal handlers. */
export function defaultDeps(): BridgeDeps {
  return {
    env: process.env,
    version: packageVersion(),
    createWebApi: token => createWebApi(token),
    createSocket,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
    onSignal: handler => {
      const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
      for (const signal of signals) process.on(signal, handler)
      return () => {
        for (const signal of signals) process.off(signal, handler)
      }
    },
  }
}

const USAGE = 'Usage: slack-bridge <listen | api <method> [json] | auth | --version>'

/**
 * Run one bridge command and return its exit code: 0 for success, 1 for a failed Slack exchange,
 * 2 for usage and configuration errors.
 */
export async function main(argv: string[], io: BridgeIo, deps: BridgeDeps = defaultDeps()): Promise<number> {
  try {
    const [command, ...args] = argv
    if (command === '--version') {
      if (args.length > 0) throw new UsageError(USAGE)
      io.out(deps.version)
      return 0
    }
    if (command === 'listen') {
      if (args.length > 0) throw new UsageError(USAGE)
      return await listen(io, deps)
    }
    if (command === 'api') return await callApi(args, io, deps)
    if (command === 'auth') {
      if (args.length > 0) throw new UsageError(USAGE)
      return await authenticate(io, deps)
    }
    throw new UsageError(USAGE)
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message)
      return 2
    }
    io.err(`slack-bridge: ${messageOf(error)}`)
    return 1
  }
}

/** Print Slack's answer for one method, waiting out up to two 429s, or exit 1 without JSON. */
async function callApi(args: string[], io: BridgeIo, deps: BridgeDeps): Promise<number> {
  if (args.length < 1 || args.length > 2) throw new UsageError(USAGE)
  const method = args[0]!
  if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(method)) throw new UsageError(`Not a Slack Web API method: ${method}`)
  let body: Record<string, unknown> = {}
  if (args[1] !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(args[1])
    } catch {
      throw new UsageError('The JSON argument must be one JSON object.')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('The JSON argument must be one JSON object.')
    body = parsed as Record<string, unknown>
  }
  const { botToken } = await loadTokens(deps.env, 'bot')
  const api = deps.createWebApi(botToken!)
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.out(JSON.stringify(await api.call(method, body)))
      return 0
    } catch (error) {
      if (error instanceof SlackRateLimitedError) {
        if (attempt >= 2) {
          io.err('Slack kept rate limiting the call; no response was received. Try again later.')
          return 1
        }
        const seconds = Number.isFinite(error.retryAfterSeconds) ? Math.max(0, error.retryAfterSeconds) : 0
        await deps.sleep(Math.min(seconds, 60) * 1000)
        continue
      }
      io.err(`Could not reach Slack: ${redact(messageOf(error), [botToken!])}`)
      return 1
    }
  }
}

/** Validate both tokens on stdin, write the config atomically and print a redacted identity line. */
async function authenticate(io: BridgeIo, deps: BridgeDeps): Promise<number> {
  const { botToken, appToken } = parseAuthInput(await io.stdin())
  const secrets = [botToken, appToken]
  let identity: SlackApiResponse
  try {
    identity = await deps.createWebApi(botToken).call('auth.test', {})
  } catch (error) {
    io.err(authFailure(error, secrets))
    return 1
  }
  if (identity.ok !== true) {
    io.err(`Slack rejected the bot token: ${slackError(identity)}`)
    return 1
  }
  try {
    const connection = await deps.createWebApi(appToken).call('apps.connections.open', {})
    if (connection.ok !== true) {
      io.err(`Slack rejected the app token: ${slackError(connection)}`)
      return 1
    }
  } catch (error) {
    io.err(authFailure(error, secrets))
    return 1
  }
  const config = {
    version: 1,
    bot_token: botToken,
    app_token: appToken,
    team_id: textField(identity.team_id),
    team: textField(identity.team),
    bot_id: textField(identity.bot_id),
    user_id: textField(identity.user_id),
    url: textField(identity.url),
    created_at: deps.now().toISOString(),
  }
  const path = configPath(deps.env)
  try {
    await writeConfig(path, config)
  } catch (error) {
    io.err(`Could not write the Slack config to ${path}: ${redact(messageOf(error), secrets)}`)
    return 1
  }
  io.out(JSON.stringify({
    ok: true,
    team: config.team,
    team_id: config.team_id,
    bot_id: config.bot_id,
    user_id: config.user_id,
    url: config.url,
  }))
  return 0
}

/**
 * Follow Slack until a signal or `link_disabled`: frames go to stdout, readiness and reconnects to
 * stderr, and an event is acknowledged before its frame is printed.
 */
async function listen(io: BridgeIo, deps: BridgeDeps): Promise<number> {
  const { appToken } = await loadTokens(deps.env, 'app')
  const secrets = [appToken!]
  const socket = deps.createSocket(appToken!)
  let finish!: (code: number) => void
  const done = new Promise<number>(resolve => { finish = resolve })
  let ended = false
  let ready = false
  let queue = Promise.resolve()
  const end = (code: number): void => {
    if (ended) return
    ended = true
    finish(code)
  }
  const showError = (prefix: string, error: unknown): void => {
    io.err(`${prefix} ${redact(messageOf(error), secrets)}`)
  }
  const handle = async (event: SocketEvent): Promise<void> => {
    if (ended) return
    if (event.type === 'closed') {
      io.err(`[socket] closed ${redact(event.reason, secrets)}`)
      return
    }
    const frame = event.frame
    const type = typeof frame.type === 'string' ? frame.type : ''
    if (type === 'hello') {
      io.out(JSON.stringify(frame))
      if (!ready) {
        ready = true
        io.err('[socket] ready')
      }
      return
    }
    if (type === 'disconnect') {
      io.out(JSON.stringify(frame))
      const reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
      if (reason === 'link_disabled') {
        io.err('[socket] disabled')
        end(1)
      } else {
        io.err(`[socket] reconnecting ${redact(reason, secrets)}`)
      }
      return
    }
    try {
      if (event.ack) await event.ack()
    } catch (error) {
      showError('[socket] ack failed:', error)
      return
    }
    if (!ended) io.out(JSON.stringify(frame))
  }
  socket.onEvent(event => {
    queue = queue
      .then(() => handle(event))
      .catch(error => {
        showError('[socket] closed', error)
        end(1)
      })
  })
  const unregister = deps.onSignal(() => { queue = queue.then(() => end(0)) })
  socket.start().catch(error => {
    if (!ended) {
      showError('[socket] closed', error)
      end(1)
    }
  })
  const code = await done
  await queue
  try {
    await socket.stop()
  } catch {
    // A socket that already failed to start has nothing to close.
  }
  unregister()
  return code
}

interface Tokens {
  botToken?: string
  appToken?: string
}

/** Env tokens replace the config file entirely, as §13.3 says; otherwise the file supplies both. */
async function loadTokens(env: Record<string, string | undefined>, need: 'bot' | 'app'): Promise<Tokens> {
  const envBot = nonEmpty(env.SLACK_BOT_TOKEN)
  const envApp = nonEmpty(env.SLACK_APP_TOKEN)
  if (envBot !== undefined || envApp !== undefined) {
    if (need === 'bot' && envBot === undefined) throw new UsageError('Missing SLACK_BOT_TOKEN; set it or run `slack-bridge auth`.')
    if (need === 'app' && envApp === undefined) throw new UsageError('Missing SLACK_APP_TOKEN; set it or run `slack-bridge auth`.')
    return { botToken: envBot, appToken: envApp }
  }
  const path = configPath(env)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError('No Slack tokens found. Run `slack-bridge auth` or set SLACK_BOT_TOKEN and SLACK_APP_TOKEN.')
    }
    throw new UsageError(`Could not read the Slack config at ${path}.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new UsageError(`The Slack config at ${path} is not valid JSON.`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`The Slack config at ${path} is not a JSON object.`)
  const stored = parsed as Record<string, unknown>
  const botToken = nonEmpty(stored.bot_token)
  const appToken = nonEmpty(stored.app_token)
  if (need === 'bot' && botToken === undefined) throw new UsageError(`The Slack config at ${path} has no bot token; run \`slack-bridge auth\` again.`)
  if (need === 'app' && appToken === undefined) throw new UsageError(`The Slack config at ${path} has no app token; run \`slack-bridge auth\` again.`)
  return { botToken, appToken }
}

/** Parse the one auth object; snake_case is the documented spelling and camelCase is accepted. */
function parseAuthInput(input: string): { botToken: string; appToken: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new UsageError('auth expects exactly one JSON object on stdin.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('auth expects exactly one JSON object on stdin.')
  const value = parsed as Record<string, unknown>
  const botToken = nonEmpty(value.bot_token) ?? nonEmpty(value.botToken)
  const appToken = nonEmpty(value.app_token) ?? nonEmpty(value.appToken)
  if (botToken === undefined || !botToken.startsWith('xoxb-')) throw new UsageError('auth needs a bot token ("bot_token", starting with "xoxb-").')
  if (appToken === undefined || !appToken.startsWith('xapp-')) throw new UsageError('auth needs an app token ("app_token", starting with "xapp-").')
  return { botToken, appToken }
}

/** Write the config through a fresh 0600 file in the same directory and rename it into place. */
async function writeConfig(path: string, config: unknown): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** `SLACK_BRIDGE_CONFIG` wins; otherwise the config sits under the operator's home directory. */
function configPath(env: Record<string, string | undefined>): string {
  return nonEmpty(env.SLACK_BRIDGE_CONFIG) ?? join(nonEmpty(env.HOME) ?? homedir(), '.slack-dsh-superagent', 'config.json')
}

/** The version is beside the built file and two levels up from the source file. */
function packageVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const value = JSON.parse(readFileSync(new URL(candidate, import.meta.url), 'utf8')) as { version?: unknown }
      if (typeof value.version === 'string') return value.version
    } catch {
      // Try the source layout next.
    }
  }
  return '0.0.0'
}

function authFailure(error: unknown, secrets: string[]): string {
  if (error instanceof SlackRateLimitedError) return 'Slack is rate limiting the token check; try again later.'
  return `Could not validate the tokens: ${redact(messageOf(error), secrets)}`
}

function describeHttpError(error: WebAPIHTTPError): string {
  return `HTTP ${error.statusCode}${error.statusMessage ? ` ${error.statusMessage}` : ''}`
}

function describeRequestError(error: WebAPIRequestError): string {
  return error.original instanceof Error ? error.original.message : 'network error'
}

function slackError(response: SlackApiResponse): string {
  return typeof response.error === 'string' ? response.error : 'unknown_error'
}

/** Slack answers with an object carrying `ok`; anything else is a parse failure, not a Slack answer. */
function checkedResponse(value: unknown): SlackApiResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackTransportError('Slack returned a response that could not be parsed')
  }
  const response = value as SlackApiResponse
  if (typeof response.ok !== 'boolean') throw new SlackTransportError('Slack returned a response that could not be parsed')
  if (!response.ok && (typeof response.error !== 'string' || !/^[a-z][a-z0-9_]*$/.test(response.error))) {
    throw new SlackTransportError('Slack returned an error that could not be parsed')
  }
  return response
}

/** The SDK adds an empty response_metadata to every answer; the bridge prints Slack's fields only. */
function withoutEmptyMetadata(response: SlackApiResponse): SlackApiResponse {
  const metadata = response.response_metadata
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata) || Object.keys(metadata).length > 0) return response
  const copy = { ...response }
  delete copy.response_metadata
  return copy
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Remove token values from any diagnostic before it reaches stderr. */
function redact(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => secret ? result.split(secret).join('[redacted]') : result, text)
}

/** Run the executable itself; a test importing `main` must not start the CLI. */
function invokedAsProgram(): boolean {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedAsProgram()) process.exitCode = await main(process.argv.slice(2), processIo())
