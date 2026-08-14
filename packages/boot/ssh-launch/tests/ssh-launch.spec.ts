/**
 * Launch planning for a remote runtime: what a stored connection may contain,
 * what `ssh` is asked to do with it, and what a failure means.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROFILE,
  DEFAULT_LAUNCHER_VERSION,
  diagnoseSshFailure,
  LOOPBACK_HOST,
  pickRemotePort,
  planSshLaunch,
  describePayloadMismatch,
  planPayloadProbe,
  planPayloadTransfer,
  quoteRemoteArgument,
  readHostProbe,
  readProgress,
  readSshTargets,
  remoteCommandLine,
  resolveSshTarget,
  validateSshTarget,
  verifyForwardedUrl,
  type ForwardedUrlOutcome,
  type SshTarget,
} from '../src/index.ts'

/** The smallest connection that passes validation. */
const MINIMAL: SshTarget = { id: 'box', label: 'Dev box', host: 'dev-box' }

/** A connection that names every optional decision. */
const COMPLETE: SshTarget = {
  id: 'full',
  label: 'Full',
  host: 'dev-box',
  user: 'haowang',
  port: 2222,
  identityFile: '/Users/haowang/.ssh/id_ed25519',
  jumpHosts: ['bastion', 'edge'],
  launcher: { kind: 'host', command: '/opt/dsh/bin/dsh' },
  remoteCwd: '/srv/work',
  profile: 'web',
  loginShell: false,
}

/** The same connection with no remote working directory. */
const NO_DIRECTORY: SshTarget = {
  id: 'bare',
  label: 'Bare',
  host: 'dev-box',
  launcher: { kind: 'host', command: '/opt/dsh/bin/dsh' },
  loginShell: false,
}

/** Ports one launch occupies, fixed so plans compare exactly. */
const PORTS = { local: 51_000, remote: 52_000 }

/**
 * Read one option's value out of a planned argument vector.
 * @param args - the planned arguments.
 * @param flag - the option to read.
 * @returns the word following the flag, or `undefined` when the flag is absent.
 */
function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/**
 * Read the reason from an outcome that must be unusable.
 * @param outcome - the verified readiness address.
 * @returns the reason text.
 */
function unusableReason(outcome: ForwardedUrlOutcome): string {
  if (outcome.status !== 'unexpected') throw new Error(`expected an unusable address, got ${outcome.status}`)
  return outcome.reason
}

