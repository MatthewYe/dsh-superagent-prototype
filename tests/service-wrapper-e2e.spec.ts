import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Opt-in process-level test for ticket #5: the operator wrapper
 * `scripts/dsh-superagent` drives the two Docker-backed instances through
 * `scripts/docker-instance`, with isolated Compose projects, host ports, state
 * directories and artifacts.
 *
 * It is skipped unless `DSH_DOCKER_E2E=1`. Every project name and port is
 * unique to this run; the live `dsh-superagent-superagent` and
 * `dsh-superagent-livis` projects and `~/.dsh/state/*` are never touched. The
 * superagent instance starts against an empty state directory (so it reports
 * setup waiting), while livis starts from an empty imported state and an empty
 * test credential store. That keeps the two containers inert: no real GitHub
 * token, model key, Livis refresh token or executor work is involved.
 *
 * The image is built once with `BUILDX_CONFIG=/tmp/dsh-buildx-ticket05`, as
 * `scripts/docker-build` asks when the sandbox blocks `~/.docker`. The legacy
 * fallback is stubbed rather than booting tmux: a copied wrapper runs a copied
 * stub in place of `scripts/dsh-superagent-legacy`, proving the argument
 * contract without touching the host path.
 */

vi.setConfig({ testTimeout: 20 * 60_000, hookTimeout: 45 * 60_000 })

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRAPPER = join(ROOT, 'scripts', 'dsh-superagent')
const ENABLED = process.env.DSH_DOCKER_E2E === '1'
const TIMEOUT = Number(process.env.DSH_DOCKER_E2E_TIMEOUT ?? 240_000)
const SUPERAGENT_PORT = Number(process.env.DSH_DOCKER_E2E_WRAPPER_SUPERAGENT_PORT ?? 38086)
const LIVIS_PORT = Number(process.env.DSH_DOCKER_E2E_WRAPPER_LIVIS_PORT ?? 38087)
const PREFIX = process.env.DSH_DOCKER_E2E_WRAPPER_PROJECT ?? `dsh-wrapper-e2e-${process.pid}-${Date.now().toString(36)}`
const LIVIS_DIR = process.env.LIVIS_DIR ?? '/Users/matthewye/Documents/WorkSpace/dsh-livis'

interface Instance {
  name: 'superagent' | 'livis'
  port: number
  project: string
  stateDir: string
  dshHome: string
  ghConfigDir: string
}

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

let scratch = ''
let artifacts = ''
let ghStub = ''
let image = ''
let superagent: Instance
let livis: Instance

function instances(): Instance[] {
  return [superagent, livis]
}

function wrapperEnv(instance: Instance): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERAGENT_PROJECT: instance.project,
    SUPERAGENT_PUBLISH_PORT: String(instance.port),
    SUPERAGENT_STATE_DIR: instance.stateDir,
    SUPERAGENT_DSH_HOME: instance.dshHome,
    SUPERAGENT_ARTIFACTS_DIR: artifacts,
    SUPERAGENT_GH_BIN: ghStub,
    SUPERAGENT_GH_CONFIG_DIR: instance.ghConfigDir,
    SUPERAGENT_IMAGE: image,
    DSH_SUPERAGENT_PROFILE: '',
    DSH_SUPERAGENT_URL: '',
    LIVIS_DIR,
    BUILDX_CONFIG: '/tmp/dsh-buildx-ticket05',
  }
  if (instance.name === 'superagent') {
    env.DEEPSEEK_API_KEY = 'sk-wrapper-e2e-placeholder'
  } else {
    // The livis profile authenticates through the DSH credential store and must
    // not require the model key.
    delete env.DEEPSEEK_API_KEY
  }
  return env
}

function wrapper(instance: Instance, action: 'start' | 'stop' | 'restart' | 'status' | 'logs', extra: string[] = [], options: { allowFailure?: boolean } = {}): Result {
  return run('python3', [WRAPPER, action, '--profile', instance.name, '--timeout', '45', ...extra], {
    env: wrapperEnv(instance),
    allowFailure: options.allowFailure ?? true,
    timeout: 10 * 60_000,
  })
}

