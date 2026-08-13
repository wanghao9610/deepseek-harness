/**
 * Build the macOS desktop application.
 *
 * The product is self-contained: the Electron shell, the Electron runtime, and
 * a deployed harness closure the shell supervises, with no dependency on a
 * checkout, a Node installation, or a package manager on the target machine.
 * The pipeline deploys that closure, proves it boots before packaging it, packs
 * the shell around it, ad-hoc signs the result — required on Apple silicon,
 * where a modified bundle without a signature is killed at launch — and writes
 * the disk image.
 *
 * Usage: `pnpm run package:desktop [-- --arch arm64|x64] [--out <dir>]
 * [--skip-deploy] [--skip-smoke] [--no-dmg]`
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { RUNTIME_DIRECTORY, RUNTIME_ENTRY_RELATIVE } from '../apps/desktop/src/paths.ts'
import { ReadinessScanner } from '../apps/desktop/src/readiness.ts'
import { runtimeArgs } from '../apps/desktop/src/runtime-launch.ts'
import { defaultHeapLimitMb } from '../apps/desktop/src/resource-governor.ts'
import { deployWorkspaceClosure, runCommand } from './deploy-closure.ts'
import { createDiskImage } from './macos-disk-image.ts'

const root = resolve(import.meta.dirname, '..')

/** Diagnostic prefix on this script's logs and errors. */
const PREFIX = 'package-desktop-app'

/** Reverse-DNS bundle id. Unsigned, so it only has to be stable and distinct from the browser launcher's. */
const APP_ID = 'ai.deepseek.dsh.desktop'

/** Bundle and volume name. */
const PRODUCT_NAME = 'DeepSeek Harness'

/** Basename of the disk image, which carries no spaces. */
const PRODUCT_SLUG = 'DeepSeek-Harness'

/** Workspace directory of the Electron shell; also electron-builder's project directory. */
const DESKTOP_DIR = 'apps/desktop'

/** Generated deploy root whose closure becomes the embedded runtime. */
const DEPLOY_ROOT_PACKAGE = 'dsh-desktop-runtime-pkg'

/** Where the closure, the packed application, and the image land. */
const DEFAULT_OUTPUT = 'dist-desktop'

/** Frontend dist inside the deployed closure; the web bundle refuses to activate without it. */
const RUNTIME_FRONTEND = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'

/** Build outputs the shell needs before anything is packed. */
const REQUIRED_ARTIFACTS = [`${DESKTOP_DIR}/lib/main.mjs`, `${DESKTOP_DIR}/resources/boot.html`, 'apps/web/dist/index.html']

/** Icon artwork; electron-builder renders the icon set from this square PNG. */
const ICON = 'assets/macos-app-icon.png'

/** Oldest macOS the bundle declares support for, matching the browser launcher. */
const MINIMUM_SYSTEM_VERSION = '13.0'

/** How long the closure has to print its URL line before the smoke run fails. */
const SMOKE_TIMEOUT_MS = 180_000

/** Architectures this packager builds for. */
const ARCHES = ['arm64', 'x64'] as const
type Arch = (typeof ARCHES)[number]

/**
 * Directories inside the closure that only a build needs, removed so the
 * bundle ships the runtime rather than the material for rebuilding it.
 */
const PRUNE_PATHS = [
  'node_modules/node-pty/deps',
  'node_modules/node-pty/src',
  'node_modules/node-pty/third_party',
  'node_modules/node-pty/binding.gyp',
]

/**
 * Narrow a raw `--arch` value.
 * @param value - the flag value.
 * @returns the architecture.
 */
function parseArch(value: string): Arch {
  if ((ARCHES as readonly string[]).includes(value)) return value as Arch
  throw new Error(`${PREFIX}: --arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(value)}.`)
}

/**
 * Read one JSON manifest.
 * @param path - absolute path.
 * @returns the parsed object.
 */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/**
 * Total size of a directory tree.
 * @param directory - the tree to measure.
 * @returns its size in bytes.
 */
async function treeSize(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    try {
      total += (await stat(join(entry.parentPath, entry.name))).size
    } catch {
      // A file removed between listing and measuring contributes nothing.
    }
  }
  return total
}

/**
 * Remove the build-only material and every foreign-platform native prebuild
 * from the deployed closure.
 * @param staging - the deployed closure.
 * @param arch - the architecture being packaged.
 */
