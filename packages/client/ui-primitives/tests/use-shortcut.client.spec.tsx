// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { Chord } from '../src/useShortcut.ts'
import { shortcutLabel, useShortcut } from '../src/useShortcut.ts'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(navigator, 'userAgent')
})

/** A user agent with no Apple platform in it, which is what jsdom reports by default. */
const WINDOWS_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'

/** A macOS user agent, where the shortcut modifier is Command. */
const MAC_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36'

/**
 * Report one user agent to the hook.
 * @param agent - the user agent string.
 */
function onPlatform(agent: string): void {
  Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true })
}

/**
 * Mount a component that binds one chord.
 * @param chord - the chord, as the hook takes it.
 * @returns the action the chord runs, and the mounted tree.
 */
function mount(chord: string | Chord) {
  const run = vi.fn()
  function Probe() {
    useShortcut(chord, run)
    return null
  }
  return { run, ...render(<Probe />) }
}

describe('shortcutLabel', () => {
  it('writes the chord the way its platform does', () => {
    onPlatform(MAC_AGENT)
    expect(shortcutLabel('k')).toBe('⌘K')
    expect(shortcutLabel(',')).toBe('⌘,')
    onPlatform(WINDOWS_AGENT)
    expect(shortcutLabel('k')).toBe('Ctrl+K')
    expect(shortcutLabel(',')).toBe('Ctrl+,')
  })

  it('writes Shift where the chord carries it', () => {
    onPlatform(MAC_AGENT)
    expect(shortcutLabel({ key: 'f', shift: true })).toBe('⇧⌘F')
    expect(shortcutLabel({ key: 'f' })).toBe('⌘F')
    onPlatform(WINDOWS_AGENT)
    expect(shortcutLabel({ key: 'f', shift: true })).toBe('Ctrl+Shift+F')
    expect(shortcutLabel({ key: 'f' })).toBe('Ctrl+F')
  })
})

describe('useShortcut', () => {
  it('answers Command on Apple platforms and Control everywhere else', () => {
    onPlatform(MAC_AGENT)
    const mac = mount('k')
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(mac.run).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(mac.run).toHaveBeenCalledTimes(1)
    cleanup()

    onPlatform(WINDOWS_AGENT)
    const windows = mount('k')
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(windows.run).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    expect(windows.run).toHaveBeenCalledTimes(1)
  })

  it('refuses the chord when the other platform modifier rides along', () => {
    onPlatform(MAC_AGENT)
    const mac = mount('k')
    fireEvent.keyDown(document, { key: 'k', metaKey: true, ctrlKey: true })
    expect(mac.run).not.toHaveBeenCalled()
    cleanup()

    onPlatform(WINDOWS_AGENT)
    const windows = mount('k')
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, metaKey: true })
    expect(windows.run).not.toHaveBeenCalled()
  })

  it('refuses a chord another modifier makes into a different one, and a held repeat', () => {
    onPlatform(WINDOWS_AGENT)
    const { run } = mount('k')
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, altKey: true })
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, repeat: true })
    fireEvent.keyDown(document, { key: 'k' })
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true })
    expect(run).not.toHaveBeenCalled()
  })

  it('holds Shift as part of the chord, in both directions', () => {
    onPlatform(MAC_AGENT)
    // The press macOS reports for the chord: Shift uppercases the key.
    const shifted = mount({ key: 'f', shift: true })
    fireEvent.keyDown(document, { key: 'F', metaKey: true, shiftKey: true })
    expect(shifted.run).toHaveBeenCalledTimes(1)
    // Without Shift it is a different chord — the browser's find-in-page here.
    fireEvent.keyDown(document, { key: 'f', metaKey: true })
    expect(shifted.run).toHaveBeenCalledTimes(1)
    cleanup()

    // And the bare chord stays off the shifted press (pinned for 'k' above).
    const bare = mount({ key: 'f' })
    fireEvent.keyDown(document, { key: 'F', metaKey: true, shiftKey: true })
    expect(bare.run).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'f', metaKey: true })
    expect(bare.run).toHaveBeenCalledTimes(1)
  })

  it('matches a letter in either case, and a punctuation key as itself', () => {
    onPlatform(WINDOWS_AGENT)
    const letter = mount('k')
    fireEvent.keyDown(document, { key: 'K', ctrlKey: true })
    expect(letter.run).toHaveBeenCalledTimes(1)
    cleanup()

    const comma = mount(',')
    fireEvent.keyDown(document, { key: ',', ctrlKey: true })
    expect(comma.run).toHaveBeenCalledTimes(1)
  })

  it('takes the key from the page so the browser does not also act on it', () => {
    onPlatform(WINDOWS_AGENT)
    mount('k')
    const press = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true, bubbles: true })
    document.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
  })

  it('runs the action the latest render passed, and stops listening once unmounted', () => {
    onPlatform(WINDOWS_AGENT)
    const first = vi.fn()
    const second = vi.fn()
    function Probe({ run }: { run: () => void }) {
      useShortcut('k', run)
      return null
    }
    const view = render(<Probe run={first} />)
    view.rerender(<Probe run={second} />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    view.unmount()
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    expect(second).toHaveBeenCalledTimes(1)
  })
})
