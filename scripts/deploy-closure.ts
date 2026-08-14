/**
 * Materialize a workspace deploy root into a symlink-free directory tree.
 *
 * `pnpm deploy --legacy` is the only deploy path with workspace injection off,
 * and it leaves two things behind that a packaged artifact cannot ship: direct
 * dependencies hoisted back beside the deploy source, and package links whose
 * targets live outside the tree. Both are repaired here so every consumer —
 * the single-executable build and the desktop application — packages the same
 * kind of closure.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'

/** One command run, with the caller's diagnostic prefix. */
export interface CommandOptions {
  /** Step name used in logs and error messages. */
  label: string
  /** The executable. */
  command: string
  /** Its arguments, verbatim. */
  args: readonly string[]
  /** Working directory. */
  cwd: string
  /** Diagnostic prefix identifying the calling script. */
  prefix: string
  /** Print the command instead of running it. */
  dryRun: boolean
  /** Extra environment variables merged over `CI=true`. */
  extraEnv?: NodeJS.ProcessEnv
}

/** What one closure deployment needs. */
export interface DeployClosureOptions {
  /** Repository root. */
  root: string
  /** Workspace package name of the deploy root. */
  packageName: string
  /** Directory receiving the closure; cleared first. */
  staging: string
  /** The deploy root's own `node_modules`, where legacy deploy may hoist direct dependencies. */
  sourceNodeModules: string
  /** Diagnostic prefix identifying the calling script. */
  prefix: string
  /** Print every command and filesystem change instead of performing it. */
  dryRun: boolean
}

/** The package manager binary for this platform. */
export function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Run one subprocess with inherited stdio, failing loud with the command.
 * @param options - the command, its context, and the diagnostic prefix.
 */
export async function runCommand(options: CommandOptions): Promise<void> {
  const printable = formatCommand(options.command, options.args)
  if (options.dryRun) {
    console.log(`${options.prefix}: [dry-run] ${printable}`)
    return
  }
  console.log(`${options.prefix}: ${options.label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: 'inherit',
      // Artifact builds must not mutate or validate a developer's Git hooks.
      env: { ...process.env, CI: 'true', ...options.extraEnv },
    })
    child.once('error', (error) => {
      reject(new Error(`${options.prefix}: ${options.label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${String(code)}`
      reject(new Error(`${options.prefix}: ${options.label} failed (${cause}): ${printable}`))
    })
  })
}

/**
 * Deploy one workspace package's production closure into a symlink-free tree.
 *
 * The deploy flags are load-bearing: `--legacy` is the mandatory path with
 * workspace injection off; a hoisted linker gives one flat instance of every
 * package; disabling automatic peer installation keeps undeclared peers from
 * expanding the closure; linking workspace packages selects the in-repository
 * sources over anything a registry would resolve; and unused patches are
 * allowed because a filtered `--prod` deploy of one package does not install
 * every patched dependency the root workspace declares. The full-workspace
 * install still fails on unused patches.
 * @param options - deploy root, destination, and diagnostics.
 */
export async function deployWorkspaceClosure(options: DeployClosureOptions): Promise<void> {
  if (options.staging === options.root || options.root.startsWith(options.staging + sep)) {
    throw new Error(`${options.prefix}: refusing to clear staging dir ${options.staging}: it contains the repo root.`)
  }
  if (options.dryRun) console.log(`${options.prefix}: [dry-run] rm -rf ${options.staging}`)
  else await rm(options.staging, { recursive: true, force: true })
  try {
    await runCommand({
      label: 'deploy',
      command: pnpmBin(),
      args: [
        '--filter',
        options.packageName,
        'deploy',
        '--legacy',
        '--prod',
        '--config.node-linker=hoisted',
        '--config.auto-install-peers=false',
        '--config.link-workspace-packages=true',
        '--config.allowUnusedPatches=true',
        options.staging,
      ],
      cwd: options.root,
      prefix: options.prefix,
      dryRun: options.dryRun,
    })
    await restoreLegacyHoists(options)
    await materializeStagedLinks(options)
  } finally {
    await restoreWorkspaceInstallState(options)
  }
}

/**
 * Return the checkout to its own install settings.
 *
 * A deploy records the flags it ran with in the workspace install state, and
 * pnpm reconciles that state before the next `pnpm run` — which would reinstall
 * the checkout production-only and remove every development dependency the rest
 * of this build needs. Reinstalling with the repository's own settings rewrites
 * the record; with a warm store it costs seconds.
 * @param options - repository root and diagnostics.
 */
async function restoreWorkspaceInstallState(options: DeployClosureOptions): Promise<void> {
  await runCommand({
    label: 'restore workspace install state',
    command: pnpmBin(),
    args: ['install'],
    cwd: options.root,
    prefix: options.prefix,
    dryRun: options.dryRun,
  })
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target. The deploy manifest supplies every peer, so
 * package-local `node_modules` trees are omitted to preserve one flat instance
 * of each package and a symlink-free payload.
 * @param options - deploy root, destination, and diagnostics.
 */
async function restoreLegacyHoists(options: DeployClosureOptions): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.prefix}: [dry-run] restore direct dependencies omitted by legacy deploy`)
    return
  }
  const manifestPath = join(options.staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(options.staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(options.sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(`${options.prefix}: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`)
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyWithoutNestedModules(source, destination)
    restored.push(dependency)
  }
  const stillMissing = Object.keys(manifest.dependencies ?? {})
    .filter(dependency => !existsSync(join(options.staging, 'node_modules', dependency)))
  if (stillMissing.length > 0) {
    throw new Error(`${options.prefix}: staged dependencies remain missing: ${stillMissing.join(', ')}.`)
  }
  if (restored.length > 0) console.log(`${options.prefix}: restored legacy deploy hoists: ${restored.join(', ')}`)
}

/**
 * Replace deploy-time package links with files and reject any remaining link.
 * @param options - destination and diagnostics.
 */
async function materializeStagedLinks(options: DeployClosureOptions): Promise<void> {
  if (options.dryRun) {
    console.log(`${options.prefix}: [dry-run] materialize staged package links`)
    return
  }
  const nodeModules = join(options.staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const source = await realpath(remaining)
    await rm(remaining, { recursive: true, force: true })
    await copyWithoutNestedModules(source, remaining)
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * Copy one package directory, dropping its own `node_modules`.
 * @param source - the real package directory.
 * @param destination - where to place its bytes.
 */
async function copyWithoutNestedModules(source: string, destination: string): Promise<void> {
  const nested = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nested && !path.startsWith(nested + sep),
  })
}

/**
 * Find the first symbolic link below a directory.
 * @param directory - the tree to scan.
 * @returns the link's path, or `undefined` when the tree holds none.
 */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}
