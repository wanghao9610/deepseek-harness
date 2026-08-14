# Agent Note: the Windows setup closes the process tree, and the closure ships only loadable files

Status: implemented

English | [中文](2026-08-14-windows-setup-closes-the-process-tree.zh.md)

## Problem

Installing over a running installation takes many minutes and then fails with "DeepSeek Harness cannot be closed. Please close it manually and click Retry to continue." Two independent causes meet in that message.

electron-builder's check for a running application finds every process whose executable path lies under the installation directory, terminates matches one process at a time, and gives up after two force-kill rounds — roughly six seconds. This application always presents more than one such process. The shell spawns the harness runtime from its own executable through `ELECTRON_RUN_AS_NODE`, so the runtime carries the shell's image name and path; the runtime is spawned detached, so it outlives a terminated shell; and the supervisor restarts a runtime that has served for at least a minute with no delay at all. Terminating the runtime while the shell lives produces a replacement before the next scan, and terminating the shell first leaves the detached runtime behind. Whichever process the installer reaches first, the scan that follows still finds one, and the six-second budget expires.

The files those survivors hold open then defeat the old version's uninstaller, which the installer runs up to five times before reporting the same message. That is the second half of the delay.

The first half is the payload. The closure shipped 25,490 files, over half of which nothing in it can load: 9,804 TypeScript declarations, 2,243 third-party sources, and 854 documentation files. A Windows install is paced by per-file extraction and the on-access scan of each written file far more than by total bytes, so the count, not the 524 MiB, set the duration.

## Decision

### The setup closes the process tree

[`apps/desktop/build/close-app-processes.nsh`](../../../../apps/desktop/build/close-app-processes.nsh) defines `customCheckAppRunning`, the macro app-builder-lib inserts in place of its own check, and the packaging script names it as the NSIS `include`.

Termination is unconditional. A check that probes first and acts only on a positive result skips the close entirely whenever the probe command itself fails — a silent no-op whose symptom is the failure it was written to prevent — and terminating nothing costs one command that reports no match. The probe still runs, because it decides whether to ask the user, not whether to act.

Each pass matches processes two ways. `taskkill /F /T /IM` takes every image-name match down with its children, so a live shell goes with the runtime and the shells it started. A PowerShell pass then terminates anything whose executable lies under the installation directory, which reaches the native hosts and pty helpers that carry neither the application's name nor, once their parent is gone, a tree reachable from it. The budget is 20 passes at 500 ms rather than two rounds at about three seconds.

The macro carries its own PowerShell probe. The default check's `$IsPowerShellAvailable` is initialized only on the branch this macro replaces, so reusing that macro's `FIND_PROCESS` would not compile. Neither the setup nor the uninstaller carries the application's image name or lives under the installation directory, so no pass can terminate the installer running it.

The macro keeps the confirmation prompt for an install the user started against a running application, and skips it under `isUpdated`, matching the behavior it replaces. Its labels carry a per-insertion suffix because NSIS compiles the installer and the uninstaller as one script and each inserts the macro once.

### The closure ships only what it can load

`pruneClosure` in [`scripts/package-desktop-app.ts`](../../../../scripts/package-desktop-app.ts) removes every `.ts`, `.mts`, and `.cts` file — declarations included — along with source maps, documentation Markdown, and the directories left empty.

Nothing in the closure can load any of it. No TypeScript toolchain ships there — not `typescript`, `tsx`, `esbuild`, or `@swc/core` — so Node never reads the `types` export condition, and the windows-acl runner reaches its source through `tsx` only when the built `lib/runner.js` is absent, which packaging always provides. Source maps go with the sources they point at.

Markdown is pruned by documentation stem, and exempt under a `config` or `assets` directory. The skill loader reads every `.md` under a skill directory, so a documentation stem there names a skill rather than a document; the shipped Cordis presets and the badge body live in exactly those places.

The pipeline reports the file count beside the size, because that count is what a Windows install is paced by.

### Three sites raise the same message

`appCannotBeClosed` is the text of three distinct failures, and this macro owns one of them. The pre-install check is the site replaced here. `uninstallOldVersion` raises it when the old version's uninstaller returns non-zero five times. `extractAppPackage` raises it when `CopyFiles` over the installed tree fails five times, one second apart — the progress bar is already moving by then, and the Retry button falls through to a `Nsis7z::Extract` that overwrites in place and ignores per-file errors, so answering Retry completes the install non-atomically.

A report of this message therefore has to name its stage before it names a cause: only the first is a process the pre-install pass could have missed, while the other two mean a file was locked after that pass ran, or was never held by a process at all.

## Alternatives considered

**Suspend the runtime's automatic restart while an installer runs.** The supervisor cannot distinguish an installer's `TerminateProcess` from a crash, so the only honest form of this is a switch the installer sets and the shell reads — a new cross-process protocol whose failure mode is a runtime that never recovers from a real crash. Killing the tree needs no such agreement.

**Give the runtime its own executable name.** A distinct name would let the installer close the shell without matching the runtime. The runtime needs Electron's Node — the `--expose-internals` route to the internal ES module loader, because the `node-addon-require-builtin` addon cannot load under Electron — so it must launch from the Electron binary. A renamed copy would duplicate a 215 MiB executable and, on macOS, fall outside the ad-hoc signature this pipeline applies.

**Ship the closure as one archive the installer extracts.** Far fewer files for NSIS to write. Electron can import neither ES modules nor native addons from inside an archive — the same constraint that rules out asar — so the archive would have to be expanded at first run, moving the cost onto the user's first launch and leaving an uninstall unable to account for what it wrote.

**Keep declarations and sources for field debugging.** Source maps were already pruned before this change, so a stack trace already pointed at built output only; the sources retained nothing that could be stepped through.

## Testing

A macOS packaging run boots the pruned closure under the command line the shipped shell uses and reads the served page, which is what proves the prune removed nothing the runtime loads. The Windows setup is compiled on this host, so the NSIS script is proved to assemble, and the packaged tree's file count is measured directly.

The close path itself is unproven: a Windows Electron binary cannot run on macOS, so no run here reaches the macro. Proving it needs an upgrade install over a running application on Windows.

## Consequences

A Windows install writes 12,504 files instead of 25,490, and the setup is 126.4 MiB instead of 137.6 MiB. The unpacked tree falls from 524.3 MiB to 482.9 MiB — a small share of the win, which is the point: the count moved by half and the bytes barely moved.

The installer force-terminates a running application rather than asking it to exit. Sessions are durable and Windows already maps the supervisor's `SIGTERM` to `TerminateProcess`, so this is the same class of stop the platform's own shutdown path takes; no disposer runs there either.

Anything that later needs a `.ts` file or a documentation-stemmed `.md` at runtime must be added to the exemptions in `pruneClosure`, and a Windows install will not surface the omission until the code path runs.

## Related

The pipeline and the process lifetime this changes are described in [the desktop application Agent Note](../architecture/2026-08-13-electron-desktop-application.md).
