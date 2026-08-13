/**
 * Workspace dependency-graph traversal shared by the deploy-root gates and
 * generators. A deploy root is a dependency-only manifest whose closure pnpm
 * materializes, so both consumers need the same answer to "which workspace
 * packages does this root reach, and which peers does it leave unsupplied".
 */

import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** The manifest fields graph traversal reads. */
export interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** One workspace member. */
export interface WorkspacePackage {
  /** Absolute path of its `package.json`. */
  path: string
  manifest: PackageManifest
}

/** Result of one traversal. */
export interface ClosureWalk {
  /** Reachable workspace package names, in breadth-first discovery order. */
  order: string[]
  /** Discovery parent of each reachable package; the seeds map to `undefined`. */
  parents: Map<string, string | undefined>
  /** Non-optional workspace peers the root manifest does not itself declare, mapped to the packages requiring them. */
  unsuppliedPeers: Map<string, string[]>
}

/** How to traverse. */
export interface ClosureOptions {
  /**
   * Whether an unsupplied peer is itself traversed. A verifier reports peers
   * the root must add and stops there; a generator writes those peers into the
   * root, so it must also traverse what they pull in.
   */
  followPeers: boolean
}

/**
 * Read one manifest.
 * @param path - absolute path of a `package.json`.
 * @returns its parsed fields.
 */
export async function loadManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

/**
 * Load every workspace member matching the given manifest globs.
 * @param root - repository root the globs resolve against.
 * @param patterns - `package.json` globs, relative to the root.
 * @returns members by package name; an unnamed manifest is skipped.
 */
export async function loadWorkspacePackages(
  root: string,
  patterns: readonly string[],
): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync([...patterns], { cwd: root }).sort().map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = await loadManifest(path)
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

/**
 * Traverse the workspace graph from one deploy root's dependencies.
 * @param workspace - workspace members by name.
 * @param rootDependencies - the deploy root's `dependencies` map.
 * @param options - traversal behavior.
 * @returns the reachable set, discovery parents, and unsupplied peers.
 */
export function walkClosure(
  workspace: ReadonlyMap<string, WorkspacePackage>,
  rootDependencies: Readonly<Record<string, string>>,
  options: ClosureOptions,
): ClosureWalk {
  const parents = new Map<string, string | undefined>()
  const order: string[] = []
  const unsuppliedPeers = new Map<string, string[]>()

  const enqueue = (name: string, parent: string | undefined): void => {
    if (!workspace.has(name) || parents.has(name)) return
    parents.set(name, parent)
    order.push(name)
  }

  for (const dependency of Object.keys(rootDependencies).sort()) enqueue(dependency, undefined)

  for (let index = 0; index < order.length; index += 1) {
    const packageName = order[index]
    if (packageName === undefined) continue
    const current = workspace.get(packageName)
    if (current === undefined) continue
    const peers = current.manifest.peerDependencies ?? {}
    const peerMeta = current.manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers).sort()) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      if (rootDependencies[peer]?.startsWith('workspace:') === true) continue
      const requiring = unsuppliedPeers.get(peer)
      if (requiring === undefined) unsuppliedPeers.set(peer, [packageName])
      else requiring.push(packageName)
      if (options.followPeers) enqueue(peer, packageName)
    }
    const dependencies = { ...current.manifest.dependencies, ...current.manifest.optionalDependencies }
    for (const dependency of Object.keys(dependencies).sort()) enqueue(dependency, packageName)
  }

  return { order, parents, unsuppliedPeers }
}

/**
 * Render the discovery chain that reached one package, for diagnostics.
 * @param rootName - the deploy root's name.
 * @param packageName - the package to trace.
 * @param parents - discovery parents from {@link walkClosure}.
 * @returns the chain, root first, joined with arrows.
 */
export function formatChain(
  rootName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [rootName, ...chain].join(' -> ')
}
