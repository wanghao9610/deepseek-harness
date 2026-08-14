/**
 * Build the server payload a desktop shell sends to a host with no network.
 *
 * The payload is the same deployed closure the desktop application embeds,
 * packed as one archive with a manifest naming the version and the platform it
 * was built for. It is built for THIS machine: the closure carries compiled
 * native modules — `node-pty` among them, which the runtime imports at boot —
 * so a payload runs only on a host whose platform and architecture match the
 * machine that produced it. Build it on the target platform, or in CI for that
 * platform; the manifest is what lets the shell refuse a mismatch instead of
 * shipping a runtime that cannot start.
 *
 * Usage: `pnpm run package:remote-server [-- --out <dir>] [--skip-deploy]`
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { PAYLOAD_DIGEST_LENGTH } from '@deepseek-ai/dsh-ssh-launch'
import { deployWorkspaceClosure, runCommand } from './deploy-closure.ts'

const root = resolve(import.meta.dirname, '..')

/** Diagnostic prefix on this script's logs and errors. */
const PREFIX = 'package-remote-server'

/** Workspace package whose dependency closure the payload carries. */
const DEPLOY_PACKAGE = 'dsh-desktop-runtime-pkg'

/** Manifest file the archive carries at its root, which the shell reads. */
const MANIFEST_NAME = 'dsh-server.json'

/**
 * Name the platform the way `uname -s` does, so the shell can compare a
 * manifest against a host without translating either.
 * @param value - `os.platform()`.
 * @returns the `uname -s` spelling.
 */
function unamePlatform(value: NodeJS.Platform): string {
  if (value === 'darwin') return 'Darwin'
  if (value === 'linux') return 'Linux'
  throw new Error(`${PREFIX}: ${value} hosts cannot serve a remote runtime over SSH`)
}

/**
 * Name the architecture the way `uname -m` does.
 * @param value - `os.arch()`.
 * @returns the `uname -m` spelling.
 */
function unameArch(value: string): string {
  if (value === 'arm64') return 'arm64'
  if (value === 'x64') return 'x86_64'
  throw new Error(`${PREFIX}: ${value} is not an architecture a payload is built for`)
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

/** Build the payload. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: {
      out: { type: 'string' },
      'skip-deploy': { type: 'boolean', default: false },
    },
  })
  const outDir = resolve(root, values.out ?? 'dist/remote-server')
  const staging = join(outDir, 'closure')
  const launcher = JSON.parse(await readFile(join(root, 'apps', 'cli', 'package.json'), 'utf8')) as { version: string }
  const manifest = {
    version: launcher.version,
    platform: unamePlatform(platform()),
    arch: unameArch(arch()),
  }

  await mkdir(outDir, { recursive: true })
  if (values['skip-deploy']) console.log(`${PREFIX}: reusing the closure already in ${staging}`)
  else {
    console.log(`${PREFIX}: deploying the runtime closure for ${manifest.platform} ${manifest.arch}`)
    await deployWorkspaceClosure({
      root,
      packageName: DEPLOY_PACKAGE,
      staging,
      sourceNodeModules: join(root, 'apps', 'desktop', 'runtime', 'node_modules'),
      prefix: PREFIX,
      dryRun: false,
    })
  }
  await writeFile(join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, undefined, 2)}\n`)

  const archive = join(outDir, `dsh-server-${manifest.platform}-${manifest.arch}-${manifest.version}.tar.gz`)
  await rm(archive, { force: true })
  console.log(`${PREFIX}: packing ${archive}`)
  await runCommand({
    label: 'tar',
    command: 'tar',
    // Ownership and macOS extended attributes belong to this machine, not to
    // the host that unpacks the payload as another user.
    args: ['--no-xattrs', '--numeric-owner', '-czf', archive, '-C', staging, '.'],
    cwd: root,
    prefix: PREFIX,
    dryRun: false,
    extraEnv: { COPYFILE_DISABLE: '1' },
  })
  const size = (await stat(archive)).size
  console.log(`${PREFIX}: ${archive}`)
  console.log(`${PREFIX}: ${String(Math.round(size / (1024 * 1024)))} MiB, digest ${await digestFile(archive)}`)
  console.log(`${PREFIX}: point a desktop connection at this file to serve a host with no network`)
}

await main()