describe('validateSshTarget', () => {
  it('accepts a connection that names only what ssh cannot resolve itself', () => {
    expect(validateSshTarget(MINIMAL)).toEqual([])
  })

  it('accepts a connection that names every optional decision', () => {
    expect(validateSshTarget(COMPLETE)).toEqual([])
  })

  it('requires an identifier, a name, and a host', () => {
    const fields = validateSshTarget({}).map(problem => problem.field)
    expect(fields).toEqual(['id', 'label', 'host'])
  })

  it('rejects an identifier containing a space', () => {
    expect(validateSshTarget({ ...MINIMAL, id: 'dev box' })[0]?.field).toBe('id')
  })

  it('rejects a name that is only whitespace', () => {
    expect(validateSshTarget({ ...MINIMAL, label: '   ' })[0]?.field).toBe('label')
  })

  it('rejects a name carrying a control character', () => {
    expect(validateSshTarget({ ...MINIMAL, label: 'dev\u0007box' })[0]?.field).toBe('label')
  })

  it('rejects an option-shaped host, which ssh would run as a local command', () => {
    const problems = validateSshTarget({ ...MINIMAL, host: '-oProxyCommand=touch /tmp/pwned' })
    expect(problems[0]?.field).toBe('host')
  })

  it('rejects a host carrying a newline', () => {
    expect(validateSshTarget({ ...MINIMAL, host: 'dev-box\nother' })[0]?.field).toBe('host')
  })

  it('rejects an option-shaped user', () => {
    expect(validateSshTarget({ ...MINIMAL, user: '-l root' })[0]?.field).toBe('user')
  })

  it('rejects a port outside the TCP range or with a fraction', () => {
    expect(validateSshTarget({ ...MINIMAL, port: 0 })[0]?.field).toBe('port')
    expect(validateSshTarget({ ...MINIMAL, port: 65_536 })[0]?.field).toBe('port')
    expect(validateSshTarget({ ...MINIMAL, port: 22.5 })[0]?.field).toBe('port')
  })

  it('rejects an empty identity file', () => {
    expect(validateSshTarget({ ...MINIMAL, identityFile: '' })[0]?.field).toBe('identityFile')
  })

  it('rejects an option-shaped jump host and accepts an ordinary one', () => {
    expect(validateSshTarget({ ...MINIMAL, jumpHosts: ['bastion', '-oProxyCommand=x'] })[0]?.field).toBe('jumpHosts')
    expect(validateSshTarget({ ...MINIMAL, jumpHosts: ['bastion'] })).toEqual([])
  })

  it('rejects a host launcher or directory carrying a control character', () => {
    expect(validateSshTarget({ ...MINIMAL, launcher: { kind: 'host', command: 'dsh\n' } })[0]?.field).toBe('launcher')
    expect(validateSshTarget({ ...MINIMAL, remoteCwd: '/srv\u007f' })[0]?.field).toBe('remoteCwd')
  })

  it('rejects a managed version outside the path-safe alphabet', () => {
    expect(validateSshTarget({ ...MINIMAL, launcher: { kind: 'managed', version: '../evil' } })[0]?.field).toBe('launcher')
    expect(validateSshTarget({ ...MINIMAL, launcher: { kind: 'managed', version: '0.1.0-rc.6' } })).toEqual([])
    expect(validateSshTarget({ ...MINIMAL, launcher: { kind: 'managed' } })).toEqual([])
  })

  it('rejects a profile name outside the allowed alphabet', () => {
    expect(validateSshTarget({ ...MINIMAL, profile: 'web app' })[0]?.field).toBe('profile')
    expect(validateSshTarget({ ...MINIMAL, profile: '.hidden' })[0]?.field).toBe('profile')
    expect(validateSshTarget({ ...MINIMAL, profile: 'web-2.0_x' })).toEqual([])
  })
})

describe('readSshTargets', () => {
  it('recovers stored connections in order', () => {
    expect(readSshTargets([MINIMAL, { ...COMPLETE }])).toEqual([MINIMAL, COMPLETE])
  })

  it('answers empty for a document that is not a list', () => {
    expect(readSshTargets(undefined)).toEqual([])
    expect(readSshTargets({ targets: [MINIMAL] })).toEqual([])
  })

  it('discards an unusable entry without losing the rest', () => {
    expect(readSshTargets([null, 'text', { id: 'no-host', label: 'No host' }, MINIMAL])).toEqual([MINIMAL])
  })

  it('drops jump-host entries that are not text, and an empty list with them', () => {
    expect(readSshTargets([{ ...MINIMAL, jumpHosts: ['bastion', 7] }])).toEqual([
      { ...MINIMAL, jumpHosts: ['bastion'] },
    ])
    expect(readSshTargets([{ ...MINIMAL, jumpHosts: [] }])).toEqual([MINIMAL])
    expect(readSshTargets([{ ...MINIMAL, jumpHosts: 'bastion' }])).toEqual([MINIMAL])
  })

  it('ignores optional fields stored empty or with the wrong type', () => {
    expect(readSshTargets([{ ...MINIMAL, user: '', remoteCwd: '', port: '2222', loginShell: 'yes' }]))
      .toEqual([MINIMAL])
  })

  it('keeps a stored port and login-shell choice', () => {
    expect(readSshTargets([{ ...MINIMAL, port: 2222, loginShell: false }]))
      .toEqual([{ ...MINIMAL, port: 2222, loginShell: false }])
  })

  it('recovers either launcher choice, and ignores one this build does not serve', () => {
    expect(readSshTargets([{ ...MINIMAL, launcher: { kind: 'host', command: 'dsh' } }]))
      .toEqual([{ ...MINIMAL, launcher: { kind: 'host', command: 'dsh' } }])
    expect(readSshTargets([{ ...MINIMAL, launcher: { kind: 'managed', version: '0.1.0-rc.6' } }]))
      .toEqual([{ ...MINIMAL, launcher: { kind: 'managed', version: '0.1.0-rc.6' } }])
    expect(readSshTargets([{ ...MINIMAL, launcher: { kind: 'managed', version: '' } }]))
      .toEqual([{ ...MINIMAL, launcher: { kind: 'managed' } }])
    expect(readSshTargets([{ ...MINIMAL, launcher: { kind: 'download' } }])).toEqual([MINIMAL])
    expect(readSshTargets([{ ...MINIMAL, launcher: 'dsh' }])).toEqual([MINIMAL])
  })

  it('discards a stored launcher whose own field is missing', () => {
    expect(readSshTargets([{ ...MINIMAL, launcher: { kind: 'host' } }])).toEqual([])
    expect(readSshTargets([{ ...MINIMAL, launcher: { kind: 'archive' } }])).toEqual([])
  })
})

