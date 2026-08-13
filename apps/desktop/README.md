# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The macOS desktop application: an Electron shell that supervises one embedded `dsh --profile web` runtime and shows it in a native window. It ships as an unsigned `.dmg` built by [`scripts/package-desktop-app.ts`](../../scripts/package-desktop-app.ts), and it is self-contained — the Electron runtime, the harness closure, and the built frontend all live inside the bundle, so the installed application needs no checkout, no Node installation, and no package manager. The decision record is the [desktop application Agent Note](../../.agents/notes/implemented/architecture/2026-08-13-electron-desktop-application.md).

The shell adds no harness capability. It reuses the shipped Web surface verbatim over the runtime's loopback server, and owns only what a browser tab cannot: process supervision, the user's shell environment, native window and menu behavior, attention signals, and a memory policy.

## The runtime process

[`src/runtime-supervisor.ts`](src/runtime-supervisor.ts) runs the harness as a child process rather than inside the main process, so a harness fault costs a restart instead of the window and its heap is bounded independently of Chromium's. The child is Electron's own binary in `ELECTRON_RUN_AS_NODE` mode, which is why the bundle carries no second Node runtime.

| Concern | Behavior |
|---|---|
| Launch | [`src/runtime-launch.ts`](src/runtime-launch.ts) owns the argument list, including `--expose-internals`. Electron cannot load the `node-addon-require-builtin` addon Cordis otherwise uses to reach Node's internal module loader, so without that flag the HMR service refuses to start and takes the boot with it. |
| Readiness | The `dsh web: <url>` line, not the port answering. [`src/readiness.ts`](src/readiness.ts) joins it across chunk boundaries and only reports a complete line. |
| Port | `--port 0`, so the shell never collides with a `dsh web` started in a terminal. |
| Restart | [`src/restart-policy.ts`](src/restart-policy.ts) restarts a served run at once, backs off exponentially through startup failures, and stops after five in a row. Sessions are durable, so a restart costs an in-flight turn and nothing else. |
| Shutdown | `SIGTERM` to the runtime, which disposes its own plugin tree and subprocesses within its own five-second bound; the process group is signalled only after an eight-second grace, which is what catches subprocesses a wedged runtime never reaped. |
| Log | `~/Library/Logs/DeepSeek Harness/runtime.log`, truncated per run and rotated at 4 MiB. |

## The user's environment

A Finder launch inherits launchd's environment, whose `PATH` is four system directories. The agent runs the user's tools from that `PATH`, so [`src/login-environment.ts`](src/login-environment.ts) runs `$SHELL -ilc` once at startup and reads the environment the profile composes, framed by markers so a profile banner cannot corrupt the payload. The probe is skipped when `PATH` already carries a profile entry, is bounded at five seconds, and falls back to the inherited environment.

## Window behavior

Windows load the runtime's loopback origin directly and carry no preload, so the harness UI runs sandboxed and context-isolated. The boot surface ([`resources/boot.html`](resources/boot.html)) is a local file the shell navigates to whenever the runtime is not serving; its buttons are links in a `dsh-action:` scheme that [`src/windows.ts`](src/windows.ts) intercepts. Geometry is validated against the attached displays before a window opens ([`src/window-state.ts`](src/window-state.ts)), so a window stored on a monitor that is gone does not open off-screen.

## Attention and power

[`src/activity.ts`](src/activity.ts) folds the runtime's own frames, read through a [`AbstractApiClient`](../../packages/host/apiproxy/README.md) subclass over the WebSocket downlink:

- The **host stream** stays open while the runtime serves. It reports which sessions are running, which drives the power-save blocker held exactly while a turn runs, and the "task finished" notification raised only when no window has focus.
- The **mux stream** opens only while no window has focus, and carries the approval and question frames that mean the agent is blocked on the user. A visible window already shows those requests, so subscribing while the user is watching would double the runtime's frame serialization for no signal. Pending requests appear as the Dock badge.

## Memory policy

[`src/resource-governor.ts`](src/resource-governor.ts) samples the runtime every 30 seconds and applies one rule set whose first clause is that agent work is never interrupted: every reclamation applies to an idle runtime only. An idle runtime with no window open for ten minutes is stopped and restarted on the next activation; an idle runtime holding more than 35% of physical memory is restarted in place. Idle stopping is a checkbox in the application menu.

## Known Limitations and Deferred Work

- The runtime serves on loopback with an OS-assigned port and no authentication, which is the posture `dsh web` already has: any process running as the same user can reach the API. An Electron IPC carrier would remove the port, at the cost of reimplementing the plugin-bundle endpoint, the boot-manifest injection, and the downlink that the Web carrier already provides.
- Stopping an idle runtime also stops whatever the schedule and job plugins would have run while it was idle. The menu checkbox turns the behavior off; a policy that distinguishes scheduled work from idleness is deferred.
- The downlink pathnames are restated here because the constants live in a `packages/client` package, which the host TypeScript program deliberately cannot see.
- The bundle is ad-hoc signed, not notarized: a copy carried to another machine needs `xattr -dr com.apple.quarantine <app>`.
- No CI gate covers the application. Packaging needs macOS, and exercising the shell needs a windowing session; the packaging pipeline's own boot smoke is what proves the closure it ships.
