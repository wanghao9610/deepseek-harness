/**
 * Supervision of the embedded `dsh --profile web` process: start, readiness,
 * restart pacing, and bounded shutdown.
 *
 * The runtime runs as a child rather than inside the main process so a harness
 * fault, a memory climb, or a wedged plugin tree costs a restart instead of the
 * window, and so its heap is sized independently of Chromium's.
 * @module @deepseek-ai/dsh-desktop/runtime-supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { ReadinessScanner } from './readiness.ts'
import { DEFAULT_RESTART_LIMITS, RestartPolicy, type RestartLimits } from './restart-policy.ts'
import { runtimeArgs } from './runtime-launch.ts'

/**
 * Grace between the stop request and the forced kill. The runtime bounds its
 * own disposal at five seconds and then force-exits, so this waits out that
 * bound before escalating.
 */
const SHUTDOWN_GRACE_MS = 8_000

/** Observable condition of the supervised runtime. */
export type RuntimeState =
  /** No process, and none requested. */
  | { status: 'stopped' }
  /** A process is running but has not reported its URL. */
  | { status: 'starting'; attempt: number }
  /** The runtime reported this URL and is serving. */
  | { status: 'ready'; url: string }
  /** The previous process exited; the next start is scheduled. */
  | { status: 'restarting'; attempt: number; delayMs: number }
  /** Startup failed repeatedly; nothing further is scheduled. */
  | { status: 'failed'; reason: string }

/** Everything the supervisor needs from the application around it. */
export interface RuntimeSupervisorOptions {
  /** Absolute path of the `dsh` launcher. */
  entry: string
  /** Node-capable binary to run it with: the Electron binary in `ELECTRON_RUN_AS_NODE` mode. */
  nodePath: string
  /** Working directory of the runtime, which becomes a new session's default project directory. */
  cwd: string
  /** Environment for the runtime, already merged from the login shell. */
  env: Readonly<Record<string, string>>
  /** V8 old-space bound for the runtime, in MiB. */
  maxOldSpaceMb: number
  /** Receives every stdout and stderr chunk verbatim. */
  onOutput: (chunk: string) => void
  /** Restart pacing; defaults to {@link DEFAULT_RESTART_LIMITS}. */
  limits?: RestartLimits
}

/** Owns one runtime process at a time and the schedule for replacing it. */
export class RuntimeSupervisor {
  private state: RuntimeState = { status: 'stopped' }
  private child: ChildProcess | undefined
  private readonly policy: RestartPolicy
  private readonly watchers = new Set<(state: RuntimeState) => void>()
  private scanner = new ReadinessScanner()
  private startedAt = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private stopRequested = false
  private exitWaiters: (() => void)[] = []

  /** @param options - runtime location, launch environment, and pacing. */
  constructor(private readonly options: RuntimeSupervisorOptions) {
    this.policy = new RestartPolicy(options.limits ?? DEFAULT_RESTART_LIMITS)
  }

  /** The current condition. */
  get current(): RuntimeState {
    return this.state
  }

  /** The serving URL, or `undefined` unless the runtime is ready. */
  get url(): string | undefined {
    return this.state.status === 'ready' ? this.state.url : undefined
  }

  /** Process id of the running runtime, or `undefined` when none is running. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /**
   * Observe condition changes.
   * @param listener - called on every transition, never for the current value.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (state: RuntimeState) => void): () => void {
    this.watchers.add(listener)
    return () => this.watchers.delete(listener)
  }

  /**
   * Start the runtime unless one is already running or scheduled. Clears a
   * previous give-up, so this is also how the user retries after a failure.
   */
  start(): void {
    this.stopRequested = false
    if (this.child !== undefined || this.restartTimer !== undefined) return
    if (this.state.status === 'failed') this.policy.reset()
    this.spawnRuntime(this.state.status === 'restarting' ? this.state.attempt : 0)
  }

  /**
   * Replace the running runtime. Sessions are durable, so a restart costs an
   * in-flight turn and nothing else.
   */
  async restart(): Promise<void> {
    await this.stop()
    this.start()
  }

  /**
   * Stop the runtime and cancel any scheduled start.
   *
   * The request is a `SIGTERM` to the runtime, which disposes its own plugin
   * tree and its own subprocesses. Only when it outlives the grace does the
   * escalation reach the process group, which is what catches subprocesses
   * that a wedged runtime never reaped.
   */
  async stop(): Promise<void> {
    this.stopRequested = true
    this.clearRestartTimer()
    const child = this.child
    if (child === undefined) {
      this.publish({ status: 'stopped' })
      return
    }
    const exited = new Promise<void>((resolve) => { this.exitWaiters.push(resolve) })
    child.kill('SIGTERM')
    const escalation = setTimeout(() => { this.killGroup(child) }, SHUTDOWN_GRACE_MS)
    await exited
    clearTimeout(escalation)
  }

  /**
   * Signal the whole process group, which reaches subprocesses the runtime
   * started and did not reap.
   * @param child - the runtime process, which is its group leader.
   */
  private killGroup(child: ChildProcess): void {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // The group is already gone: the exit handler has run or is about to.
    }
  }

  /**
   * Launch one runtime process and wire its output.
   * @param attempt - consecutive startup failures preceding this launch.
   */
  private spawnRuntime(attempt: number): void {
    this.scanner = new ReadinessScanner()
    this.startedAt = Date.now()
    this.publish({ status: 'starting', attempt })
    const child = spawn(
      this.options.nodePath,
      runtimeArgs(this.options.entry, this.options.maxOldSpaceMb),
      {
        cwd: this.options.cwd,
        env: { ...this.options.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so shutdown can reach subprocesses as a unit.
        detached: true,
      },
    )
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.consume(chunk) })
    child.stderr?.on('data', (chunk: string) => { this.consume(chunk) })
    child.once('error', (error) => {
      this.options.onOutput(`desktop: runtime failed to launch: ${error.message}\n`)
    })
    child.once('exit', (code, signal) => { this.handleExit(code, signal) })
  }

  /**
   * Route one output chunk to the log and to readiness detection.
   * @param chunk - decoded stdout or stderr text.
   */
  private consume(chunk: string): void {
    this.options.onOutput(chunk)
    const url = this.scanner.push(chunk)
    if (url !== undefined) this.publish({ status: 'ready', url })
  }

  /**
   * Account for the runtime process ending.
   * @param code - exit code, or `null` when a signal ended it.
   * @param signal - the signal that ended it, when one did.
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined
    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const resolve of waiters) resolve()
    if (this.stopRequested) {
      this.publish({ status: 'stopped' })
      return
    }
    const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${String(code)}`
    const decision = this.policy.recordExit(Date.now() - this.startedAt)
    if (decision.action === 'give-up') {
      this.publish({ status: 'failed', reason: `the harness runtime stopped ${String(decision.attempt)} times in a row (${cause})` })
      return
    }
    this.options.onOutput(`desktop: runtime ended (${cause}); restarting in ${String(decision.delayMs)}ms\n`)
    this.publish({ status: 'restarting', attempt: decision.attempt, delayMs: decision.delayMs })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.stopRequested) return
      this.spawnRuntime(decision.attempt)
    }, decision.delayMs)
  }

  /** Cancel a scheduled start. */
  private clearRestartTimer(): void {
    if (this.restartTimer === undefined) return
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  /**
   * Record and broadcast one condition.
   * @param state - the new condition.
   */
  private publish(state: RuntimeState): void {
    this.state = state
    for (const watcher of this.watchers) watcher(state)
  }
}
