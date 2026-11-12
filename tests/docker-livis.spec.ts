import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

/**
 * Opt-in process-level test for ticket #4: the second `livis` instance runs from
 * the same image as `superagent`, seeded from its own baked profile, with the
 * Livis SourceKind plugin built from the sibling dsh-livis checkout.
 *
 * It is skipped unless `DSH_DOCKER_E2E=1`. The host livis instance is never
 * touched: its state is copied (never moved), the copied refresh token is
 * replaced with a value the IDaaS rejects, and the copied settings are paused
 * with no configured Sources. That makes the container inert (no GitHub polling,
 * no executor work) while still proving the real plugin boots, resolves its state
 * under the imported directory, and reports a graceful authentication failure
 * instead of crashing DSH.
 *
 * The real relay identity (`hermes-…` reconnect with the live refresh token) is
 * exercised only at cutover (#7), never here: two processes must not rotate the
 * same refresh token.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRAPPER = join(ROOT, 'scripts', 'docker-instance')
const ENABLED = process.env.DSH_DOCKER_E2E === '1'
const PORT = Number(process.env.DSH_DOCKER_E2E_LIVIS_PORT ?? 38084)
const SUPERAGENT_PORT = Number(process.env.DSH_DOCKER_E2E_LIVIS_SUPERAGENT_PORT ?? 38085)
const PROJECT = process.env.DSH_DOCKER_E2E_LIVIS_PROJECT ?? `dsh-livis-e2e-${process.pid}-${Date.now().toString(36)}`
const INSTANCE = 'livis'
const TIMEOUT = Number(process.env.DSH_DOCKER_E2E_TIMEOUT ?? 240_000)
const REAL_STATE = join(homedir(), '.dsh', 'state', 'livis')
const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')
const LIVIS_DIR = process.env.LIVIS_DIR ?? join(homedir(), 'Documents', 'WorkSpace', 'dsh-livis')
const OPERATOR_HOME = process.env.OPERATOR_HOME ?? homedir()
const OPERATOR_UID = process.env.OPERATOR_UID ?? String(process.getuid?.() ?? 1000)
const OPERATOR_GID = process.env.OPERATOR_GID ?? String(process.getgid?.() ?? 1000)
const LIVIS_STATE_PATH = join(OPERATOR_HOME, '.dsh', 'state', 'livis')
const FAKE_REFRESH = 'livis-e2e-fake-refresh-token-never-a-valid-credential'
const MARKER_SETTING = 9

interface Result {
  status: number | null
  stdout: string
  stderr: string
}

function run(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeout?: number; cwd?: string } = {}): Result {
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  })
  if (result.error) throw new Error(`${file} ${args.join(' ')} could not run: ${result.error.message}`)
  const text = { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited ${result.status}:\n${text.stdout}\n${text.stderr}`)
  }
  return text
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

let scratch = ''
let stateDir = ''
let dshHome = ''
let artifacts = ''
let runtime = ''
let image = ''
let masterId = ''
let hostRefresh = ''
let importedHash = ''
let ghStub = ''

function composeArgs(): string[] {
  return ['compose', '-f', join(ROOT, 'compose.yaml'), '--project-directory', ROOT, '-p', PROJECT]
}

function compose(args: string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeout?: number } = {}): Result {
  return run('docker', [...composeArgs(), ...args], {
    ...options,
    env: {
      SUPERAGENT_IMAGE: image,
      SUPERAGENT_PUBLISH_PORT: String(SUPERAGENT_PORT),
      LIVIS_PUBLISH_PORT: String(PORT),
      OPERATOR_HOME,
      OPERATOR_UID,
      OPERATOR_GID,
      ...options.env,
    },
  })
}

function wrapper(command: 'prepare' | 'start' | 'stop' | 'status', options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeout?: number } = {}): Result {
  const env: NodeJS.ProcessEnv = {
    SUPERAGENT_IMAGE: image,
    SUPERAGENT_INSTANCE: INSTANCE,
    SUPERAGENT_PROJECT: PROJECT,
    SUPERAGENT_PUBLISH_PORT: String(PORT),
    SUPERAGENT_STATE_DIR: stateDir,
    SUPERAGENT_DSH_HOME: dshHome,
    SUPERAGENT_ARTIFACTS_DIR: artifacts,
    OPERATOR_HOME,
    OPERATOR_UID,
    OPERATOR_GID,
    // The livis suite is about the second instance, not the operator's GitHub
    // login. A local stub keeps the wrapper's token validation deterministic
    // while still staging the hosts.yml the container would receive.
    SUPERAGENT_GH_BIN: ghStub,
    ...options.env,
  }
  // The livis profile signs in through the DSH credential store; the wrapper must
  // not require the model key for it.
  delete env.DEEPSEEK_API_KEY
  return run('bash', [WRAPPER, command], { ...options, env, timeout: options.timeout ?? 10 * 60_000 })
}

function stateUrl(path = ''): string {
  return `http://127.0.0.1:${PORT}/${path}`
}

async function management(path: string): Promise<Response> {
  return fetch(stateUrl(`orchestrator/api/${path}`), { headers: { 'x-orchestrator-request': '1' } })
}

async function managementJson(path: string): Promise<any> {
  const response = await management(path)
  check(response.status === 200, `management ${path} answered ${response.status}`)
  return response.json()
}

function logs(service = INSTANCE): string {
  return compose(['logs', '--no-color', '--no-log-prefix', service]).stdout
}

function tokenFrom(text: string): string | undefined {
  return [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
}

function container(service = INSTANCE): string {
  return compose(['ps', '-q', service]).stdout.trim()
}

function volumeFile(path: string): string {
  return run('docker', ['run', '--rm', '--entrypoint', 'cat', '-v', `${PROJECT}_livis-state:/state`, image, path]).stdout
}

function hashFile(path: string): string {
  return run('shasum', ['-a', '256', path]).stdout.split(/\s+/)[0]!
}

/** Same contract as the wrapper: every file except SQLite's shared-memory file, in stable order. */
function stateHash(directory: string): string {
  const script = 'find . -type f ! -name "*.sqlite-shm" -print | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done | shasum -a 256 | awk \'{print $1}\''
  return run('bash', ['-c', script], { cwd: directory, env: { PATH: process.env.PATH ?? '' } }).stdout.trim()
}

