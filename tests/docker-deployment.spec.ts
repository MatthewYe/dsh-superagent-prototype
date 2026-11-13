import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Opt-in process-level test for the Docker deployment contract (ticket #2).
 *
 * It is skipped unless `DSH_DOCKER_E2E=1`, because it needs a Docker daemon and
 * several minutes for an image build. The default `pnpm test` therefore stays
 * host-independent. Everything it creates (containers, volumes, networks) is
 * named after a throwaway compose project and is removed even when a step fails.
 *
 * The service publishes an alternate host port so a live host instance on 3082
 * is never touched; `DSH_DOCKER_E2E_PORT` overrides it.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENABLED = process.env.DSH_DOCKER_E2E === '1'
const PORT = Number(process.env.DSH_DOCKER_E2E_PORT ?? 38082)
const PROJECT = process.env.DSH_DOCKER_E2E_PROJECT ?? `dsh-e2e-${process.pid}-${Date.now().toString(36)}`
const TIMEOUT = Number(process.env.DSH_DOCKER_E2E_TIMEOUT ?? 180_000)
const OPERATOR_HOME = process.env.OPERATOR_HOME ?? homedir()
const OPERATOR_UID = process.env.OPERATOR_UID ?? String(process.getuid?.() ?? 1000)
const OPERATOR_GID = process.env.OPERATOR_GID ?? String(process.getgid?.() ?? 1000)

const COMPOSE = ['compose', '-f', join(ROOT, 'compose.yaml'), '--project-directory', ROOT, '-p', PROJECT]

interface RunOptions {
  allowFailure?: boolean
  env?: NodeJS.ProcessEnv
  timeout?: number
}

/** Run a command synchronously; docker output is bounded and failures carry stderr. */
function run(file: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(file, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  })
  if (result.error) throw new Error(`${file} ${args.join(' ')} could not run: ${result.error.message}`)
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} exited ${result.status}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function compose(options: RunOptions, ...args: string[]): string
function compose(...args: string[]): string
function compose(first: string | RunOptions, ...rest: string[]): string {
  const options = typeof first === 'string' ? {} : first
  const args = typeof first === 'string' ? [first, ...rest] : rest
  return run('docker', [...COMPOSE, ...args], {
    ...options,
    env: {
      ...process.env,
      SUPERAGENT_IMAGE: image,
      SUPERAGENT_PUBLISH_PORT: String(PORT),
      OPERATOR_HOME,
      OPERATOR_UID,
      OPERATOR_GID,
    },
  })
}

function failure(text: string, detail?: string): never {
  throw new Error(detail ? `${text}\n${detail}` : text)
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) failure(message)
}

/** Poll until `probe` is satisfied; report the last failure instead of a bare timeout. */
async function waitFor(label: string, probe: () => Promise<boolean>, timeout = TIMEOUT): Promise<void> {
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
  failure(`timed out after ${timeout}ms waiting for ${label}`, last || undefined)
}

let image = ''
let cid = ''

function stateUrl(path = ''): string {
  return `http://127.0.0.1:${PORT}/${path}`
}

async function state(): Promise<any> {
  const response = await fetch(stateUrl('orchestrator/api/state'), { headers: { 'x-orchestrator-request': '1' } })
  check(response.status === 200, `management state answered ${response.status}`)
  return await response.json()
}

function container(): string {
  const id = compose('ps', '-q', 'superagent').trim()
  check(id.length > 0, 'compose reported no superagent container')
  return id
}

function health(id: string): string {
  return run('docker', ['inspect', '--format', '{{.State.Health.Status}}', id]).trim()
}

function logs(): string {
  return compose('logs', '--no-color', 'superagent')
}

