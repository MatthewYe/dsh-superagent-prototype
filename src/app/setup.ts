/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { resolveDeployment, workerProbe, type Deployment, type Machine, type Probe } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  /** Registered source kinds; read lazily because plugins register after `Setup` is constructed. */
  sources(): SourceRegistry
  restart(): void
}

const setupFields = (settings: Settings, kinds: readonly SourceKind[]) =>
  JSON.stringify(kinds.map(kind => kind.setup?.fields.map(field => settings.sources[kind.kind]?.config[field] ?? '') ?? []))
/** Whether a save changed a field any registered Source kind's setup reads (such as an account CLI). */
export const setupChanged = (before: Settings, after: Settings, kinds: readonly SourceKind[]): boolean => setupFields(before, kinds) !== setupFields(after, kinds)

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Attribute a probe failure to the Source kind whose slot failed, even when the kind used a generic error. */
function problemFor(kind: string, error: unknown): SetupProblem {
  return error instanceof SetupError
    ? { ...error.problem, place: kind }
    : { place: kind, code: 'sourceFailed', values: { source: kind, output: reason(error) }, detail: reason(error) }
}

export interface SourceProfiles {
  /** Resolved profiles keyed by Source kind ID; a kind that resolves nothing is absent. */
  sources: Record<string, unknown>
  /** Failed probes keyed by Source kind ID, including disabled kinds shown on their cards. */
  problems: Map<string, SetupProblem>
  /** Kinds whose stored instance is enabled; only these block setup completion. */
  enabled: Set<string>
}

/** Probe every registered kind's deployment slot independently, so one broken Source does not hide the others. */
export async function resolveSourceProfiles(input: { machine: Machine; settings: Settings; kinds: readonly SourceKind[]; run: Probe; signal: AbortSignal }): Promise<SourceProfiles> {
  const { machine, settings, run, signal } = input
  const sources: Record<string, unknown> = {}
  const problems = new Map<string, SetupProblem>()
  const enabled = new Set<string>()
  for (const kind of input.kinds) {
    if (!kind.setup) continue
    const stored = settings.sources[kind.kind]
    if (stored?.enabled ?? true) enabled.add(kind.kind)
    try {
      const profile = await kind.setup.probe({ machine, config: stored?.config ?? {}, run, signal })
      if (profile !== undefined) sources[kind.kind] = profile
    } catch (error) { problems.set(kind.kind, problemFor(kind.kind, error)) }
  }
  return { sources, problems, enabled }
}

/**
 * Resolves the target repository, the GitHub account, and each Source kind's own deployment profile by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  /** Setup failures keyed by settings card: core `deployment`/`github`, or a Source kind ID. */
  readonly problems = new Map<string, SetupProblem>()
  private enabled = new Set<string>()
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** First failure that stops the configured deployment: a core failure while unresolved, otherwise an enabled Source's failure. */
  get problem(): SetupProblem | undefined {
    if (!this.resolved) return this.problems.values().next().value
    return [...this.problems].find(([kind]) => this.enabled.has(kind))?.[1]
  }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures per settings card and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    this.problems.clear()
    this.enabled.clear()
    try { this.resolved = await this.resolve(settings); return true }
    catch (error) {
      if (!(error instanceof SetupError)) throw error
      this.problems.set(error.place, error.problem)
      return false
    }
  }
  /** Trigger a restart to re-run setup, refusing if the deployment and every enabled Source are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.problem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify the changed Source's own CLI before saving; a disabled Source records its problem but does not block the save. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    if (block === 'source:github') {
      await resolveDeployment(machine, settings.sources.github?.config, this.probe()).catch((error: unknown) => {
        if (!(error instanceof SetupError) || error.place === 'github') throw error
      })
      return
    }
    if (!block.startsWith('source:')) return
    const id = block.slice(7)
    const setup = this.host.sources().kind(id)?.setup
    if (!setup) return
    const stored = settings.sources[id]
    const enabled = stored?.enabled ?? true
    try {
      const profile = await setup.probe({ machine, config: stored?.config ?? {}, run: this.probe(), signal: this.host.lifetime })
      if (this.resolved) {
        const sources = this.resolved.sources as Record<string, unknown>
        if (profile === undefined) delete sources[id]
        else sources[id] = profile
      }
      this.problems.delete(id)
    } catch (error) {
      const problem = problemFor(id, error)
      this.problems.set(id, problem)
      if (enabled) throw error
    }
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const { sources, problems, enabled } = await resolveSourceProfiles({
      machine, settings, kinds: this.host.sources().all(), run: probe, signal: lifetime,
    })
    this.enabled = enabled
    for (const [kind, problem] of problems) {
      this.problems.set(kind, problem)
      context.logger.warn('dsh-superagent leaves the %s Source out: %s', kind, problem.detail)
    }
    const resolved: Deployment = { ...deployment, sources }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}