/**
 * The application menu: the chord each shell operation answers to, that no
 * chord is claimed twice on either platform, and that every item runs the
 * action its label names.
 */

import type { MenuItem, MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildApplicationMenu, SHELL_ACCELERATORS, type MenuActions } from '../src/menu.ts'

/** The platforms the application ships on, and the ones the template branches over. */
const PLATFORMS = ['darwin', 'win32'] as const

/**
 * Canonical spelling of one accelerator, so `CmdOrCtrl+Shift+R` and
 * `Shift+CmdOrCtrl+R` compare equal.
 * @param accelerator - the accelerator as Electron spells it.
 * @param platform - the host OS, which decides what `CmdOrCtrl` resolves to.
 * @returns the chord's modifiers and key, lower-cased and ordered.
 */
function chord(accelerator: string, platform: NodeJS.Platform): string {
  const aliases: Record<string, string> = {
    cmdorctrl: platform === 'darwin' ? 'cmd' : 'ctrl',
    commandorcontrol: platform === 'darwin' ? 'cmd' : 'ctrl',
    command: 'cmd',
    control: 'ctrl',
    option: 'alt',
  }
  return accelerator.toLowerCase().split('+').map(part => aliases[part] ?? part).sort().join('+')
}

/**
 * The chords this menu's roles already hold, from Electron's role defaults.
 * A role carries no `accelerator` in the template, so the chords this shell
 * picks can only be checked against them by name — and the collision this
 * guards against is silent: Electron gives a repeated chord to whichever item
 * the template lists first, leaving the other one keyless.
 *
 * `quit` is deliberately absent: this template sets that role's accelerator
 * itself, and an item cannot collide with itself.
 */
const ROLE_CHORDS: Record<(typeof PLATFORMS)[number], readonly string[]> = {
  darwin: [
    'Cmd+H', 'Cmd+Alt+H', // hide, hideOthers
    'Cmd+W', 'Cmd+M', // close, minimize
    'Cmd+Z', 'Cmd+Shift+Z', 'Cmd+X', 'Cmd+C', 'Cmd+V', 'Cmd+Alt+Shift+V', 'Cmd+A',
    'Cmd+R', 'Cmd+Shift+R', 'Cmd+Alt+I', // reload, forceReload, toggleDevTools
    'Cmd+0', 'Cmd+Plus', 'Cmd+-',
    'Ctrl+Cmd+F', // togglefullscreen
  ],
  win32: [
    'Ctrl+W', 'Ctrl+M',
    'Ctrl+Z', 'Ctrl+Y', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Ctrl+Shift+V', 'Ctrl+A', 'Delete',
    'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+Shift+I',
    'Ctrl+0', 'Ctrl+Plus', 'Ctrl+-',
    'F11',
  ],
}

/**
 * Every item of a template, submenus included.
 * @param items - the template to walk.
 * @returns one flat list, parents before their children.
 */
function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap(item => [
    item,
    ...Array.isArray(item.submenu) ? flatten(item.submenu) : [],
  ])
}

/**
 * Find one item by the label it shows.
 * @param items - the template to search.
 * @param label - the item's label.
 * @returns the item.
 */
function item(items: readonly MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = flatten(items).find(candidate => candidate.label === label)
  if (found === undefined) throw new Error(`no menu item labelled ${label}`)
  return found
}

/**
 * Invoke one item the way Electron does when its chord is pressed.
 * @param target - the item to run.
 * @param checked - the checkbox state Electron reports after the toggle.
 */
function press(target: MenuItemConstructorOptions, checked = false): void {
  const click = target.click
  if (click === undefined) throw new Error(`${String(target.label)} runs no action`)
  click({ checked } as unknown as MenuItem, undefined, {})
}

/**
 * Actions that record what the menu asked for.
 * @returns the actions and the list they append to.
 */
function recording(): { actions: MenuActions; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    actions: {
      newWindow: () => calls.push('newWindow'),
      restartRuntime: () => calls.push('restartRuntime'),
      manageConnections: () => calls.push('manageConnections'),
      openLog: () => calls.push('openLog'),
      openInBrowser: () => calls.push('openInBrowser'),
      setIdleSuspend: enabled => calls.push(`setIdleSuspend:${String(enabled)}`),
    },
  }
}

