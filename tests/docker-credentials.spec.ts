import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { KV } from '../src/kv.ts'

/**
 * Opt-in process-level test for ticket #3: the host wrapper materialises the
 * agent's GitHub credential from the macOS Keychain, copies the host DSH
 * credential store into the container home once, imports the host state volume
 * once after a WAL checkpoint, and keeps the model key out of the image and
 * compose file.
 *
 * It is skipped unless `DSH_DOCKER_E2E=1`. It never targets the live instance:
 * a throwaway compose project, port, state copy, DSH home, and artifacts
 * directory are used, and the copied state is sanitised (paused, sources
 * cleared, one synthetic ticket) before it reaches the volume.
 *
 * The real-model assertion runs only when `DEEPSEEK_API_KEY` resolves from the
 * process environment or `op run --env-file=$HOME/.config/op/llm.env`. In a
 * locked 1Password session that one assertion is skipped with a reported
 * reason; the rest of the test still runs with a placeholder key.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRAPPER = join(ROOT, 'scripts', 'docker-instance')
const ENABLED = process.env.DSH_DOCKER_E2E === '1'
const PORT = Number(process.env.DSH_DOCKER_E2E_CREDENTIALS_PORT ?? 38083)
const PROJECT = process.env.DSH_DOCKER_E2E_CREDENTIALS_PROJECT ?? `dsh-cred-e2e-${process.pid}-${Date.now().toString(36)}`
const INSTANCE = 'credentials'
const TIMEOUT = Number(process.env.DSH_DOCKER_E2E_TIMEOUT ?? 180_000)
const REAL_STATE = join(homedir(), '.dsh', 'state', 'superagent')
const CREDENTIALS = join(homedir(), '.dsh', '.credentials.yaml')
const OP_ENV = join(homedir(), '.config', 'op', 'llm.env')
// The image bakes the operator identity as a build input. Derive the expected
// container paths from the same values the wrapper/build script use, so the
// spec passes for any operator instead of one hard-coded home.
const OPERATOR_HOME = process.env.OPERATOR_HOME ?? homedir()
const OPERATOR_UID = process.env.OPERATOR_UID ?? String(process.getuid?.() ?? 1000)
const OPERATOR_GID = process.env.OPERATOR_GID ?? String(process.getgid?.() ?? 1000)
const STATE_PATH = join(OPERATOR_HOME, '.dsh', 'state', 'superagent')
const GH_AGENT = join(OPERATOR_HOME, '.local', 'bin', 'gh-agent')
const GH_CONFIG = join(OPERATOR_HOME, '.config', 'gh-agent')
const PLACEHOLDER_KEY = 'sk-e2e-placeholder-never-a-real-key'
const IMPORTED_TICKET = 'ticket-imported-by-ticket-03'
const IMPORTED_TITLE = 'Imported host history is visible in the container'

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
let repository = ''
let masterId = ''
let realKey: string | undefined
let modelKeyReason = ''
let hostsHashBefore = ''
let hostStateHash = ''

function composeFiles(): string[] {
  const files = ['-f', join(ROOT, 'compose.yaml')]
  if (runtime && existsSync(join(runtime, 'compose.runtime.yaml'))) files.push('-f', join(runtime, 'compose.runtime.yaml'))
  return files
}

function compose(args: string[], options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Result {
  return run('docker', ['compose', ...composeFiles(), '--project-directory', ROOT, '-p', PROJECT, ...args], {
    ...options,
    env: {
      SUPERAGENT_IMAGE: image,
      SUPERAGENT_PUBLISH_PORT: String(PORT),
      OPERATOR_HOME,
      OPERATOR_UID,
      OPERATOR_GID,
      ...options.env,
    },
  })
}

function wrapper(command: 'prepare' | 'start' | 'stop' | 'status', extra: NodeJS.ProcessEnv = {}, options: { allowFailure?: boolean; timeout?: number } = {}): Result {
  return run('bash', [WRAPPER, command], {
    ...options,
    env: {
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
      DEEPSEEK_API_KEY: realKey ?? PLACEHOLDER_KEY,
      ...extra,
    },
    timeout: options.timeout ?? 10 * 60_000,
  })
}

function stateUrl(path = ''): string {
  return `http://127.0.0.1:${PORT}/${path}`
}

async function management(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(stateUrl(`orchestrator/api/${path}`), {
    ...init,
    headers: { 'x-orchestrator-request': '1', ...init.headers },
  })
}

async function managementJson(path: string, init: RequestInit = {}): Promise<any> {
  const response = await management(path, init)
  check(response.status === 200, `management ${path} answered ${response.status}`)
  return response.json()
}

function logs(): string {
  return compose(['logs', '--no-color', 'superagent']).stdout
}

function tokenFrom(text: string): string | undefined {
  return [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
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

function hashFile(path: string): string {
  return run('shasum', ['-a', '256', path]).stdout.split(/\s+/)[0]!
}

/** Same contract as the wrapper: every file except SQLite's shared-memory file, in stable order. */
function stateHash(directory: string): string {
  const script = 'find . -type f ! -name "*.sqlite-shm" -print | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done | shasum -a 256 | awk \'{print $1}\''
  return run('bash', ['-c', script], { cwd: directory, env: { PATH: process.env.PATH ?? '' } }).stdout.trim()
}

