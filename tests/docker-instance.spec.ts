import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts/docker-instance')

let scratch: string | undefined

interface Harness {
  root: string
  artifacts: string
  state: string
  dshHome: string
  trace: string
  marker: string
  volume: string
  existing: string
  env: NodeJS.ProcessEnv
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'docker-instance-spec-'))
  scratch = root
  const bin = join(root, 'bin')
  const artifacts = join(root, 'artifacts')
  const state = join(root, 'state')
  const dshHome = join(root, 'dsh')
  const trace = join(root, 'trace')
  const marker = join(root, 'imported')
  const volume = join(root, 'volume')
  const existing = join(root, 'existing')
  mkdirSync(bin)
  mkdirSync(state)
  mkdirSync(dshHome)
  writeFileSync(join(state, 'worker-gitconfig'), '[credential]\n\thelper = !/Users/matthewye/.local/bin/gh-agent auth git-credential\n')
  writeFileSync(join(state, 'worker-bin'), 'shim\n')
  writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\nrecords: {}\nrefs: {}\n', { mode: 0o600 })
  writeFileSync(join(root, 'llm.env'), 'DEEPSEEK_API_KEY=op://AI Keys/DeepSeek API Key/credential\n', { mode: 0o600 })

  executable(join(bin, 'security'), `[ -n "\${FAKE_TOKEN:-}" ] || exit 1
printf '%s\\n' "$FAKE_TOKEN"`)

  executable(join(bin, 'op'), `case "$1" in
whoami) exit "\${FAKE_OP_WHOAMI:-0}" ;;
run)
  shift
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
  [ "$#" -gt 0 ] && shift
  DEEPSEEK_API_KEY=sk-from-op exec "$@" ;;
esac
exit 1`)

  executable(join(bin, 'docker'), `printf '%s\\n' "$*" >> "$FAKE_TRACE"
case "$1" in
image) exit 0 ;;
volume)
  case "$2" in
  inspect) [ -f "$FAKE_VOLUME" ] || exit 1; exit 0 ;;
  create) : > "$FAKE_VOLUME"; exit 0 ;;
  esac
  exit 0 ;;
run)
  last=
  for arg in "$@"; do last=$arg; done
  case "$last" in
  *"test -f /state/.imported"*) [ -f "$FAKE_MARKER" ] || exit 1 ;;
  *"test -e /state/orchestrator.sqlite"*) [ -f "$FAKE_EXISTING" ] || exit 1 ;;
  *"SUPERAGENT_IMPORT_MARKER"*) printf 'imported=unit\\n' > "$FAKE_MARKER"; : > "$FAKE_EXISTING"; printf '%s\\n' "$last" > "$FAKE_MARKER.copy" ;;
  esac
  exit 0 ;;
compose)
  case " $* " in
  *" logs "*) echo "dsh web: http://127.0.0.1:3082/?token=unit-token" ;;
  *" ps "*) echo "container-id" ;;
  esac
  exit 0 ;;
inspect) echo running; exit 0 ;;
esac
exit 0`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SUPERAGENT_IMAGE: 'dsh-superagent:test',
    SUPERAGENT_INSTANCE: 'unit',
    SUPERAGENT_PROJECT: 'dsh-unit',
    SUPERAGENT_PUBLISH_PORT: '4082',
    SUPERAGENT_STATE_DIR: state,
    SUPERAGENT_DSH_HOME: dshHome,
    SUPERAGENT_ARTIFACTS_DIR: artifacts,
    SUPERAGENT_GH_KEYCHAIN_SERVICE: 'gh:test',
    SUPERAGENT_GH_KEYCHAIN_ACCOUNT: 'agent-test',
    SUPERAGENT_SECURITY_BIN: join(bin, 'security'),
    SUPERAGENT_DOCKER_BIN: join(bin, 'docker'),
    SUPERAGENT_OP_BIN: join(bin, 'op'),
    SUPERAGENT_OP_ENV_FILE: join(root, 'llm.env'),
    FAKE_TOKEN: 'gho_unit_token',
    FAKE_TRACE: trace,
    FAKE_VOLUME: volume,
    FAKE_MARKER: marker,
    FAKE_EXISTING: existing,
    FAKE_OP_WHOAMI: '0',
  }
  delete env.DEEPSEEK_API_KEY
  return { root, artifacts, state, dshHome, trace, marker, volume, existing, env }
}

