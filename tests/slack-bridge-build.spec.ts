/** The built package: the Slack Source entry is exported, the executable runs, and only it imports the Slack SDKs. */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const lib = join(root, 'lib')
const executable = join(lib, 'slack-bridge.js')

beforeAll(() => {
  execFileSync(join(root, 'node_modules', '.bin', 'tsdown'), [], { cwd: root, stdio: 'pipe' })
}, 180_000)

describe('built slack-bridge', () => {
  it('ships an executable whose first line is the node shebang', () => {
    expect(existsSync(executable)).toBe(true)
    expect(readFileSync(executable, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node')
    expect(statSync(executable).mode & 0o111).not.toBe(0)
  })

  it('runs --version when executed through its shebang', () => {
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8' })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('ships the slack-watch Source entry exported by the package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, string> }
    expect(pkg.exports['./slack-watch']).toBe('./lib/slack-watch.js')
    expect(existsSync(join(lib, 'slack-watch.js'))).toBe(true)
  })

  it('keeps both Slack SDKs external and out of every other entry', () => {
    const bridge = readFileSync(executable, 'utf8')
    expect(bridge).toContain('@slack/socket-mode')
    expect(bridge).toContain('@slack/web-api')
    for (const file of readdirSync(lib).filter(name => name.endsWith('.js') && name !== 'slack-bridge.js')) {
      expect(readFileSync(join(lib, file), 'utf8')).not.toContain('@slack/')
    }
  })
})
