/**
 * What the local boot surface can ask the shell to do, and how one of its
 * requests is read.
 *
 * The surface is a sandboxed page with no preload, so it reaches the shell by
 * navigating to a scheme the window host intercepts. That navigation is a wire
 * between two processes: this module is where its text becomes a typed request,
 * and where a request this build does not serve stops.
 * @module @deepseek-ai/dsh-desktop/boot-action
 */

import type { SshTarget } from '@deepseek-ai/dsh-ssh-launch'

/** Scheme the boot surface uses for its buttons; navigation to it never happens. */
export const ACTION_SCHEME = 'dsh-action:'

/** What the boot surface can ask the shell to do. */
export type BootAction =
  /** Start the runtime again after a failure. */
  | { kind: 'retry' }
  /** Reveal the runtime log. */
  | { kind: 'open-log' }
  /** Quit the application. */
  | { kind: 'quit' }
  /** Stop a start that is taking too long, without scheduling another. */
  | { kind: 'cancel-start' }
  /** Show the connection list over whatever the window is showing. */
  | { kind: 'manage-connections' }
  /** Leave the connection list. */
  | { kind: 'close-connections' }
  /** Serve from this connection, or from this machine when no target is named. */
  | { kind: 'connect'; targetId: string | undefined }
  /** Store one connection, adding it or replacing the one with its identifier. */
  | { kind: 'save-connection'; draft: Partial<SshTarget> }
  /** Forget one connection. */
  | { kind: 'remove-connection'; targetId: string }
  /** Choose a server payload for the connection being edited, keeping the rest of the draft. */
  | { kind: 'pick-payload'; draft: Partial<SshTarget> }

/**
 * Recover one connection draft from an action's parameter.
 *
 * The surface sends every field as text, and an untouched optional field
 * arrives empty; an empty field means "let ssh decide", which is not the same
 * as the empty string a validator would reject. Nothing here judges the values:
 * the shell runs them through the connection validator, which owns what may be
 * stored and handed to `ssh`.
 * @param payload - the encoded draft, when the action carried one.
 * @returns the fields the draft named, each trimmed, with empty ones left out.
 */
export function readDraft(payload: string | null): Partial<SshTarget> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload ?? 'null')
  } catch {
    // A payload the surface could not have produced; the caller reports the
    // empty draft as a missing host rather than acting on half of it.
    parsed = null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const source = parsed as Record<string, unknown>
  const text = (key: string): string | undefined => {
    const value = source[key]
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const jumps = text('jumpHosts')?.split(',').map(hop => hop.trim()).filter(hop => hop.length > 0) ?? []
  const port = text('port')
  const id = text('id')
  const label = text('label')
  const host = text('host')
  const user = text('user')
  const identityFile = text('identityFile')
  const remoteCwd = text('remoteCwd')
  const remoteHome = text('remoteHome')
  const profile = text('profile')
  const loginShell = text('loginShell')
  return {
    ...id !== undefined && { id },
    ...label !== undefined && { label },
    ...host !== undefined && { host },
    ...user !== undefined && { user },
    ...port !== undefined && { port: Number(port) },
    ...identityFile !== undefined && { identityFile },
    ...jumps.length > 0 && { jumpHosts: jumps },
    ...readDraftLauncher(text),
    ...remoteCwd !== undefined && { remoteCwd },
    ...remoteHome !== undefined && { remoteHome },
    ...profile !== undefined && { profile },
    ...loginShell !== undefined && { loginShell: loginShell === 'true' },
  }
}

/**
 * Read the launcher choice out of the two fields the surface pairs with it.
 *
 * The surface always sends both, because the person can switch between them
 * without losing what they typed; only the chosen one carries meaning, and a
 * host launcher with an empty command reaches the validator as one so it can
 * say the field is required.
 * @param text - reader over the draft's text fields.
 * @returns the launcher fragment, or nothing when the draft named no choice.
 */
function readDraftLauncher(text: (key: string) => string | undefined): Pick<Partial<SshTarget>, 'launcher'> {
  const kind = text('launcherKind')
  if (kind === undefined) return {}
  if (kind === 'host') return { launcher: { kind: 'host', command: text('launcherCommand') ?? '' } }
  if (kind === 'archive') return { launcher: { kind: 'archive', path: text('launcherArchive') ?? '' } }
  const version = text('launcherVersion')
  return { launcher: { kind: 'managed', ...version !== undefined && { version } } }
}

/**
 * Read one intercepted navigation as a request.
 * @param url - the whole intercepted URL, scheme included.
 * @returns the request, or `undefined` when this build serves no such action.
 */
export function parseBootAction(url: string): BootAction | undefined {
  if (!url.startsWith(ACTION_SCHEME)) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // A URL the surface could not have produced; there is nothing to run.
    return undefined
  }
  const named = parsed.searchParams.get('target') ?? undefined
  switch (parsed.pathname) {
    case 'retry':
    case 'open-log':
    case 'quit':
    case 'cancel-start':
    case 'manage-connections':
    case 'close-connections':
      return { kind: parsed.pathname }
    case 'connect':
      return { kind: 'connect', targetId: named }
    case 'remove-connection':
      return named === undefined ? undefined : { kind: 'remove-connection', targetId: named }
    case 'save-connection':
      return { kind: 'save-connection', draft: readDraft(parsed.searchParams.get('payload')) }
    case 'pick-payload':
      return { kind: 'pick-payload', draft: readDraft(parsed.searchParams.get('payload')) }
    default:
      // An action this build does not serve. The surface and the shell ship
      // together, so nothing else can produce one.
      return undefined
  }
}
