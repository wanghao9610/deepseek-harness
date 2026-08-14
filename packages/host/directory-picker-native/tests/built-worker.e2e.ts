/**
 * Keyless built-artifact guard (the `dsh-workflow-worker-thread` built-worker
 * shape): plain `node` runs `lib/worker.cjs` and the bundle reaches its
 * real koffi requires. POSIX hosts prove the load path end to end through
 * the deterministic ole32 rejection; win32 hosts run the whole COM
 * conversation against the built bundle and prove the outcome still arrives
 * after the `showing` notice — the packaged arm, which the source-plane
 * smoke in win32-dialog.spec.ts cannot reach and which only ever ran in a
 * shipped application. Skips until a build produces the artifact.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { closeThreadWindows } from '../src/win32-dialog-bindings.ts'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

const builtWorker = fileURLToPath(new URL('../lib/worker.cjs', import.meta.url))

/** How the built worker is launched wherever this guard drives it. */
function spawnBuilt(): ReturnType<typeof spawn> {
  return spawn(process.execPath, [builtWorker], {
    env: { ...process.env, DSH_DIALOG_TITLE: 'Built-artifact guard' },
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    windowsHide: true,
  })
}

/**
 * Retain a child's standard error, which is the whole account of a worker
 * that dies before posting.
 * @param child - the spawned worker.
 * @returns a reader for everything it has printed so far.
 */
function retainStderr(child: ReturnType<typeof spawn>): () => string {
  let text = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { text += chunk })
  return () => text
}

describe.skipIf(!existsSync(builtWorker) || process.platform === 'win32')('built dialog worker (lib/worker.cjs)', () => {
  it('loads under plain node and reports the native-surface failure', async () => {
    const message = await new Promise<Win32DialogWorkerMessage>((resolve, reject) => {
      const child = spawnBuilt()
      const stderr = retainStderr(child)
      child.on('message', resolve)
      child.on('error', reject)
      child.on('close', (code) => {
        reject(new Error(`worker exited (${String(code)}) before reporting: ${stderr()}`))
      })
    })
    expect(message.kind).toBe('error')
    expect((message as { kind: 'error'; message: string }).message).toMatch(/ole32|koffi/i)
  }, 30_000)
})

// The arm a packaged application runs and nothing else did: the bundled CJS
// worker opening a real dialog. It asserts the outcome rather than only the
// open, because the failure this guard exists for — a worker that dies
// between `showing` and its result — is invisible to a test that stops at
// the notice.
describe.skipIf(!existsSync(builtWorker) || process.platform !== 'win32')('built dialog worker on win32 (lib/worker.cjs)', () => {
  it('opens a real dialog and still reports the outcome after the showing notice', async () => {
    const child = spawnBuilt()
    const stderr = retainStderr(child)
    const seen: Win32DialogWorkerMessage[] = []
    let closing: NodeJS.Timeout | undefined
    const outcome = new Promise<Win32DialogWorkerMessage>((resolve, reject) => {
      child.on('message', (message: Win32DialogWorkerMessage) => {
        seen.push(message)
        if (message.kind !== 'showing') {
          resolve(message)
          return
        }
        // Closing the dialog thread's windows is the same lever the driver's
        // abort service pulls, re-posted on the same cadence: the notice
        // precedes the blocking `Show`, so the first WM_CLOSE can race the
        // window into existence. `Show` then returns cancelled and the worker
        // unwinds through its ordinary result path.
        const post = (): void => { void closeThreadWindows(message.threadId).catch(() => undefined) }
        closing = setInterval(post, 150)
        post()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        reject(new Error(`worker exited (${String(code)}) after ${JSON.stringify(seen)}: ${stderr()}`))
      })
    })
    try {
      expect(await outcome).toStrictEqual({ kind: 'done', path: null })
      expect(seen[0]).toMatchObject({ kind: 'showing' })
    } finally {
      if (closing !== undefined) clearInterval(closing)
      child.kill()
    }
  }, 30_000)
})