describe('resolveSshTarget', () => {
  it('makes every deferred decision for a minimal connection', () => {
    expect(resolveSshTarget(MINIMAL)).toEqual({
      host: 'dev-box',
      user: undefined,
      port: undefined,
      identityFile: undefined,
      jumpHosts: [],
      launcher: { kind: 'managed', version: DEFAULT_LAUNCHER_VERSION },
      remoteHome: '"$HOME/.dsh-server"',
      remoteCwd: undefined,
      profile: DEFAULT_PROFILE,
      loginShell: true,
    })
  })

  it('decides the version a managed launcher left open, and keeps a pinned one', () => {
    expect(resolveSshTarget({ ...MINIMAL, launcher: { kind: 'managed' } }).launcher)
      .toEqual({ kind: 'managed', version: DEFAULT_LAUNCHER_VERSION })
    expect(resolveSshTarget({ ...MINIMAL, launcher: { kind: 'managed', version: '0.1.0-rc.6' } }).launcher)
      .toEqual({ kind: 'managed', version: '0.1.0-rc.6' })
  })

  it('keeps every decision a connection made itself', () => {
    expect(resolveSshTarget(COMPLETE)).toEqual({
      host: 'dev-box',
      user: 'haowang',
      port: 2222,
      identityFile: '/Users/haowang/.ssh/id_ed25519',
      jumpHosts: ['bastion', 'edge'],
      launcher: { kind: 'host', command: '/opt/dsh/bin/dsh' },
      remoteHome: '"$HOME/.dsh-server"',
      remoteCwd: '/srv/work',
      profile: 'web',
      loginShell: false,
    })
  })
})

describe('quoteRemoteArgument', () => {
  it('keeps a plain word literal', () => {
    expect(quoteRemoteArgument('/srv/work')).toBe('\'/srv/work\'')
  })

  it('keeps an embedded quote from ending the word', () => {
    expect(quoteRemoteArgument('it\'s here')).toBe('\'it\'\\\'\'s here\'')
  })

  it('keeps shell metacharacters from being interpreted', () => {
    expect(quoteRemoteArgument('$(id); rm -rf /')).toBe('\'$(id); rm -rf /\'')
  })
})

