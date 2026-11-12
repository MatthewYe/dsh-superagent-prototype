/** Shared supervision of a long-running Source process: spawn, readiness, line handling, restart with backoff, and a clean stop. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { health, type SourceContext } from './host.ts'

const LINE_LIMIT = 1_048_576
const DEFAULT_TIMEOUT_MS = 45_000

/** A line handler throws this to stop the consumer for good: the supervisor reports its health and does not restart it. */
export class ConsumerFatal extends Error {
  override name = 'ConsumerFatal'
}

/** One long-running Source process, its readiness signal, and what to do with each stdout line. */
export interface Consumer {
  /** Source kind: the consumer runs while its configuration is present and reports this health entry. */
  kind: string
  /** Name used in diagnostics and health details, for example "Feishu event consumer". */
  name: string
  /** Program and arguments, resolved by the deployment profile. */
  command: string
  args: string[]
  /** Variables added to the inherited environment; PATH is inherited unchanged. */
  env: Record<string, string>
  /** Readiness line on stderr, for example "[event] ready". */
  ready: string
  /** Health detail reported while the consumer is ready. */
  listening: string
  /** Error text for a stdout line over 1 MiB. */
  oversized: string
  /** Called for each stdout line, in order; a rejection is reported on the consumer's health entry. */
  line: (line: string) => void | Promise<void>
  /** How long to wait for readiness; 45 seconds by default. */
  timeoutMs?: number
}

/** Wait before restarting a consumer: 1s after the first failure or after a minute up, otherwise doubling, capped at 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/**
 * Runs one consumer until the signal aborts: waits for readiness, streams lines sequentially, restarts with backoff,
 * and reports readiness, warnings and exit diagnostics on the kind's health entry.
 */
export async function supervise(ctx: SourceContext, consumer: Consumer, signal: AbortSignal): Promise<void> {
  await ctx.ready
  let retry: number | undefined
  while (!signal.aborted) {
    if (!ctx.config(consumer.kind)) {
      ctx.report(consumer.kind, health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!ctx.config(consumer.kind)) running.abort() }, 5000)
    const stop = (): void => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    const began = Date.now()
    try { await consume(ctx, consumer, running.signal) }
    catch (error) {
      if (error instanceof ConsumerFatal) return
      if (!running.signal.aborted) ctx.report(consumer.kind, { state: 'error', detail: String(error) })
    } finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    if (running.signal.aborted) continue
    retry = consumerRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}

/** One run of the consumer: ready line on stderr, stdout lines one after another, stopped on abort or readiness timeout. */
async function consume(ctx: SourceContext, consumer: Consumer, signal: AbortSignal): Promise<void> {
  const child = spawn(consumer.command, consumer.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...consumer.env } })
  const stdout = createInterface({ input: child.stdout }); const stderr = createInterface({ input: child.stderr })
  let chain = Promise.resolve(); let diagnostic = ''; let ready = false; let fatal: ConsumerFatal | undefined
  const stop = (): void => { child.stdin.end(); child.kill('SIGTERM') }
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(() => {
    diagnostic = `${consumer.name} did not become ready within ${(consumer.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000} seconds`
    stop()
  }, consumer.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  stderr.on('line', (line: string) => {
    diagnostic = line.slice(0, 4000)
    if (line.startsWith(consumer.ready)) {
      ready = true; clearTimeout(timeout)
      ctx.report(consumer.kind, { state: 'ready', detail: consumer.listening, at: new Date().toISOString() })
    } else if (/WARN|drop|error/.test(line)) ctx.report(consumer.kind, { state: 'error', detail: diagnostic })
  })
  stdout.on('line', (line: string) => {
    chain = chain.then(async () => {
      if (line.length > LINE_LIMIT) throw new Error(consumer.oversized)
      await consumer.line(line)
    }).catch(error => {
      if (error instanceof ConsumerFatal) { fatal = error; stop(); return }
      ctx.report(consumer.kind, { state: 'error', detail: String(error) })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      const exited = (code: number | null) => new Error(`${consumer.name} exited (${code}, ready=${ready}): ${diagnostic}`)
      child.once('close', code => fatal ? reject(fatal) : signal.aborted ? resolve() : reject(exited(code)))
    })
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); stdout.close(); stderr.close(); await chain }
}
