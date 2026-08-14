/**
 * The terminal app's ordinary command-line provider over a real Loader tree:
 * the resolved session identity reaches consumer rows through lazy config,
 * while help leaves every consumer pending.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, MAIN_AGENT_ID, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  agentLoopConfig?: { agents: { id: string; sessionId?: string; resumeSessionId?: string }[] }
  tuiConfig?: { sessionId: string }
}

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/**
 * Mount the real provider under stand-ins for the two rows the shipped patch
 * configures from it.
 * @param args - the invocation's inner arguments.
 * @returns the resolved service value and observed row/process effects.
 */
async function bootStartup(args: string[]): Promise<{ startup: TuiStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'agent-loop.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.agentLoopConfig = config }\n')
  writeFileSync(join(dir, 'tui.mjs'), 'export function apply(_ctx, config) { globalThis.__tuiStartupObserved.tuiConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'tui-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__tuiStartupApply(ctx)
`)
  // The same expressions the shipped bundle patch carries.
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: agent-loop',
    `  name: ${pathToFileURL(join(dir, 'agent-loop.mjs')).href}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    agents:',
    `      - id: ${MAIN_AGENT_ID}`,
    '        sessionId: !!js "ctx.tuiStartup.resume ? undefined : ctx.tuiStartup.sessionId"',
    '        resumeSessionId: !!js "ctx.tuiStartup.resume ? ctx.tuiStartup.sessionId : undefined"',
    '- id: tui',
    `  name: ${pathToFileURL(join(dir, 'tui.mjs')).href}`,
    `  inject: [${TUI_STARTUP_SERVICE}]`,
    '  config:',
    '    sessionId: !!js ctx.tuiStartup.sessionId',
    '- id: tui-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __tuiStartupApply: typeof apply
    __tuiStartupObserved: Observed
  }
  globals.__tuiStartupApply = apply
  globals.__tuiStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    startup: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    observed,
  }
}

describe('terminal command-line provider', () => {
  it('mints a fresh identity and hands the same id to both rows', async () => {
    const { startup, observed } = await bootStartup([])
    expect(startup?.resume).toBe(false)
    expect(startup?.sessionId).toMatch(/^main-session-[0-9a-f-]{36}$/u)
    expect(observed.agentLoopConfig?.agents[0]).toEqual({
      id: 'main',
      sessionId: startup?.sessionId,
    })
    expect(observed.tuiConfig).toEqual({ sessionId: startup?.sessionId })
    expect(observed.exits).toEqual([])
  })

  it('binds an explicit --resume id as persisted history to load', async () => {
    const { startup, observed } = await bootStartup(['--resume', 'main-session-earlier'])
    expect(startup?.resume).toBe(true)
    expect(startup?.sessionId).toBe('main-session-earlier')
    // Exactly one identity key survives, so a fresh create can never race a load.
    expect(observed.agentLoopConfig?.agents[0]).toEqual({
      id: 'main',
      resumeSessionId: 'main-session-earlier',
    })
    expect(observed.tuiConfig).toEqual({ sessionId: 'main-session-earlier' })
  })

  it.each([{ args: ['--resume'] }, { args: ['--resume', '   '] }])(
    'leaves the switch to the front door when --resume names no session ($args)',
    async ({ args }) => {
      const { startup } = await bootStartup(args)
      expect(startup?.resume).toBe(false)
      expect(startup?.sessionId).toMatch(/^main-session-/u)
    },
  )

  it('names the exact session in the exit line and gives the index a process-local path', async () => {
    const { startup } = await bootStartup([])
    expect(startup?.goodbye).toBe(`To resume this session: dsh --profile tui --resume ${startup?.sessionId ?? ''}`)
    expect(startup?.queryIndexPath).toContain(`dsh-session-query-${String(process.pid)}-`)
    expect(startup?.queryIndexPath.endsWith('.db')).toBe(true)
  })

  it('prints its own help and leaves every consumer row pending', async () => {
    const { startup, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile tui')
    expect(startup).toBeUndefined()
    expect(observed.agentLoopConfig).toBeUndefined()
    expect(observed.tuiConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
