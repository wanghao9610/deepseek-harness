/**
 * The desktop application: it supervises one harness runtime, owns the windows
 * that show it, and translates the runtime's own event streams into the
 * native surface — Dock badge or taskbar flash, notifications, sleep prevention, and the
 * resource policy that decides when an idle runtime keeps its memory.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { app, BrowserWindow, dialog, Menu, Notification, powerSaveBlocker, shell, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir, totalmem } from 'node:os'
import { join } from 'node:path'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import { pickRemotePort, validateSshTarget, type SshTarget } from '@deepseek-ai/dsh-ssh-launch'
import type { BootAction } from './boot-action.ts'
import {
  applyHostFrame,
  applyMuxFrame,
  attentionCount,
  EMPTY_ATTENTION_STATE,
  EMPTY_RUN_STATE,
  type AttentionState,
  type RunState,
} from './activity.ts'
import { DesktopApiClient } from './api-client.ts'
import { startFrameStream } from './frame-stream.ts'
import {
  mergeLaunchEnvironment,
  needsLoginEnvironment,
  readLoginShellEnvironment,
} from './login-environment.ts'
import { buildApplicationMenu } from './menu.ts'
import { resolveRuntimeEntry } from './paths.ts'
import {
  decideResourceAction,
  defaultHeapLimitMb,
  defaultRecycleThreshold,
  IDLE_SUSPEND_MS,
  readProcessRss,
  SAMPLE_INTERVAL_MS,
} from './resource-governor.ts'
import { openRuntimeLog, type RuntimeLog } from './runtime-log.ts'
import {
  localRuntimeLaunch,
  remoteRuntimeLaunch,
  reserveLoopbackPort,
  type RuntimeLaunch,
} from './runtime-launch.ts'
import { ensurePayload, readArchivePayload } from './remote-payload.ts'
import { RuntimeSupervisor, type RuntimeState } from './runtime-supervisor.ts'
import { SettingsStore } from './store.ts'
import { THIS_MACHINE, WindowHost, type ConnectionKey } from './windows.ts'

/** Display name; it also names the user-data and log directories. */
const APP_NAME = 'DeepSeek Harness'

/** Runtime log filename under the application's log directory. */
const LOG_FILENAME = 'runtime.log'

/** Settings filename under the application's user-data directory. */
const SETTINGS_FILENAME = 'desktop-settings.json'

/** Boot surface, relative to the Electron app directory. */
const BOOT_PAGE = join('resources', 'boot.html')

/** Window focus settles after a blur/focus pair; the attention stream reacts once it has. */
const FOCUS_SETTLE_MS = 400

/** Fallback login shell when the launch environment names none. */
const FALLBACK_SHELL = '/bin/zsh'

/**
 * Ask for a server payload with the platform's own file chooser.
 * @returns the chosen path, or `undefined` when the person cancelled.
 */
async function chooseServerPayload(): Promise<string | undefined> {
  const options: OpenDialogOptions = {
    title: 'Choose a server payload',
    properties: ['openFile'],
    filters: [{ name: 'Server payload', extensions: ['gz', 'tgz'] }],
  }
  const chosen = await dialog.showOpenDialog(options)
  return chosen.filePaths[0]
}

/** Owns the application's whole lifetime. */
class DesktopApplication {
  private readonly settings = new SettingsStore(join(app.getPath('userData'), SETTINGS_FILENAME))
  private readonly log: RuntimeLog = openRuntimeLog({ directory: app.getPath('logs'), filename: LOG_FILENAME })
  private readonly windows: WindowHost
  // One runtime per connection, created on first use: two windows on different
  // hosts each keep serving, and what one of them does is not the other's
  // business.
  private readonly supervisors = new Map<ConnectionKey, RuntimeSupervisor>()
  private readonly runStates = new Map<ConnectionKey, RunState>()
  private readonly attentions = new Map<ConnectionKey, AttentionState>()
  private readonly hostStreams = new Map<ConnectionKey, () => void>()
  private readonly muxStreams = new Map<ConnectionKey, () => void>()
  private runtimeEntry = ''
  private maxOldSpaceMb = 0
  private powerBlockerId: number | undefined
  private sampleTimer: ReturnType<typeof setInterval> | undefined
  private focusTimer: ReturnType<typeof setTimeout> | undefined
  private lastActiveAt = Date.now()
  private launchEnvironment: Readonly<Record<string, string>> = {}
  private quitting = false

