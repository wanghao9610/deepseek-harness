# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The macOS and Windows desktop application: an Electron shell that supervises one embedded `dsh --profile web` runtime and shows it in a native window. It ships as an unsigned `.dmg` (macOS) or NSIS `.exe` (Windows) built by [`scripts/package-desktop-app.ts`](../../scripts/package-desktop-app.ts), and it is self-contained — the Electron runtime, the harness closure, and the built frontend all live inside the bundle, so the installed application needs no checkout, no Node installation, and no package manager. The decision record is the [desktop application Agent Note](../../.agents/notes/implemented/architecture/2026-08-13-electron-desktop-application.md).

The shell adds no harness capability. It reuses the shipped Web surface verbatim over the runtime's loopback server, and owns only what a browser tab cannot: process supervision, the user's shell environment, native window and menu behavior, attention signals, a memory policy, and the choice of which host the runtime runs on.

## Remote hosts

The runtime serves either from this machine or from a host reached over SSH, and which one is a property of the launch the supervisor is handed rather than of the supervision. A remote runtime is a complete harness on the far side: files, commands, terminals, and language servers are that host's, while this application keeps the window, the connection list, and nothing else.

[`@deepseek-ai/dsh-ssh-launch`](../../packages/boot/ssh-launch/README.md) owns what a connection may contain, the `ssh` command line, and what a failure means; [`src/runtime-launch.ts`](src/runtime-launch.ts) turns either choice into one prepared launch. One `ssh` session both starts the remote runtime and forwards its loopback port back, so the window loads an ordinary loopback origin and the API client, the boot surface, and the attention streams are unchanged.

**A connection belongs to a window, not to the application.** Each window serves from one connection and shows what that connection's runtime is doing; pointing one window at another host leaves every other window where it was, still served by its own runtime. There is one runtime per connection in use, created when a window first asks for it, and the idle rule is what stops one whose last window left.

Connections are edited on the boot surface, reached from **View › Connections** or from a failed start, and stored beside the shell's other preferences. The stored choice is the default for windows opened later, not a change to the ones already open.

Every waiting surface carries its own actions — Stop, Connections…, Reveal Log, Quit — and Escape presses Stop. A first connection installs a launcher on the host, which takes minutes, so a window with no way out of that would leave force-quitting as the only exit. Stopping also reaches the work that runs before any process exists: the payload transfer and the archive read are cancelled with it.

A host does not have to have `dsh` on it. By default the shell installs one on first connection — from npm, into `~/.dsh-remote/<version>` on that host, in the same `ssh` session that starts the runtime — and a connection can instead name a launcher the host already provides. The install takes minutes, so the remote script announces its steps and the boot surface shows them; afterwards a present launcher is the whole check, so later connections need no network and nothing upgrades on its own. Changing the version a connection asks for is what moves that host.

Two consequences of the forward are worth knowing. The runtime sees the connection as an SSH launch, so its directory picker serves the in-app browser instead of trying to open a chooser on an unattended machine. And requests arrive at the remote `/api` from `127.0.0.1`, which is what keeps the privileged methods — directory picking, settings, credentials, preset authoring — reachable at all; they are loopback-only until a real authentication layer exists.

## The runtime process

[`src/runtime-supervisor.ts`](src/runtime-supervisor.ts) runs the harness as a child process rather than inside the main process, so a harness fault costs a restart instead of the window and its heap is bounded independently of Chromium's. The child is Electron's own binary in `ELECTRON_RUN_AS_NODE` mode, which is why the bundle carries no second Node runtime.

