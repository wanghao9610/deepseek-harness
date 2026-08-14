/**
 * Main-thread driver for the Win32 folder dialog: spawns the dialog child
 * process (which blocks inside the modal `Show`), maps its message protocol
 * onto a promise, and services aborts by posting `WM_CLOSE` to the dialog
 * thread's windows until the child reports back. The real process/window
 * surface is injectable so every driver path is testable on any platform.
 */

import type { Readable } from 'node:stream'
import { closeThreadWindows as hostCloseThreadWindows, spawnDialogWorker } from './win32-dialog-host.ts'
import type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** The child-process surface the driver drives (satisfied by `node:child_process`). */
export interface Win32DialogWorkerLike {
  /**
   * Subscribe to a child-process event.
   * @param event - `message`, `error`, or `close`.
   * @param listener - the event consumer.
   */
  on(event: 'message', listener: (message: Win32DialogWorkerMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  /**
   * The child's standard error, or null when the spawn did not pipe it. A
   * child that dies before posting — a load-time throw, a native fault in
   * the COM conversation — leaves its reason here and in no other place the
   * driver can reach, so the retained tail is what its rejection carries.
   */
  readonly stderr: Readable | null
  /**
   * Force-stop the child; the abort path's last resort when `WM_CLOSE`
   * never lands (e.g. the dialog window was never created).
   * @returns whether a kill signal was delivered.
   */
  kill(): boolean
  /**
   * Release the event-loop reference. Called once the pick settles so a
   * child stuck in the native modal call never blocks process exit.
   */
  unref?(): void
}

/** Injectable process surface for deterministic driver tests. */
export interface Win32DialogInternals {
  /** Replaces the real child spawn (`win32-dialog-host.ts`). */
  spawnWorker?: (data: Win32DialogWorkerData) => Win32DialogWorkerLike
  /** Replaces the real `WM_CLOSE` poster (`win32-dialog-host.ts`). */
  closeThreadWindows?: (threadId: number) => Promise<void>
  /** Abort-service cadence override so tests never wait wall-clock time. */
  closeRetryMs?: number
}

/** The dialog title every host shows. */
export const DIALOG_TITLE = 'Select Workspace Directory'

/** `WM_CLOSE` re-post cadence while an abort waits for the worker to unwind. */
const CLOSE_RETRY_MS = 150
/** Abort-service attempts before force-terminating the worker. */
const CLOSE_MAX_ATTEMPTS = 20
/** Characters of worker standard error retained as the diagnostic for a silent exit. */
const STDERR_TAIL_CHARS = 4096

/**
 * Name how the worker ended, for the one rejection whose only evidence is
 * the ending itself.
 *
 * Windows reports a native fault as an NTSTATUS-valued exit code, so a code
 * outside the POSIX status range also carries its hexadecimal form:
 * `0xc0000005` names an access violation where `3221225477` names nothing.
 * @param code - the exit code, or null when a signal ended the worker.
 * @param signal - the signal that ended it, when one did.
 * @returns the phrase naming the ending.
 */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (code === null) return `signal ${signal ?? 'unknown'}`
  if (code >= 0 && code <= 0xff) return `exit code ${String(code)}`
  return `exit code ${String(code)} (0x${(code >>> 0).toString(16)})`
}

/** Fail loudly if the closed worker-to-driver union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop; unreachable without a TypeScript contract violation */
function assertNever(value: never): never {
  throw new TypeError(`unknown win32 dialog worker message kind: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * Open the modern Win32 folder picker off the event loop.
 * @param signal - caller lifetime; abort closes the dialog and rejects.
 * @param internals - Worker/window hooks for deterministic tests.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickWin32Directory(
  signal: AbortSignal,
  internals: Win32DialogInternals = {},
): Promise<string | null> {
  if (signal.aborted) throw new Error('native directory picker aborted')
  const spawnWorker = internals.spawnWorker ?? spawnDialogWorker
  const closeWindows = internals.closeThreadWindows ?? hostCloseThreadWindows
  const closeRetryMs = internals.closeRetryMs ?? CLOSE_RETRY_MS

  const worker: Win32DialogWorkerLike = spawnWorker({ title: DIALOG_TITLE })
  let dialogThreadId: number | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let settled = false
  let stderrTail = ''

  worker.stderr?.setEncoding('utf8')
  worker.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
  })

  return await new Promise<string | null>((resolve, reject) => {
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      if (closeTimer !== undefined) clearInterval(closeTimer)
      signal.removeEventListener('abort', onAbort)
      // A child left in the native modal call must not hold the host open,
      // and the stderr pipe carries an event-loop reference of its own that
      // releasing the process handle does not cover.
      worker.stderr?.destroy()
      worker.unref?.()
      outcome()
    }

    const postClose = (): void => {
      // Before `showing` there is no window to close; the budget below still
      // runs so a child that never reports cannot dangle the pick. A
      // rejected close attempt (EnumThreadWindows/PostMessageW refusing) is
      // discarded: the interval retries it and kill is the backstop.
      if (dialogThreadId !== undefined) void closeWindows(dialogThreadId).catch(() => undefined)
    }

    // Sole caller: the once-registered abort listener, so no re-entry guard.
    const serviceAbort = (): void => {
      let attempts = 0
      // The `showing` notice precedes the blocking `Show`, so the very first
      // WM_CLOSE can race the window's creation; re-post until the child
      // reports back, then force-kill as a last resort. The budget is
      // unconditional — an abort before `showing` (child hung in koffi or
      // COM init) still ends in kill instead of a dangling promise.
      closeTimer = setInterval(() => {
        attempts += 1
        if (attempts > CLOSE_MAX_ATTEMPTS) {
          settle(() => {
            worker.kill()
            reject(new Error('native directory picker aborted (dialog unresponsive; worker killed)'))
          })
          return
        }
        postClose()
      }, closeRetryMs)
      postClose()
    }

    const onAbort = (): void => {
      serviceAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (message: Win32DialogWorkerMessage) => {
      switch (message.kind) {
        case 'showing':
          dialogThreadId = message.threadId
          // An abort that raced ahead of this notice now has a window to hit.
          if (signal.aborted) postClose()
          return
        case 'done':
          settle(() => {
            if (signal.aborted) reject(new Error('native directory picker aborted'))
            else resolve(message.path)
          })
          return
        case 'error':
          settle(() => {
            reject(new Error(`win32 folder dialog failed: ${message.message}`))
          })
          return
        /* v8 ignore next 2 -- closed worker-owned union; a fourth kind becomes a compile error */
        default:
          assertNever(message)
      }
    })
    worker.on('error', (error: Error) => {
      settle(() => {
        reject(error)
      })
    })
    // `close`, not `exit`: the stderr pipe is the only account a worker that
    // died before posting leaves behind, and `exit` can precede its last
    // chunk. Nothing else holds the pipe open, so the worker's own ending
    // always closes it.
    worker.on('close', (code, endingSignal) => {
      settle(() => {
        const account = stderrTail.trim()
        reject(new Error(`win32 folder dialog worker exited before reporting a result (${describeExit(code, endingSignal)})${account === '' ? '' : `: ${account}`}`))
      })
    })
  })
}