  constructor() {
    this.windows = new WindowHost({
      bootPage: join(app.getAppPath(), BOOT_PAGE),
      settings: this.settings,
      onAction: (action, window) => { this.handleBootAction(action, window) },
      onWindowCountChange: () => { this.onWindowCountChange() },
    })
  }

  /** Start the application: window first, then the runtime it will show. */
  async run(): Promise<void> {
    await app.whenReady()
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: 'DeepSeek Harness',
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenu({
      newWindow: () => { this.windows.open({ freshSession: true, connection: this.currentConnection() }) },
      restartRuntime: () => { void this.supervisors.get(this.currentConnection())?.restart() },
      manageConnections: () => { this.showConnections(this.windows.current()) },
      openLog: () => { shell.showItemInFolder(this.log.path) },
      openInBrowser: () => { this.openInBrowser() },
      setIdleSuspend: (enabled) => { this.settings.writeIdleSuspend(enabled) },
    }, this.settings.readIdleSuspend())))

    // The window opens before the runtime so the user sees the application
    // start, not a bounce followed by silence while the environment probe and
    // the harness boot run.
    const initial = this.settings.readActiveConnection() ?? THIS_MACHINE
    this.windows.applyRuntimeState(initial, { status: 'starting', attempt: 0 })
    this.windows.open({ connection: initial })

    this.registerAppEvents()
    await this.prepareEnvironment()
    this.supervisorFor(initial).start()
    this.sampleTimer = setInterval(() => { void this.sampleResources() }, SAMPLE_INTERVAL_MS)
  }

  /** Wire the application-level events macOS delivers. */
  private registerAppEvents(): void {
    app.on('activate', () => {
      const connection = this.currentConnection()
      this.windows.ensureOpen({ connection })
      this.supervisorFor(connection).start()
    })
    app.on('second-instance', () => {
      this.windows.present()
      app.focus({ steal: true })
    })
    app.on('window-all-closed', () => {
      // Closing the last window is not quitting on macOS; the Dock tile stays
      // and the runtime keeps serving until the resource policy stops it.
      if (process.platform !== 'darwin') app.quit()
    })
    app.on('browser-window-focus', () => { this.scheduleAttentionUpdate() })
    app.on('browser-window-blur', () => { this.scheduleAttentionUpdate() })
    app.on('before-quit', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.quitting = true
      void this.shutdown().finally(() => { app.exit(0) })
    })
  }

  /**
   * Recover the user's shell environment and resolve what a launch needs from
   * the installation, once, before any runtime starts.
   */
  private async prepareEnvironment(): Promise<void> {
    const inherited = process.env
    const probe = needsLoginEnvironment(inherited)
      ? await readLoginShellEnvironment({
        shell: inherited.SHELL ?? FALLBACK_SHELL,
        nodePath: process.execPath,
        env: inherited,
      })
      : undefined
    this.log.reset()
    this.log.write(`desktop: ${APP_NAME} ${app.getVersion()} starting\n`)
    this.log.write(probe === undefined
      ? 'desktop: using the inherited environment\n'
      : 'desktop: recovered the login shell environment\n')
    const entry = resolveRuntimeEntry({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    })
    this.runtimeEntry = entry
    this.maxOldSpaceMb = defaultHeapLimitMb()
    this.launchEnvironment = mergeLaunchEnvironment(inherited, probe)
  }

  /**
   * The supervisor for one connection, created the first time that connection
   * is used.
   * @param connection - the connection to serve from.
   * @returns its supervisor.
   */
  private supervisorFor(connection: ConnectionKey): RuntimeSupervisor {
    const existing = this.supervisors.get(connection)
    if (existing !== undefined) return existing
    const supervisor = new RuntimeSupervisor({
      prepareLaunch: (report, signal) => this.prepareLaunch(connection, report, signal),
      // A Finder launch has no meaningful working directory, and this one
      // becomes a local session's default project directory. A remote runtime
      // takes its own from the connection.
      cwd: homedir(),
      env: this.launchEnvironment,
      onOutput: (chunk) => { this.log.write(chunk) },
    })
    supervisor.subscribe((state) => { this.onRuntimeState(connection, state) })
    this.supervisors.set(connection, supervisor)
    return supervisor
  }

  /**
   * The connection the window a command acts on serves from.
   * @returns that connection, or the stored default when no window is open.
   */
  private currentConnection(): ConnectionKey {
    const window = this.windows.current()
    return window === undefined
      ? this.settings.readActiveConnection() ?? THIS_MACHINE
      : this.windows.connectionOf(window)
  }

  /**
   * Prepare the launch one connection calls for.
   * @param connection - the connection this runtime serves from.
   * @param report - receives what a slow preparation is doing.
   * @param signal - ends the preparation when the start is cancelled.
   * @returns the launch to spawn.
   */
  private async prepareLaunch(
    connection: ConnectionKey,
    report: (detail: string) => void,
    signal: AbortSignal,
  ): Promise<RuntimeLaunch> {
    if (connection === THIS_MACHINE) {
      return localRuntimeLaunch({
        entry: this.runtimeEntry,
        nodePath: process.execPath,
        maxOldSpaceMb: this.maxOldSpaceMb,
      })
    }
    const target = this.settings.readConnections().find(stored => stored.id === connection)
    if (target === undefined) {
      throw new Error('the chosen connection is no longer stored; pick a host under View › Connections')
    }
    const onOutput = (chunk: string): void => { this.log.write(chunk) }
    const payload = target.launcher?.kind === 'archive'
      ? await readArchivePayload(target.launcher.path, onOutput, signal)
      : undefined
    if (payload !== undefined && target.launcher?.kind === 'archive') {
      await ensurePayload(payload, {
        target,
        archive: target.launcher.path,
        env: this.launchEnvironment,
        report,
        onOutput,
        signal,
      })
    }
    return remoteRuntimeLaunch({
      target,
      ports: { local: await reserveLoopbackPort(), remote: pickRemotePort(Math.random) },
      ...payload !== undefined && { payload },
    })
  }

  /**
   * React to one runtime transition.
   * @param connection - the connection whose runtime changed.
   * @param state - that runtime's new condition.
   */
  private onRuntimeState(connection: ConnectionKey, state: RuntimeState): void {
    this.windows.applyRuntimeState(connection, state)
    if (state.status === 'ready') {
      this.openHostStream(connection, state.url)
      this.scheduleAttentionUpdate()
      return
    }
    // Every fold is about a runtime that is gone; a stale badge or a held
    // power blocker would outlive the work it described.
    this.closeStreams(connection)
    this.runStates.delete(connection)
    this.attentions.delete(connection)
    this.updateBadge()
    this.updatePowerBlocker()
  }

  /**
   * Follow one runtime's host stream, which reports session running state.
   * @param connection - the connection that runtime serves.
   * @param origin - the runtime origin.
   */
  private openHostStream(connection: ConnectionKey, origin: string): void {
    this.hostStreams.get(connection)?.()
    const client = new DesktopApiClient(origin)
    this.hostStreams.set(connection, startFrameStream<HostFrame>({
      open: signal => client.events.host({}, signal),
      onFrame: (request) => { this.onHostFrame(connection, request.payload) },
      onLog: (message) => { this.log.write(`${message}\n`) },
    }))
  }

  /**
   * Apply one host frame and update everything derived from running state.
   * @param connection - the connection that runtime serves.
   * @param frame - the frame the runtime pushed.
   */
  private onHostFrame(connection: ConnectionKey, frame: HostFrame): void {
    const current = this.runStates.get(connection) ?? EMPTY_RUN_STATE
    const next = applyHostFrame(current, frame)
    const finished = [...current.running].filter(id => !next.running.has(id))
    this.runStates.set(connection, next)
    this.markActive()
    this.updatePowerBlocker()
    if (this.windows.anyFocused) return
    if (finished.length > 0) {
      this.notify('Task finished', finished.length === 1
        ? 'A session finished its turn.'
        : `${String(finished.length)} sessions finished their turns.`)
    }
    if (frame.type === 'host/agent-error') this.notify('Agent error', frame.message)
  }

  /**
   * Open or close the mux subscription so it runs only while the user cannot
   * see the requests it exists to announce.
   */
  private updateAttentionSubscription(): void {
    const unwatched = !this.windows.anyFocused
    for (const [connection, supervisor] of this.supervisors) {
      const origin = supervisor.url
      const wanted = unwatched && origin !== undefined
      const open = this.muxStreams.get(connection)
      if (wanted && open === undefined) {
        const client = new DesktopApiClient(origin)
        this.muxStreams.set(connection, startFrameStream<MuxFrame>({
          open: signal => client.events.mux({}, signal),
          onFrame: (request) => { this.onMuxFrame(connection, request) },
          onLog: (message) => { this.log.write(`${message}\n`) },
        }))
        continue
      }
      if (!wanted && open !== undefined) {
        open()
        this.muxStreams.delete(connection)
        this.attentions.delete(connection)
      }
    }
    this.updateBadge()
  }

  /**
   * Apply one mux frame and announce a newly blocked agent.
   * @param connection - the connection that runtime serves.
   * @param request - the narrow server-request form carrying the frame.
   */
  private onMuxFrame(connection: ConnectionKey, request: Parameters<typeof applyMuxFrame>[1]): void {
    const current = this.attentions.get(connection) ?? EMPTY_ATTENTION_STATE
    const before = attentionCount(current)
    const next = applyMuxFrame(current, request)
    this.attentions.set(connection, next)
    const after = attentionCount(next)
    if (after === before) return
    this.updateBadge()
    if (after > before) {
      app.dock?.bounce('informational')
      this.notify('Waiting for you', request.payload.type === 'question/requested'
        ? 'The agent asked a question.'
        : 'The agent is waiting for approval.')
    }
  }

  /** Re-evaluate the mux subscription once window focus has settled. */
  private scheduleAttentionUpdate(): void {
    if (this.focusTimer !== undefined) clearTimeout(this.focusTimer)
    this.focusTimer = setTimeout(() => {
      this.focusTimer = undefined
      this.updateAttentionSubscription()
    }, FOCUS_SETTLE_MS)
  }

  /** Keep the Dock badge equal to the number of requests waiting on the user. */
  private updateBadge(): void {
    let pending = 0
    for (const attention of this.attentions.values()) pending += attentionCount(attention)
    app.dock?.setBadge(pending > 0 ? String(pending) : '')
  }

  /**
   * Hold a power-save blocker exactly while a session is running, so a long
   * turn is not suspended when the user walks away.
   */
  private updatePowerBlocker(): void {
    let running = 0
    for (const state of this.runStates.values()) running += state.running.size
    const wanted = running > 0
    if (wanted && this.powerBlockerId === undefined) {
      this.powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
      return
    }
    if (!wanted && this.powerBlockerId !== undefined) {
      powerSaveBlocker.stop(this.powerBlockerId)
      this.powerBlockerId = undefined
    }
  }

  /** Sample every runtime and apply the resource policy to each on its own. */
  private async sampleResources(): Promise<void> {
    if (this.quitting) return
    this.markActive()
    for (const [connection, supervisor] of this.supervisors) {
      await this.applyResourcePolicy(connection, supervisor)
    }
  }

  /**
   * Apply the resource policy to one runtime.
   *
   * A runtime whose last window moved to another host has no window of its own
   * and is idle by that measure, which is what stops it without a rule about
   * switching.
   * @param connection - the connection this runtime serves.
   * @param supervisor - its supervisor.
   */
  private async applyResourcePolicy(connection: ConnectionKey, supervisor: RuntimeSupervisor): Promise<void> {
    const pid = supervisor.pid
    // A remote runtime's child here is the ssh session, whose resident memory
    // says nothing about the harness; only the idle policy applies to it.
    const local = connection === THIS_MACHINE
    const decision = decideResourceAction({
      runningSessions: this.runStates.get(connection)?.running.size ?? 0,
      openWindows: this.windows.countOn(connection),
      idleForMs: Date.now() - this.lastActiveAt,
      runtimeRssBytes: pid === undefined || !local ? undefined : await readProcessRss(pid),
      totalMemoryBytes: totalmem(),
    }, {
      idleSuspendMs: this.settings.readIdleSuspend() ? IDLE_SUSPEND_MS : undefined,
      recycleRssBytes: defaultRecycleThreshold(totalmem()),
    })
    switch (decision.action) {
      case 'suspend':
        this.log.write('desktop: stopping the idle runtime to release its memory\n')
        await supervisor.stop()
        return
      case 'recycle':
        this.log.write(`desktop: recycling the idle runtime at ${String(Math.round(decision.rssBytes / (1024 * 1024)))} MiB resident\n`)
        await supervisor.restart()
        return
      case 'none':
        return
      default:
        decision satisfies never
    }
  }

  /** Record that the application is doing something the idle timer must not count. */
  private markActive(): void {
    if (this.windows.count > 0) {
      this.lastActiveAt = Date.now()
      return
    }
    for (const state of this.runStates.values()) {
      if (state.running.size > 0) this.lastActiveAt = Date.now()
    }
  }

  /** Re-evaluate what the current window count implies for idling and attention. */
  private onWindowCountChange(): void {
    this.markActive()
    this.scheduleAttentionUpdate()
  }

  /**
   * Run one boot-surface action for the window it came from.
   * @param action - the button the user pressed.
   * @param window - the window it was pressed in.
   */
  private handleBootAction(action: BootAction, window: BrowserWindow): void {
    const connection = this.windows.connectionOf(window)
    switch (action.kind) {
      case 'retry':
        this.supervisorFor(connection).start()
        return
      case 'open-log':
        shell.showItemInFolder(this.log.path)
        return
      case 'quit':
        app.quit()
        return
      case 'cancel-start':
        void this.supervisors.get(connection)?.stop()
        return
      case 'manage-connections':
        this.showConnections(window)
        return
      case 'close-connections':
        this.windows.manageConnections(window, false)
        return
      case 'connect':
        this.connectTo(window, action.targetId)
        return
      case 'save-connection':
        this.saveConnection(action.draft)
        return
      case 'remove-connection':
        this.removeConnection(action.targetId)
        return
      case 'pick-payload':
        void this.pickPayload(action.draft)
        return
      default:
        action satisfies never
    }
  }

  /**
   * Show the connection list over one window's surface.
   * @param window - the window that asked for it.
   * @param problems - messages from a rejected edit, keyed by field.
   * @param draft - the rejected edit, so its values stay on screen with them.
   */
  private showConnections(
    window: BrowserWindow | undefined,
    problems: Readonly<Record<string, string>> = {},
    draft?: Partial<SshTarget>,
  ): void {
    if (window === undefined) return
    this.windows.applyConnections({
      targets: this.settings.readConnections(),
      activeId: this.settings.readActiveConnection(),
      problems,
      ...draft !== undefined && { draft },
    })
    this.windows.manageConnections(window, true)
  }

  /**
   * Point one window at another host.
   *
   * Only that window moves. A runtime another window still uses keeps serving,
   * and one whose last window left is stopped by the idle policy rather than
   * torn down under whoever was watching it.
   * @param window - the window to move.
   * @param targetId - the connection to use, or `undefined` for this machine.
   */
  private connectTo(window: BrowserWindow, targetId: string | undefined): void {
    const connection = targetId ?? THIS_MACHINE
    // The default for windows opened later, not a change to the ones open now.
    this.settings.writeActiveConnection(targetId)
    this.log.write(`desktop: a window is now serving from ${targetId ?? 'this machine'}\n`)
    this.windows.manageConnections(window, false)
    this.windows.bind(window, connection)
    this.supervisorFor(connection).start()
  }


  /**
   * Store one edited connection, keeping the list up with its problems when the
   * edit cannot be stored.
   * @param draft - the fields the person entered.
   */
  private saveConnection(draft: Partial<SshTarget>): void {
    const candidate: Partial<SshTarget> = { ...draft, id: draft.id ?? randomUUID() }
    const problems = validateSshTarget(candidate)
    if (problems.length > 0) {
      this.showConnections(
        this.windows.current(),
        Object.fromEntries(problems.map(problem => [problem.field, problem.message])),
        candidate,
      )
      return
    }
    const target = candidate as SshTarget
    const stored = this.settings.readConnections()
    this.settings.writeConnections(stored.some(entry => entry.id === target.id)
      ? stored.map(entry => entry.id === target.id ? target : entry)
      : [...stored, target])
    this.showConnections(this.windows.current())
  }

  /**
   * Choose a server payload for the connection being edited.
   *
   * The draft comes back with the chosen path and nothing else changed, so the
   * dialog costs the person nothing they had already typed.
   * @param draft - the fields the form currently holds.
   */
  private async pickPayload(draft: Partial<SshTarget>): Promise<void> {
    const path = await chooseServerPayload()
    this.showConnections(this.windows.current(), {}, path === undefined ? draft : { ...draft, launcher: { kind: 'archive', path } })
  }

  /**
   * Forget one connection. A running runtime keeps serving; the choice it was
   * started from is what changes.
   * @param targetId - the connection to remove.
   */
  private removeConnection(targetId: string): void {
    this.settings.writeConnections(this.settings.readConnections().filter(entry => entry.id !== targetId))
    if (this.settings.readActiveConnection() === targetId) this.settings.writeActiveConnection(undefined)
    this.showConnections(this.windows.current())
  }

  /** Open the running UI in the user's default browser. */
  private openInBrowser(): void {
    const url = this.supervisors.get(this.currentConnection())?.url
    if (url !== undefined) void shell.openExternal(url)
  }

  /**
   * Show one notification.
   * @param title - the notification title.
   * @param body - the notification body.
   */
  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      this.windows.present()
      app.focus({ steal: true })
    })
    notification.show()
  }

  /** Close both event streams. */
  private closeStreams(connection: ConnectionKey): void {
    this.hostStreams.get(connection)?.()
    this.hostStreams.delete(connection)
    this.muxStreams.get(connection)?.()
    this.muxStreams.delete(connection)
  }

  /** Release every held resource and stop every runtime before the process exits. */
  private async shutdown(): Promise<void> {
    if (this.sampleTimer !== undefined) clearInterval(this.sampleTimer)
    if (this.focusTimer !== undefined) clearTimeout(this.focusTimer)
    for (const connection of this.supervisors.keys()) this.closeStreams(connection)
    if (this.powerBlockerId !== undefined) powerSaveBlocker.stop(this.powerBlockerId)
    this.windows.flushGeometry()
    this.log.write('desktop: stopping every runtime\n')
    await Promise.all([...this.supervisors.values()].map(supervisor => supervisor.stop()))
  }
}

app.setName(APP_NAME)

// A second launch raises the running application instead of starting a second
// runtime against the same harness home.
if (app.requestSingleInstanceLock()) void new DesktopApplication().run()
else app.quit()
