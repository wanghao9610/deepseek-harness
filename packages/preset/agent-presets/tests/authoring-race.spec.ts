import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { copyComposition, PresetExistsError, type AgentPreset } from '../src/index.ts'

const { statImpl, cpImpl } = vi.hoisted(() => ({
  statImpl: vi.fn<() => Promise<unknown>>(),
  cpImpl: vi.fn<() => Promise<unknown>>(),
}))

// Drive the occupied-probe/cp race deterministically: stat reports the id
// absent (the probe misses) while cp loses the race with EEXIST. All other
// filesystem calls stay real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: statImpl,
    cp: cpImpl,
  }
})

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const source = { path: join(tmpdir(), 'source.yml') } as unknown as AgentPreset

describe('copyComposition race handling', () => {
  it('throws PresetExistsError and preserves the winner directory on EEXIST', async () => {
    statImpl.mockImplementation(async () => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    })
    cpImpl.mockRejectedValueOnce(Object.assign(new Error('destination exists'), { code: 'EEXIST' }))
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-race-'))
    roots.push(root)
    await mkdir(join(root, 'taken'))

    const error = await copyComposition([{ trust: 'user', path: root }], source, 'taken').then(
      () => { throw new Error('copy unexpectedly succeeded') },
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(PresetExistsError)
    // The loser must not delete the directory the concurrent winner created.
    expect(await readdir(root)).toContain('taken')
  })

  it('removes a half-copied directory on any other failure', async () => {
    statImpl.mockImplementation(async () => {
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    })
    cpImpl.mockRejectedValueOnce(Object.assign(new Error('source missing'), { code: 'ENOENT' }))
    const root = await mkdtemp(join(tmpdir(), 'dsh-preset-race-'))
    roots.push(root)

    const error = await copyComposition([{ trust: 'user', path: root }], source, 'fresh').then(
      () => { throw new Error('copy unexpectedly succeeded') },
      (err: unknown) => err,
    )

    expect((error as Error).message).toContain('source missing')
    await expect(readdir(join(root, 'fresh'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