describe('remoteCommandLine', () => {
  it('runs the launcher through a login shell so PATH matches an interactive session', () => {
    const line = remoteCommandLine(resolveSshTarget(MINIMAL), 52_000)
    expect(line.startsWith('exec "${SHELL:-/bin/sh}" -lc ')).toBe(true)
    expect(line).toContain('\'\\\'\'52000\'\\\'\'')
  })

  it('runs the launcher directly when the connection turns the login shell off', () => {
    expect(remoteCommandLine(resolveSshTarget(COMPLETE), 52_000)).toBe([
      'dsh_home="$HOME/.dsh-server"',
      'export DSH_HOME="$dsh_home"',
      'dsh_launcher=\'/opt/dsh/bin/dsh\'',
      'cd \'/srv/work\' || exit 1',
      'exec 3<&0',
      '"$dsh_launcher" \'--profile\' \'web\' \'--host\' \'127.0.0.1\' \'--port\' \'52000\' &',
      'dsh_runtime=$!',
      '{ while read -r dsh_ignored; do :; done; kill -TERM "$dsh_runtime" 2>/dev/null; } <&3 &',
      'dsh_watchdog=$!',
      'wait "$dsh_runtime"',
      'dsh_status=$?',
      'kill -TERM "$dsh_watchdog" 2>/dev/null',
      'exit "$dsh_status"',
    ].join('\n'))
  })

  it('keeps the session stdin on its own descriptor, which a background job would otherwise lose', () => {
    const script = remoteCommandLine(resolveSshTarget(NO_DIRECTORY), 52_000)
    expect(script).toContain('exec 3<&0')
    expect(script).toContain('} <&3 &')
  })

  it('ends the runtime when the launch stdin closes, and ends itself when the runtime exits', () => {
    const script = remoteCommandLine(resolveSshTarget(NO_DIRECTORY), 52_000)
    expect(script).toContain('while read -r dsh_ignored')
    expect(script).toContain('kill -TERM "$dsh_runtime"')
    expect(script).toContain('wait "$dsh_runtime"')
    expect(script).toContain('exit "$dsh_status"')
  })

  it('omits the directory change when the connection names no directory', () => {
    const target = resolveSshTarget(NO_DIRECTORY)
    expect(remoteCommandLine(target, 52_000)).not.toContain('cd ')
  })

  it('runs a host-provided launcher without provisioning anything', () => {
    expect(remoteCommandLine(resolveSshTarget(COMPLETE), 52_000)).not.toContain('npm install')
  })

  it('installs a managed launcher on first use, into a directory scoped by version', () => {
    const script = remoteCommandLine(resolveSshTarget({ ...MINIMAL, loginShell: false }), 52_000)
    expect(script).toContain('dsh_dir="$dsh_home/bin/latest"')
    expect(script).toContain('dsh_launcher="$dsh_dir/node_modules/.bin/dsh"')
    expect(script).toContain('if [ ! -x "$dsh_launcher" ]; then')
    expect(script).toContain('npm install --prefix "$dsh_dir" --no-save --no-audit --no-fund --loglevel=error \'@deepseek-ai/dsh@latest\'')
  })

  it('installs the version the connection pinned', () => {
    const target = { ...MINIMAL, launcher: { kind: 'managed', version: '0.1.0-rc.6' }, loginShell: false } as const
    const script = remoteCommandLine(resolveSshTarget(target), 52_000)
    expect(script).toContain('dsh_dir="$dsh_home/bin/0.1.0-rc.6"')
    expect(script).toContain('\'@deepseek-ai/dsh@0.1.0-rc.6\'')
  })

  it('refuses to install onto a host without a usable node or npm', () => {
    const script = remoteCommandLine(resolveSshTarget({ ...MINIMAL, loginShell: false }), 52_000)
    expect(script).toContain('command -v node >/dev/null 2>&1 ||')
    expect(script).toContain('command -v npm >/dev/null 2>&1 ||')
    expect(script).toContain('v[0]===22&&v[1]>=19')
  })

  it('announces the install so a shell can show it is not stalled', () => {
    const script = remoteCommandLine(resolveSshTarget({ ...MINIMAL, loginShell: false }), 52_000)
    expect(script).toContain('echo \'dsh-remote: installing @deepseek-ai/dsh@latest\' >&2')
    expect(script).toContain('echo \'dsh-remote: installed @deepseek-ai/dsh@latest\' >&2')
  })
})

