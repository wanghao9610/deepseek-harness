/**
 * Application shortcut hook: one document-level chord bound to one action.
 *
 * The chord's modifier is the one its platform uses for application shortcuts
 * — Command on Apple platforms, Control everywhere else. The two are not
 * interchangeable: macOS gives Control+letter to text editing inside every
 * field, and Windows gives Meta+letter to the desktop, so a map that accepted
 * either would fire on a keystroke the user aimed somewhere else. A chord acts
 * wherever focus is, the composer included, because a modifier means the
 * keystroke was never text the user meant to type.
 */
import { useEffect, useRef } from 'react'

/**
 * One chord beside the platform modifier. A bare key is spelled as the string
 * itself; the object form is what adds Shift.
 *
 * Shift is part of the chord's identity in both directions: a chord that wants
 * it is not answered without it, and a chord that does not is not answered
 * while it is held — those are two different chords, and one must not fire for
 * the other. Shift is what reaches the keys a browser's own menu bar has not
 * already claimed, which on macOS is the difference between a chord the page
 * receives and one it never sees.
 */
export interface Chord {
  /** The chord's key beside its modifiers, spelled as `KeyboardEvent.key`; letters match in either case. */
  key: string
  /** Whether Shift is held with the platform modifier. */
  shift?: boolean
}

/** The chord's key and Shift, however the caller spelled it. */
function chordOf(chord: string | Chord): { key: string; shift: boolean } {
  return typeof chord === 'string'
    ? { key: chord, shift: false }
    : { key: chord.key, shift: chord.shift === true }
}

/** Whether this platform spells the shortcut modifier as Command. */
function commandPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent)
}

/**
 * The chord's own name, for a control that wants to announce it.
 * @param chord - the chord, as {@link useShortcut} takes it.
 * @returns the chord as its platform writes it: `⌘K` / `⇧⌘F` on Apple platforms, `Ctrl+K` / `Ctrl+Shift+K` elsewhere.
 */
export function shortcutLabel(chord: string | Chord): string {
  const { key, shift } = chordOf(chord)
  return commandPlatform()
    ? `${shift ? '⇧' : ''}⌘${key.toUpperCase()}`
    : `Ctrl+${shift ? 'Shift+' : ''}${key.toUpperCase()}`
}

/**
 * Run one action while the user presses its chord.
 * @param chord - the chord: a bare key string, or `{ key, shift }` for a chord carrying Shift.
 * @param run - what the chord does; a press runs the most recent one passed.
 */
export function useShortcut(chord: string | Chord, run: () => void): void {
  const { key, shift } = chordOf(chord)
  const latest = useRef(run)
  useEffect(() => { latest.current = run })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A held key repeats; a shortcut acts once per press. Another modifier
      // makes it a different chord, which this one must not answer.
      if (event.repeat || event.altKey || event.shiftKey !== shift) return
      const command = commandPlatform()
      if (!(command ? event.metaKey : event.ctrlKey)) return
      if (command ? event.ctrlKey : event.metaKey) return
      if (event.key.toLowerCase() !== key.toLowerCase()) return
      event.preventDefault()
      latest.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [key, shift])
}
