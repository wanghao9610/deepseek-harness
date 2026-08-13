/**
 * Filesystem layout of the two trees the desktop shell runs from: its own
 * Electron app directory, and the harness runtime closure beside it.
 * @module @deepseek-ai/dsh-desktop/paths
 */

import { join } from 'node:path'

/** Directory under `Contents/Resources` holding the deployed harness closure. */
export const RUNTIME_DIRECTORY = 'backend'

/** Path of the `dsh` launcher inside a deployed closure, relative to its root. */
export const RUNTIME_ENTRY_RELATIVE = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

/** Where the shell is running from, as Electron reports it. */
export interface RuntimeLayout {
  /** Whether this is an installed application rather than a checkout run. */
  packaged: boolean
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** `app.getAppPath()` — the checkout's `apps/desktop` when unpackaged. */
  appPath: string
}

/**
 * Resolve the harness launcher this shell supervises.
 *
 * A packaged application owns a deployed closure under its own resources. A
 * checkout run has no closure, so it supervises the sibling CLI's build
 * output, which is what `pnpm run build` produces.
 * @param layout - the running application's layout.
 * @returns the absolute path of the `dsh` launcher.
 */
export function resolveRuntimeEntry(layout: RuntimeLayout): string {
  if (layout.packaged) return join(layout.resourcesPath, RUNTIME_DIRECTORY, RUNTIME_ENTRY_RELATIVE)
  return join(layout.appPath, '..', 'cli', 'lib', 'bin.js')
}
