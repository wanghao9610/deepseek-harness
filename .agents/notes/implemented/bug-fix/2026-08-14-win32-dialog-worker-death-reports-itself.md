# Agent Note: a win32 dialog worker that dies reports why

Status: implemented

English | [中文](2026-08-14-win32-dialog-worker-death-reports-itself.zh.md)

## Problem

The workspace picker in the installed Windows [desktop application](../architecture/2026-08-13-electron-desktop-application.md) failed with `directory picker failed: directory picker failed: win32 folder dialog worker exited before reporting a result`.

That sentence was everything the product knew. The [dialog driver](../feature/2026-08-02-win32-in-process-folder-dialog.md) held three facts about the child that died — its exit code, its signal, and everything it printed — and put none of them in the rejection: `exit` was handled as `() => reject(...)`, and standard error was inherited into the host's own, which in a packaged application is a log file under `%APPDATA%` that no user opens and no error message quotes. A load-time throw, a native access violation inside the COM conversation, and an IPC channel closed under the modal call all produce that identical sentence, and the exit code is the only thing that separates them. The prefix arrived doubled because the Host RPC and its Consumer each named the operation, which spent the beginning of a one-line dialog message saying the same thing twice.

The arm it failed on was the arm nothing tested. The source plane has a real-Windows smoke, and it passes; the packaged plane — the bundled CJS worker running the whole COM conversation — had never run under any test, which [the dialog note](../feature/2026-08-02-win32-in-process-folder-dialog.md) recorded as a named gap. Two defects were sitting in that untested arm, and a third in the path a successful pick returns through.

## Decision

A worker that dies before reporting now rejects with how it ended and what it said. Standard error is piped rather than inherited, and `pickWin32Directory` retains a bounded tail of it; the rejection names the ending through `describeExit` and appends that tail. Windows reports a native fault as an NTSTATUS-valued exit code, so a code outside the POSIX status range carries its hexadecimal form too — `0xc0000005` names an access violation where `3221225477` names nothing. The driver settles on `close` rather than `exit`, because `exit` can precede the child's last stderr chunk and that chunk is the one that explains a load-time throw; nothing but the worker holds the pipe open, so its ending always closes it.

Three defects on that path are fixed with it.

**Only the outcome closes the IPC channel.** The worker's `post` sent every message with a completion callback that disconnected, and its own `disconnect` handler exits the process — so the `showing` notice, which precedes a modal call that runs for as long as the user browses, armed a teardown underneath it. `post` now sends; a separate `finish` sends the outcome and closes behind it.

**The COM string ends at a zero code unit, not a zero byte.** `readUtf16` scanned bytes, so a character whose code point is a multiple of 0x100 — U+4E00 一 among them — ended the path early: `C:\项目一号\src` came back as `C:\项目`. The picker returned a directory the user had not chosen, silently, with no error anywhere.

**The Host RPC reports the cause alone.** Every Consumer names the failing operation itself, and the response is already the answer to one request.

The built-artifact guard now drives the bundled worker through a real dialog on win32 — open, `showing`, close the dialog thread's windows, and assert the outcome still arrives — rather than skipping the platform it exists for. It asserts the outcome and not merely the open, because a worker that dies between the notice and its result is invisible to a test that stops at the notice.

## Alternatives considered

**Diagnose the Windows failure first and fix that one cause.** The mechanism could not be identified from the evidence the product produced: the message is the same for all three, and the exit code that separates them is what the driver was discarding. Reproduction needs the packaged application on Windows, which no lane here can build and run. Fixing what is provable and making the rest self-reporting gets a correct change now and a named cause from the next occurrence, instead of a guess shipped as a fix.

**Leave standard error inherited and read the desktop runtime log.** The reason is already written there today — this is how the log is designed to work. It is also a file the person hitting the failure does not know exists, reached through a path they would have to be told, while the message they actually see still says nothing. A diagnostic that needs a second artifact is not a diagnostic for the user, and the failure is theirs before it is a maintainer's.

**Settle on `exit` and take whatever standard error had arrived.** Simpler, and wrong in the case that matters: the last chunk before a load-time throw is routinely the one still in flight when `exit` fires, so the rejection would be empty exactly when it had something to say.

**Keep one `post` and let it disconnect after every message.** The teardown is latent rather than certain — the modal call blocks the loop, so the completion callback cannot run before the outcome is sent — but it arms a process exit underneath an operation still in flight, on the one path whose duration is a person browsing a filesystem. A lifecycle that is safe only because of what the event loop happens to be blocked on is not one to leave in place while chasing a failure with this signature.

**Fall back to another picker mechanism when the child dies.** Rejected before, in [the chain removal](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md), and rejected again for the same reason: it converts a reportable failure into a silent downgrade. The browse backend remains the fallback at the composition level.

## Consequences

- A dialog child that dies before reporting names its ending and quotes what it printed, so the next Windows report identifies the mechanism instead of restating the symptom.
- Chinese and other non-ASCII paths through a zero-low-byte character now come back whole. Any workspace opened at a truncated path was opened at a directory the user did not pick.
- The bundled worker's COM conversation is covered on win32, closing the packaged-worker half of the gap [the dialog note](../feature/2026-08-02-win32-in-process-folder-dialog.md) named. The guard needs a real Windows session with a desktop, so the self-hosted Windows lane is what runs it.
- The remaining half of that gap is unchanged: the packaged **executable** spawning itself as the dialog entry — Electron in `ELECTRON_RUN_AS_NODE` mode rather than `node` — is still exercised by nothing, because no lane packages the desktop application. That launch was confirmed by hand to load the built worker, resolve koffi, and carry the IPC channel; what a Windows machine adds to it is untested.
- The Host's `pickDirectory` error message is the cause verbatim. A Consumer that does not name the operation shows a bare cause.
