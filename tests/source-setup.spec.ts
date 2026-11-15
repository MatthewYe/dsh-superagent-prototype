/** Per-source deployment and setup slots: each Source kind resolves and reports its own profile. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { resolveDeployment } from '../src/deployment.ts'
import { SetupError } from '../src/setup.ts'
import { resolveSourceProfiles, setupChanged } from '../src/app/setup.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { testMachine } from './fixtures/deployment.ts'

const StubConfig = z.object({ cli: z.string().default(''), token: z.string().default('') }).strict()
const stub = (probe: (input: { config: Record<string, unknown> }) => Promise<unknown>): SourceKind => ({
  kind: 'stub',
  title: { zh: '桩', en: 'Stub' },
  description: { zh: '桩', en: 'Stub' },
  schema: StubConfig,
  fields: [],
  health: ['stub'],
  setup: { fields: ['cli', 'token'], probe: input => probe({ config: input.config }) },
})
const settings = (config: Record<string, unknown>, enabled = true) =>
  SettingsSchema.parse({ sources: { stub: { enabled, config } } })
const resolve = (kind: SourceKind, config: Record<string, unknown>, enabled = true) => resolveSourceProfiles({
  machine: testMachine(),
  settings: settings(config, enabled),
  kinds: [kind],
  run: async () => '',
  signal: new AbortController().signal,
})

describe('per-source setup fields', () => {
  it('follows the fields each registered kind declares', () => {
    const kinds = [githubKind, stub(() => Promise.resolve(undefined))]
    const before = settings({ cli: 'a' })
    const after = settings({ cli: 'b' })
    expect(setupChanged(before, after, kinds)).toBe(true)
    expect(setupChanged(before, settings({ cli: 'a', token: 't' }), kinds)).toBe(true)
    expect(setupChanged(before, settings({ cli: 'a', unrelated: 1 }), kinds)).toBe(false)
  })
})

describe('per-source resolution', () => {
  it('stores the profile a kind resolves and leaves absent profiles out', async () => {
    const resolved = await resolve(stub(async ({ config }) => ({ token: config.cli })), { cli: 'stub-token' })
    expect(resolved.sources).toEqual({ stub: { token: 'stub-token' } })
    expect(resolved.problems.size).toBe(0)
    expect([...resolved.enabled]).toEqual(['stub'])
  })

  it('records a failed probe against its kind without failing the others', async () => {
    const good = stub(async () => ({ ok: true }))
    const bad: SourceKind = { ...stub(async () => { throw new Error('stub is broken') }), kind: 'bad', health: ['bad'] }
    const settingsValue = SettingsSchema.parse({ sources: { stub: { enabled: true, config: {} }, bad: { enabled: true, config: {} } } })
    const resolved = await resolveSourceProfiles({
      machine: testMachine(), settings: settingsValue, kinds: [bad, good], run: async () => '', signal: new AbortController().signal,
    })
    expect(resolved.sources).toEqual({ stub: { ok: true } })
    expect(resolved.problems.get('bad')).toMatchObject({ place: 'bad', code: 'sourceFailed', detail: 'stub is broken' })
  })

  it('keeps an empty profile as no profile instead of an error', async () => {
    const resolved = await resolve(stub(async () => undefined), {})
    expect(resolved.sources).toEqual({})
    expect(resolved.problems.size).toBe(0)
  })

  it('does not treat a disabled kind as blocking', async () => {
    const resolved = await resolve(stub(async () => { throw new SetupError('foreignFile', { file: 'x' }) }), { cli: 'bad' }, false)
    expect(resolved.problems.get('stub')?.place).toBe('stub')
    expect(resolved.enabled.size).toBe(0)
  })
})

describe('Feishu keeps its history slot name', () => {
  it('owns history:feishu and not the old history entry', () => {
    expect(feishuKind.health).toContain('history:feishu')
    expect(feishuKind.health).not.toContain('history')
  })
})

describe('deployment slots', () => {
  it('carries a per-source record and no feishu field', async () => {
    const deployment = await resolveDeployment(testMachine(), { repository: 'acme/widgets', cli: '/bin/sh' }, async argv =>
      argv.includes('user') ? '{"login":"agent-bot","id":7}' : '{"name":"acme/widgets","push":true}', '/usr/bin:/bin')
    expect(deployment.sources).toEqual({})
    expect(deployment).not.toHaveProperty('feishu')
  })
})