async function waitFor(label: string, probe: () => Promise<boolean> | boolean, timeout = TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeout
  let last = ''
  while (Date.now() < deadline) {
    try {
      if (await probe()) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(1_000)
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${label}${last ? `\n${last}` : ''}`)
}

async function panelLogin(): Promise<string> {
  const token = tokenFrom(logs())
  check(token !== undefined, 'the livis container logged no panel token')
  const login = await fetch(stateUrl(`?token=${token}`), { redirect: 'manual' })
  expect(login.status).toBe(303)
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
  check(cookie !== undefined, 'the token exchange did not set a panel cookie')
  const page = await fetch(stateUrl(), { headers: { cookie } })
  expect(page.status).toBe(200)
  expect(page.headers.get('content-type')).toContain('text/html')
  const html = await page.text()
  expect(html).toContain('<title>DeepSeek Harness</title>')
  return cookie
}

/**
 * Copy the host livis state, then make it inert for a test: paused, no Sources,
 * a distinguishable executor setting, and a refresh token the IDaaS rejects. The
 * real token stays only in the host file and is never written to the volume,
 * the image, the logs, or this test's output.
 */
function sanitiseState(): void {
  cpSync(REAL_STATE, stateDir, { recursive: true, preserveTimestamps: true })

  const clientState = join(stateDir, 'livis-source', 'client', 'state.json')
  const real = JSON.parse(readFileSync(join(REAL_STATE, 'livis-source', 'client', 'state.json'), 'utf8'))
  hostRefresh = String(real.refreshToken ?? '')
  check(hostRefresh.length > 0, 'the host livis state has no refresh token to sanitise')
  check(/^hermes-/.test(String(real.agentId ?? '')), 'the host livis state has no hermes- agent identity')

  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    masterId = store.get(KV.runtime.masterId) ?? ''
    check(masterId.length > 0, 'the copied livis state has no master-id')
    const settings = store.settings()
    store.saveSettings({ ...settings, paused: true, sources: {}, executor: { ...settings.executor, maxWorkers: MARKER_SETTING } }, {
      source: 'panel', block: 'pause', policyVersion: '', policyChanged: false, notified: [],
    })
  } finally {
    store.close()
  }
  chmodSync(join(stateDir, 'orchestrator.sqlite'), 0o600)

  real.refreshToken = FAKE_REFRESH
  writeFileSync(clientState, `${JSON.stringify(real, null, 2)}\n`, { mode: 0o600 })
  chmodSync(clientState, 0o600)
}

function livisHealth(state: any): any {
  return state?.health?.[INSTANCE]
}

describe.skipIf(!ENABLED)('docker livis instance with its plugin and sanitised state (ticket #4)', () => {
  beforeAll(async () => {
    check(PORT !== 3082 && PORT !== 3083 && SUPERAGENT_PORT !== 3082 && SUPERAGENT_PORT !== 3083, `refusing to publish on the live instance ports ${PORT}/${SUPERAGENT_PORT}`)
    check(existsSync(join(REAL_STATE, 'orchestrator.sqlite')), `no host livis state at ${REAL_STATE}`)
    check(existsSync(join(REAL_STATE, 'livis-source', 'client', 'state.json')), `no host livis client state at ${REAL_STATE}`)
    check(existsSync(CREDENTIALS), `no host DSH credential store at ${CREDENTIALS}`)
    check(existsSync(join(LIVIS_DIR, 'packages', 'dsh-livis-source', 'package.json')), `no dsh-livis checkout at ${LIVIS_DIR}; set LIVIS_DIR`)

    scratch = mkdtempSync(join(tmpdir(), 'dsh-livis-e2e-'))
    stateDir = join(scratch, 'state')
    dshHome = join(scratch, 'dsh')
    artifacts = join(scratch, 'artifacts')
    runtime = join(artifacts, 'instances', INSTANCE)
    mkdirSync(dshHome, { recursive: true })
    copyFileSync(CREDENTIALS, join(dshHome, '.credentials.yaml'))
    chmodSync(join(dshHome, '.credentials.yaml'), 0o600)
    sanitiseState()

    const bin = join(scratch, 'bin')
    mkdirSync(bin, { recursive: true })
    ghStub = join(bin, 'gh')
    writeFileSync(ghStub, '#!/bin/sh\ncase "$1 $2" in\n  "auth token") printf "%s\\n" "gho_livis_e2e_placeholder_token" ;;\n  "api user") printf "%s\\n" "livis-e2e-agent" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 })
    chmodSync(ghStub, 0o755)

    const built = process.env.DSH_DOCKER_E2E_IMAGE
      ?? run('bash', [join(ROOT, 'scripts', 'docker-build')], {
        env: {
          ...process.env,
          SUPERAGENT_IMAGE: '',
          OPERATOR_HOME,
          OPERATOR_UID,
          OPERATOR_GID,
          BUILDX_CONFIG: '/tmp/dsh-buildx-ticket04',
        },
        timeout: 40 * 60_000,
      }).stdout.trim().split('\n').at(-1)!.trim()
    image = built
    check(image.length > 0, 'scripts/docker-build did not print an image tag')
    const commit = run('git', ['rev-parse', '--short=12', 'HEAD']).stdout.trim()
    expect(image).toContain(commit)
    if (!process.env.DSH_DOCKER_E2E_IMAGE) {
      const livisCommit = run('git', ['-C', LIVIS_DIR, 'rev-parse', '--short=12', 'HEAD']).stdout.trim()
      expect(image).toContain(`livis-${livisCommit}`)
    }
    // The image is metadata-only for credentials: no host token, model key, or
    // livis refresh token is baked into its environment or labels.
    const imageEnv = run('docker', ['image', 'inspect', image, '--format', '{{json .Config.Env}}']).stdout
    expect(imageEnv).not.toMatch(/DEEPSEEK_API_KEY|oauth_token|refreshToken|gho_/)
    // Both profile templates and the built plugin are in the same image.
    const baked = run('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c',
      'test -f /opt/superagent-template/profiles/superagent/package.json && test -f /opt/livis-template/profiles/livis/cordis.patch.yml && test -f /opt/dsh-livis/packages/dsh-livis-source/index.js && grep -q "dsh-livis-source" /opt/livis-template/profiles/livis/package.json'], { allowFailure: true })
    expect(baked.status, baked.stderr).toBe(0)

    const prepared = wrapper('prepare')
    expect(prepared.status, prepared.stderr).toBe(0)
    expect(prepared.stderr).toContain('imported')
    expect(prepared.stderr).toContain('once')
    importedHash = stateHash(stateDir)
    expect(volumeFile('/state/.imported')).toContain(`hash=${importedHash}`)
    expect(volumeFile('/state/livis-source/client/state.json')).toContain(FAKE_REFRESH)
    expect(volumeFile('/state/livis-source/client/state.json')).not.toContain(hostRefresh)

    const started = wrapper('start')
    expect(started.status, started.stderr).toBe(0)
    expect(started.stderr).toContain('already imported')
    expect(started.stdout).toMatch(/panel: http:\/\/127\.0\.0\.1:\d+\/\?token=/)
    await waitFor('the livis management API through the published port', async () => (await management('state').catch(() => undefined))?.status === 200)
  }, 45 * 60_000)

  afterAll(async () => {
    if (!ENABLED || !scratch) return
    const stopped = wrapper('stop', { allowFailure: true })
    if (stopped.status === 0 && existsSync(runtime)) throw new Error('wrapper stop left its runtime directory behind')
    compose(['down', '--volumes', '--remove-orphans', '--timeout', '10'], { allowFailure: true, timeout: 120_000 })
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }, 180_000)

  it('boots from the sanitised state, resolves the plugin state in the imported directory, and reports a graceful auth failure', async () => {
    // The wrapper stages credentials for the livis instance too, but no model key.
    expect(statSync(runtime).mode & 0o777).toBe(0o700)
    expect(statSync(join(runtime, 'credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(hashFile(join(runtime, 'credentials.yaml'))).toBe(hashFile(join(dshHome, '.credentials.yaml')))
    const override = readFileSync(join(runtime, 'compose.runtime.yaml'), 'utf8')
    expect(override).toContain('services:\n  livis:')
    expect(override).not.toContain('DEEPSEEK_API_KEY')
    expect(override).toContain('/run/superagent/credentials.yaml')
    expect(override).toContain('read_only: true')

    // The imported state belongs to the wrapper: same master id, settings marker,
    // sanitised token, and the plugin resolves its state under the imported path
    // rather than the container HOME default.
    const cid = container()
    check(cid.length > 0, 'the livis container is not running')
    const env = compose(['exec', '-T', INSTANCE, 'printenv', 'DSH_LIVIS_STATE_DIR']).stdout.trim()
    expect(env).toBe(`${LIVIS_STATE_PATH}/livis-source`)
    expect(compose(['exec', '-T', INSTANCE, 'test', '-f', `${LIVIS_STATE_PATH}/livis-source/client/state.json`], { allowFailure: true }).status).toBe(0)
    expect(compose(['exec', '-T', INSTANCE, 'test', '!', '-e', '/data/dsh/.dsh/state/livis/livis-source'], { allowFailure: true }).status).toBe(0)

    const state = await managementJson('state')
    expect(state.masterId).toBe(masterId)
    expect(state.paused).toBe(true)
    const settings = await managementJson('settings')
    expect(settings.blocks.executor.value.maxWorkers).toBe(MARKER_SETTING)

    // The plugin is the real one from the dsh-livis build: it claims the `livis`
    // health entry and, with the fake refresh token, reports an authentication
    // failure. It must never take DSH down.
    await waitFor('the livis Source health entry', async () => livisHealth(await managementJson('state')) !== undefined)
    await waitFor('the livis Source to report the rejected refresh token', async () => {
      const entry = livisHealth(await managementJson('state'))
      return entry !== undefined && entry.state !== 'starting'
    }, 5 * 60_000)
    const health = livisHealth(await managementJson('state'))
    expect(health.state).toBe('error')
    expect(String(health.detail)).toMatch(/LIVIS_|refresh token|authentication/i)
    expect(compose(['ps', '--status', 'running', '-q', INSTANCE]).stdout.trim()).toBe(cid)

    // Panel login works through the published port (the relay preserves Host).
    await panelLogin()

    // One container per state volume: the live volume is not mounted anywhere
    // else, and this project has exactly one container using the imported volume.
    const mounting = run('docker', ['ps', '-aq', '--filter', `volume=${PROJECT}_livis-state`]).stdout.trim().split('\n').filter(Boolean)
    expect(mounting.length).toBe(1)
    expect(cid.startsWith(mounting[0]!) || mounting[0]!.startsWith(cid)).toBe(true)
    const volumes = run('docker', ['inspect', cid, '--format', '{{json .Mounts}}']).stdout
    expect(volumes).toContain(`${PROJECT}_livis-state`)
    expect(volumes).toContain(LIVIS_STATE_PATH)
  }, 10 * 60_000)

  it('keeps the imported state across a wrapper stop/start and preserves the one-container rule', async () => {
    const before = await managementJson('state')
    const stopped = wrapper('stop')
    expect(stopped.status, stopped.stderr).toBe(0)
    expect(existsSync(runtime)).toBe(false)
    expect(run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout.trim()).toBe('')

    const started = wrapper('start')
    expect(started.status, started.stderr).toBe(0)
    expect(started.stderr).toContain('already imported')
    await waitFor('the restarted livis management API', async () => (await management('state').catch(() => undefined))?.status === 200)
    const after = await managementJson('state')
    expect(after.masterId).toBe(before.masterId)
    expect(after.paused).toBe(true)
    expect((await managementJson('settings')).blocks.executor.value.maxWorkers).toBe(MARKER_SETTING)
    expect(volumeFile('/state/.imported')).toContain(`hash=${importedHash}`)
    expect(volumeFile('/state/livis-source/client/state.json')).toContain(FAKE_REFRESH)
    await waitFor('the livis Source after the restart', async () => livisHealth(await managementJson('state'))?.state === 'error', 5 * 60_000)
    await panelLogin()

    const cid = container()
    const mounting = run('docker', ['ps', '-aq', '--filter', `volume=${PROJECT}_livis-state`]).stdout.trim().split('\n').filter(Boolean)
    expect(mounting.length).toBe(1)
    expect(cid.startsWith(mounting[0]!) || mounting[0]!.startsWith(cid)).toBe(true)
  }, 15 * 60_000)

  it('runs the superagent and livis services side by side without port interference', async () => {
    compose(['up', '--detach', 'superagent'])
    await waitFor('the superagent container to log a panel token', () => tokenFrom(logs('superagent')) !== undefined, 5 * 60_000)
    const superagentToken = tokenFrom(logs('superagent'))!
    const login = await fetch(`http://127.0.0.1:${SUPERAGENT_PORT}/?token=${superagentToken}`, { redirect: 'manual' })
    expect(login.status).toBe(303)

    // The livis panel still answers on its own published port and the livis
    // container was not restarted or replaced by the superagent service.
    const livis = await management('state')
    expect(livis.status).toBe(200)
    const superagent = await fetch(`http://127.0.0.1:${SUPERAGENT_PORT}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' } })
    expect(superagent.status).toBe(200)

    const running = run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout.trim().split('\n').filter(Boolean)
    expect(running.length).toBe(2)
    expect(compose(['ps', '-q', INSTANCE]).stdout.trim().length).toBeGreaterThan(0)
    expect(compose(['ps', '-q', 'superagent']).stdout.trim().length).toBeGreaterThan(0)
  }, 10 * 60_000)
})
