/**
 * Which surface one window shows.
 *
 * A window serves from one connection and shows what THAT connection's runtime
 * is doing. Two windows on different hosts are two answers, so the decision
 * takes the state it is about rather than reading a single runtime: a window
 * whose host is installing must not put every other window on the same waiting
 * screen.
 * @module @deepseek-ai/dsh-desktop/surface
 */

import type { RuntimeState } from './runtime-supervisor.ts'

/** What a window is pointed at. */
export type Surface =
  /** The harness UI, served by a runtime that is ready. */
  | { kind: 'app'; url: string }
  /** The local boot page, in this state, with what else the shell knows. */
  | { kind: 'boot'; state: string; note: string }

/**
 * Decide what one window shows.
 * @param state - the condition of the connection that window serves from; absent before its first report.
 * @param managing - whether this window is showing the connection list.
 * @returns the surface to route it to.
 */
export function surfaceFor(state: RuntimeState | undefined, managing: boolean): Surface {
  // The list is a surface over one window rather than a state of the runtime,
  // so it outranks whatever that runtime is doing.
  if (managing) return { kind: 'boot', state: 'connections', note: '' }
  if (state === undefined) return { kind: 'boot', state: 'stopped', note: '' }
  switch (state.status) {
    case 'ready':
      return { kind: 'app', url: state.url }
    case 'failed':
      return { kind: 'boot', state: 'failed', note: state.reason }
    case 'starting':
      return { kind: 'boot', state: 'starting', note: state.detail ?? '' }
    case 'restarting':
    case 'stopped':
      return { kind: 'boot', state: state.status, note: '' }
    default:
      return state satisfies never
  }
}
