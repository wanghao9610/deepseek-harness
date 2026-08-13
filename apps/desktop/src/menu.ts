/**
 * The application menu.
 *
 * Beyond the standard macOS roles — which are also what give the window
 * working clipboard, zoom, and full-screen shortcuts — the menu exposes the
 * three shell-owned operations: replacing the runtime, reading its log, and
 * choosing whether an idle runtime keeps its memory.
 * @module @deepseek-ai/dsh-desktop/menu
 */

import { Menu, type MenuItemConstructorOptions } from 'electron'

/** Operations the menu invokes on the application. */
export interface MenuActions {
  /** Open one more window on the running runtime. */
  newWindow: () => void
  /** Stop and start the runtime process. */
  restartRuntime: () => void
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
 * Build and install the application menu.
 * @param actions - the operations menu items invoke.
 * @param idleSuspend - current state of the idle memory-release setting.
 */
export function installApplicationMenu(actions: MenuActions, idleSuspend: boolean): void {
  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Release Memory When Idle',
          type: 'checkbox',
          checked: idleSuspend,
          click: (item) => { actions.setIdleSuspend(item.checked) },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      role: 'fileMenu',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => { actions.newWindow() } },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      role: 'viewMenu',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        {
          label: 'Restart Harness Runtime',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => { actions.restartRuntime() },
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open in Browser', click: () => { actions.openInBrowser() } },
        { label: 'Reveal Runtime Log', click: () => { actions.openLog() } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