describe('readProgress', () => {
  it('reads the note out of a line the remote script printed', () => {
    expect(readProgress('dsh-remote: installing @deepseek-ai/dsh@latest\n')).toBe('installing @deepseek-ai/dsh@latest')
  })

  it('keeps the newest note when a chunk carries several', () => {
    expect(readProgress('dsh-remote: installing\nnpm noise\ndsh-remote: installed\n')).toBe('installed')
  })

  it('ignores a chunk that carries none, and an empty note', () => {
    expect(readProgress('npm warn deprecated something\n')).toBeUndefined()
    expect(readProgress('dsh-remote: \n')).toBeUndefined()
  })
})

describe('planSshLaunch', () => {
  it('forwards the remote port to the local one and reports the local origin', () => {
    const plan = planSshLaunch(MINIMAL, PORTS)
    expect(plan.command).toBe('ssh')
    expect(optionValue(plan.args, '-L')).toBe('127.0.0.1:51000:127.0.0.1:52000')
    expect(plan.localOrigin).toBe(`http://${LOOPBACK_HOST}:51000`)
  })

  it('refuses a prompt and a forward that did not bind', () => {
    const plan = planSshLaunch(MINIMAL, PORTS)
    expect(plan.args).toContain('BatchMode=yes')
    expect(plan.args).toContain('ExitOnForwardFailure=yes')
    expect(plan.args).toContain('-T')
  })

  it('omits every option the connection left to ssh', () => {
    const plan = planSshLaunch(MINIMAL, PORTS)
    expect(plan.args).not.toContain('-p')
    expect(plan.args).not.toContain('-l')
    expect(plan.args).not.toContain('-i')
    expect(plan.args).not.toContain('-J')
  })

  it('passes every option the connection named', () => {
    const plan = planSshLaunch(COMPLETE, PORTS)
    expect(optionValue(plan.args, '-p')).toBe('2222')
    expect(optionValue(plan.args, '-l')).toBe('haowang')
    expect(optionValue(plan.args, '-i')).toBe('/Users/haowang/.ssh/id_ed25519')
    expect(optionValue(plan.args, '-J')).toBe('bastion,edge')
  })

  it('puts the destination and the remote command last, in that order', () => {
    const plan = planSshLaunch(COMPLETE, PORTS)
    expect(plan.args.at(-2)).toBe('dev-box')
    expect(plan.args.at(-1)).toBe(remoteCommandLine(resolveSshTarget(COMPLETE), PORTS.remote))
  })
})

describe('verifyForwardedUrl', () => {
  it('accepts the runtime that bound the forwarded port', () => {
    expect(verifyForwardedUrl('http://127.0.0.1:52000', PORTS))
      .toEqual({ status: 'forwarded', origin: 'http://127.0.0.1:51000' })
  })

  it('refuses a runtime serving a port this machine cannot reach', () => {
    expect(unusableReason(verifyForwardedUrl('http://127.0.0.1:3080', PORTS))).toContain('3080')
  })

  it('names the protocol default when the reported address carries no port', () => {
    expect(unusableReason(verifyForwardedUrl('http://127.0.0.1/', PORTS))).toContain('protocol default')
  })

  it('refuses output that is not a URL at all', () => {
    expect(unusableReason(verifyForwardedUrl('listening', PORTS))).toContain('not a URL')
  })
})

