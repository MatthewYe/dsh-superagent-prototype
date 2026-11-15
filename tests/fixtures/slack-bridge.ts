/** A fake `slack-bridge` for Source tests: canned Web API answers and a socket that reports ready and stays up. */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Canned answers keyed by `method`, `method:channel`, or `method:channel:ts`; each key holds a page queue. */
export type SlackPlan = Record<string, unknown[]>
export interface SlackCall { method: string; body: Record<string, unknown> }

/**
 * Writes an executable bridge that answers `api <method> [json]` from `plan`. A key's first answer is popped until one
 * remains, so a two-page history can answer two calls while a single answer repeats for every pass. An unknown key
 * answers `{ ok: true }`. `listen` prints the ready marker and blocks until the supervisor stops it.
 */
export function fakeSlackBridge(directory: string, plan: SlackPlan): { cli: string; calls(): SlackCall[] } {
  const cli = join(directory, 'slack-bridge')
  const planPath = join(directory, 'slack-plan.json')
  const callsPath = join(directory, 'slack-calls.jsonl')
  writeFileSync(planPath, JSON.stringify(plan))
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs')
const [mode, method, json] = process.argv.slice(2)
if (mode === 'listen') {
  process.stderr.write('[socket] ready\\n')
  setInterval(() => {}, 1000)
} else if (mode === 'api') {
  const body = json ? JSON.parse(json) : {}
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ method, body }) + '\\n')
  const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)}, 'utf8'))
  const key = method + ':' + String(body.channel ?? body.user ?? '') + (body.ts ? ':' + String(body.ts) : '')
  const queue = plan[key] ?? plan[method] ?? [{ ok: true }]
  const answer = queue.length > 1 ? queue.shift() : queue[0]
  fs.writeFileSync(${JSON.stringify(planPath)}, JSON.stringify(plan))
  process.stdout.write(JSON.stringify(answer) + '\\n')
} else {
  process.exit(2)
}
`, { mode: 0o755 })
  chmodSync(cli, 0o755)
  return {
    cli,
    calls: () => existsSync(callsPath)
      ? readFileSync(callsPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as SlackCall)
      : [],
  }
}
