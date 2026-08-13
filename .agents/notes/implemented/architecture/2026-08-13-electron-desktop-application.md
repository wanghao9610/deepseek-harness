# Agent Note: the macOS desktop application — an Electron shell over the loopback Web runtime

Status: implemented

English | [中文](2026-08-13-electron-desktop-application.zh.md)

## Problem

The harness has a Web surface and, on macOS, a [launcher bundle](../process/2026-08-13-macos-app-bundle-packaging.md) that starts `dsh web` and opens a browser tab. The launcher is a developer convenience over one checkout: it bakes in an absolute path to that checkout's `apps/cli/lib/bin.js` and to a Node binary resolved at build time, so it stops working when either moves, and it cannot be handed to anyone who does not already have the repository.

A desktop application is a different product. It has to install from a disk image onto a machine with no checkout, no Node, and no package manager; survive the harness process crashing; run the user's own tools, which a Finder launch cannot find; not hold a browser tab hostage for the life of a session; tell the user when a long agent run finished or is blocked on them while they are in another application; and not leave hundreds of megabytes resident when nothing is happening.

## Decision

`apps/desktop` is an Electron application that supervises one embedded `dsh --profile web` runtime and shows it in a native window over the runtime's loopback origin. `pnpm run package:desktop` builds `dist-desktop/DeepSeek-Harness-<version>-<arch>.dmg`, unsigned beyond an ad-hoc signature.

The shell adds no harness capability, and that is the point of the design: everything the user interacts with is the shipped Web composition, unchanged. The shell owns only what a browser tab cannot.

### The Web carrier is reused, not replaced

The [GUI layering](2026-07-19-gui-layering-and-rpc-protocol.md) anticipated an Electron client that loads the built files over `file://` and carries `/api` over an IPC fetch bridge. That is not what shipped. The window loads `http://127.0.0.1:<port>`, because `dsh-host-webserver` carries four things the browser client needs — `/api`, the plugin-bundle endpoint, the `__DSH_BOOT__` manifest injection, and the WebSocket downlink — and an IPC carrier has to supply all four before the first window renders anything. Reusing the HTTP carrier means the desktop surface is the Web surface by construction, and a Web fix is a desktop fix with no second carrier to keep in step.

What that costs is stated where it belongs: the runtime serves on loopback with an OS-assigned port and no authentication, which is the posture `dsh web` already has. The IPC carrier remains the way to remove the port when someone needs it removed.

The shell is still a first-class protocol client rather than a screen scraper. `DesktopApiClient` subclasses the shipped `AbstractApiClient`, so envelope parsing, frame validation, and rpcId discipline are the same code the browser runs; only the two platform aspects differ — `doFetch`, and the downlink, which the Web carrier serves over WebSocket and answers `426 Upgrade Required` for any plain request.

### The runtime is a child process, and Electron is its Node

The harness runs as a child of the main process, not inside it. A harness fault then costs a restart rather than the window; its V8 old space is sized from physical memory independently of Chromium's; and a tool that wedges cannot block the UI thread.

The child is the Electron binary itself in `ELECTRON_RUN_AS_NODE` mode, so the bundle carries one JavaScript runtime instead of two. That works because `node-pty` ships Node-API prebuilds, which load unchanged under Electron's ABI. It does **not** work for `node-addon-require-builtin`, the addon Cordis uses to reach Node's internal ES module loader without a flag: it reads V8 embedder data whose layout Electron does not share, and fails to load. `--expose-internals` is the remaining route, and the runtime is launched with it — without it the HMR service refuses to start and takes the whole boot with it. That flag, the heap bound, and the rest of the argument list live in one module (`src/runtime-launch.ts`) that both the shell and the packaging smoke use, because a smoke that launched the runtime differently would prove nothing about the launch that ships.

Readiness is the `dsh web: <url>` line, not the port answering, and the scanner requires the line's terminating newline: output arrives in chunks that split anywhere, and a chunk ending mid-URL would otherwise report a truncated address.

### The login shell is recovered once at startup

A Finder launch inherits launchd's environment, whose `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. The agent runs `git`, `rg`, and the user's language toolchains from that `PATH`, so the shell runs `$SHELL -ilc` once and reads back the environment the user's profile composes. The probe prints its payload from a Node child so the value is exact JSON rather than line-parsed `env` output, frames it with markers so a profile banner cannot corrupt it, is bounded at five seconds, and is skipped outright when `PATH` already carries a non-launchd entry.

### Reclamation never interrupts agent work

The resource policy samples the runtime every 30 seconds, and its first clause is that a running session outranks every other rule. Only an idle runtime is ever touched: one with no window open for ten minutes is stopped and restarted on the next activation, and one holding more than 35% of physical memory is restarted in place. The runtime's resident size comes from `ps`, because it is not an Electron child process and `app.getAppMetrics()` does not cover it.

The same running-state signal drives the rest of the macOS surface: a power-save blocker held exactly while a turn runs, and a "task finished" notification raised only when no window has focus.