describe('diagnoseSshFailure', () => {
  it('names an unknown or changed host key', () => {
    expect(diagnoseSshFailure({ exitCode: 255, output: 'Host key verification failed.' }))
      .toContain('host key')
  })

  it('names the missing interactive prompt when the key was refused', () => {
    expect(diagnoseSshFailure({ exitCode: 255, output: 'dev-box: Permission denied (publickey).' }))
      .toContain('ssh-agent')
  })

  it('names an unresolved host', () => {
    expect(diagnoseSshFailure({ exitCode: 255, output: 'ssh: Could not resolve hostname dev-box' }))
      .toContain('did not resolve')
  })

  it('names an unreachable sshd', () => {
    expect(diagnoseSshFailure({ exitCode: 255, output: 'connect to host dev-box port 22: Connection refused' }))
      .toContain('sshd')
  })

  it('names a taken forward port as retryable', () => {
    expect(diagnoseSshFailure({ exitCode: 1, output: 'bind: Address already in use' }))
      .toContain('picks another one')
  })

  it('names what the provisioning preamble refused, from its own exit status', () => {
    expect(diagnoseSshFailure({ exitCode: 9, output: '' })).toContain('Node 22.19')
    expect(diagnoseSshFailure({ exitCode: 10, output: '' })).toContain('no npm')
    expect(diagnoseSshFailure({ exitCode: 11, output: '' })).toContain('a version that does not exist')
    expect(diagnoseSshFailure({ exitCode: 12, output: '' })).toContain('left no launcher')
  })

  it('names a missing remote launcher, by message or by exit status', () => {
    expect(diagnoseSshFailure({ exitCode: 1, output: 'bash: dsh: command not found' })).toContain('absolute path')
    expect(diagnoseSshFailure({ exitCode: 127, output: '' })).toContain('absolute path')
  })

  it('falls back to the transport for an undiagnosed ssh failure', () => {
    expect(diagnoseSshFailure({ exitCode: 255, output: 'kex_exchange_identification: banner line' }))
      .toContain('could not establish')
  })

  it('falls back to the runtime for an undiagnosed remote exit', () => {
    expect(diagnoseSshFailure({ exitCode: 1, output: 'plugin tree failed' })).toContain('remote runtime stopped')
    expect(diagnoseSshFailure({ exitCode: null, output: '' })).toContain('remote runtime stopped')
  })
})

describe('pickRemotePort', () => {
  it('stays inside the dynamic range at both ends of the draw', () => {
    expect(pickRemotePort(() => 0)).toBe(49_152)
    expect(pickRemotePort(() => 0.999_999_9)).toBe(65_535)
  })
})

