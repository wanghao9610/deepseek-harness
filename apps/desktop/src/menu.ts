/**
 * The application menu, and the keyboard map it carries.
 *
 * Beyond the standard roles — which are also what give the window working
 * clipboard, undo, zoom, reload, and full-screen shortcuts — the menu exposes
 * the shell-owned operations: choosing which host serves the runtime, replacing
 * that runtime, reading its log, and choosing whether an idle runtime keeps its
 * memory. Each of those carries an accelerator, because the menu is the only
 * place this shell can bind a key that reaches it: the harness window is
 * ordinary web content the shell does not extend, and it owns every key the
 * menu does not claim.
 * @module @deepseek-ai/dsh-desktop/menu
 */

import type { MenuItemConstructorOptions } from 'electron'

/** Operations the menu invokes on the application. */
export interface MenuActions {
  /** Open one more window on the running runtime, showing a session of its own. */
  newWindow: () => void
  /** Stop and start the runtime process. */
  restartRuntime: () => void
  /** Show the list of hosts the runtime can serve from. */
  manageConnections: () => void
  /** Reveal the runtime log file. */
  openLog: () => void
  /** Open the running UI in the user's browser. */
  openInBrowser: () => void
  /**
   * Turn idle memory release on or off.
   * @param enabled - the new setting.
   */
  setIdleSuspend: (enabled: boolean) => void
}

/**
 * The chord each shell-owned menu item answers to. Every other item is a role,
 * which carries the host platform's own spelling of a standard operation.
 *
 * `CmdOrCtrl` is Command on macOS and Control on Windows and Linux, so one
 * entry states both platforms. The tiers are what keep the map memorable and
 * collision-free: the bare modifier is the standard window operations, `Shift`
 * reaches a shell surface or destination, and `Alt` reaches the runtime process
 * — the tier Electron itself puts the macOS developer tools on.
 */
export const SHELL_ACCELERATORS = {
  /** Open one more window on the running runtime, showing a session of its own. */
  newWindow: 'CmdOrCtrl+N',
  /** Leave the application; on Windows the `quit` role carries no chord of its own. */
  quit: 'CmdOrCtrl+Q',
  /** Stop and start the runtime process — one step past the `forceReload` role. */
  restartRuntime: 'CmdOrCtrl+Alt+R',
  /** Turn idle memory release on or off. */
  idleSuspend: 'CmdOrCtrl+Alt+M',
  /** Show the list of hosts the runtime can serve from. */
  manageConnections: 'CmdOrCtrl+Shift+H',
  /** Open the running UI in the user's browser. */
  openInBrowser: 'CmdOrCtrl+Shift+O',
  /** Reveal the runtime log file. */
  openLog: 'CmdOrCtrl+Shift+L',
} as const

/**
 * Build the application menu template.
 *
 * macOS keeps the standard app menu (About, Hide, Quit) and puts the idle
 * setting there. Windows and Linux put New Window, the idle setting, and Exit
 * on a File menu, because those platforms have no app menu. Both keep the
 * window operations on the `windowMenu` role, which is where each platform's
 * Minimize, Zoom, and Close already are.
 * @param actions - the operations menu items invoke.
 * @param idleSuspend - current state of the idle memory-release setting.
 * @param platform - the host OS; defaults to this process.
 * @returns the template to install with `Menu.buildFromTemplate`.
 */
export function buildApplicationMenu(
  actions: MenuActions,
  idleSuspend: boolean,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin'
  const newWindowItem: MenuItemConstructorOptions = {
    label: 'New Window',
    accelerator: SHELL_ACCELERATORS.newWindow,
    click: () => { actions.newWindow() },
  }
  const idleItem: MenuItemConstructorOptions = {
    label: 'Release Memory When Idle',
    accelerator: SHELL_ACCELERATORS.idleSuspend,
    type: 'checkbox',
    checked: idleSuspend,
    click: (item) => { actions.setIdleSuspend(item.checked) },
  }
  const quitItem: MenuItemConstructorOptions = { role: 'quit', accelerator: SHELL_ACCELERATORS.quit }
  // What the `editMenu` role carries on macOS alone; the system adds its own
  // dictation and emoji items to any menu named Edit.
  const speechItems: MenuItemConstructorOptions[] = mac
    ? [
      { type: 'separator' },
      { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] },
    ]
    : []
  const editMenu: MenuItemConstructorOptions = {
    role: 'editMenu',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      // The composer takes styled text from a browser or an editor, and every
      // platform has a chord for dropping that styling on the way in.
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      ...speechItems,
    ],
  }
  const viewMenu: MenuItemConstructorOptions = {
    role: 'viewMenu',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      {
        label: 'Restart Harness Runtime',
        accelerator: SHELL_ACCELERATORS.restartRuntime,
        click: () => { actions.restartRuntime() },
      },
      {
        label: 'Connections…',
        accelerator: SHELL_ACCELERATORS.manageConnections,
        click: () => { actions.manageConnections() },
      },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  }
  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'Open in Browser',
        accelerator: SHELL_ACCELERATORS.openInBrowser,
        click: () => { actions.openInBrowser() },
      },
      {
        label: 'Reveal Runtime Log',
        accelerator: SHELL_ACCELERATORS.openLog,
        click: () => { actions.openLog() },
      },
    ],
  }
  return mac
    ? [
      {
        role: 'appMenu',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          idleItem,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          quitItem,
        ],
      },
      {
        role: 'fileMenu',
        submenu: [
          newWindowItem,
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      editMenu,
      viewMenu,
      { role: 'windowMenu' },
      helpMenu,
    ]
    : [
      {
        label: 'File',
        submenu: [
          newWindowItem,
          { type: 'separator' },
          idleItem,
          { type: 'separator' },
          quitItem,
        ],
      },
      editMenu,
      viewMenu,
      { role: 'windowMenu' },
      helpMenu,
    ]
}
