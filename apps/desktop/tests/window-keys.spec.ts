/**
 * The keys a window answers itself: the Windows and Linux function row, and
 * nothing on macOS.
 */

import { describe, expect, it } from 'vitest'
import { resolveWindowKey, type KeyChord } from '../src/window-keys.ts'

/**
 * One key press.
 * @param key - the pressed key, spelled as `KeyboardEvent.key`.
 * @param held - the modifiers held with it.
 * @returns the press, as Electron reports it.
 */
function press(key: string, held: Partial<KeyChord> = {}): KeyChord {
  return { type: 'keyDown', key, control: false, alt: false, shift: false, meta: false, ...held }
}

describe('the window key map', () => {
  it('answers the function row Windows and Linux users expect', () => {
    expect(resolveWindowKey(press('F5'), 'win32')).toBe('reload')
    expect(resolveWindowKey(press('F5', { control: true }), 'win32')).toBe('force-reload')
    expect(resolveWindowKey(press('F5', { shift: true }), 'win32')).toBe('force-reload')
    expect(resolveWindowKey(press('F12'), 'win32')).toBe('toggle-dev-tools')
    expect(resolveWindowKey(press('F5'), 'linux')).toBe('reload')
  })

  it('leaves the function row to the system on macOS', () => {
    expect(resolveWindowKey(press('F5'), 'darwin')).toBeUndefined()
    expect(resolveWindowKey(press('F12'), 'darwin')).toBeUndefined()
  })

  it('answers the press, not the release', () => {
    expect(resolveWindowKey({ ...press('F5'), type: 'keyUp' }, 'win32')).toBeUndefined()
  })

  it('ignores a key the map does not claim, and one held with a modifier it does not name', () => {
    expect(resolveWindowKey(press('r', { control: true }), 'win32')).toBeUndefined()
    expect(resolveWindowKey(press('F11'), 'win32')).toBeUndefined()
    expect(resolveWindowKey(press('F5', { meta: true }), 'win32')).toBeUndefined()
    expect(resolveWindowKey(press('F5', { alt: true }), 'win32')).toBeUndefined()
    expect(resolveWindowKey(press('F12', { control: true }), 'win32')).toBeUndefined()
  })
})