describe('a payload the shell sends', () => {
  /** A connection that installs from a payload this machine holds. */
  const SENDING: SshTarget = {
    id: 'air', label: 'Air-gapped', host: 'vault', loginShell: false,
    launcher: { kind: 'archive', path: '/tmp/dsh-server-Linux-x86_64-0.1.0.tar.gz' },
  }

  /** What the shell read out of that archive. */
  const PAYLOAD = { version: '0.1.0', digest: 'abc123def456', platform: 'Linux', arch: 'x86_64' }

  it('cannot be planned before the archive has been read', () => {
    expect(() => resolveSshTarget(SENDING)).toThrow(/without reading it first/)
  })

  it('scopes the installation by version and digest, so a rebuilt archive lands beside the old one', () => {
    expect(resolveSshTarget(SENDING, { payload: PAYLOAD }).launcher)
      .toEqual({ kind: 'archive', directory: '0.1.0-abc123def456' })
  })

  it('asks the host what it is and whether it already has the payload, in one round trip', () => {
    const probe = planPayloadProbe(SENDING, PAYLOAD)
    expect(probe.command).toBe('ssh')
    expect(probe.args.at(-1)).toContain('uname -s')
    expect(probe.args.at(-1)).toContain('$dsh_home/bin/0.1.0-abc123def456')
    expect(probe.args).not.toContain('-L')
  })

  it('reads the answer, and nothing from output that carries none', () => {
    expect(readHostProbe('motd noise\ndsh-probe Linux x86_64 present\n'))
      .toEqual({ platform: 'Linux', arch: 'x86_64', present: true })
    expect(readHostProbe('dsh-probe Darwin arm64 absent\n')?.present).toBe(false)
    expect(readHostProbe('nothing here\n')).toBeUndefined()
    expect(readHostProbe('dsh-probe Linux\n')).toBeUndefined()
  })

  it('refuses a payload with no path, and one this build cannot transfer', () => {
    expect(validateSshTarget({ ...MINIMAL, launcher: { kind: 'archive', path: '' } })[0]?.field).toBe('launcher')
    expect(() => planPayloadTransfer(MINIMAL, PAYLOAD)).toThrow(/only a connection that sends a server payload/)
  })

  it('refuses a payload built for another platform, because the runtime would not start', () => {
    expect(describePayloadMismatch(PAYLOAD, { platform: 'Linux', arch: 'x86_64', present: false }))
      .toBeUndefined()
    expect(describePayloadMismatch(PAYLOAD, { platform: 'Darwin', arch: 'arm64', present: false }))
      .toContain('build one on a Darwin arm64 machine')
  })

  it('unpacks beside the destination and renames, so an interrupted transfer leaves nothing usable', () => {
    const transfer = planPayloadTransfer(SENDING, PAYLOAD)
    const script = transfer.args.at(-1) ?? ''
    expect(script).toContain('tar -xzf - -C "$dsh_partial"')
    expect(script).toContain('mv "$dsh_partial" "$dsh_dir"')
    expect(script).toContain('command -v tar')
  })

  it('runs the entry a deployed closure carries, which has no npm bin directory', () => {
    const script = remoteCommandLine(resolveSshTarget(SENDING, { payload: PAYLOAD }), 52_000)
    expect(script).toContain('dsh_launcher="$dsh_dir/node_modules/@deepseek-ai/dsh/lib/bin.js"')
    expect(script).not.toContain('node_modules/.bin/dsh')
    expect(script).not.toContain('npm install')
  })

  it('still refuses a host whose node cannot run it, because a payload carries none', () => {
    const script = remoteCommandLine(resolveSshTarget(SENDING, { payload: PAYLOAD }), 52_000)
    expect(script).toContain('the transferred server payload is missing')
    expect(script).toContain('command -v node')
    expect(script).toContain('v[0]===22&&v[1]>=19')
  })

  it('names the failures only a transfer has', () => {
    expect(diagnoseSshFailure({ exitCode: 13, output: '' })).toContain('no tar')
    expect(diagnoseSshFailure({ exitCode: 14, output: '' })).toContain('did not unpack')
  })
})

describe('the server root', () => {
  it('holds the runtime data as well as the installations, under one directory per connection', () => {
    const script = remoteCommandLine(resolveSshTarget({ ...MINIMAL, loginShell: false }), 52_000)
    expect(script).toContain('dsh_home="$HOME/.dsh-server"')
    expect(script).toContain('export DSH_HOME="$dsh_home"')
    expect(script).toContain('dsh_dir="$dsh_home/bin/latest"')
  })

  it('takes an absolute root, or one under the account home', () => {
    const absolute = resolveSshTarget({ ...MINIMAL, remoteHome: '/srv/dsh' })
    expect(absolute.remoteHome).toBe('\'/srv/dsh\'')
    const relative = resolveSshTarget({ ...MINIMAL, remoteHome: '~/work/dsh' })
    expect(relative.remoteHome).toBe('"$HOME/"\'work/dsh\'')
  })

  it('refuses a root that is neither', () => {
    expect(validateSshTarget({ ...MINIMAL, remoteHome: 'relative/dir' })[0]?.field).toBe('remoteHome')
    expect(validateSshTarget({ ...MINIMAL, remoteHome: '/srv/dsh' })).toEqual([])
  })

  it('keeps a stored root and launcher payload path', () => {
    const stored = { ...MINIMAL, remoteHome: '/srv/dsh', launcher: { kind: 'archive', path: '/tmp/p.tar.gz' } }
    expect(readSshTargets([stored])).toEqual([stored])
  })
})
