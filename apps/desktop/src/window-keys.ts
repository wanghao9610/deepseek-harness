/**
 * The keys a window answers itself, beside the ones the menu carries.
 *
 * A menu item holds exactly one accelerator, and on Windows and Linux the
 * function-key row is a second spelling of operations whose first spelling is
 * already on the View menu. macOS has no such second spelling — the function
 * row belongs to the system there — so this map is empty on it.
 * @module @deepseek-ai/dsh-desktop/window-keys
 */

/** The fields of Electron's `Input` this map reads. */
export interface KeyChord {
  /** `keyDown` for a press; every other value is ignored. */
  type: string
  /** The pressed key, spelled as `KeyboardEvent.key`. */
  key: string
  /** Whether Control is held. */
  control: boolean
  /** Whether Alt (Option) is held. */
  alt: boolean
  /** Whether Shift is held. */
  shift: boolean
  /** Whether Command (or the Windows key) is held. */
  meta: boolean
}

/** What a window does with a key no menu item carries. */
export type WindowKeyAction = 'reload' | 'force-reload' | 'toggle-dev-tools'

/**
 * Resolve one key press against the window-level map.
 *
 * The keys here are deliberately outside the printable range: the window shows
 * a composer the user types into, and a map that claimed a letter would take it
 * from the harness UI, which this shell cannot see into.
 * @param chord - the key press, as Electron reports it.
 * @param platform - the host OS; defaults to this process.
 * @returns the operation to run, or `undefined` when the press is not one of these keys.
 */
export function resolveWindowKey(
  chord: KeyChord,
  platform: NodeJS.Platform = process.platform,
): WindowKeyAction | undefined {
  if (platform === 'darwin' || chord.type !== 'keyDown' || chord.meta || chord.alt) return undefined
  // Ctrl+F5 and Shift+F5 are both the browser's "reload past the cache".
  if (chord.key === 'F5') return chord.control || chord.shift ? 'force-reload' : 'reload'
  if (chord.key === 'F12' && !chord.control && !chord.shift) return 'toggle-dev-tools'
  return undefined
}