/** The wrapper keeps stdout for its one JSON status object; helper output goes to stderr. */
function statusObject(result: Result): any {
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`stdout was not one JSON status object:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
}

function runtimeDir(instance: Instance): string {
  return join(artifacts, 'instances', instance.name)
}

function panelFile(instance: Instance): string {
  return join(runtimeDir(instance), 'panel-url')
}

function panelToken(url: string | null | undefined): string | undefined {
  return typeof url === 'string' ? /[?&]token=([A-Za-z0-9_-]+)/.exec(url)?.[1] : undefined
}

async function panelLogin(url: string): Promise<number> {
  const response = await fetch(url, { redirect: 'manual' })
  return response.status
}

function containerId(instance: Instance): string {
  return run('docker', ['compose', '-f', join(ROOT, 'compose.yaml'), '--project-directory', ROOT, '-p', instance.project, 'ps', '-q', instance.name], {
    env: { SUPERAGENT_IMAGE: image, SUPERAGENT_PUBLISH_PORT: String(instance.port), LIVIS_PUBLISH_PORT: String(instance.port) },
  }).stdout.trim()
}

function projectVolumes(instance: Instance): string[] {
  return run('docker', ['volume', 'ls', '--filter', `label=com.docker.compose.project=${instance.project}`, '--format', '{{.Name}}']).stdout
    .trim().split('\n').filter(Boolean)
}

function readPanel(instance: Instance): { url: string; token: string } {
  const url = readFileSync(panelFile(instance), 'utf8').trim()
  const token = panelToken(url)
  check(url.length > 0, `${instance.name} wrote no panel URL`)
  check(token !== undefined, `${instance.name}'s panel URL has no token: ${url}`)
  return { url, token }
}

function checkPanelFile(instance: Instance, expected: string): void {
  expect(readPanel(instance).url).toBe(expected)
  expect(statSync(panelFile(instance)).mode & 0o777).toBe(0o600)
}

async function stopInstance(instance: Instance): Promise<void> {
  wrapper(instance, 'stop', [], { allowFailure: true })
  run('docker', ['compose', '-f', join(ROOT, 'compose.yaml'), '--project-directory', ROOT, '-p', instance.project, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], {
    env: { SUPERAGENT_IMAGE: image, SUPERAGENT_PUBLISH_PORT: String(instance.port), LIVIS_PUBLISH_PORT: String(instance.port) },
    allowFailure: true,
    timeout: 120_000,
  })
}

