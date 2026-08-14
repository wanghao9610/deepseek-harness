/** What one window shows, given the condition of the connection it serves from. */

import { describe, expect, it } from 'vitest'
import { surfaceFor } from '../src/surface.ts'

describe('surfaceFor', () => {
  it('shows the harness UI of a runtime that is ready', () => {
    expect(surfaceFor({ status: 'ready', url: 'http://127.0.0.1:5321' }, false))
      .toEqual({ kind: 'app', url: 'http://127.0.0.1:5321' })
  })

  it('shows the connection list over anything, because it is about the window', () => {
    expect(surfaceFor({ status: 'ready', url: 'http://127.0.0.1:5321' }, true))
      .toEqual({ kind: 'boot', state: 'connections', note: '' })
  })

  it('carries the reason a start failed, and what a slow one is doing', () => {
    expect(surfaceFor({ status: 'failed', reason: 'the host refused the key' }, false))
      .toEqual({ kind: 'boot', state: 'failed', note: 'the host refused the key' })
    expect(surfaceFor({ status: 'starting', attempt: 0, detail: 'installing' }, false))
      .toEqual({ kind: 'boot', state: 'starting', note: 'installing' })
    expect(surfaceFor({ status: 'starting', attempt: 0 }, false))
      .toEqual({ kind: 'boot', state: 'starting', note: '' })
  })

  it('waits on the boot page while a runtime is between runs', () => {
    expect(surfaceFor({ status: 'restarting', attempt: 1, delayMs: 500 }, false))
      .toEqual({ kind: 'boot', state: 'restarting', note: '' })
    expect(surfaceFor({ status: 'stopped' }, false))
      .toEqual({ kind: 'boot', state: 'stopped', note: '' })
  })

  it('treats a connection nothing has reported yet as one that is not running', () => {
    expect(surfaceFor(undefined, false)).toEqual({ kind: 'boot', state: 'stopped', note: '' })
  })
})
