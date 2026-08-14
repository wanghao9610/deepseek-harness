/**
 * The terminal app's command-line provider: it parses the `dsh --profile tui`
 * flag family (`--resume`, `--continue`) and its `--help` text, resolves the
 * session identity this invocation drives, then provides the immutable values
 * as {@link TUI_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** The config `id` of the agent-loop entry the terminal front door drives. */
export const MAIN_AGENT_ID = 'main'

/** What the terminal rows read from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Exact session identity for this invocation, fresh or resumed. */
  sessionId: SessionId
  /** Whether {@link TuiStartupValues.sessionId} names a persisted session to load. */
  resume: boolean
  /** The command line that returns to this session, shown when the UI exits. */
  goodbye: string
  /**
   * Process-local path for the derived `/resume` search index. The SQLite
   * backend has one writer owner, so concurrent `dsh --profile tui` processes
   * must not share a file.
   */
  queryIndexPath: string
}

/** The terminal flag family, as commander parsed it. */
interface TuiOptions {
  resume?: string
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Open the DeepSeek Harness interactive terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume [session]', 'resume a persisted session; omit the id to pick one from the session list')
    .addHelpText('after', `
Examples:
  dsh --profile tui                          start a fresh session in this directory
  dsh --profile tui --resume                 pick a session to resume from the list
  dsh --profile tui --resume <session-id>    resume that exact session
`)
}

/**
 * Resolve the identity of the session this invocation drives.
 * @param options - the parsed flag family.
 * @returns the exact identity plus whether it names persisted history.
 */
function resolveIdentity(options: TuiOptions): { sessionId: SessionId; resume: boolean } {
  // `--resume` without a value enters the front door with a fresh session; the
  // UI's own selector, which knows the persisted corpus, performs the switch.
  // Only an explicit id binds the boot identity.
  const explicit = typeof options.resume === 'string' && options.resume.trim() !== ''
    ? options.resume.trim()
    : undefined
  return explicit === undefined
    ? { sessionId: SessionId(`main-session-${randomUUID()}`), resume: false }
    : { sessionId: SessionId(explicit), resume: true }
}

/**
 * Parse and provide the terminal invocation as an ordinary Cordis service. The
 * command's action publishes the resolved identity; on a usage error (and on
 * `--help`) nothing is provided and no front door mounts.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const identity = resolveIdentity(program.opts<TuiOptions>())
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...identity,
      goodbye: `To resume this session: dsh --profile tui --resume ${identity.sessionId}`,
      queryIndexPath: join(tmpdir(), `dsh-session-query-${String(process.pid)}-${randomUUID()}.db`),
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
