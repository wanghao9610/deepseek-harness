/**
 * Atomic whole-file replacement for the JSON backend.
 *
 * Publish protocol: write a same-directory temp file, fsync it, then
 * `rename()` over the target. Rename is an atomic replace on POSIX and on
 * Windows (libuv maps it to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`),
 * and replacement is the intended semantic here — unlike the session-log
 * backend's link()+unlink() no-clobber protocol, a unit file has exactly one
 * writer per process and last-write-wins is correct. After the rename the
 * parent directory is fsynced on POSIX so the new entry is crash-durable.
 * @module @deepseek-ai/dsh-storage-json/src/atomic
 */

import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Thrown when the rename committed but the parent directory could not be
 * fsynced: the new value IS in place (memory and disk agree), only the
 * crash-durability of the directory entry is unproven. Callers must not roll
 * authoritative state back on this error.
 */
export class JsonWriteCommittedError extends Error {
  /** @param cause - the directory-fsync failure. */
  constructor(cause: unknown) {
    super('committed JSON unit write is not crash-durable', { cause })
    this.name = 'JsonWriteCommittedError'
  }
}

/**
 * Durably replace `path` with `data`.
 * @param path - Absolute target file path.
 * @param data - Full new file content.
 * @returns resolution after the replacement is crash-durable; a directory-fsync
 * failure rejects with {@link JsonWriteCommittedError} after the rename already
 * committed (the value is in place, its durability unproven).
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    try {
      await fsyncDirectory(dirname(path))
    } catch (error) {
      throw new JsonWriteCommittedError(error)
    }
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** fsync a POSIX directory so a just-renamed entry is crash-durable. */
/* v8 ignore start -- Windows rejects O_RDONLY directory opens; POSIX coverage exercises this. */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */
