# Agent Note: Windows launcher opens an app window instead of reusing a tab

Status: implemented

English | [中文](2026-08-13-windows-app-window-launcher.zh.md)

## Problem

The [macOS bundle](2026-08-13-macos-app-bundle-packaging.md) gives `dsh web` a double-clickable entry whose central behavior is tab reuse: reaching the app raises the browser tab already showing the session rather than opening another. Windows offers no equivalent of the AppleScript that makes it work. Nothing there enumerates a running browser's tabs: UI Automation can walk Chromium's accessibility tree but is version- and locale-sensitive, window-title matching finds a window only when the wanted tab is already active, and the DevTools protocol requires launching the browser with a debugging flag, which cannot be applied to the session the user already has open.

## Decision

`scripts\windows\start-web.ps1` sidesteps tab reuse by not producing a tab. It asks a Chromium-family browser for a dedicated window (`--app=<url>`), which carries its own taskbar button, so Alt-Tab reaches the session directly and a second run raises that window by title instead of opening another. The browser is the user's default when that default is Chromium-family, otherwise the first installed candidate; a non-Chromium default gets an ordinary tab and no reuse, which the launcher does not try to hide. `pnpm run package:win` writes launch and stop shortcuts over the launcher, and packaging is optional because the launcher is a plain script that runs from a checkout.

Window matching is by containment of `DeepSeek Harness`, the constant suffix of the title `packages/client/web` sets. The full title carries the session name ahead of it, so equality or a prefix match would find nothing.

The launcher does not stay resident the way the macOS bundle's shim does, because Windows has no equivalent of the launch check-in that made a resident process necessary there. It starts the server detached, waits for the URL line, opens the window, and exits; `-Stop` ends the server by matching the entry path in the command line of a `node.exe` process.

## Verification status

The PowerShell in this change has never been executed. It was written on macOS, where no PowerShell, wine, mono, or .NET runtime was available to so much as parse it, and its behavior needs a desktop session and a browser that CI cannot supply — the repository's [native Windows CI](2026-08-08-native-windows-pull-request-ci.md) can build and test the harness but cannot exercise a foreground window. What review did catch stands as evidence of the risk: `Start-Process` joins an argument array without quoting, so a checkout path containing a space would have broken the entry argument; `-like` reads a Windows path's backslashes as escape syntax, so process matching used string containment instead; and `-WindowStyle` cannot combine with output redirection. A `-Check` mode prints the resolved Node binary, entry, server state, browser, and window in one shot, and every failure raises a dialog, because a launcher started from a shortcut has no console for either.

## Alternatives considered

- **UI Automation over browser tabs.** This is the only route to real tab reuse on Windows, and it was rejected on the same ground that shapes this whole note: correctness would have to be established by watching a live accessibility tree, which was not possible here. Shipping untestable UIA traversal would have produced code that fails silently against a browser version nobody checked.
- **Window-title matching against ordinary tabs.** Cheap and available, but it locates a browser window only while the wanted tab is the active one, so it degrades to opening duplicates exactly when the user has moved away — the failure the macOS work existed to remove.
- **A resident launcher mirroring the macOS shim.** The shim exists because LaunchServices bounces the Dock tile until the executable checks in with the window server. Windows imposes no such requirement, so a resident process would buy nothing and add an invisible process the user cannot see or stop.
- **An installer (MSI, NSIS, Inno Setup).** Rejected as answering a different question: an installer distributes a self-contained program, while this launcher runs one checkout on the machine that built it, the same limit the macOS bundle carries.
- **Reusing the `.icns` artwork.** The macOS icon sits on the Big Sur grid, with a transparent margin around an 824-unit tile that would render visibly small on a taskbar. A Windows variant fills its canvas, and the multi-resolution `.ico` is committed because the packaging step runs on a machine with no rasterizer.

## Consequences

- The first run on Windows is the first execution of this code. Treat a failure there as expected cost rather than surprise, and read `-Check` before anything else.
- Firefox users get an ordinary tab with no reuse. Reuse for them needs a mechanism nothing in this change provides.
- The server outlives the window: closing the app window leaves it running, and the stop shortcut or `-Stop` is what ends it. This differs from macOS, where quitting the bundle stops the server.
- No gate covers either script. They are PowerShell, so the repository's lint and typecheck gates do not see them at all, unlike the macOS packaging script.
