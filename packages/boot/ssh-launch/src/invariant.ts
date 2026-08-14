/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ssh-launch`.
 * @module @deepseek-ai/dsh-ssh-launch/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ssh-launch'

/** Cordis companion plugin name. */
export const name = 'ssh-launch-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this library plans a launch for a shell that runs
 * outside any harness context, and the runtime it plans for is a separate
 * process whose own packages own the event-stream relations.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