| Concern | Behavior |
|---|---|
| Launch | [`src/runtime-launch.ts`](src/runtime-launch.ts) owns both command lines. The local one includes `--expose-internals`: Electron cannot load the `node-addon-require-builtin` addon Cordis otherwise uses to reach Node's internal module loader, so without that flag the HMR service refuses to start and takes the boot with it. A launch is prepared per start rather than per supervisor, because a remote one occupies a fresh pair of ports every time. |
| Readiness | The `dsh web: <url>` line, not the port answering. [`src/readiness.ts`](src/readiness.ts) joins it across chunk boundaries and only reports a complete line. A remote runtime reports the address it bound on its own host, so the launch maps it to the forwarded port and refuses any other address instead of pointing a window at something else. |
| Port | Locally `--port 0`, so the shell never collides with a `dsh web` started in a terminal. A forwarded launch has to name the remote port before the runtime picks one, so it draws one and treats a collision as a retryable failure. |
| Restart | [`src/restart-policy.ts`](src/restart-policy.ts) restarts a served run at once, backs off exponentially through startup failures, and stops after five in a row. Sessions are durable, so a restart costs an in-flight turn and nothing else. A giving-up remote launch reports what `ssh` actually hit — a refused key, an unresolved host, a missing remote launcher — because the exit code alone cannot tell those apart. |
| Shutdown | A local runtime is asked with `SIGTERM`, which disposes its own plugin tree and subprocesses within its own five-second bound; Windows has no `SIGTERM` and terminates the process instead. A remote one is asked by closing the `ssh` session's stdin, which its own remote script turns into the same `SIGTERM` on the far side; signalling `ssh` instead would leave that runtime orphaned. The process tree is signalled only after the ladder's grace (`taskkill /T` on Windows), which is what catches subprocesses a wedged runtime never reaped. |
| Log | Electron's logs directory: `~/Library/Logs/DeepSeek Harness/runtime.log` on macOS, `%APPDATA%\DeepSeek Harness\logs\runtime.log` on Windows; truncated per run and rotated at 4 MiB. |

## The user's environment

A Finder launch inherits launchd's environment, whose `PATH` is four system directories. The agent runs the user's tools from that `PATH`, so [`src/login-environment.ts`](src/login-environment.ts) runs `$SHELL -ilc` once at startup and reads the environment the profile composes, framed by markers so a profile banner cannot corrupt the payload. The probe is skipped when `PATH` already carries a profile entry, is bounded at five seconds, and falls back to the inherited environment. Windows Explorer and a Linux desktop session already hand the user `PATH` to a GUI application, so they never probe.

## Window behavior

Windows load the runtime's loopback origin directly and carry no preload, so the harness UI runs sandboxed and context-isolated. The boot surface ([`resources/boot.html`](resources/boot.html)) is a local file the shell navigates to whenever the runtime is not serving; its buttons are links in a `dsh-action:` scheme that [`src/windows.ts`](src/windows.ts) intercepts. Geometry is validated against the attached displays before a window opens ([`src/window-state.ts`](src/window-state.ts)), so a window stored on a monitor that is gone does not open off-screen.

Every window is one origin's web content, and the harness UI keeps the session a window shows per window rather than per origin, so the shell's part is saying which windows are new ones. **New Window** loads the runtime address with the UI's `new` parameter and the window starts on a session of its own; the first window and a Dock activation load it plain and restore the last session. The request is spent on that first load, because a runtime restart re-routes the windows already open and each of those is the same window, not another new one.

## Keyboard

The menu is the shell's keyboard map. The harness window is web content this shell does not extend, so every key the menu does not claim belongs to the UI inside it — which is why the map stays off the printable range. The standard operations — clipboard, undo, zoom, reload, developer tools, full screen, minimize, and close — are Electron menu roles, and a role spells its chord the way its platform does.

| Operation | macOS | Windows |
|---|---|---|
| New Window (on its own session) | ⌘N | Ctrl+N |
| Close Window | ⌘W | Ctrl+W |
| Quit | ⌘Q | Ctrl+Q |
| Restart Harness Runtime | ⌥⌘R | Ctrl+Alt+R |
| Release Memory When Idle | ⌥⌘M | Ctrl+Alt+M |
| Connections… | ⇧⌘H | Ctrl+Shift+H |
| Open in Browser | ⇧⌘O | Ctrl+Shift+O |
| Reveal Runtime Log | ⇧⌘L | Ctrl+Shift+L |
| Reload | ⌘R | Ctrl+R, F5 |
| Reload past the cache | ⇧⌘R | Ctrl+Shift+R, Shift+F5 |
| Developer Tools | ⌥⌘I | Ctrl+Shift+I, F12 |
| Full Screen | ⌃⌘F | F11 |
| Paste and Match Style | ⌥⇧⌘V | Ctrl+Shift+V |