async function pruneClosure(staging: string, arch: Arch): Promise<void> {
  const before = await treeSize(staging)
  for (const relative of PRUNE_PATHS) await rm(join(staging, relative), { recursive: true, force: true })
  const prebuilds = join(staging, 'node_modules/node-pty/prebuilds')
  if (existsSync(prebuilds)) {
    const keep = `darwin-${arch}`
    for (const entry of await readdir(prebuilds)) {
      if (entry !== keep) await rm(join(prebuilds, entry), { recursive: true, force: true })
    }
  }
  for (const entry of await readdir(staging, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.map')) await rm(join(entry.parentPath, entry.name), { force: true })
  }
  const after = await treeSize(staging)
  console.log(`${PREFIX}: pruned the closure from ${formatMib(before)} to ${formatMib(after)}`)
}

/**
 * Render a byte count for logs.
 * @param bytes - the count.
 * @returns the count in MiB, one decimal.
 */
function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Boot the deployed closure exactly as the shipped shell will, and prove it
 * serves the UI.
 *
 * This is the packaging gate that a static check cannot replace: peers missing
 * from the deploy root, a vendored package the overrides left behind, and a
 * frontend dist that never got built all surface only when the tree boots.
 * @param staging - the deployed closure.
 * @param electronBinary - the Electron binary, run in Node mode.
 */
async function smokeClosure(staging: string, electronBinary: string): Promise<void> {
  const entry = join(staging, RUNTIME_ENTRY_RELATIVE)
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-smoke-'))
  console.log(`${PREFIX}: smoke: booting the closure under ${electronBinary}`)
  const child = spawn(electronBinary, runtimeArgs(entry, defaultHeapLimitMb()), {
    cwd: home,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const exited = new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
  try {
    const scanner = new ReadinessScanner()
    const url = await new Promise<string>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${PREFIX}: the closure did not report a URL within ${String(SMOKE_TIMEOUT_MS)}ms:\n${output}`))
      }, SMOKE_TIMEOUT_MS)
      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        output += text
        const found = scanner.push(text)
        if (found === undefined) return
        clearTimeout(timer)
        resolvePromise(found)
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`${PREFIX}: the closure exited with code ${String(code)} before serving:\n${output}`))
      })
    })
    const response = await probeLoopback(url).catch((error: unknown) => {
      const state = child.exitCode === null ? 'still running' : `exited with code ${String(child.exitCode)}`
      throw new Error(`${PREFIX}: ${url} did not answer (${error instanceof Error ? error.message : String(error)}); the runtime is ${state}:\n${output}`)
    })
    if (response.status !== 200 || !response.body.includes('id="root"')) {
      throw new Error(`${PREFIX}: ${url} answered ${String(response.status)} without the application shell.`)
    }
    console.log(`${PREFIX}: smoke: ${url} served the application shell`)
  } finally {
    child.kill('SIGTERM')
    // The runtime disposes its plugin tree on the signal; removing its home
    // underneath that teardown would report failures the packaging did not cause.
    await exited
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Refuse to package a shell bundle older than the source it was built from.
 *
 * The bundle, not the sources, is what runs in the application, so a stale one
 * ships behavior nobody wrote and no later step can detect — the packaging
 * smoke boots the runtime closure, which the shell bundle is not part of.
 */
async function assertShellBundleCurrent(): Promise<void> {
  const bundle = (await stat(join(root, DESKTOP_DIR, 'lib/main.mjs'))).mtimeMs
  const sources = join(root, DESKTOP_DIR, 'src')
  for (const entry of await readdir(sources, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if ((await stat(join(entry.parentPath, entry.name))).mtimeMs <= bundle) continue
    throw new Error(`${PREFIX}: ${DESKTOP_DIR}/lib/main.mjs is older than ${entry.name} — run 'pnpm run build' first.`)
  }
}

/**
 * Read one loopback URL.
 *
 * `node:http` rather than `fetch`, because a developer machine commonly
 * exports proxy variables and the check must reach the local runtime rather
 * than whatever a proxy answers for it.
 * @param url - the URL to read.
 * @returns the status and body.
 */
async function probeLoopback(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpGet(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolvePromise({ status: response.statusCode ?? 0, body }) })
    })
    request.once('error', reject)
  })
}

/**
 * Locate the `.app` electron-builder produced.
 * @param outputDir - electron-builder's output directory.
 * @returns the bundle path.
 */
async function findApp(outputDir: string): Promise<string> {
  for (const entry of await readdir(outputDir, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.app')) return join(entry.parentPath, entry.name)
  }
  throw new Error(`${PREFIX}: no .app bundle under ${outputDir}.`)
}

/**
 * Apply an ad-hoc signature to the packed bundle.
 *
 * Packaging rewrites the Electron binary's identity and layout, which
 * invalidates the signature it shipped with. On Apple silicon an invalid
 * signature is fatal at launch, so the bundle is re-signed with the ad-hoc
 * identity — enough to run locally, and not a distribution signature.
 * @param appPath - the packed bundle.
 */
function signAdHoc(appPath: string): void {
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${PREFIX}: codesign exited ${String(result.status)}\n${result.stdout}${result.stderr}`)
  }
  const verify = spawnSync('codesign', ['--verify', '--strict', appPath], { encoding: 'utf8' })
  if (verify.status !== 0) {
    throw new Error(`${PREFIX}: the ad-hoc signature did not verify\n${verify.stdout}${verify.stderr}`)
  }
}

/** Run the pipeline. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arch: { type: 'string' },
      out: { type: 'string' },
      'skip-deploy': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      dmg: { type: 'boolean', default: true },
    },
    allowPositionals: false,
  })
  if (process.platform !== 'darwin') throw new Error(`${PREFIX}: builds on macOS only, ran on ${process.platform}.`)
  const arch = values.arch === undefined ? (process.arch === 'x64' ? 'x64' : 'arm64') : parseArch(values.arch)

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(root, artifact))) throw new Error(`${PREFIX}: missing ${artifact} — run 'pnpm run build' first.`)
  }
  await assertShellBundleCurrent()

  const outputDir = resolve(root, values.out ?? DEFAULT_OUTPUT)
  const staging = join(outputDir, 'runtime')
  const appOutput = join(outputDir, 'app')
  await mkdir(outputDir, { recursive: true })

  const desktopRequire = createRequire(join(root, DESKTOP_DIR, 'package.json'))
  const electronBinary = desktopRequire('electron') as string
  const electronVersion = (await readJson(join(root, DESKTOP_DIR, 'node_modules/electron/package.json'))).version
  const version = (await readJson(join(root, DESKTOP_DIR, 'package.json'))).version

  // Run through Node rather than `pnpm run`: pnpm reconciles the workspace
  // install state before a script, and this pipeline deliberately perturbs
  // that state when it deploys.
  await runCommand({
    label: 'runtime closure freshness',
    command: process.execPath,
    args: ['--import', 'tsx', 'scripts/gen-desktop-runtime-closure.ts', '--check'],
    cwd: root,
    prefix: PREFIX,
    dryRun: false,
  })

  if (values['skip-deploy']) console.log(`${PREFIX}: reusing the closure at ${staging} (--skip-deploy)`)
  else {
    await deployWorkspaceClosure({
      root,
      packageName: DEPLOY_ROOT_PACKAGE,
      staging,
      sourceNodeModules: join(root, DESKTOP_DIR, 'runtime', 'node_modules'),
      prefix: PREFIX,
      dryRun: false,
    })
    await pruneClosure(staging, arch)
  }
  for (const required of [RUNTIME_ENTRY_RELATIVE, RUNTIME_FRONTEND]) {
    if (!existsSync(join(staging, required))) throw new Error(`${PREFIX}: the deployed closure is missing ${required}.`)
  }

  if (values['skip-smoke']) console.log(`${PREFIX}: skipping the closure boot smoke (--skip-smoke)`)
  else await smokeClosure(staging, electronBinary)

  const builderConfig = join(outputDir, 'electron-builder.json')
  await writeFile(builderConfig, `${JSON.stringify({
    appId: APP_ID,
    productName: PRODUCT_NAME,
    electronVersion,
    // The harness is ES modules with dynamic imports and native addons, and an
    // archive serves neither: Electron's loader cannot import ES modules from
    // inside one, and a native addon has to exist as a file to be loaded.
    asar: false,
    npmRebuild: false,
    buildDependenciesFromSource: false,
    directories: { output: appOutput },
    files: ['lib/*.mjs', 'resources/**', 'package.json'],
    mac: {
      category: 'public.app-category.developer-tools',
      target: [{ target: 'dir', arch: [arch] }],
      icon: join(root, ICON),
      minimumSystemVersion: MINIMUM_SYSTEM_VERSION,
      // Signing is this script's own step; electron-builder must not attempt
      // to discover a Developer ID it will not find.
      identity: null,
    },
  }, undefined, 2)}\n`)

  await runCommand({
    label: 'electron-builder',
    command: join(root, DESKTOP_DIR, 'node_modules/.bin/electron-builder'),
    // Never publish: the build runs with CI set, which electron-builder
    // otherwise reads as a request to upload the artifact.
    args: ['--mac', '--dir', '--publish', 'never', '--config', builderConfig],
    cwd: join(root, DESKTOP_DIR),
    prefix: PREFIX,
    dryRun: false,
  })

  const appPath = await findApp(appOutput)
  // The closure is staged after packing, not through electron-builder's
  // resource copying, which applies its own filters to the tree it copies and
  // dropped the closure's `node_modules` on the way in. Signing follows, so
  // the staged bytes are covered by the signature.
  const staged = join(appPath, 'Contents', 'Resources', RUNTIME_DIRECTORY)
  await rm(staged, { recursive: true, force: true })
  await cp(staging, staged, { recursive: true, preserveTimestamps: true })
  if (!existsSync(join(staged, RUNTIME_ENTRY_RELATIVE))) throw new Error(`${PREFIX}: staging the closure did not produce ${RUNTIME_ENTRY_RELATIVE}.`)
  signAdHoc(appPath)
  console.log(`${PREFIX}: app: ${appPath} (${formatMib(await treeSize(appPath))})`)
  if (!values.dmg) return
  const dmgPath = join(outputDir, `${PRODUCT_SLUG}-${String(version)}-${arch}.dmg`)
  await createDiskImage({ appPath, volumeName: PRODUCT_NAME, dmgPath })
  console.log(`${PREFIX}: dmg: ${dmgPath} (${formatMib((await stat(dmgPath)).size)})`)
}

await main()
