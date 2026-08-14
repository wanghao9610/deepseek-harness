/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tui-app`.
 * @module @deepseek-ai/dsh-tui-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tui-app'

/** Cordis companion plugin name. */
export const name = 'tui-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: every contribution (the two prompt sections, the
 * provided host slots, the index-cleanup effect) is registry-disposed with the
 * fiber, and each owning registry's package carries that relation's invariant.
 * The parsed invocation is immutable once published, so the package holds no
 * mutable relation of its own to audit.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