describe.skipIf(!ENABLED)('docker operator wrapper with isolated instances (ticket #5)', () => {
  beforeAll(() => {
    check(SUPERAGENT_PORT !== 3082 && SUPERAGENT_PORT !== 3083, `refusing to publish superagent on the live port ${SUPERAGENT_PORT}`)
    check(LIVIS_PORT !== 3082 && LIVIS_PORT !== 3083, `refusing to publish livis on the live port ${LIVIS_PORT}`)
    check(SUPERAGENT_PORT !== LIVIS_PORT, 'the two wrapper instances need different host ports')
    check(SUPERAGENT_PORT > 0 && SUPERAGENT_PORT < 65_536 && LIVIS_PORT > 0 && LIVIS_PORT < 65_536, 'the wrapper ports must be valid TCP ports')
    check(existsSync(join(LIVIS_DIR, 'packages', 'dsh-livis-source', 'package.json')), `no dsh-livis checkout at ${LIVIS_DIR}; set LIVIS_DIR`)
    check(existsSync(WRAPPER), `no operator wrapper at ${WRAPPER}`)

    scratch = mkdtempSync(join(tmpdir(), 'dsh-wrapper-e2e-'))
    artifacts = join(scratch, 'artifacts')
    mkdirSync(artifacts, { recursive: true })

    const bin = join(scratch, 'bin')
    mkdirSync(bin, { recursive: true })
    ghStub = join(bin, 'gh')
    writeFileSync(ghStub, `#!/bin/sh
case "$1 $2" in
  "auth token") printf '%s\\n' "gho_wrapper_e2e_placeholder_token" ;;
  "api user") printf '%s\\n' "wrapper-e2e-agent" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
    chmodSync(ghStub, 0o755)

    superagent = {
      name: 'superagent',
      port: SUPERAGENT_PORT,
      project: `${PREFIX}-superagent`,
      stateDir: join(scratch, 'state', 'superagent'),
      dshHome: join(scratch, 'dsh', 'superagent'),
      ghConfigDir: join(scratch, 'gh', 'superagent'),
    }
    livis = {
      name: 'livis',
      port: LIVIS_PORT,
      project: `${PREFIX}-livis`,
      stateDir: join(scratch, 'state', 'livis'),
      dshHome: join(scratch, 'dsh', 'livis'),
      ghConfigDir: join(scratch, 'gh', 'livis'),
    }
    for (const instance of instances()) {
      check(instance.project !== 'dsh-superagent-superagent' && instance.project !== 'dsh-superagent-livis', `refusing to reuse the live project ${instance.project}`)
      mkdirSync(instance.stateDir, { recursive: true })
      mkdirSync(instance.dshHome, { recursive: true })
      mkdirSync(instance.ghConfigDir, { recursive: true })
    }
    // The livis profile needs a DSH credential store, but this test must not read
    // the operator's real one: an empty store is enough for the container to boot
    // and keeps the run disconnected from any account.
    writeFileSync(join(livis.dshHome, '.credentials.yaml'), 'version: 1\nrecords: {}\nrefs: {}\n', { mode: 0o600 })
    chmodSync(join(livis.dshHome, '.credentials.yaml'), 0o600)

    const built = process.env.DSH_DOCKER_E2E_IMAGE
      ?? run('bash', [join(ROOT, 'scripts', 'docker-build')], {
        env: { ...process.env, SUPERAGENT_IMAGE: '', BUILDX_CONFIG: '/tmp/dsh-buildx-ticket05' },
        timeout: 40 * 60_000,
      }).stdout.trim().split('\n').at(-1)!.trim()
    image = built
    check(image.length > 0, 'scripts/docker-build did not print an image tag')
    if (!process.env.DSH_DOCKER_E2E_IMAGE) {
      const commit = run('git', ['rev-parse', '--short=12', 'HEAD']).stdout.trim()
      expect(image).toContain(commit)
      const livisCommit = run('git', ['-C', LIVIS_DIR, 'rev-parse', '--short=12', 'HEAD']).stdout.trim()
      expect(image).toContain(`livis-${livisCommit}`)
      expect(image).toContain('dsh-0.2.1-rc.3')
    }
    run('docker', ['info', '--format', '{{.ServerVersion}}'])
  })

  afterAll(async () => {
    for (const instance of [superagent, livis].filter(Boolean) as Instance[]) await stopInstance(instance)
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('starts, reports, restarts and stops the superagent instance without touching the live project', async () => {
    const start = wrapper(superagent, 'start')
    // A fresh state directory has no Repository or Policy yet: the wrapper must
    // still boot the container, record the panel URL and report setup waiting.
    expect(start.status).toBe(3)
    const started = statusObject(start)
    expect(started.instance).toBe('superagent')
    expect(started.project).toBe(superagent.project)
    expect(started.container).toBe('running')
    expect(started.image).toBe(image)
    expect(started.url).toBe(`http://127.0.0.1:${SUPERAGENT_PORT}`)
    expect(started.health.runtime).toBeTruthy()
    expect(started.errors).toEqual({})
    const firstPanel = readPanel(superagent)
    expect(started.panel).toBe(firstPanel.url)
    checkPanelFile(superagent, firstPanel.url)
    expect(containerId(superagent)).not.toBe('')
    await waitFor('the superagent panel login', async () => await panelLogin(firstPanel.url) === 303)
    expect(projectVolumes(superagent)).toEqual(expect.arrayContaining([`${superagent.project}_superagent-home`, `${superagent.project}_superagent-state`]))

    const logs = wrapper(superagent, 'logs', ['--tail', '20'])
    expect(logs.status).toBe(0)
    expect(logs.stdout).toContain(firstPanel.token)

    const status = wrapper(superagent, 'status')
    expect(status.status).toBe(3)
    const reported = statusObject(status)
    expect(reported.panel).toBe(firstPanel.url)
    expect(reported.container).toBe('running')

    const previousContainer = containerId(superagent)
    const restart = wrapper(superagent, 'restart')
    expect(restart.status).toBe(3)
    const restarted = statusObject(restart)
    expect(restarted.container).toBe('running')
    const secondPanel = readPanel(superagent)
    expect(secondPanel.url).not.toBe(firstPanel.url)
    expect(secondPanel.token).not.toBe(firstPanel.token)
    checkPanelFile(superagent, secondPanel.url)
    expect(containerId(superagent)).not.toBe(previousContainer)
    await waitFor('the restarted superagent panel login', async () => await panelLogin(secondPanel.url) === 303)
    expect(projectVolumes(superagent)).toEqual(expect.arrayContaining([`${superagent.project}_superagent-home`, `${superagent.project}_superagent-state`]))

    const stop = wrapper(superagent, 'stop')
    expect(stop.status).toBe(0)
    expect(stop.stdout).toContain('Automatic recovery is paused until start/restart.')
    expect(existsSync(panelFile(superagent))).toBe(false)

    const stopped = wrapper(superagent, 'status')
    expect(stopped.status).toBe(1)
    const offline = statusObject(stopped)
    expect(offline.container).toBe('stopped')
    expect(offline.panel).toBeNull()
    expect(offline.manually_stopped).toBe(true)

    const skipped = wrapper(superagent, 'start', ['--respect-stop'])
    expect(skipped.status).toBe(0)
    expect(skipped.stdout).toContain('Intentional stop is active')
    expect(containerId(superagent)).toBe('')
  })

  it('starts, reports, restarts and stops the livis instance on its own project and port', async () => {
    const start = wrapper(livis, 'start')
    // The imported state is empty and the credential store is deliberately
    // empty, so readiness may legitimately be waiting or report a runtime error.
    // What this test owns is the wrapper contract: the container runs, the JSON
    // object is stable, and the panel URL matches the file and the log.
    expect([0, 1, 2, 3]).toContain(start.status)
    const started = statusObject(start)
    expect(started.instance).toBe('livis')
    expect(started.project).toBe(livis.project)
    expect(started.container).toBe('running')
    expect(started.image).toBe(image)
    expect(started.url).toBe(`http://127.0.0.1:${LIVIS_PORT}`)
    const firstPanel = readPanel(livis)
    expect(started.panel).toBe(firstPanel.url)
    checkPanelFile(livis, firstPanel.url)
    expect(containerId(livis)).not.toBe('')
    await waitFor('the livis panel login', async () => await panelLogin(firstPanel.url) === 303)
    expect(projectVolumes(livis)).toEqual(expect.arrayContaining([`${livis.project}_livis-home`, `${livis.project}_livis-state`]))

    const status = wrapper(livis, 'status')
    expect(status.status).toBe(start.status)
    expect(statusObject(status).panel).toBe(firstPanel.url)

    const previousContainer = containerId(livis)
    const restart = wrapper(livis, 'restart')
    expect([0, 1, 2, 3]).toContain(restart.status)
    expect(statusObject(restart).container).toBe('running')
    const secondPanel = readPanel(livis)
    expect(secondPanel.url).not.toBe(firstPanel.url)
    expect(containerId(livis)).not.toBe(previousContainer)
    await waitFor('the restarted livis panel login', async () => await panelLogin(secondPanel.url) === 303)

    const stop = wrapper(livis, 'stop')
    expect(stop.status).toBe(0)
    const stopped = wrapper(livis, 'status')
    expect(stopped.status).toBe(1)
    const offline = statusObject(stopped)
    expect(offline.container).toBe('stopped')
    expect(offline.panel).toBeNull()
    expect(containerId(livis)).toBe('')
  })

  it('delegates --legacy to the preserved host implementation, stubbed here', () => {
    const legacyRoot = join(scratch, 'legacy')
    const legacyScripts = join(legacyRoot, 'scripts')
    mkdirSync(legacyScripts, { recursive: true })
    const copiedWrapper = join(legacyScripts, 'dsh-superagent')
    copyFileSync(WRAPPER, copiedWrapper)
    chmodSync(copiedWrapper, 0o755)
    const recorded = join(legacyRoot, 'argv.json')
    writeFileSync(join(legacyScripts, 'dsh-superagent-legacy'), `#!/usr/bin/env python3
import json
import os
import sys

with open(os.environ['LEGACY_ARGV_FILE'], 'w') as handle:
    json.dump(sys.argv[1:], handle)
`, { mode: 0o755 })

    const delegated = run('python3', [copiedWrapper, '--legacy', 'status', '--profile', 'other', '--timeout', '12', '--stop-timeout', '34'], {
      env: { ...process.env, LEGACY_ARGV_FILE: recorded, SUPERAGENT_ARTIFACTS_DIR: join(legacyRoot, 'artifacts') },
      allowFailure: true,
    })
    expect(delegated.status).toBe(0)
    const argv = JSON.parse(readFileSync(recorded, 'utf8')) as string[]
    expect(argv.slice(0, 4)).toEqual(['status', '--profile', 'other', '--timeout'])
    expect(Number(argv[4])).toBe(12)
    expect(argv[5]).toBe('--stop-timeout')
    expect(Number(argv[6])).toBe(34)
    // The dispatch happens before the Docker instance check and creates no state.
    expect(existsSync(join(legacyRoot, 'artifacts'))).toBe(false)

    const unsupported = run('python3', [copiedWrapper, '--legacy', 'logs', '--profile', 'other'], {
      env: { ...process.env, LEGACY_ARGV_FILE: recorded },
      allowFailure: true,
    })
    expect(unsupported.status).toBe(2)
    expect(unsupported.stderr).toContain('not supported by the legacy host path')
  })
})
