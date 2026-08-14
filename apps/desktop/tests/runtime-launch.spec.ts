/**
 * The two launches the shell can prepare: the runtime beside the window, and
 * the one an ssh session carries from another host.
 */

import { describe, expect, it } from 'vitest'
import type { SshTarget } from '@deepseek-ai/dsh-ssh-launch'
import { localRuntimeLaunch, remoteRuntimeLaunch, reserveLoopbackPort } from '../src/runtime-launch.ts'

/** A connection with only what ssh cannot resolve itself. */
const TARGET: SshTarget = { id: 'box', label: 'Dev box', host: 'dev-box' }

/** Ports one remote launch occupies. */
const PORTS = { local: 51_000, remote: 52_000 }

describe('localRuntimeLaunch', () => {
  it('runs the launcher under the given Node with the web profile on loopback', () => {
    const launch = localRuntimeLaunch({ entry: '/app/dsh.js', nodePath: '/bin/electron', maxOldSpaceMb: 2048 })
    expect(launch.command).toBe('/bin/electron')
    expect(launch.args).toContain('/app/dsh.js')
    expect(launch.args).toContain('--max-old-space-size=2048')
    expect(launch.args.slice(-6)).toEqual(['--profile', 'web', '--host', '127.0.0.1', '--port', '0'])
  })

  it('runs it as Node rather than as an Electron shell', () => {
    expect(localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 }).env)
      .toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('reaches the runtime at the address it reported, because it is this machine', () => {
    const launch = localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 })
    expect(launch.address('http://127.0.0.1:5321')).toEqual({ status: 'ready', url: 'http://127.0.0.1:5321' })
  })

  it('has no use for stdin, and is not stopped by closing it', () => {
    const launch = localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 })
    expect(launch.stdin).toBe('ignore')
    expect(launch.stopsOnStdinEnd).toBe(false)
  })

  it('counts repeated failures, which is all a local exit says', () => {
    const launch = localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 })
    expect(launch.explain({ exitCode: 3, signal: null, output: '', attempts: 4 }))
      .toBe('the harness runtime stopped 4 times in a row (exit code 3)')
    expect(launch.explain({ exitCode: null, signal: 'SIGSEGV', output: '', attempts: 2 }))
      .toContain('signal SIGSEGV')
  })
})

describe('remoteRuntimeLaunch', () => {
  it('spawns ssh with the forward the window will use', () => {
    const launch = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    expect(launch.command).toBe('ssh')
    expect(launch.args).toContain('127.0.0.1:51000:127.0.0.1:52000')
    expect(launch.description).toBe('Dev box')
  })

  it('holds stdin open, because closing it is what ends the remote runtime', () => {
    const launch = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    expect(launch.stdin).toBe('pipe')
    expect(launch.stopsOnStdinEnd).toBe(true)
  })

  it('sends the window to the forwarded port, not to the address the host reported', () => {
    const launch = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    expect(launch.address('http://127.0.0.1:52000')).toEqual({ status: 'ready', url: 'http://127.0.0.1:51000' })
  })

  it('refuses a remote runtime that bound a port this machine cannot reach', () => {
    const launch = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    const address = launch.address('http://127.0.0.1:3080')
    expect(address.status).toBe('unusable')
  })

  it('reads the remote script\'s own progress notes, which a local launch has none of', () => {
    const launch = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    expect(launch.progress?.('dsh-remote: installing @deepseek-ai/dsh@latest\n'))
      .toBe('installing @deepseek-ai/dsh@latest')
    expect(localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 }).progress).toBeUndefined()
  })

  it('installs a launcher on a host that names none, and runs the one a host names', () => {
    const managed = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    expect(managed.args.at(-1)).toContain('npm install --prefix')
    const provided = remoteRuntimeLaunch({
      target: { ...TARGET, launcher: { kind: 'host', command: '/opt/dsh/bin/dsh' } },
      ports: PORTS,
    })
    expect(provided.args.at(-1)).not.toContain('npm install')
  })

  it('explains the failure the connection actually hit', () => {
    const launch = remoteRuntimeLaunch({ target: TARGET, ports: PORTS })
    expect(launch.explain({
      exitCode: 255,
      signal: null,
      output: 'dev-box: Permission denied (publickey).',
      attempts: 1,
    })).toContain('ssh-agent')
  })
})

describe('reserveLoopbackPort', () => {
  it('answers a port that was free, and does not hold it', async () => {
    const first = await reserveLoopbackPort()
    expect(first).toBeGreaterThan(0)
    expect(await reserveLoopbackPort()).toBeGreaterThan(0)
  })
})
