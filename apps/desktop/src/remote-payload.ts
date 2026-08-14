/**
 * Sending a server payload to a host that cannot reach a registry.
 *
 * The shell reads what the archive says it is, asks the host what it is and
 * whether it already carries this payload, and streams the archive into an
 * `ssh` that unpacks it. Nothing is staged on either machine: the archive goes
 * from this disk to that `tar` over the one connection.
 * @module @deepseek-ai/dsh-desktop/remote-payload
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  describePayloadMismatch,
  PAYLOAD_DIGEST_LENGTH,
  planPayloadProbe,
  planPayloadTransfer,
  readHostProbe,
  type ArchivePayload,
  type SshCommandPlan,
  type SshTarget,
} from '@deepseek-ai/dsh-ssh-launch'

/** Manifest the archive carries at its root, as the builder wrote it. */
const MANIFEST_ENTRY = './dsh-server.json'

/** How often the transfer reports how far it has got. */
const PROGRESS_STEP_PERCENT = 5

/** What one payload step needs from the application. */
export interface PayloadOptions {
  /** The connection this payload is for. */
  target: SshTarget
  /** Absolute path of the archive on this machine. */
  archive: string
  /** Environment `ssh` runs with, already merged from the login shell. */
  env: Readonly<Record<string, string>>
  /**
   * Report what this step is doing.
   * @param detail - one short present-tense note.
   */
  report: (detail: string) => void
  /**
   * Receive everything the commands print.
   * @param chunk - decoded output.
   */
  onOutput: (chunk: string) => void
  /** Ends the step when the start it belongs to is cancelled. */
  signal: AbortSignal
}

/**
 * Run one `ssh` command and collect what it printed.
 * @param plan - the command to run.
 * @param options - environment and output sink.
 * @returns its exit code and combined output.
 */
function runPlan(
  plan: SshCommandPlan,
  options: Pick<PayloadOptions, 'env' | 'onOutput' | 'signal'>,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, [...plan.args], {
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        output += chunk
        options.onOutput(chunk)
      })
    }
    child.once('error', reject)
    child.once('close', (exitCode) => { resolve({ exitCode, output }) })
  })
}

/**
 * Read what an archive says it is.
 *
 * The manifest is read with the `tar` this machine already has rather than a
 * bundled decoder, which is the same tool the host unpacks it with.
 * @param archive - absolute path of the archive.
 * @param onOutput - receives what `tar` printed.
 * @param signal - ends the read when the start it belongs to is cancelled.
 * @returns the payload's identity, digest included.
 */
export async function readArchivePayload(
  archive: string,
  onOutput: (chunk: string) => void,
  signal: AbortSignal,
): Promise<ArchivePayload> {
  const manifest = await runPlan(
    { command: 'tar', args: ['-xzOf', archive, MANIFEST_ENTRY] },
    { env: process.env as Record<string, string>, onOutput, signal },
  )
  if (manifest.exitCode !== 0) {
    throw new Error(`"${archive}" is not a dsh server payload; build one with pnpm run package:remote-server`)
  }
  let declared: unknown
  try {
    declared = JSON.parse(manifest.output)
  } catch {
    // The entry exists but is not the manifest this build writes.
    declared = undefined
  }
  if (typeof declared !== 'object' || declared === null) {
    throw new Error(`"${archive}" carries no readable server manifest`)
  }
  const { version, platform, arch } = declared as Record<string, unknown>
  if (typeof version !== 'string' || typeof platform !== 'string' || typeof arch !== 'string') {
    throw new Error(`"${archive}" carries a server manifest this build cannot read`)
  }
  return { version, platform, arch, digest: await digestFile(archive) }
}

/**
 * Digest one file.
 * @param path - the file to read.
 * @returns the leading hex characters of its SHA-256.
 */
async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array)
  return hash.digest('hex').slice(0, PAYLOAD_DIGEST_LENGTH)
}

/**
 * Put the payload on the host, unless it is already there.
 *
 * A host that answers with another platform is refused rather than sent a
 * payload it cannot run: the closure carries compiled modules the runtime
 * imports at boot, so the failure would otherwise arrive as a runtime that
 * never starts.
 * @param payload - what the archive says it is.
 * @param options - the connection, the archive, and where to report.
 */
export async function ensurePayload(payload: ArchivePayload, options: PayloadOptions): Promise<void> {
  options.report('checking the host')
  const probed = await runPlan(planPayloadProbe(options.target, payload), options)
  const host = readHostProbe(probed.output)
  if (host === undefined) {
    throw new Error('the host did not answer what it is; the runtime log holds what ssh reported')
  }
  const mismatch = describePayloadMismatch(payload, host)
  if (mismatch !== undefined) throw new Error(mismatch)
  if (host.present) return

  const size = (await stat(options.archive)).size
  options.report('sending the server payload')
  await transfer(payload, size, options)
}

/**
 * Stream the archive into the `ssh` that unpacks it.
 * @param payload - what the archive says it is.
 * @param size - the archive's size, which turns bytes written into progress.
 * @param options - the connection, the archive, and where to report.
 */
function transfer(payload: ArchivePayload, size: number, options: PayloadOptions): Promise<void> {
  const plan = planPayloadTransfer(options.target, payload)
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, [...plan.args], {
      env: { ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        output += chunk
        options.onOutput(chunk)
      })
    }
    let sent = 0
    let reported = 0
    const source = createReadStream(options.archive)
    source.on('data', (chunk) => {
      sent += chunk.length
      const percent = Math.floor((sent / size) * 100)
      if (percent < reported + PROGRESS_STEP_PERCENT) return
      reported = percent
      options.report(`sending the server payload (${String(percent)}%)`)
    })
    source.on('error', reject)
    // Swallows the EPIPE this pipe reports when ssh refuses the payload first:
    // the exit handler owns what that means, and it has the diagnosis.
    child.stdin.on('error', () => {})
    source.pipe(child.stdin)
    child.once('error', reject)
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolve()
        return
      }
      reject(new Error(`sending the server payload failed (exit code ${String(exitCode)}); ${output.trim().split('\n').at(-1) ?? 'the runtime log holds what ssh reported'}`))
    })
  })
}
