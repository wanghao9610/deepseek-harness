import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { JsonWriteCommittedError } from '../src/atomic.ts'
import { openJsonUnit } from '../src/unit.ts'

const { writeAtomicMock } = vi.hoisted(() => ({ writeAtomicMock: vi.fn() }))

vi.mock('../src/atomic.ts', () => ({
  writeAtomic: writeAtomicMock,
  JsonWriteCommittedError: class JsonWriteCommittedError extends Error {
    constructor(cause: unknown) {
      super('committed JSON unit write is not crash-durable', { cause })
      this.name = 'JsonWriteCommittedError'
    }
  },
}))

const descriptor = { name: 'shape', version: 1, tables: ['t'], hasGlobal: true }

/** Open a unit whose publish is fully mocked; the backing file never exists. */
async function freshUnit(): Promise<Awaited<ReturnType<typeof openJsonUnit>>> {
  return openJsonUnit(descriptor, join(tmpdir(), 'dsh-json-unit-' + Math.random().toString(36).slice(2) + '.json'), () => {})
}

describe('JsonKvUnit rollback vs committed writes', () => {
  it('rolls a failed pre-commit publish back out of memory', async () => {
    writeAtomicMock.mockRejectedValueOnce(new Error('write failed before commit'))
    const unit = await freshUnit()
    await expect(unit.putRecord('t', 'k', 'value')).rejects.toThrow('write failed before commit')
    const state = await unit.loadAll()
    expect(state.tables.t?.k).toBeUndefined()
  })

  it('restores the previous record when an overwrite fails before commit', async () => {
    writeAtomicMock.mockResolvedValueOnce(undefined)
    writeAtomicMock.mockRejectedValueOnce(new Error('second write failed'))
    const unit = await freshUnit()
    await unit.putRecord('t', 'k', 'first')
    await expect(unit.putRecord('t', 'k', 'second')).rejects.toThrow('second write failed')
    expect((await unit.loadAll()).tables.t?.k).toBe('first')
  })

  it('keeps the committed value when the directory fsync fails after the rename', async () => {
    writeAtomicMock.mockRejectedValueOnce(new JsonWriteCommittedError(new Error('fsync boom')))
    const unit = await freshUnit()
    await expect(unit.putRecord('t', 'k', 'committed')).rejects.toThrow(JsonWriteCommittedError)
    // The file already holds the new value; memory must agree, not roll back.
    expect((await unit.loadAll()).tables.t?.k).toBe('committed')
  })

  it('keeps a committed delete (key stays absent) when the fsync fails after the rename', async () => {
    writeAtomicMock.mockResolvedValueOnce(undefined)
    writeAtomicMock.mockRejectedValueOnce(new JsonWriteCommittedError(new Error('fsync boom')))
    const unit = await freshUnit()
    await unit.putRecord('t', 'k', 'value')
    await expect(unit.deleteRecord('t', 'k')).rejects.toThrow(JsonWriteCommittedError)
    expect((await unit.loadAll()).tables.t?.k).toBeUndefined()
  })

  it('keeps a committed global when the fsync fails after the rename', async () => {
    writeAtomicMock.mockRejectedValueOnce(new JsonWriteCommittedError(new Error('fsync boom')))
    const unit = await freshUnit()
    await expect(unit.setGlobal('committed')).rejects.toThrow(JsonWriteCommittedError)
    expect((await unit.loadAll()).global).toBe('committed')
  })

  it('rolls a failed pre-commit global write back', async () => {
    writeAtomicMock.mockRejectedValueOnce(new Error('write failed before commit'))
    const unit = await freshUnit()
    await expect(unit.setGlobal('value')).rejects.toThrow('write failed before commit')
    expect((await unit.loadAll()).global).toBeNull()
  })
})