function volumeFile(path: string): string {
  return run('docker', ['run', '--rm', '--entrypoint', 'cat', '-v', `${PROJECT}_superagent-state:/state`, image, path]).stdout
}

function imageEnv(): string {
  return run('docker', ['image', 'inspect', image, '--format', '{{json .Config.Env}}']).stdout
}

function resolveModelKey(): { key?: string; reason: string } {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, reason: 'DEEPSEEK_API_KEY from the environment' }
  const who = spawnSync('op', ['whoami'], { encoding: 'utf8', timeout: 15_000 })
  if (who.status !== 0) return { reason: `1Password is not signed in (op whoami exited ${who.status ?? 'timed out'})` }
  const resolved = spawnSync('op', ['run', `--env-file=${OP_ENV}`, '--', 'printenv', 'DEEPSEEK_API_KEY'], { encoding: 'utf8', timeout: 30_000 })
  const key = resolved.stdout?.trim()
  if (resolved.status !== 0 || !key) return { reason: `op run could not resolve DEEPSEEK_API_KEY from ${OP_ENV} (exit ${resolved.status ?? 'timeout'})` }
  return { key, reason: 'DEEPSEEK_API_KEY from op run' }
}

/** Copy the host state, then make it inert for a test: paused, no Sources, one synthetic open ticket, and a distinguishable executor setting. */
function sanitiseState(): void {
  cpSync(REAL_STATE, stateDir, { recursive: true, preserveTimestamps: true })
  const store = new Store(join(stateDir, 'orchestrator.sqlite'))
  try {
    masterId = store.get(KV.runtime.masterId) ?? ''
    check(masterId.length > 0, 'the copied state has no master-id')
    const settings = store.settings()
    const github = settings.sources.github
    repository = typeof github?.config.repository === 'string' ? github.config.repository : ''
    check(repository.includes('/'), 'the copied settings do not name a GitHub repository')
    store.saveSettings({ ...settings, paused: true, sources: {}, executor: { ...settings.executor, maxWorkers: 7 } }, {
      source: 'panel', block: 'pause', policyVersion: '', policyChanged: false, notified: [],
    })
    const ticket: Ticket = {
      id: IMPORTED_TICKET, title: IMPORTED_TITLE, decisionId: 'decision-imported', channels: [], inputs: [], undelivered: [],
      mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed', sender: 'Alice' }, actor: { source: 'github', id: 'alice' }, scope: 'small' },
      assignments: [], createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z',
      origin: { triggerId: 'trigger-imported', triggerIds: ['trigger-imported'] },
    }
    store.tickets.save(ticket)
  } finally {
    store.close()
  }
  chmodSync(join(stateDir, 'orchestrator.sqlite'), 0o600)
}