### The mux stream is a background-only subscription

Approval and question frames — the two that mean the agent is blocked on the user — ride the mux stream, which also carries every assistant token. The shell subscribes to it **only while no window has focus**. A visible window already shows those requests, so a foreground subscription would double the runtime's frame serialization for no signal the user cannot already see. Opening the stream replays still-pending requested frames after the subscribed frame, so going to the background immediately surfaces anything already waiting.

### Packaging deploys a closure and proves it boots

The bundle is self-contained: `apps/desktop/runtime/package.json` is a generated dependency-only deploy root naming every workspace package reachable from `@deepseek-ai/dsh`, and `pnpm deploy` materializes it into the bundle. Listing the whole reachable set rather than the app alone is what makes the closure complete: with automatic peer installation off, peers are not installed, and a package reached only through the `link:` overrides in `pnpm-workspace.yaml` is skipped unless the root names it. `scripts/gen-desktop-runtime-closure.ts` writes that list and `--check` gates its freshness in `pnpm run hygiene`.

Before anything is packed, the pipeline **boots the deployed closure** under the same command line the shipped shell uses and reads the served page. This is the gate no static check replaces: a missing peer, a vendored package the overrides left behind, an unbuilt frontend dist, and the `--expose-internals` requirement all surfaced there rather than in a shipped application.

Two mechanical facts govern the rest of the pipeline. The bundle is **not** an asar archive: the harness is ES modules with dynamic imports and native addons, and Electron's loader can import neither from inside one. And the packed application is **ad-hoc signed by this pipeline**, because packaging rewrites the Electron binary's identity and layout — which invalidates the signature it shipped with — and Apple silicon kills a bundle whose signature is invalid.

## Alternatives considered

- **The IPC fetch carrier the layering note anticipated.** Rejected as the first step, not on the merits: it needs a plugin-bundle endpoint, boot-manifest injection, and a downlink before the first window renders, and each is a second implementation of something the Web carrier already ships. Reusing the HTTP carrier gets a working application now and keeps one carrier to maintain; the port is the price, and it is the price `dsh web` already pays.
- **Running the harness inside the Electron main process.** It saves a process and a startup, and costs crash isolation, an independent heap bound, and a UI thread that no tool can block. A desktop application whose window dies with the agent is worse than one that restarts it.
- **Shipping a Node binary beside Electron.** The obvious way to avoid ABI questions, at roughly 100 MB and a second runtime to keep patched. Unnecessary once `node-pty`'s Node-API prebuilds were confirmed to load under Electron; the one addon that genuinely cannot load there is replaced by a flag, not by a runtime.
- **Extending the launcher bundle instead.** The launcher's whole shape is "a script that starts a server and opens a tab"; window management, notifications, a Dock badge, and a memory policy are not extensions of it. The two artifacts have different bundle ids and coexist.
- **A preload script on the harness window.** It would let the shell talk to the UI, and it requires `sandbox: false` for an ES module preload — weakening the renderer that displays model output, for no capability this shell needs. The boot surface reaches the shell through an intercepted `dsh-action:` scheme instead, and the harness window carries no preload at all.
- **Subscribing to the mux stream all the time.** Simpler, and it makes the Dock badge correct while the window is focused — which is exactly when the user is already looking at the same information in the UI.
- **Hand-listing the closure manifest,** as the [single-executable pipeline](2026-07-10-single-file-executable-sdk-runtime-distribution.md) does. Its list is a product decision about which plugins the executable ships; the desktop's list is "whatever the CLI reaches", which is a derivation, and deriving it keeps it correct without anyone remembering to.
- **electron-builder's `dmg` target and its resource copying.** The disk image is built with `hdiutil` through the same helper the launcher bundle uses, and the closure is staged into the packed bundle directly, after electron-builder's own resource copy silently dropped the closure's `node_modules`.

## Consequences

- The desktop application and the Web surface cannot drift: there is one carrier, one client base class, and one frontend build. A new Web feature reaches the desktop with no desktop change.
- Any local process running as the same user can reach the runtime's API, exactly as with `dsh web`. Removing that requires the IPC carrier.
- `pnpm deploy` records the flags it ran with in the workspace install state, and pnpm reconciles that state before the next `pnpm run` — which would reinstall the checkout production-only and delete the development dependencies the rest of the build needs. Every closure deploy now restores the workspace install state afterwards, which also repairs the same latent hazard in the single-executable pipeline.
- The disk image is about 240 MB and the installed application about 430 MB, most of it the harness closure and its provider SDKs. Pruning build-only material and foreign-platform prebuilds removes roughly 40% of the closure before it is packed.
- Adding a package to the CLI's dependency graph now requires regenerating the desktop closure manifest and reinstalling, the same maintenance the Python runtime manifest already carries. `pnpm run hygiene` reports a stale manifest.
- No CI gate covers the application: packaging needs macOS and exercising the shell needs a windowing session. What CI does cover is the shell's logic, which is unit-tested away from Electron, and what the packaging run covers is the closure it is about to ship.
