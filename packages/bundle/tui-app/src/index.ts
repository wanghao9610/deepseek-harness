/**
 * @deepseek-ai/dsh-tui-app — the interactive terminal bundle's runtime glue
 * plugin plus the bundle patch (`cordis.patch.yml`, declared by the
 * `dsh.bundle.patch` manifest field). The plugin owns what the terminal front
 * door needs from the process it runs in: the harness-source and
 * terminal-surface prompt sections, the in-place `/resume` process handoff,
 * the exit line, and disposal of the process-local `/resume` search index.
 * Invocation values arrive through the `tuiStartup` service expressions in the
 * bundle patch.
 * @module @deepseek-ai/dsh-tui-app
 */

import { rm } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { addHarnessSourceSection, resolveHarnessCheckout } from '@deepseek-ai/dsh-app-boot'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiResumeHost } from '@deepseek-ai/dsh-tui'
import { TUI_GOODBYE_MESSAGE_KEY } from '@deepseek-ai/dsh-tui'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'tui-app'

/** Services required before the glue can mount; the invocation reaches it through config. */
export const inject: string[] = []

/** What the model is told about the surface its user is sitting in front of. */
const TERMINAL_SURFACE_PROMPT = 'The user is working in an interactive terminal UI. They see your text replies rendered as Markdown, one card per tool call, and the current plan. They can interrupt a turn, steer it mid-run, and answer questions you ask, so prefer asking over guessing when a choice is theirs.'

/** Plugin config: the composed deployment settings for this terminal surface. */
export interface Config {
  /** Line printed once the terminal is released on exit; the command that returns to this session. */
  goodbye: string
  /** Absolute path of this process's disposable `/resume` search index, removed on disposal. */
  queryIndexPath: string
  /**
   * Register the model-visible surface context (the harness-source and
   * terminal-surface prompt sections). A composition whose user is not at this
   * terminal turns it off so the orientation text cannot be false.
   */
  surfaceContext: boolean
}

export const Config: z<Config> = z.object({
  goodbye: z.string().required(),
  queryIndexPath: z.string().required(),
  surfaceContext: z.boolean().default(true),
})

/** Process capabilities the in-place resume handoff needs, replaceable by tests. */
export const internals: {
  /** Absolute path of the entry module this process was launched with. */
  entry: string | undefined
  /** `process.execve`, absent on platforms and Node builds without it. */
  execve: typeof process.execve
  /** Enter a directory before committing teardown. */
  chdir(directory: string): void
} = {
  entry: process.argv[1],
  execve: process.execve?.bind(process),
  chdir: (directory: string) => { process.chdir(directory) },
}

/**
 * Build the in-place resume handoff, or `undefined` when this process cannot
 * replace itself. The TUI keeps foreign sessions selectable either way and
 * reports the missing capability rather than silently doing nothing.
 * @param ctx - plugin context whose root owns the app being torn down.
 * @returns the handoff host, or `undefined` without `process.execve` or a known entry.
 */
function resolveResumeHost(ctx: Context): TuiResumeHost | undefined {
  const { entry, execve } = internals
  if (entry === undefined || execve === undefined) return undefined
  return {
    async handoff(sessionId: SessionId, cwd: string): Promise<never> {
      const nextArgv = [process.execPath, ...process.execArgv, entry, '--profile', 'tui', `--resume=${sessionId}`]
      // `execve` inherits the cwd, and the target session may belong to another
      // workspace. Enter it BEFORE teardown commits: an unreachable directory
      // (deleted, unreadable) must reject while the caller can still restore
      // the terminal, and a chdir after disposal would have no owner to report to.
      try {
        internals.chdir(cwd)
      } catch (error: unknown) {
        throw new Error(`dsh: cannot resume in "${cwd}": ${String(error)}`)
      }
      try {
        await ctx.root.fiber.dispose()
        execve(process.execPath, nextArgv, process.env)
        throw new Error('process replacement returned unexpectedly')
      } catch (error: unknown) {
        process.stderr.write(`dsh: resume handoff failed after terminal release: ${String(error)}\n`)
        process.exit(1)
      }
    },
  }
}

/**
 * Mount the terminal surface's process glue.
 * @param ctx - plugin context carrying the parsed invocation.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  const resumeHost = resolveResumeHost(ctx)
  if (resumeHost !== undefined) ctx.provide('tuiResumeHost', resumeHost)
  // Provided last of the front door's inputs: the `tui` row injects this key,
  // so publishing it is what releases the terminal takeover, and every optional
  // host slot above is already visible by then.
  ctx.provide(TUI_GOODBYE_MESSAGE_KEY, config.goodbye)
  const queryIndexPath = config.queryIndexPath
  ctx.effect(() => async () => {
    await Promise.all([
      rm(queryIndexPath, { force: true }),
      rm(`${queryIndexPath}-wal`, { force: true }),
      rm(`${queryIndexPath}-shm`, { force: true }),
    ])
  }, 'tui-app.sessionQueryIndex')
  if (!config.surfaceContext) return
  ctx.inject(['systemPrompt'], (promptCtx) => {
    addHarnessSourceSection(promptCtx, resolveHarnessCheckout(import.meta.url))
    promptCtx.systemPrompt.section({
      name: 'app:terminal-surface',
      order: -98,
      text: TERMINAL_SURFACE_PROMPT,
    })
  })
}
