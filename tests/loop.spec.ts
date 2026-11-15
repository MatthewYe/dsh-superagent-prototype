import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { consumerRetry, supervise, type Consumer } from '../src/sources/loop.ts'

const demoKind: SourceKind = {
  kind: 'demo',
  title: { zh: '演示', en: 'Demo' },
  description: { zh: '演示', en: 'Demo' },
  schema: z.object({}),
  fields: [],
  health: ['demo'],
}

describe('shared consumer supervisor', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<void> | undefined
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'consumer-loop-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  // The fake consumer is a real process, which starts slower while the whole suite runs.
  const until = { timeout: 10_000 }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  /** A shell script that stands in for a Source's long-running consumer. */
  function script(body: string): string {
    const path = join(dir, 'consumer')
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }
  function consumer(command: string, overrides: Partial<Consumer> = {}): Consumer {
    return { kind: 'demo', name: 'Demo consumer', command, args: [], env: {}, ready: '[ready]', listening: 'Listening for demo events',
      oversized: 'Demo event exceeds 1 MiB', line: () => {}, ...overrides }
  }
  /** The demo Source's context, on a fresh Store whose demo Source is on. */
  function context() {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { demo: { enabled: true, config: {} } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(demoKind)
    const parts = { store, sources, ready: Promise.resolve(), configured: () => true, problems: new Map(), receive: () => {} } as unknown as SourceContextDeps
    return { ctx: sourceContextOf(parts, demoKind), board, store }
  }

  it('waits a second after the first failure, doubles the wait, caps it at a minute, and resets after a minute up', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 500)).toBe(2000)
    expect(consumerRetry(32_000, 500)).toBe(60_000)
    expect(consumerRetry(60_000, 120_000)).toBe(1000)
  })
  it('reports the readiness timeout and stops a consumer that never becomes ready', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const path = script(`echo $$ > '${dir}/pid'\nexec sleep 60`)
    const { ctx, board } = context()
    running = supervise(ctx, consumer(path), controller.signal)
    await vi.waitFor(() => expect(existsSync(join(dir, 'pid'))).toBe(true), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => expect(board.all.demo).toMatchObject({ state: 'error',
      detail: expect.stringContaining('Demo consumer did not become ready within 45 seconds') }), until)
    expect(alive(pid)).toBe(false)
  })
  it('reports the exit diagnostic when the consumer exits on its own', async () => {
    const path = script(`echo 'consumer stopped' >&2\nexit 0`)
    const { ctx, board } = context()
    running = supervise(ctx, consumer(path), controller.signal)
    await vi.waitFor(() => expect(board.all.demo).toMatchObject({ state: 'error',
      detail: expect.stringContaining('Demo consumer exited (0, ready=false): consumer stopped') }), until)
  })
  it('stops the consumer when the signal aborts', async () => {
    const path = script(`echo $$ > '${dir}/pid'\nexec sleep 60`)
    const { ctx } = context()
    running = supervise(ctx, consumer(path), controller.signal)
    await vi.waitFor(() => expect(existsSync(join(dir, 'pid'))).toBe(true), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    const began = Date.now()
    controller.abort()
    await running
    expect(Date.now() - began).toBeLessThan(5000)
    expect(alive(pid)).toBe(false)
  })
  it('reads a stdout line over 1 MiB and rejects it instead of handling it', async () => {
    const path = script(`printf '%*s' 1048577 '' | tr ' ' x; echo\necho after\nexec sleep 60`)
    const seen: string[] = []
    const { ctx, board } = context()
    running = supervise(ctx, consumer(path, { line: line => { seen.push(line) } }), controller.signal)
    await vi.waitFor(() => expect(board.all.demo).toMatchObject({ state: 'error',
      detail: expect.stringContaining('Demo event exceeds 1 MiB') }), until)
    await vi.waitFor(() => expect(seen).toEqual(['after']), until)
  })
  it('handles stdout lines strictly in order, waiting for an async handler', async () => {
    const path = script(`echo one\necho two\necho three\nexec sleep 60`)
    const pauses: Record<string, number> = { one: 60, two: 30, three: 0 }
    const steps: string[] = []
    const { ctx } = context()
    running = supervise(ctx, consumer(path, {
      line: async line => { steps.push(`start:${line}`); await delay(pauses[line]!); steps.push(`end:${line}`) },
    }), controller.signal)
    await vi.waitFor(() => expect(steps).toEqual(['start:one', 'end:one', 'start:two', 'end:two', 'start:three', 'end:three']), until)
  })
  it('reports the ready health entry, and reports it again after a restart', async () => {
    const path = script(`runs=$(cat '${dir}/runs' 2>/dev/null || echo 0)
runs=$((runs + 1))
echo "$runs" > '${dir}/runs'
echo '[ready]' >&2
if [ "$runs" -eq 1 ]; then exit 1; fi
exec sleep 60`)
    const { ctx, board } = context()
    running = supervise(ctx, consumer(path), controller.signal)
    await vi.waitFor(() => expect(board.all.demo).toMatchObject({ state: 'error',
      detail: expect.stringContaining('Demo consumer exited (1, ready=true)') }), until)
    expect(Number(readFileSync(join(dir, 'runs'), 'utf8'))).toBe(1)
    await vi.waitFor(() => expect(Number(readFileSync(join(dir, 'runs'), 'utf8'))).toBe(2), until)
    await vi.waitFor(() => expect(board.all.demo).toMatchObject({ state: 'ready',
      detail: 'Listening for demo events' }), until)
  })
  it('passes the caller environment through with the consumer variables added, keeping PATH intact', async () => {
    const path = script(`printf '%s|%s' "$DEMO_TOKEN" "$PATH" > '${dir}/env'\nexec sleep 60`)
    const { ctx } = context()
    running = supervise(ctx, consumer(path, { env: { DEMO_TOKEN: 'demo-token' } }), controller.signal)
    await vi.waitFor(() => expect(existsSync(join(dir, 'env'))).toBe(true), until)
    expect(readFileSync(join(dir, 'env'), 'utf8')).toBe(`demo-token|${process.env.PATH}`)
  })
})
