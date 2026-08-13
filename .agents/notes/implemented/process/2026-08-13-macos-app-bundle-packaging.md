# Agent Note: macOS application bundle for dsh web

Status: implemented

English | [中文](2026-08-13-macos-app-bundle-packaging.zh.md)

## Problem

`dsh web` starts from a terminal and prints a URL, so using the GUI means keeping a terminal open for the server's lifetime and clicking through a printed line. On macOS the natural entry is a double-clickable application, and nothing produced one. A distributable application is a much larger project than that need — Developer ID signing, notarization, hardened-runtime entitlements worked out for every shell, subprocess, and worker thread the harness spawns, and per-architecture `node-pty` prebuilds — and none of it is required to launch the harness on the machine that built it.

## Decision

`pnpm run package:mac` ([scripts/package-macos-app.ts](../../../../scripts/package-macos-app.ts)) builds an unsigned `dist-macos/DSH.app` and a `dist-macos/DSH.dmg` holding it beside an `/Applications` symlink. The bundle is a launcher over one checkout rather than a distribution: it runs that checkout's built `apps/cli/lib/bin.js` under an absolute Node path, both resolved at build time and baked into the launch script. It builds on macOS only and fails loud when `pnpm run build` has not produced the CLI entry and the frontend dist, because the web bundle refuses to activate without that dist.

Nothing inside the bundle is addressed by an absolute path, so the built application still works after being dragged to `/Applications`; only the two paths that point out of it are fixed.

### The executable is a compiled shim, not the script

LaunchServices bounces the Dock tile, and eventually reports a launch timeout, until the bundle executable checks in with the window server — which only a process that starts an `NSApplication` can do, and a shell script never can. The executable is therefore a small Swift Cocoa shim compiled by `swiftc` during packaging, and the bash launch script runs as its child. The shim owns the application's lifetime in both directions: Quit reaches the script's `SIGTERM` trap, which stops the server before the app exits, and the script exiting terminates the app rather than leaving an idle Dock tile. Where no Swift compiler exists the script becomes the executable and the bundle is marked `LSUIElement`, which has no Dock tile to bounce and no Dock icon either.

### Reaching the app raises its tab

An application with no window of its own has nothing to present when the user reaches it, so every route in — a Dock click, Command-Tab, any other activation — runs the launch script in a focus-only mode that raises the browser tab. That mode starts nothing: an activation arrives moments after launch, and starting a server there would race the launch for the port.

What that mode waits for is a readiness marker the launch writes after opening its tab, not the port. The port answers about a second and a half before that tab exists — long enough for an activation to land inside the interval, find no tab, and open a second one. A probe still runs after the marker check, because a killed run leaves its marker behind and the URL under it serves nothing. A single Dock click delivers both the reopen and the activation callback, and the shim suppresses the second while the first is still running, for the same reason: two concurrent runs that find no tab would each open one.

### Browsers are addressed by bundle id

Browsers are named by bundle id and never by display name: naming an application that is not installed sends AppleScript searching for it and blocks on a chooser dialog, which hung the launcher outright while a listed browser was absent, whereas an absent bundle id fails immediately. Only a browser that is already running is asked, so a Dock click never starts one the user had closed. Chromium-family browsers share one script compiled under `using terms from application "Google Chrome"`; Safari has its own dictionary and its own script.

### The baked Node path is a PATH entry

`process.execPath` is already resolved through its symlinks, so under Homebrew or a version manager it names a version-stamped directory that the next upgrade deletes — leaving a bundle that dies before it can report why. The build instead bakes a `PATH` entry that resolves to the same binary. An upgrade that changes Node's major then produces a loud `node-pty` ABI error that `pnpm install` repairs, which is a better failure than a path that silently no longer exists. `--node` pins an exact binary when that trade is unwanted.

## Alternatives considered

- **Reuse the single-executable pipeline.** The [single-exe distribution](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) already materializes a symlink-free deploy closure and builds macOS binaries, so it could carry a self-contained bundle. Rejected for this step: its closure is the JSON-RPC runtime, not the web surface with its frontend dist, and a self-contained bundle is only worth assembling once signing and notarization make it distributable. It remains the foundation to build on when distribution is the goal.
- **An Electron shell.** The [GUI layering](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md) anticipates one, reusing the web client packages over an IPC fetch carrier. Rejected as disproportionate here: `dsh-host-webserver` also carries `/api`, the plugin-bundle endpoint, the reload stream, and boot-manifest injection, each of which needs a new carrier under Electron. A launcher answers the immediate need without touching shipped source.
- **`LSUIElement` for every build.** This removes the Dock bounce with no compiler dependency, but also removes the Dock icon and its Quit item, leaving Activity Monitor as the way to stop the server. It is kept only as the fallback when `swiftc` is absent.
- **Sign and notarize.** Out of scope while the bundle targets the machine that built it: a locally built bundle carries no quarantine flag, so Gatekeeper never inspects it. Adding signing means entitlements reasoned through per subprocess path, Developer ID credentials, and a release job — work that belongs with a self-contained artifact, not a launcher.
- **Generate the icon from SVG at packaging time.** Rejected because `sips` and `iconutil` read PNG and no macOS system tool rasterizes SVG, so this would add a renderer dependency contributors need not have. The rendered PNG is committed beside the SVG it came from.

## Consequences

- The bundle stops working when the checkout moves or its Node installation is removed. It is a developer convenience, and [docs/development.md](../../../../docs/development.md#macos-application-bundle) states that limit alongside the rebuild rules.
- LaunchServices resolves an application by bundle id, so a copy installed under `/Applications` answers `open dist-macos/DSH.app`. A rebuild has to be reinstalled there or the previous copy keeps running.
- Raising a browser tab needs one Automation approval per browser, and an unsigned executable's identity changes with every rebuild, so macOS asks for those approvals again after repackaging.
- No CI gate covers the script: it needs macOS, a Swift compiler, a windowing session, and a browser, so its behavior is established by hand on a developer machine. The repository-wide lint and typecheck gates cover the script as TypeScript source and nothing more.
