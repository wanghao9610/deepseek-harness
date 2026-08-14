/** Persisted shell preferences, including geometry read against the current displays. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from '../src/store.ts'
import { DEFAULT_GEOMETRY } from '../src/window-state.ts'

const laptop = { x: 0, y: 25, width: 1512, height: 945 }

let directory: string
let path: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-store-'))
  path = join(directory, 'nested', 'desktop-settings.json')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('serves defaults with no file', () => {
    const store = new SettingsStore(path)
    expect(store.readGeometry([laptop])).toEqual(DEFAULT_GEOMETRY)
    expect(store.readIdleSuspend()).toBe(true)
  })

  it('serves defaults for a file it cannot parse', async () => {
    await writeFile(join(directory, 'broken.json'), 'not json')
    const store = new SettingsStore(join(directory, 'broken.json'))
    expect(store.readGeometry([laptop])).toEqual(DEFAULT_GEOMETRY)
    expect(store.readIdleSuspend()).toBe(true)
  })

  it('round-trips geometry through the file', async () => {
    const store = new SettingsStore(path)
    store.writeGeometry({ x: 40, y: 60, width: 1000, height: 700 })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      geometry: { x: 40, y: 60, width: 1000, height: 700 },
    })
    expect(new SettingsStore(path).readGeometry([laptop])).toEqual({ x: 40, y: 60, width: 1000, height: 700 })
  })

  it('validates stored geometry on every read, not once', () => {
    const store = new SettingsStore(path)
    store.writeGeometry({ x: 40, y: 60, width: 1000, height: 700 })
    // A read taken while a display is absent must not poison the next one.
    expect(store.readGeometry([])).toEqual({ width: 1000, height: 700 })
    expect(store.readGeometry([laptop])).toEqual({ x: 40, y: 60, width: 1000, height: 700 })
  })

  it('keeps geometry when the idle setting changes', async () => {
    const store = new SettingsStore(path)
    store.writeGeometry({ x: 10, y: 20, width: 900, height: 600 })
    store.writeIdleSuspend(false)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      geometry: { x: 10, y: 20, width: 900, height: 600 },
      idleSuspend: false,
    })
    expect(new SettingsStore(path).readIdleSuspend()).toBe(false)
  })

  it('treats any stored value but false as idle suspension on', () => {
    const store = new SettingsStore(path)
    store.writeIdleSuspend(true)
    expect(store.readIdleSuspend()).toBe(true)
  })

  it('serves this machine and no connections until some are stored', () => {
    const store = new SettingsStore(path)
    expect(store.readConnections()).toEqual([])
    expect(store.readActiveConnection()).toBeUndefined()
  })

  it('keeps connections and the chosen one across restarts', () => {
    const store = new SettingsStore(path)
    store.writeConnections([{ id: 'box', label: 'Dev box', host: 'dev-box', port: 2222 }])
    store.writeActiveConnection('box')
    const reopened = new SettingsStore(path)
    expect(reopened.readConnections()).toEqual([{ id: 'box', label: 'Dev box', host: 'dev-box', port: 2222 }])
    expect(reopened.readActiveConnection()).toBe('box')
  })

  it('returns to this machine when the choice is cleared', () => {
    const store = new SettingsStore(path)
    store.writeActiveConnection('box')
    store.writeActiveConnection(undefined)
    expect(new SettingsStore(path).readActiveConnection()).toBeUndefined()
  })

  it('drops a stored connection this build cannot use, keeping the rest', async () => {
    const store = new SettingsStore(path)
    store.writeConnections([{ id: 'box', label: 'Dev box', host: 'dev-box' }])
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({
      ...document,
      connections: [{ id: 'broken', label: 'Broken' }, ...document.connections as unknown[]],
    }))
    expect(new SettingsStore(path).readConnections().map(entry => entry.id)).toEqual(['box'])
  })
})