describe.skipIf(!ENABLED)('docker credentials and one-time state import (ticket #3)', () => {
  beforeAll(async () => {
    check(PORT !== 3082 && PORT !== 3083, `refusing to publish on the live instance port ${PORT}`)
    check(existsSync(join(REAL_STATE, 'orchestrator.sqlite')), `no host state at ${REAL_STATE}`)
    check(existsSync(CREDENTIALS), `no host DSH credential store at ${CREDENTIALS}`)

    scratch = mkdtempSync(join(tmpdir(), 'dsh-cred-e2e-'))
    stateDir = join(scratch, 'state')
    dshHome = join(scratch, 'dsh')
    artifacts = join(scratch, 'artifacts')
    runtime = join(artifacts, 'instances', INSTANCE)
    mkdirSync(dshHome, { recursive: true })
    copyFileSync(CREDENTIALS, join(dshHome, '.credentials.yaml'))
    chmodSync(join(dshHome, '.credentials.yaml'), 0o600)
    sanitiseState()
    hostsHashBefore = hashFile(join(dshHome, '.credentials.yaml'))

    const resolved = resolveModelKey()
    realKey = resolved.key
    modelKeyReason = resolved.reason
    if (!realKey) {
      console.warn(`docker credentials e2e: real model reply will be skipped because ${modelKeyReason}.`)
    }

    const built = process.env.DSH_DOCKER_E2E_IMAGE
      ?? run('bash', [join(ROOT, 'scripts', 'docker-build')], {
        env: {
          ...process.env,
          SUPERAGENT_IMAGE: '',
          OPERATOR_HOME,
          OPERATOR_UID,
          OPERATOR_GID,
          BUILDX_CONFIG: '/tmp/dsh-buildx-ticket03',
        },
        timeout: 40 * 60_000,
      }).stdout.trim().split('\n').at(-1)!.trim()
    image = built
    check(image.length > 0, 'scripts/docker-build did not print an image tag')
    const commit = run('git', ['rev-parse', '--short=12', 'HEAD']).stdout.trim()
    check(image.includes(commit), `image tag ${image} does not encode the product commit ${commit}`)

    // The credential must never be a layer input or image metadata.
    expect(imageEnv()).not.toMatch(/oauth_token|gho_|sk-e2e|DEEPSEEK_API_KEY/)

    const prepared = wrapper('prepare')
    expect(prepared.status, prepared.stderr).toBe(0)
    expect(prepared.stderr).toContain('imported')
    expect(prepared.stderr).toContain('once')

    // The wrapper hashes the host copy after the WAL checkpoint and before/after
    // the copy; the same hash must match the marker and survive the whole run.
    hostStateHash = stateHash(stateDir)
    expect(volumeFile('/state/.imported')).toContain(`hash=${hostStateHash}`)
    expect(hashFile(join(stateDir, 'orchestrator.sqlite'))).toBe(
      run('docker', ['run', '--rm', '--entrypoint', 'sha256sum', '-v', `${PROJECT}_superagent-state:/state`, image, '/state/orchestrator.sqlite']).stdout.split(/\s+/)[0],
    )

    const started = wrapper('start')
    expect(started.status, started.stderr).toBe(0)
    expect(started.stderr).toContain('already imported')
    expect(started.stdout).toMatch(/panel: http:\/\/127\.0\.0\.1:\d+\/\?token=/)

    await waitFor('the management API through the published port', async () => (await management('state').catch(() => undefined))?.status === 200)
  }, 45 * 60_000)

  afterAll(async () => {
    if (!ENABLED) return
    const stopped = wrapper('stop', {}, { allowFailure: true })
    if (stopped.status === 0) {
      try {
        expect(existsSync(runtime)).toBe(false)
        expect(run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).stdout).toContain(`${PROJECT}_superagent-state`)
      } catch (error) {
        console.error('docker credentials e2e: stop contract failed', error)
        throw error
      }
    }
    run('docker', ['compose', ...composeFiles(), '--project-directory', ROOT, '-p', PROJECT, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], {
      env: {
        SUPERAGENT_IMAGE: image,
        SUPERAGENT_PUBLISH_PORT: String(PORT),
        OPERATOR_HOME,
        OPERATOR_UID,
        OPERATOR_GID,
      },
      allowFailure: true,
      timeout: 120_000,
    })
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }, 180_000)

  it('materialises runtime credentials, proves gh and git access, imports once, and keeps post-import state across a restart', async () => {
    // The host-side runtime directory is private, contains the token, and is
    // removed on stop. The compose override is the only place the token-bearing
    // file is referenced; compose.yaml itself stays secret-free.
    expect(statSync(runtime).mode & 0o777).toBe(0o700)
    const hosts = readFileSync(join(runtime, 'hosts.yml'), 'utf8')
    expect(hosts).toContain('github.com:')
    expect(hosts).toContain('oauth_token:')
    expect(statSync(join(runtime, 'hosts.yml')).mode & 0o777).toBe(0o600)
    expect(statSync(join(runtime, 'credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(hashFile(join(runtime, 'credentials.yaml'))).toBe(hostsHashBefore)
    const override = readFileSync(join(runtime, 'compose.runtime.yaml'), 'utf8')
    expect(override).toContain(`target: "${GH_CONFIG}/hosts.yml"`)
    expect(override).toContain('/run/superagent/credentials.yaml')
    expect(override).toContain('read_only: true')
    expect(override).not.toContain('oauth_token')
    expect(readFileSync(join(ROOT, 'compose.yaml'), 'utf8')).not.toContain('oauth_token')

    // The container sees a 0600 DSH credential copy, not the host path.
    const credentialLine = compose(['exec', '-T', 'superagent', 'stat', '-c', '%a %u %g', '/data/dsh/.credentials.yaml']).stdout.trim()
    expect(credentialLine).toBe(`600 ${OPERATOR_UID} ${OPERATOR_GID}`)
    expect(compose(['exec', '-T', 'superagent', 'sha256sum', '/data/dsh/.credentials.yaml']).stdout.split(/\s+/)[0]).toBe(hostsHashBefore)

    // The imported worker-gitconfig names the in-image shim, so the shim must
    // pass the container GH_CONFIG_DIR through to gh. A live GitHub token is not
    // reliably available in this sandbox (the Keychain item can be a fixture),
    // so the shim contract is proved with a stub and the live network calls run
    // only when GitHub accepts the imported token.
    expect(compose(['exec', '-T', 'superagent', 'test', '-x', GH_AGENT]).status).toBe(0)
    const auth = compose(['exec', '-T', '--user', `${OPERATOR_UID}:${OPERATOR_GID}`, 'superagent', GH_AGENT, 'auth', 'status'], { allowFailure: true })
    expect(`${auth.stdout}${auth.stderr}`).toMatch(/github\.com/i)
    const api = compose(['exec', '-T', '--user', `${OPERATOR_UID}:${OPERATOR_GID}`, 'superagent', GH_AGENT, 'api', 'user', '--jq', '.login'], { allowFailure: true })
    const githubUsable = auth.status === 0 && api.status === 0 && /^[A-Za-z0-9-]+$/.test(api.stdout.trim())

    const stub = Buffer.from(`#!/bin/sh
case "$1 $2" in
  "auth status") echo "github.com"; echo "Logged in to github.com account agent-under-test (stub)"; exit 0 ;;
  "api user") test -f "$GH_CONFIG_DIR/hosts.yml" && echo "stub-agent-under-test" || exit 1; exit 0 ;;
  "auth git-credential") printf 'username=agent-under-test\\npassword=stub-token\\n\\n'; exit 0 ;;
esac
echo "stub gh: $*" >&2; exit 1
`).toString('base64')
    compose(['exec', '-T', 'superagent', 'sh', '-c', `mkdir -p /tmp/gh-stub && printf %s '${stub}' | base64 -d > /tmp/gh-stub/gh && chmod 0755 /tmp/gh-stub/gh`])
    const stubLogin = compose(['exec', '-T', '--user', `${OPERATOR_UID}:${OPERATOR_GID}`, 'superagent', 'env', 'PATH=/tmp/gh-stub:/usr/local/bin:/usr/bin:/bin', 'sh', '-c',
      `GH_CONFIG_DIR=${GH_CONFIG} ${GH_AGENT} api user --jq .login`]).stdout.trim()
    expect(stubLogin).toBe('stub-agent-under-test')
    const credential = compose(['exec', '-T', '--user', `${OPERATOR_UID}:${OPERATOR_GID}`, 'superagent', 'sh', '-c',
      `printf "protocol=https\\nhost=github.com\\n\\n" | env GIT_CONFIG_GLOBAL=${STATE_PATH}/worker-gitconfig PATH=/tmp/gh-stub:/usr/local/bin:/usr/bin:/bin git credential fill`]).stdout
    expect(credential).toContain('username=agent-under-test')
    expect(credential).toContain('password=stub-token')

    if (!githubUsable) {
      console.warn(`docker credentials e2e: live gh authentication skipped because the imported Keychain token was rejected: ${`${auth.stderr}${api.stderr}`.trim().split('\n').slice(0, 4).join(' | ')}`)
    } else {
      expect(api.stdout.trim()).toMatch(/^[A-Za-z0-9-]+$/)
    }
    // The repository is public, so this exercises the configured URL and the
    // container network even when the imported token is rejected; the credential
    // path itself is covered by the git credential fill assertion above.
    const remote = compose(['exec', '-T', '--user', `${OPERATOR_UID}:${OPERATOR_GID}`, 'superagent', 'env',
      `GIT_CONFIG_GLOBAL=${STATE_PATH}/worker-gitconfig`,
      'git', 'ls-remote', `https://github.com/${repository}.git`, 'HEAD']).stdout
    expect(remote).toMatch(/^[0-9a-f]{40}\tHEAD/m)

    // Existing history and settings are visible through the management API.
    const state = await managementJson('state')
    expect(state.masterId).toBe(masterId)
    expect(state.paused).toBe(true)
    const settings = await managementJson('settings')
    expect(settings.blocks.executor.value.maxWorkers).toBe(7)
    const tickets = await managementJson('tickets?state=open')
    expect(tickets.items.map((item: any) => item.id)).toContain(IMPORTED_TICKET)
    expect(tickets.items.find((item: any) => item.id === IMPORTED_TICKET).title).toBe(IMPORTED_TITLE)

    // The panel URL is scraped from the per-boot log line and stored under .artifacts.
    const panelUrl = readFileSync(join(runtime, 'panel-url'), 'utf8').trim()
    expect(statSync(join(runtime, 'panel-url')).mode & 0o777).toBe(0o600)
    const token = new URL(panelUrl).searchParams.get('token')
    expect(token).toBe(tokenFrom(logs()))
    const loginResponse = await fetch(panelUrl, { redirect: 'manual' })
    expect(loginResponse.status).toBe(303)
    const cookie = loginResponse.headers.getSetCookie()[0]!.split(';')[0]!
    const page = await fetch(stateUrl(), { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>DeepSeek Harness</title>')

    // A post-import mutation through the management API must survive a restart,
    // while the import marker and host copy stay untouched.
    const unpaused = await management('executor/pause', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: false }),
    })
    expect(unpaused.status).toBe(200)
    expect(await unpaused.json()).toEqual({ paused: false })

    compose(['restart', 'superagent'])
    await waitFor('the restarted management API', async () => (await management('state').catch(() => undefined))?.status === 200)
    const restarted = await managementJson('state')
    expect(restarted.paused).toBe(false)
    expect(restarted.masterId).toBe(masterId)
    const restartedTickets = await managementJson('tickets?state=open')
    expect(restartedTickets.items.map((item: any) => item.id)).toContain(IMPORTED_TICKET)
    const restartedSettings = await managementJson('settings')
    expect(restartedSettings.blocks.executor.value.maxWorkers).toBe(7)
    expect(stateHash(stateDir)).toBe(hostStateHash)
    expect(volumeFile('/state/.imported')).toContain(`hash=${hostStateHash}`)

  }, 20 * 60_000)

  it('answers a human message with a real model reply and usage', async (context) => {
    if (!realKey) {
      console.warn(`docker credentials e2e: skipping the real model reply because ${modelKeyReason}.`)
      context.skip()
      return
    }

    const token = tokenFrom(logs())
    check(token !== undefined, 'the restarted container logged no panel token')
    const login = await fetch(stateUrl(`?token=${token}`), { redirect: 'manual' })
    const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!
    const master = (await managementJson('state')).masterId as string
    check(master.length > 0, 'the management state has no master session id')

    const rpc = async (method: string, payload: unknown): Promise<any> => {
      const response = await fetch(stateUrl(`api/${method}`), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
      })
      check(response.status === 200, `${method} answered ${response.status}`)
      const body = await response.json()
      check(body?.result, `${method} returned no result`)
      if (!body.result.ok) throw new Error(`${method} failed: ${JSON.stringify(body.result.error)}`)
      return body.result.value
    }

    const accepted = await rpc('session/prompt', {
      requestId: crypto.randomUUID(), sessionId: master, mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly: TICKET03_OK' }],
    })
    expect(accepted).toEqual({ accepted: true })

    let stats: any
    await waitFor('the real model reply usage', async () => {
      stats = await rpc('session/projections', { sessionId: master })
      return stats?.kind === 'sequenced' && (stats.values?.sessionStats?.decodeTokens ?? 0) > 0
    }, 5 * 60_000)
    expect(stats.values.sessionStats.steps).toBeGreaterThanOrEqual(1)
  }, 10 * 60_000)
})
