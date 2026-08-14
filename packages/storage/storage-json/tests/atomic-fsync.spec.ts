import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { JsonWriteCommittedError, writeAtomic } from '../src/atomic.ts'

// Directories reject fsync on some filesystems. Simulate that for the
// directory handle fsyncDirectory opens (flags 'r') — the only way
// writeAtomic opens a directory; every other filesystem call stays real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (path: string | Buffer | URL, flags: string | number) => {
      if (flags === 'r') {
        throw Object.assign(new Error('directory fsync unsupported'), { code: 'EIO' })
      }
      return actual.open(path, flags)
    },
  }
})

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('writeAtomic with a failing directory fsync', () => {
  it('rejects with JsonWriteCommittedError after the rename already committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-json-atomic-'))
    roots.push(root)
    const path = join(root, 'unit.json')

    const error = await writeAtomic(path, '{"new":true}').then(
      () => { throw new Error('writeAtomic unexpectedly succeeded') },
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(JsonWriteCommittedError)
    // The rename ran before the directory fsync: the new value is on disk even
    // though the write reports failure.
    expect(await readFile(path, 'utf8')).toBe('{"new":true}')
  })
})