Three tiers keep the shell's own chords clear of the roles': the bare modifier is a standard window operation, `Shift` reaches a shell surface or destination, and `Alt` reaches the runtime process — the tier Electron itself puts the macOS developer tools on. [`src/menu.ts`](src/menu.ts) holds the whole map, and its unit test rejects a chord a role already carries, because that collision is otherwise silent: Electron gives a repeated chord to whichever item the template lists first and leaves the other one keyless.

The same test rejects a menu item claiming `⌘,` (Settings), `⌘K` (New Session), `⌘O` (Add Workspace), `⌘B` (sidebar), or `⇧⌘F` (search): those are the harness UI's own, bound inside the page by [ui-primitives](../../packages/client/ui-primitives/README.md)'s `useShortcut`, and a menu accelerator would take the key before the page saw it.

The Windows and Linux function row is what a menu item cannot carry, since an item holds one accelerator and the `Ctrl` spelling is already on it. [`src/window-keys.ts`](src/window-keys.ts) answers `F5`, `Shift+F5`, `Ctrl+F5`, and `F12` on the window itself; macOS leaves that row to the system. The boot surface answers `Escape` to leave the connection list, `Enter` in a form field to save the host, and `Enter` on a failed start to try again — keys that mean something only while that page is what the window shows.

## Attention and power

[`src/activity.ts`](src/activity.ts) folds the runtime's own frames, read through a [`AbstractApiClient`](../../packages/host/apiproxy/README.md) subclass over the WebSocket downlink:

- The **host stream** stays open while the runtime serves. It reports which sessions are running, which drives the power-save blocker held exactly while a turn runs, and the "task finished" notification raised only when no window has focus.
- The **mux stream** opens only while no window has focus, and carries the approval and question frames that mean the agent is blocked on the user. A visible window already shows those requests, so subscribing while the user is watching would double the runtime's frame serialization for no signal. Pending requests appear as the Dock badge.

## Memory policy

[`src/resource-governor.ts`](src/resource-governor.ts) samples the runtime every 30 seconds and applies one rule set whose first clause is that agent work is never interrupted: every reclamation applies to an idle runtime only. An idle runtime with no window open for ten minutes is stopped and restarted on the next activation; an idle runtime holding more than 35% of physical memory is restarted in place. Idle stopping is a checkbox in the application menu.

## Known Limitations and Deferred Work

- The runtime serves on loopback with an OS-assigned port and no authentication, which is the posture `dsh web` already has: any process running as the same user can reach the API. An Electron IPC carrier would remove the port, at the cost of reimplementing the plugin-bundle endpoint, the boot-manifest injection, and the downlink that the Web carrier already provides. A forwarded remote runtime has the same posture at both ends of the tunnel.
- Every host needs Node 22.19 or newer; a registry installation also needs npm there. A host with neither is refused with a diagnosis rather than provisioned another way.
- A server payload is platform-locked, and the desktop application does not build one: it ships a closure for its own platform and has no package manager to make another. Build one with `pnpm run package:remote-server` from a checkout on a machine matching the host.
- The shell cannot answer an SSH password or passphrase prompt: it has no terminal, and a prompt with nowhere to go would hang the connection instead of failing it. A remote host needs an ssh-agent identity or an unencrypted key file.
- The memory policy does not measure a remote runtime. The child here is the `ssh` session, whose resident memory says nothing about the harness, so only the idle rule applies to it.
- Stopping an idle runtime also stops whatever the schedule and job plugins would have run while it was idle. The menu checkbox turns the behavior off; a policy that distinguishes scheduled work from idleness is deferred.
- The downlink pathnames are restated here because the constants live in a `packages/client` package, which the host TypeScript program deliberately cannot see.
- The macOS bundle is ad-hoc signed, not notarized: a copy carried to another machine needs `xattr -dr com.apple.quarantine <app>`. The Windows setup is unsigned; SmartScreen will warn.
- No CI gate covers the application. Packaging needs macOS or Windows, and exercising the shell needs a windowing session; a same-machine packaging run's boot smoke is what proves the closure it ships. A Windows installer built on macOS is unsmoked.
- The NSIS setup replaces electron-builder's check for a running application with [`build/close-app-processes.nsh`](build/close-app-processes.nsh), because the runtime shares the shell's executable and restarts itself faster than the default check gives up. A macOS build host proves only that the script compiles; the close path needs an upgrade install over a running application on Windows.
- Closing the last window on Windows quits the application and stops the runtime; on macOS it does not.