describe('the application menu', () => {
  it.each(PLATFORMS)('claims no chord twice on %s', (platform) => {
    const template = buildApplicationMenu(recording().actions, true, platform)
    const claimed = flatten(template)
      .map(entry => entry.accelerator)
      .filter(accelerator => accelerator !== undefined)
      .map(accelerator => chord(accelerator, platform))
    const roles = ROLE_CHORDS[platform].map(accelerator => chord(accelerator, platform))
    expect(new Set(claimed).size).toBe(claimed.length)
    expect(claimed.filter(entry => roles.includes(entry))).toEqual([])
  })

  it.each(PLATFORMS)('leaves the harness UI its own chords on %s', (platform) => {
    // The Web surface binds these itself (`useShortcut` in the client's
    // sidebar, workspace, and settings shells). A menu accelerator would take
    // the key before the page saw it, and the shell has no route to those
    // operations.
    const client = ['CmdOrCtrl+,', 'CmdOrCtrl+K', 'CmdOrCtrl+O', 'CmdOrCtrl+B', 'CmdOrCtrl+Shift+F']
      .map(accelerator => chord(accelerator, platform))
    const claimed = flatten(buildApplicationMenu(recording().actions, true, platform))
      .map(entry => entry.accelerator)
      .filter(accelerator => accelerator !== undefined)
      .map(accelerator => chord(accelerator, platform))
    expect(claimed.filter(entry => client.includes(entry))).toEqual([])
  })

  it.each(PLATFORMS)('gives every shell operation the same chord on %s', (platform) => {
    const template = buildApplicationMenu(recording().actions, true, platform)
    expect(item(template, 'New Window').accelerator).toBe(SHELL_ACCELERATORS.newWindow)
    expect(item(template, 'Restart Harness Runtime').accelerator).toBe(SHELL_ACCELERATORS.restartRuntime)
    expect(item(template, 'Connections…').accelerator).toBe(SHELL_ACCELERATORS.manageConnections)
    expect(item(template, 'Open in Browser').accelerator).toBe(SHELL_ACCELERATORS.openInBrowser)
    expect(item(template, 'Reveal Runtime Log').accelerator).toBe(SHELL_ACCELERATORS.openLog)
    expect(item(template, 'Release Memory When Idle').accelerator).toBe(SHELL_ACCELERATORS.idleSuspend)
    expect(flatten(template).find(entry => entry.role === 'quit')?.accelerator).toBe(SHELL_ACCELERATORS.quit)
  })

  it('puts the idle setting and Quit on the macOS app menu, and Close Window on File', () => {
    const template = buildApplicationMenu(recording().actions, false, 'darwin')
    expect(template.map(entry => entry.role ?? entry.label))
      .toEqual(['appMenu', 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help'])
    const appMenu = template[0]?.submenu
    const fileMenu = template[1]?.submenu
    expect(Array.isArray(appMenu) ? flatten(appMenu).map(entry => entry.role ?? entry.label) : [])
      .toContain('Release Memory When Idle')
    expect(Array.isArray(fileMenu) ? flatten(fileMenu).map(entry => entry.role ?? entry.label) : [])
      .toEqual(['New Window', undefined, 'close'])
  })

  it('puts New Window, the idle setting, and Exit on the Windows File menu', () => {
    const template = buildApplicationMenu(recording().actions, false, 'win32')
    expect(template.map(entry => entry.role ?? entry.label))
      .toEqual(['File', 'editMenu', 'viewMenu', 'windowMenu', 'help'])
    const fileMenu = template[0]?.submenu
    expect(Array.isArray(fileMenu) ? flatten(fileMenu).map(entry => entry.role ?? entry.label) : [])
      .toEqual(['New Window', undefined, 'Release Memory When Idle', undefined, 'quit'])
  })

  it.each(PLATFORMS)('offers the same clipboard and view operations on %s', (platform) => {
    const template = buildApplicationMenu(recording().actions, false, platform)
    const roles = flatten(template).map(entry => entry.role)
    expect(roles).toEqual(expect.arrayContaining([
      'undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll',
      'reload', 'forceReload', 'toggleDevTools',
      'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'windowMenu',
    ]))
    // The Speech submenu is what the editMenu role carries on macOS alone.
    expect(roles.includes('startSpeaking')).toBe(platform === 'darwin')
  })

  it('shows the stored idle setting as the checkbox state', () => {
    expect(item(buildApplicationMenu(recording().actions, true, 'darwin'), 'Release Memory When Idle').checked).toBe(true)
    expect(item(buildApplicationMenu(recording().actions, false, 'darwin'), 'Release Memory When Idle').checked).toBe(false)
  })

  it.each(PLATFORMS)('runs the action each item names on %s', (platform) => {
    const { actions, calls } = recording()
    const template = buildApplicationMenu(actions, true, platform)
    press(item(template, 'New Window'))
    press(item(template, 'Restart Harness Runtime'))
    press(item(template, 'Connections…'))
    press(item(template, 'Open in Browser'))
    press(item(template, 'Reveal Runtime Log'))
    press(item(template, 'Release Memory When Idle'), false)
    expect(calls).toEqual([
      'newWindow',
      'restartRuntime',
      'manageConnections',
      'openInBrowser',
      'openLog',
      'setIdleSuspend:false',
    ])
  })
})