function tokenFrom(text: string): string | undefined {
  return [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
}

/** Parse LISTEN entries out of /proc/net/tcp{,6}: {"<hex address>:<hex port>", ...}. */
function listeners(): string[] {
  const found: string[] = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const table = compose('exec', '-T', 'superagent', 'cat', file)
    for (const line of table.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      // st === 0A is TCP_LISTEN.
      if (columns[3] !== '0A') continue
      // Docker's embedded DNS resolver listens on 127.0.0.11:<random> in every
      // container network namespace (0B00007F is 127.0.0.11 little-endian). That is
      // Docker plumbing, not a product bind, so it is not part of the contract.
      if (columns[1]!.startsWith('0B00007F:')) continue
      found.push(columns[1]!)
    }
  }
  return found.sort()
}

describe.skipIf(!ENABLED)('docker deployment', () => {
  beforeAll(async () => {
    check(PORT !== 3082 && PORT !== 3083, `refusing to publish on the live instance port ${PORT}`)
    check(PORT > 0 && PORT < 65_536, `invalid DSH_DOCKER_E2E_PORT ${PORT}`)
    const built = run('bash', [join(ROOT, 'scripts', 'docker-build')], {
      env: { ...process.env, SUPERAGENT_IMAGE: '', OPERATOR_HOME, OPERATOR_UID, OPERATOR_GID },
      timeout: 30 * 60_000,
    })
    image = built.trim().split('\n').at(-1)!.trim()
    check(image.length > 0, 'scripts/docker-build did not print the image tag')
    const commit = run('git', ['rev-parse', '--short=12', 'HEAD']).trim()
    check(image.includes(commit), `image tag ${image} does not encode the product commit ${commit}`)
    check(image.includes('dsh-0.2.1-rc.3'), `image tag ${image} does not encode the DSH CLI version`)

    compose('up', '--detach', 'superagent')
    await waitFor('the container to exist', async () => compose('ps', '-q', 'superagent').trim().length > 0)
    cid = container()
  }, 40 * 60_000)

  afterAll(async () => {
    if (!ENABLED) return
    // Best effort: the test removes the project itself; this covers failures earlier.
    compose({ allowFailure: true }, 'down', '--volumes', '--remove-orphans', '--timeout', '10')
  }, 120_000)

  it('boots unconfigured, becomes ready through the panel and management API, survives a restart, and stops cleanly', async () => {
    expect(PROJECT).toMatch(/^dsh-e2e-/)
    expect(image).toMatch(/^dsh-superagent:/)

    // The fresh volume starts without a deployment configuration: DSH reports the
    // pending setup through the published port before any credentials arrive.
    let initial: any
    await waitFor('the management API to answer through the published port', async () => {
      const response = await fetch(stateUrl('orchestrator/api/state'), {
        headers: { 'x-orchestrator-request': '1' },
      }).catch(() => undefined)
      if (response?.status !== 200) return false
      initial = await response.json()
      return initial?.health?.runtime?.state === 'paused'
    })
    expect(initial.setup.problem.code).toBe('repositoryUnset')
    expect(initial.health.github.state).toBe('paused')
    expect(initial.health.runtime.state).toBe('paused')
    expect(health(cid)).not.toBe('healthy')

    // The token lives only in the startup log; the management API refuses requests
    // without the orchestrator header even through the published port.
    let token = tokenFrom(logs())
    await waitFor('the panel token in the container log', async () => {
      token = tokenFrom(logs())
      return token !== undefined
    })
    expect(token).toBeDefined()
    const unauthenticated = await fetch(stateUrl('orchestrator/api/state'))
    expect(unauthenticated.status).toBe(403)
    expect((await fetch(stateUrl())).status).toBe(401)

    // Configure the deployment through the API, exactly as a browser would, using a
    // stub agent CLI copied into the writable DSH home. No real credentials are
    // involved; ticket #3 replaces this fixture with Keychain materialisation.
    compose('exec', '-T', 'superagent', 'mkdir', '-p', '/data/dsh/test-bin')
    run('docker', ['cp', join(ROOT, 'tests', 'fixtures', 'gh-stub'), `${cid}:/data/dsh/test-bin/gh`])
    compose('exec', '-T', 'superagent', 'chmod', '0755', '/data/dsh/test-bin/gh')
    const settings = await (await fetch(stateUrl('orchestrator/api/settings'), {
      headers: { 'x-orchestrator-request': '1' },
    })).json()
    const github = settings.sources.find((source: any) => source.id === 'github')
    check(github !== undefined, 'settings did not expose the github source')
    const response = await fetch(stateUrl('orchestrator/api/settings/source:github'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
      body: JSON.stringify({
        value: {
          enabled: true,
          config: {
            repository: 'acme/widgets',
            cli: '/data/dsh/test-bin/gh',
            pollSeconds: 60,
            failuresBeforeError: 3,
            observeIssues: false,
            observePulls: false,
            observeComments: false,
            observeCi: false,
          },
        },
        revision: github.revision,
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ saved: true, restarting: true })

    // The healthcheck is the readiness contract: it turns healthy only when every
    // part, including the newly configured GitHub source, is ready.
    await waitFor('the container healthcheck to turn healthy', async () => health(cid) === 'healthy')
    const ready = await state()
    expect(ready.setup.problem).toBeNull()
    expect(Object.keys(ready.health)).toContain('runtime')
    expect(Object.keys(ready.health)).toContain('github')
    expect(Object.entries(ready.health).map(([name, entry]) => `${name}: ${(entry as any).state}`)).toEqual(
      Object.entries(ready.health).map(([name]) => `${name}: ready`),
    )

    // DSH itself is loopback-only; the relay is the only wildcard listener. Ports in
    // /proc/net/tcp are little-endian hex: 3082 = 0C0A, 13082 = 331A.
    expect(listeners()).toEqual(['00000000:331A', '0100007F:0C0A'])

    // The panel works through the published port: token exchange sets a cookie
    // whose authority comes from the relay-rewritten Host header.
    const login = await fetch(stateUrl(`?token=${token}`), { redirect: 'manual' })
    expect(login.status).toBe(303)
    const cookie = login.headers.getSetCookie()[0]?.split(';')[0]
    check(cookie !== undefined, 'the token exchange did not set a panel cookie')
    const page = await fetch(stateUrl(), { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html.toLowerCase()).toContain('<!doctype html>')
    expect(html).toContain('<title>DeepSeek Harness</title>')

    // Stopping DSH must make the healthcheck unhealthy; resuming must recover it.
    // Match the node process, not the tini wrapper: tini's argv repeats the same
    // `dsh --profile superagent` command and would otherwise be the first match.
    const pid = compose('exec', '-T', 'superagent', 'sh', '-c', 'pgrep -f "[n]ode .*dsh --profile superagent" | head -1').trim()
    check(pid.length > 0, 'could not find the DSH process in the container')
    compose('exec', '-T', 'superagent', 'kill', '-STOP', pid)
    await waitFor('the healthcheck to notice stopped DSH', async () => health(cid) === 'unhealthy', 120_000)
    compose('exec', '-T', 'superagent', 'kill', '-CONT', pid)
    await waitFor('the healthcheck to recover after DSH resumes', async () => health(cid) === 'healthy', 120_000)

    // A restart with the same volumes must return to ready without reconfiguration,
    // and each boot mints a fresh panel token.
    compose('restart', 'superagent')
    await waitFor('the restarted container to become healthy', async () => health(cid) === 'healthy')
    await waitFor('a fresh panel token after the restart', async () => {
      const next = tokenFrom(logs())
      return next !== undefined && next !== token
    })
    const restarted = await state()
    expect(restarted.setup.problem).toBeNull()
    expect(Object.values(restarted.health).every(entry => (entry as any).state === 'ready')).toBe(true)

    // Stopping removes the container, its volumes, and the project network.
    compose('down', '--volumes', '--remove-orphans', '--timeout', '10')
    expect(compose('ps', '--all', '-q')).toBe('')
    expect(run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`]).trim()).toBe('')
    expect(run('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).trim()).toBe('')
    expect(run('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]).trim()).toBe('')
  }, 15 * 60_000)
})