function run(h: Harness, command: string, env: NodeJS.ProcessEnv = h.env) {
  return spawnSync('bash', [SCRIPT, command], { encoding: 'utf8', env, timeout: 30_000 })
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('scripts/docker-instance', () => {
  it('materialises the gh hosts.yml and imports host state exactly once', () => {
    const h = harness()
    const first = run(h, 'prepare')
    expect(first.status, first.stderr).toBe(0)
    const runtime = join(h.artifacts, 'instances', 'unit')
    expect(statSync(runtime).mode & 0o777).toBe(0o700)
    const hosts = readFileSync(join(runtime, 'hosts.yml'), 'utf8')
    expect(hosts).toContain('github.com:')
    expect(hosts).toContain('user: agent-test')
    expect(hosts).toContain('oauth_token: gho_unit_token')
    expect(statSync(join(runtime, 'hosts.yml')).mode & 0o777).toBe(0o600)
    expect(statSync(join(runtime, 'credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(runtime, 'credentials.yaml'), 'utf8')).toContain('version: 1')
    const override = readFileSync(join(runtime, 'compose.runtime.yaml'), 'utf8')
    expect(override).toContain('DEEPSEEK_API_KEY: "${DEEPSEEK_API_KEY:-}"')
    expect(override).not.toContain('gho_unit_token')
    expect(override).toContain('target: /Users/matthewye/.config/gh-agent/hosts.yml')
    expect(override).toContain('target: /run/superagent/credentials.yaml')
    expect(override).toContain('read_only: true')

    const trace = readFileSync(h.trace, 'utf8')
    expect(trace).toContain('volume create')
    expect(trace).toContain('cp -a /import/.')
    const marker = readFileSync(h.marker, 'utf8')
    expect(marker).toContain('imported=')

    const second = run(h, 'prepare')
    expect(second.status, second.stderr).toBe(0)
    expect(second.stderr).toContain('already imported')
    expect(readFileSync(h.marker, 'utf8')).toBe(marker)
    expect(readFileSync(h.trace, 'utf8').split('cp -a /import/').length - 1).toBe(1)
  })

  it('fails with configuration exit code 2 when the Keychain token is missing', () => {
    const h = harness()
    const env = { ...h.env, FAKE_TOKEN: '', DEEPSEEK_API_KEY: 'sk-present' }
    const result = run(h, 'start', env)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('macOS Keychain')
    expect(result.stderr).toContain('security find-generic-password')
    expect(existsSync(join(h.artifacts, 'instances', 'unit', 'hosts.yml'))).toBe(false)
  })

  it('fails with configuration exit code 2 when the model key cannot resolve', () => {
    const h = harness()
    const result = run(h, 'start', { ...h.env, FAKE_OP_WHOAMI: '1' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('1Password is not signed in')
    expect(existsSync(h.trace)).toBe(false)

    const missingOp = { ...h.env, SUPERAGENT_OP_BIN: join(h.root, 'no-op') }
    const second = run(h, 'start', missingOp)
    expect(second.status).toBe(2)
    expect(second.stderr).toContain('1Password CLI (op) is not installed')
    expect(existsSync(h.trace)).toBe(false)
  })

  it('resolves the model key through op, starts, and prints the panel URL from status', () => {
    const h = harness()
    const result = run(h, 'start')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('panel: http://127.0.0.1:4082/?token=unit-token')
    const runtime = join(h.artifacts, 'instances', 'unit')
    expect(readFileSync(join(runtime, 'panel-url'), 'utf8').trim()).toBe('http://127.0.0.1:4082/?token=unit-token')
    expect(statSync(join(runtime, 'panel-url')).mode & 0o777).toBe(0o600)
    expect(readFileSync(h.trace, 'utf8')).toContain('compose -f')
    expect(readFileSync(h.trace, 'utf8')).toContain('up --detach')
    expect(readFileSync(join(runtime, 'compose.runtime.yaml'), 'utf8')).not.toContain('sk-from-op')

    const status = run(h, 'status')
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('container: running')
    expect(status.stdout).toContain('panel: http://127.0.0.1:4082/?token=unit-token')
  })

  it('stops the container, removes runtime credentials, and keeps volumes', () => {
    const h = harness()
    expect(run(h, 'start').status).toBe(0)
    const runtime = join(h.artifacts, 'instances', 'unit')
    expect(existsSync(join(runtime, 'hosts.yml'))).toBe(true)
    const result = run(h, 'stop')
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(runtime)).toBe(false)
    const trace = readFileSync(h.trace, 'utf8')
    expect(trace).toContain('down --remove-orphans')
    expect(trace).not.toContain('down --volumes')
  })
})
