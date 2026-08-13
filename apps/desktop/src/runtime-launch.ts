/**
 * The command line the harness runtime is launched with.
 *
 * One definition, because the packaging smoke boots the deployed closure to
 * prove the shipped application will: a smoke that launched it differently
 * would prove nothing about the launch that ships.
 * @module @deepseek-ai/dsh-desktop/runtime-launch
 */

/** Loopback host the runtime binds; the desktop shell never serves a network. */
const RUNTIME_HOST = '127.0.0.1'

/**
 * Port request. Zero asks the OS for a free port, which keeps the shell from
 * colliding with a `dsh web` the user started in a terminal.
 */
const RUNTIME_PORT = '0'

/**
 * Node flags the runtime needs under Electron's Node.
 *
 * Cordis reaches Node's internal ES module loader either through this flag or
 * through the `node-addon-require-builtin` addon. That addon reads V8 embedder
 * data whose layout Electron does not share, so it fails to load there and the
 * flag is the only route left; without it the HMR service refuses to start and
 * takes the boot with it.
 */
const RUNTIME_NODE_FLAGS: readonly string[] = ['--expose-internals']

/**
 * Build the runtime's full argument list.
 * @param entry - absolute path of the `dsh` launcher.
 * @param maxOldSpaceMb - V8 old-space bound in MiB.
 * @returns the arguments, node flags first.
 */
export function runtimeArgs(entry: string, maxOldSpaceMb: number): string[] {
  return [
    ...RUNTIME_NODE_FLAGS,
    `--max-old-space-size=${String(maxOldSpaceMb)}`,
    entry,
    '--profile',
    'web',
    '--host',
    RUNTIME_HOST,
    '--port',
    RUNTIME_PORT,
  ]
}
