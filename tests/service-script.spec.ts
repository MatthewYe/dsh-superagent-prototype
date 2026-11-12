/**
 * Process-level tests for the operator entry `scripts/dsh-superagent`.
 *
 * The first block drives the preserved host path through `--legacy` with stubbed
 * ps, tmux and dsh binaries. The second block stubs the container runtime
 * (`docker`, `docker compose`, gh, security and op) and asserts the Docker
 * argument mapping, readiness exit codes, image build/build-failure path and
 * instance isolation without needing a Docker daemon.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync }
  from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
let server: Server | undefined
let sleepers: ChildProcess[] = []
const control = (profile: string) => join(root, '.artifacts', 'control', 'profiles', profile)
const program = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
/** Spawn a dummy process whose PID can be listed by the fake ps binary; ignoreInterrupt simulates a hung graceful stop. */
function sleeper(ignoreInterrupt = false): number {
  const [program, args] = ignoreInterrupt ? ['sh', ['-c', 'trap "" INT; exec sleep 60']] as const : ['sleep', ['60']] as const
  const child = spawn(program, [...args], { stdio: 'ignore' })
  sleepers.push(child)
  return child.pid!
}
const service = (pid: number, profile = 'superagent') => `${pid} node node /opt/my tools/dsh --profile ${profile} --no-open`
/** Write active process lines (`pid ucomm args`) for the fake ps binary. Entries prefixed with `after:<pid> ` appear only after that PID exits. */
const processes = (...lines: string[]) => writeFileSync(join(root, 'ps.txt'), lines.map(line => `${line}\n`).join(''))
const started = (...lines: string[]) => writeFileSync(join(root, 'ps-started.txt'), lines.map(line => `${line}\n`).join(''))
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'service script '))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'bin'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-legacy'), join(root, 'scripts', 'dsh-superagent-legacy'))
  processes()
  program('ps', `list='${root}/ps.txt'; [ -f '${root}/launched' ] && [ -f '${root}/ps-started.txt' ] && list='${root}/ps-started.txt'
want=; while [ $# -gt 0 ]; do [ "$1" = -p ] && want=$2; shift; done
while IFS= read -r line; do
  case "$line" in after:*) dep=\${line#after:}; dep=\${dep%% *}; kill -0 "$dep" 2>/dev/null && continue; line=\${line#after:$dep };; esac
  pid=\${line%% *}; kill -0 "$pid" 2>/dev/null || continue
  if [ -z "$want" ] || [ "$pid" = "$want" ]; then printf '%s\\n' "$line"; fi
done < "$list"`)
  // Log tmux invocations and simulate session creation by outputting the pane PID.
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 1;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  program('dsh', 'exit 0')
})
afterEach(() => {
  server?.close(); server = undefined
  for (const child of sleepers) child.kill()
  sleepers = []
  rmSync(root, { recursive: true, force: true })
})
/** Run the operator entry through its legacy dispatcher against the stubbed host path. */
function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => execFile('python3', [join(root, 'scripts', 'dsh-superagent'), '--legacy', ...args],
    { env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, DSH_SUPERAGENT_PROFILE: '', DSH_SUPERAGENT_URL: '' },
      timeout: 20_000 },
    (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))
}
const READY = { health: { runtime: { state: 'ready', detail: '' } }, setup: { problem: null, feishuProblem: null } }
/** Start a mock HTTP server that returns 503 until tmux launches the service (unless always is true). */
async function answering(state: unknown = READY, always = false): Promise<string> {
  server = createServer((_request, response) => {
    if (!always && !existsSync(join(root, 'launched'))) { response.writeHead(503).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}
const status = async (profile: string, url = 'http://127.0.0.1:9') =>
  JSON.parse((await run('status', '--profile', profile, '--url', url)).stdout) as { pids: number[]; manually_stopped: boolean }

it('refuses to stop when two processes serve the profile, before it writes the stop marker', async () => {
  processes(service(sleeper()), `${sleeper()} node node /opt/dsh --profile=superagent`)
  expect(await run('stop')).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes found') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
})
it('keeps a stop per profile', async () => {
  expect(await run('stop', '--profile', 'one')).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
  expect(await status('one')).toMatchObject({ manually_stopped: true })
  expect(await status('two')).toMatchObject({ manually_stopped: false })
  const skipped = await run('--respect-stop', 'start', '--profile', 'one')
  expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
})
it('takes no `dsh plugin` command of the profile for its service', async () => {
  const service = sleeper()
  processes(`${sleeper()} node node /opt/my tools/dsh plugin --profile superagent add link:/x`,
    `${service} node node /opt/my tools/dsh --profile superagent --no-open`)
  expect(await status('superagent')).toMatchObject({ pids: [service] })
})
it('records the service PID at start, and still refuses a second instance the scan finds', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const start = await run('start', '--url', url, '--timeout', '10')
  expect(start).toMatchObject({ code: 0, stdout: expect.stringContaining(`"pids": [\n    ${pid}\n  ]`) })
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  const tmux = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').find(call => call.startsWith('new-session'))!.split('\n')
  // The checkout's path, which has a space, is one argument, and the log path inside it is quoted for the shell.
  const checkout = realpathSync(root)
  expect(tmux).toEqual(expect.arrayContaining(['-P', '-F', '#{pane_pid}', '-c', checkout]))
  const log = new RegExp(`>> '${checkout}/\\.artifacts/dsh-superagent-superagent-\\d{8}-\\d{6}-\\d+\\.log' 2>&1$`)
  expect(tmux.find(word => word.startsWith('umask 077; exec '))).toMatch(log)
  const second = sleeper()
  started(service(pid), `${second} node node /opt/dsh --profile superagent`)
  const again = await run('start', '--url', url, '--timeout', '10')
  expect(again).toMatchObject({ code: 1, stderr: expect.stringContaining('Multiple dsh-superagent processes') })
  expect(await status('superagent')).toMatchObject({ pids: [pid, second] })
}, 20_000)
it('waits only for the process it stopped', async () => {
  const pid = sleeper()
  // Another instance shows up once the stopped one ended.
  processes(service(pid), `after:${pid} ${sleeper()} node node /opt/dsh --profile superagent`)
  expect(await run('stop', '--stop-timeout', '5')).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped') })
}, 20_000)
it('keeps only the newest logs it wrote for the profile', async () => {
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  mkdirSync(join(root, '.artifacts'), { recursive: true })
  for (const profile of ['superagent', 'other']) for (let index = 0; index < 25; index++) {
    const log = join(root, '.artifacts', `dsh-superagent-${profile}-20260901-0000${String(index).padStart(2, '0')}-1.log`)
    writeFileSync(log, '')
    utimesSync(log, 1_700_000_000 + index, 1_700_000_000 + index)
  }
  writeFileSync(join(root, '.artifacts', 'dsh-superagent-20260901-000000-1.log'), '')
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const logs = readdirSync(join(root, '.artifacts'))
  const own = logs.filter(name => name.startsWith('dsh-superagent-superagent-')).sort()
  expect(own).toHaveLength(20)
  // The oldest went; the new one stays, with the newest earlier ones. Another profile's logs and older names stay.
  expect(own).not.toContain('dsh-superagent-superagent-20260901-000000-1.log')
  expect(own.filter(name => !name.startsWith('dsh-superagent-superagent-20260901-'))).toHaveLength(1)
  expect(logs.filter(name => name.startsWith('dsh-superagent-other-'))).toHaveLength(25)
  expect(logs).toContain('dsh-superagent-20260901-000000-1.log')
}, 20_000)
it('reports a service whose Feishu bot setup could not check as running, and reads an answer with keys missing', async () => {
  processes(service(sleeper()))
  const feishu = { health: { runtime: { state: 'ready', detail: '' }, feishu: { state: 'paused', detail: '' } },
    setup: { problem: null, feishuProblem: { code: 'feishuNoBot', detail: 'No bot' } } }
  expect(await run('status', '--url', await answering(feishu, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'ready' } } }, true))).toMatchObject({ code: 0 })
  server!.close()
  expect(await run('status', '--url', await answering({ health: { runtime: { state: 'error' } } }, true))).toMatchObject({ code: 1 })
})
it('exits 2 while a part such as a Source reports an error, which a restart does not fix, and prints what it reports', async () => {
  processes(service(sleeper()))
  const github = { health: { runtime: { state: 'ready', detail: '' }, github: { state: 'error', detail: 'bad token' } }, setup: {} }
  const url = await answering(github, true)
  const checked = await run('status', '--url', url)
  expect(checked.code).toBe(2)
  expect(JSON.parse(checked.stdout)).toMatchObject({ errors: { github: 'bad token' } })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token') })
}, 20_000)
it('exits 3 while the service waits for setup, from status and from start, which a restart does not fix', async () => {
  processes(service(sleeper()))
  const waiting = { health: { runtime: { state: 'paused', detail: '' } },
    setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' }, feishuProblem: null } }
  const url = await answering(waiting, true)
  expect(await run('status', '--url', url)).toMatchObject({ code: 3 })
  expect(await run('start', '--url', url, '--timeout', '10'))
    .toMatchObject({ code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.') })
}, 20_000)
it('restarts the service, and a restart whose graceful stop timed out does not keep recovery off', async () => {
  const url = await answering()
  const old = sleeper(), pid = sleeper()
  processes(service(old))
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  const restarted = await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '5')
  expect(restarted).toMatchObject({ code: 0, stdout: expect.stringContaining('dsh-superagent stopped.') })
  expect(restarted.stdout).not.toContain('Automatic recovery is paused')
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(false)
  expect(readFileSync(join(control('superagent'), 'service.pid'), 'utf8')).toBe(`${pid}\n`)
  // A service that does not stop in time is left running, and the next check may restart it.
  rmSync(join(root, 'launched'))
  processes(service(sleeper(true)))
  expect(await run('restart', '--url', url, '--timeout', '10', '--stop-timeout', '1'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(await status('superagent')).toMatchObject({ manually_stopped: false })
}, 20_000)
it('refuses a second control operation while one holds the profile\'s lock', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const held = join(root, 'held')
  const holder = spawn('python3', ['-c', `import fcntl, pathlib, time
lock = open(${JSON.stringify(join(control('superagent'), 'operation.lock'))}, 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
pathlib.Path(${JSON.stringify(held)}).touch()
time.sleep(30)`], { stdio: 'ignore' })
  sleepers.push(holder)
  while (!existsSync(held)) await new Promise(resolve => setTimeout(resolve, 50))
  expect(await run('status')).toMatchObject({ code: 1,
    stderr: expect.stringContaining('Another dsh-superagent control operation is in progress') })
}, 20_000)
it('refuses to start a service while no process runs it but something answers at its URL', async () => {
  const url = await answering(READY, true)
  expect(await run('start', '--url', url, '--timeout', '5'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('An existing orchestrator answers at this URL') })
  expect(readFileSync(join(root, 'tmux.log'),
    'utf8').split('---\n').filter(Boolean).map(call => call.split('\n')[0])).toEqual(['has-session'])
}, 20_000)
it('starts the service in a new window of the profile\'s tmux session when the session exists', async () => {
  program('tmux', `for a in "$@"; do printf '%s\\n' "$a"; done >> '${root}/tmux.log'; echo --- >> '${root}/tmux.log'\n`
    + `case "$1" in has-session) exit 0;; new-*) touch '${root}/launched'; cat '${root}/pane';; esac`)
  const url = await answering()
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', url, '--timeout', '10')).toMatchObject({ code: 0 })
  const calls = readFileSync(join(root, 'tmux.log'), 'utf8').split('---\n').map(call => call.split('\n'))
  expect(calls.find(call => call[0] === 'new-window')).toEqual(expect.arrayContaining(['-t', '=dsh-superagent:']))
  expect(calls.some(call => call[0] === 'new-session')).toBe(false)
}, 20_000)
it('exits 1 when the started service does not answer in time, and leaves its process running', async () => {
  const pid = sleeper()
  writeFileSync(join(root, 'pane'), `${pid}\n`)
  started(service(pid))
  expect(await run('start', '--url', 'http://127.0.0.1:9', '--timeout', '2'))
    .toMatchObject({ code: 1, stderr: expect.stringContaining('Startup health check timed out') })
  expect(() => process.kill(pid, 0)).not.toThrow()
}, 20_000)
it('does not signal a process that took the recorded service PID, and keeps a stop that timed out', async () => {
  mkdirSync(control('superagent'), { recursive: true })
  const other = sleeper()
  processes(`${other} sleep sleep 60`)
  writeFileSync(join(control('superagent'), 'service.pid'), `${other}\n`)
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 0 })
  expect(() => process.kill(other, 0)).not.toThrow()
  // A service that does not stop in time keeps the stop, so recovery does not start it again.
  rmSync(join(control('superagent'), 'manually-stopped'))
  processes(service(sleeper(true)))
  expect(await run('stop', '--stop-timeout', '1')).toMatchObject({ code: 1, stderr: expect.stringContaining('Graceful stop timed out') })
  expect(existsSync(join(control('superagent'), 'manually-stopped'))).toBe(true)
}, 20_000)

describe('Docker operator wrapper', { timeout: 30_000 }, () => {
  const roots: string[] = []
  const servers: Server[] = []
  afterEach(() => {
    for (const item of servers.splice(0)) item.close()
    for (const item of roots.splice(0)) rmSync(item, { recursive: true, force: true })
  })

  interface Harness {
    root: string
    env: NodeJS.ProcessEnv
    trace: string
    running: string
    imageReady: string
    runtime: string
    image: string
    port: number
    run: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  }

  const invoke = (root: string, env: NodeJS.ProcessEnv, args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>(resolve => execFile(
      'python3', [join(root, 'scripts', 'dsh-superagent'), ...args], { env, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr })))

  function harness(options: { image?: string; withImage?: boolean } = {}): Harness {
    const root = mkdtempSync(join(tmpdir(), 'operator docker '))
    roots.push(root)
    for (const name of ['scripts', 'bin', 'home', 'state', 'dsh', 'artifacts']) mkdirSync(join(root, name))
    mkdirSync(join(root, 'home', '.config', 'op'), { recursive: true })
    writeFileSync(join(root, 'home', '.config', 'op', 'llm.env'),
      'DEEPSEEK_API_KEY=op://AI Keys/DeepSeek API Key/credential\n', { mode: 0o600 })
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent'), join(root, 'scripts', 'dsh-superagent'))
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-legacy'), join(root, 'scripts', 'dsh-superagent-legacy'))
    copyFileSync(join(import.meta.dirname, '..', 'scripts', 'docker-instance'), join(root, 'scripts', 'docker-instance'))
    writeFileSync(join(root, 'compose.yaml'), 'services: {}\n')
    writeFileSync(join(root, 'dsh', '.credentials.yaml'), 'deepseek-account\n')
    const image = options.image ?? 'dsh-superagent:test'
    const trace = join(root, 'trace.log')
    writeFileSync(trace, '')
    const running = join(root, 'running')
    const imageReady = join(root, 'image-ready')
    if (options.withImage !== false) writeFileSync(imageReady, '')
    const bin = (name: string, body: string) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })

    bin('docker', `trace='${trace}'
printf '%s\\n' "$*" >> "$trace"
marker='${running}'
case "$*" in *'dsh-superagent-livis'*) marker='${running}-livis';; esac
case "$1" in
  image)
    [ -f '${imageReady}' ] && exit 0
    exit 1 ;;
  volume)
    [ "$2" = inspect ] && exit 1
    exit 0 ;;
  ps)
    [ -f "$marker" ] && echo fake-container
    exit 0 ;;
  inspect)
    echo '${image}'
    exit 0 ;;
  run)
    case "$*" in
      *'test -f /state/.imported'*) exit 0 ;;
      *'test -e /state/orchestrator.sqlite'*) exit 1 ;;
    esac
    exit 0 ;;
  compose)
    case "$*" in
      *'up --detach'*) touch "$marker"; exit 0 ;;
      *'down'*) rm -f "$marker"; exit 0 ;;
      *'logs --no-color --no-log-prefix'*)
        printf 'dsh web: http://127.0.0.1:%s/?token=%s\\n' "\${SUPERAGENT_PUBLISH_PORT:-3082}" "\${FAKE_PANEL_TOKEN:-unit-token}"
        exit 0 ;;
      *'logs'*) printf 'fake compose log line\\n'; exit 0 ;;
      *'ps --status running -q'*)
        [ -f "$marker" ] && echo fake-container
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0`)
    bin('gh', `case "$1" in auth) echo fake-gh-token;; api) echo fake-login;; esac\nexit 0`)
    bin('security', 'exit 1')
    bin('op', `[ "$1" = whoami ] && exit "\${FAKE_OP_WHOAMI:-0}"
if [ "$1" = run ]; then
  shift
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
  [ "$#" -gt 0 ] && shift
  exec env DEEPSEEK_API_KEY=sk-from-op "$@"
fi
exit 1`)
    bin('pgrep', 'exit 1')
    bin('ps', 'exit 0')
    bin('tmux', 'exit 1')
    bin('dsh', 'exit 0')

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(root, 'home'),
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      DSH_SUPERAGENT_PROFILE: '',
      DSH_SUPERAGENT_URL: '',
      SUPERAGENT_IMAGE: image,
      SUPERAGENT_PUBLISH_PORT: '0',
      SUPERAGENT_STATE_DIR: join(root, 'state'),
      SUPERAGENT_DSH_HOME: join(root, 'dsh'),
      SUPERAGENT_ARTIFACTS_DIR: join(root, 'artifacts'),
      SUPERAGENT_GH_CONFIG_DIR: join(root, 'gh'),
      SUPERAGENT_GH_BIN: join(root, 'bin', 'gh'),
      SUPERAGENT_SECURITY_BIN: join(root, 'bin', 'security'),
      SUPERAGENT_OP_BIN: join(root, 'bin', 'op'),
      SUPERAGENT_PGREP_BIN: join(root, 'bin', 'pgrep'),
      SUPERAGENT_DOCKER_BIN: join(root, 'bin', 'docker'),
      DEEPSEEK_API_KEY: 'sk-test',
      FAKE_PANEL_TOKEN: 'unit-token',
      FAKE_TRACE: trace,
      FAKE_RUNNING: running,
      FAKE_IMAGE_READY: imageReady,
    }
    delete env.SUPERAGENT_INSTANCE
    delete env.SUPERAGENT_PROJECT
    return {
      root, env, trace, running, imageReady, image, port: 0,
      runtime: join(root, 'artifacts', 'instances', 'superagent'),
      run: (...args: string[]) => invoke(root, env, args),
    }
  }

  async function serve(instance: Harness, state: unknown = READY): Promise<void> {
    const current = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state))
    })
    servers.push(current)
    await new Promise<void>(resolve => current.listen(0, '127.0.0.1', resolve))
    instance.port = (current.address() as AddressInfo).port
    instance.env.SUPERAGENT_PUBLISH_PORT = String(instance.port)
  }

  const body = (result: { stdout: string }) => JSON.parse(result.stdout) as Record<string, unknown>
  const mode = (path: string) => statSync(path).mode & 0o777

  it('starts only the selected instance and reports its panel URL and readiness', async () => {
    const instance = harness()
    await serve(instance)
    const started = await instance.run('start')
    expect(started).toMatchObject({ code: 0 })
    expect(body(started)).toMatchObject({
      instance: 'superagent',
      project: 'dsh-superagent-superagent',
      container: 'running',
      image: 'dsh-superagent:test',
      panel: `http://127.0.0.1:${instance.port}/?token=unit-token`,
      manually_stopped: false,
      health: { runtime: 'ready' },
      setup: null,
    })
    const trace = readFileSync(instance.trace, 'utf8')
    expect(trace).toContain('-p dsh-superagent-superagent')
    expect(trace).toContain('up --detach superagent')
    expect(trace).not.toContain('livis')
    expect(readFileSync(join(instance.runtime, 'panel-url'), 'utf8').trim())
      .toBe(`http://127.0.0.1:${instance.port}/?token=unit-token`)
    expect(mode(join(instance.runtime, 'panel-url'))).toBe(0o600)
    const status = await instance.run('status')
    expect(status.code).toBe(0)
    expect(body(status)).toMatchObject({ panel: `http://127.0.0.1:${instance.port}/?token=unit-token` })
  })

  it('stops only the selected instance and reports exit 1 from status after an intentional stop', async () => {
    const instance = harness()
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    const stopped = await instance.run('stop')
    expect(stopped).toMatchObject({ code: 0, stdout: expect.stringContaining('Automatic recovery is paused') })
    expect(existsSync(join(instance.root, '.artifacts', 'control', 'profiles', 'superagent', 'manually-stopped')))
      .toBe(true)
    const trace = readFileSync(instance.trace, 'utf8')
    expect(trace).toContain('down --remove-orphans')
    expect(trace).not.toContain('down --volumes')
    const status = await instance.run('status')
    expect(status.code).toBe(1)
    expect(body(status)).toMatchObject({
      instance: 'superagent', container: 'stopped', panel: null, manually_stopped: true,
      health: null, errors: null, setup: null,
    })
  })

  it('selects the livis service, project and profile without touching superagent', async () => {
    const instance = harness()
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    const stopped = await instance.run('stop', '--profile', 'livis')
    expect(stopped).toMatchObject({ code: 0 })
    const trace = readFileSync(instance.trace, 'utf8')
    expect(trace).toContain('-p dsh-superagent-livis')
    expect(trace).toContain('label=com.docker.compose.project=dsh-superagent-livis')
    expect(trace).not.toContain('up --detach livis')
    // The superagent container and its runtime files are untouched by the other profile.
    expect(existsSync(instance.imageReady)).toBe(true)
    expect(existsSync(join(instance.runtime, 'panel-url'))).toBe(true)
    expect(existsSync(join(instance.root, '.artifacts', 'control', 'profiles', 'livis', 'manually-stopped')))
      .toBe(true)
    expect((await instance.run('status')).code).toBe(0)
  })

  it('starts livis on its own service and port', async () => {
    const instance = harness()
    instance.runtime = join(instance.root, 'artifacts', 'instances', 'livis')
    delete instance.env.DEEPSEEK_API_KEY
    await serve(instance)
    const started = await instance.run('start', '--profile', 'livis')
    expect(started.code).toBe(0)
    expect(body(started)).toMatchObject({
      instance: 'livis',
      project: 'dsh-superagent-livis',
      container: 'running',
      panel: `http://127.0.0.1:${instance.port}/?token=unit-token`,
    })
    const trace = readFileSync(instance.trace, 'utf8')
    expect(trace).toContain('up --detach livis')
    expect(trace).not.toContain('up --detach superagent')
  })

  it('returns 3, 2 and 1 for setup waiting, a broken part and a runtime error', async () => {
    const setup = harness()
    await serve(setup, {
      health: { runtime: { state: 'ready' } },
      setup: { problem: { code: 'repositoryUnset', detail: 'The GitHub Source names no repository.' } },
    })
    expect(await setup.run('start')).toMatchObject({
      code: 3, stdout: expect.stringContaining('waiting for setup: The GitHub Source names no repository.'),
    })
    expect((await setup.run('status')).code).toBe(3)

    const broken = harness()
    await serve(broken, {
      health: { runtime: { state: 'ready' }, github: { state: 'error', detail: 'bad token' } },
      setup: { problem: null },
    })
    expect(await broken.run('start')).toMatchObject({
      code: 2, stdout: expect.stringContaining('github reports an error, which a restart does not fix: bad token'),
    })
    expect((await broken.run('status')).code).toBe(2)

    const runtime = harness()
    await serve(runtime, { health: { runtime: { state: 'error', detail: 'relay exited' } }, setup: { problem: null } })
    expect((await runtime.run('start')).code).toBe(1)
  })

  it('reports exit 1 when the container runs but the management API is unreachable', async () => {
    const instance = harness()
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    for (const item of servers.splice(0)) item.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    const status = await instance.run('status')
    expect(status.code).toBe(1)
    expect(body(status)).toMatchObject({ container: 'running', health: null })
  })

  it('exits 1 when readiness times out with a health entry still starting', async () => {
    const instance = harness()
    await serve(instance, {
      health: { runtime: { state: 'ready' }, github: { state: 'starting' } },
      setup: { problem: null },
    })
    const started = await instance.run('start', '--timeout', '2')
    expect(started).toMatchObject({ code: 1, stderr: expect.stringContaining('startup health check timed out') })
  })

  it('honours --respect-stop without running Compose again', async () => {
    const instance = harness()
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    expect((await instance.run('stop')).code).toBe(0)
    writeFileSync(instance.trace, '')
    const skipped = await instance.run('start', '--respect-stop')
    expect(skipped).toMatchObject({ code: 0, stdout: expect.stringContaining('Intentional stop is active') })
    expect(readFileSync(instance.trace, 'utf8')).toBe('')
  })

  it('builds a missing image before starting and leaves everything untouched when the build fails', async () => {
    const built = harness({ withImage: false })
    writeFileSync(join(built.root, 'scripts', 'docker-build'), `#!/bin/sh
printf 'built %s\\n' "$SUPERAGENT_IMAGE" >> '${built.root}/build.log'
touch '${built.imageReady}'
printf '%s\\n' "$SUPERAGENT_IMAGE"
`, { mode: 0o755 })
    await serve(built)
    const started = await built.run('start')
    expect(started.code).toBe(0)
    expect(started.stdout).toContain('"container": "running"')
    expect(readFileSync(join(built.root, 'build.log'), 'utf8')).toContain('built dsh-superagent:test')

    const failed = harness({ withImage: false })
    writeFileSync(join(failed.root, 'scripts', 'docker-build'), '#!/bin/sh\necho build explosion >&2\nexit 4\n',
      { mode: 0o755 })
    const result = await failed.run('start')
    expect(result).toMatchObject({
      code: 2, stderr: expect.stringContaining('the image build failed; the previous image tag and every volume were left untouched.'),
    })
    expect(readFileSync(failed.trace, 'utf8')).not.toContain('up --detach')
    expect(existsSync(failed.runtime)).toBe(false)
  })

  it('warns without blocking when a running instance switches image tag', async () => {
    const instance = harness({ image: 'dsh-superagent:first' })
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    instance.env.SUPERAGENT_IMAGE = 'dsh-superagent:second'
    const switched = await instance.run('start')
    expect(switched.code).toBe(0)
    expect(switched.stderr).toContain('The DSH database migration is one-way')
    expect(body(switched)).toMatchObject({ image: 'dsh-superagent:second' })
  })

  it('passes follow and tail through to the selected service logs', async () => {
    const instance = harness()
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    const logs = await instance.run('logs', '--follow', '--tail', '25')
    expect(logs).toMatchObject({ code: 0, stdout: expect.stringContaining('fake compose log line') })
    expect(readFileSync(instance.trace, 'utf8')).toContain('logs --follow --tail 25 superagent')
    expect((await instance.run('stop')).code).toBe(0)
    expect(await instance.run('logs')).toMatchObject({
      code: 1, stderr: expect.stringContaining('no container or recorded image for superagent'),
    })
  })

  it('rejects non-Docker profiles, and dispatches them to the legacy path on request', async () => {
    const instance = harness()
    const rejected = await instance.run('status', '--profile', 'other')
    expect(rejected).toMatchObject({ code: 2, stderr: expect.stringContaining('only superagent, livis are managed by Docker') })
    expect(readFileSync(instance.trace, 'utf8')).toBe('')
    const legacy = await instance.run('--legacy', 'status', '--profile', 'other')
    expect(legacy.code).toBe(1)
    expect(JSON.parse(legacy.stdout)).toMatchObject({ pids: [], manually_stopped: false })
  })

  it('propagates missing configuration as exit 2 before Compose starts anything', async () => {
    const instance = harness()
    await serve(instance)
    writeFileSync(join(instance.root, 'bin', 'op'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    delete instance.env.DEEPSEEK_API_KEY
    const result = await instance.run('start')
    expect(result).toMatchObject({ code: 2, stderr: expect.stringContaining('could not resolve the model key') })
    expect(readFileSync(instance.trace, 'utf8')).not.toContain('up --detach')
  })

  it('resolves the model key through op run even when op whoami reports no account', async () => {
    const instance = harness()
    await serve(instance)
    delete instance.env.DEEPSEEK_API_KEY
    instance.env.FAKE_OP_WHOAMI = '1'
    const started = await instance.run('start')
    expect(started).toMatchObject({ code: 0, stderr: expect.stringContaining('resolving it through op run') })
    expect(body(started)).toMatchObject({ container: 'running' })
    expect(readFileSync(instance.trace, 'utf8')).toContain('up --detach')
  })

  it('restarts the selected instance and refreshes the panel URL', async () => {
    const instance = harness()
    await serve(instance)
    expect((await instance.run('start')).code).toBe(0)
    instance.env.FAKE_PANEL_TOKEN = 'second-token'
    const restarted = await instance.run('restart')
    expect(restarted.code).toBe(0)
    expect(body(restarted)).toMatchObject({ panel: `http://127.0.0.1:${instance.port}/?token=second-token` })
    expect(readFileSync(join(instance.runtime, 'panel-url'), 'utf8').trim())
      .toBe(`http://127.0.0.1:${instance.port}/?token=second-token`)
    const trace = readFileSync(instance.trace, 'utf8')
    expect(trace).toContain('down --remove-orphans')
    expect(trace).toContain('up --detach superagent')
  })

  it('builds explicitly without touching Compose, and exits 2 when the build fails', async () => {
    const instance = harness()
    writeFileSync(join(instance.root, 'scripts', 'docker-build'), `#!/bin/sh
printf 'force built %s\\n' "$SUPERAGENT_IMAGE" >> '${instance.root}/build.log'
printf '%s\\n' "$SUPERAGENT_IMAGE"
`, { mode: 0o755 })
    const built = await instance.run('build')
    expect(built.code).toBe(0)
    expect(built.stderr).toContain('dsh-superagent: image dsh-superagent:test is ready.')
    expect(readFileSync(instance.trace, 'utf8')).not.toContain('compose')
    expect(readFileSync(join(instance.root, 'build.log'), 'utf8')).toContain('force built dsh-superagent:test')

    writeFileSync(join(instance.root, 'scripts', 'docker-build'), '#!/bin/sh\nexit 9\n', { mode: 0o755 })
    const failed = await instance.run('build')
    expect(failed.code).toBe(2)
    expect(failed.stderr).toContain('the image build failed')
  })
})
