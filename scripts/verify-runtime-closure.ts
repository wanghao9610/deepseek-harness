/**
 * Verify that a deploy manifest supplies every required workspace peer in its
 * dependency graph. With auto peer installation disabled, a missing root peer
 * can otherwise fail only when Cordis loads the packaged plugin.
 */
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { formatChain, loadManifest, loadWorkspacePackages, walkClosure } from './workspace-closure.ts'

/** Members a deploy root can reach; app manifests are deploy roots, not members. */
const WORKSPACE_GLOBS = ['packages/*/*/package.json', 'vendor/*/package.json']

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { manifest: { type: 'string' } },
})
const runtimeManifestPath = resolve(root, values.manifest ?? 'python/sdk-runtime/package.json')
const runtimeManifest = await loadManifest(runtimeManifestPath)
const runtimeName = runtimeManifest.name ?? 'python/sdk-runtime'
const workspace = await loadWorkspacePackages(root, WORKSPACE_GLOBS)
const walk = walkClosure(workspace, runtimeManifest.dependencies ?? {}, { followPeers: false })

const failures = [...walk.unsuppliedPeers]
  .flatMap(([peer, requiring]) => requiring.map(packageName => `${formatChain(runtimeName, packageName, walk.parents)} -> ${peer}`))
  .sort()

if (failures.length > 0) {
  console.error(`verify-runtime-closure: required workspace peers are missing from ${runtimeName} dependencies:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-runtime-closure: ${String(walk.order.length)} workspace packages form a closed runtime dependency graph.`)
