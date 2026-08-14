/** Requests the local boot surface sends the shell, as they arrive on the wire. */

import { describe, expect, it } from 'vitest'
import { parseBootAction, readDraft } from '../src/boot-action.ts'

describe('parseBootAction', () => {
  it('reads the actions that carry no parameter', () => {
    expect(parseBootAction('dsh-action:retry')).toEqual({ kind: 'retry' })
    expect(parseBootAction('dsh-action:open-log')).toEqual({ kind: 'open-log' })
    expect(parseBootAction('dsh-action:quit')).toEqual({ kind: 'quit' })
    expect(parseBootAction('dsh-action:manage-connections')).toEqual({ kind: 'manage-connections' })
    expect(parseBootAction('dsh-action:close-connections')).toEqual({ kind: 'close-connections' })
  })

  it('reads a connect request, naming a host or this machine', () => {
    expect(parseBootAction('dsh-action:connect?target=box')).toEqual({ kind: 'connect', targetId: 'box' })
    expect(parseBootAction('dsh-action:connect')).toEqual({ kind: 'connect', targetId: undefined })
  })

  it('refuses a removal that names no host', () => {
    expect(parseBootAction('dsh-action:remove-connection?target=box'))
      .toEqual({ kind: 'remove-connection', targetId: 'box' })
    expect(parseBootAction('dsh-action:remove-connection')).toBeUndefined()
  })

  it('reads an edited connection out of its payload', () => {
    const payload = encodeURIComponent(JSON.stringify({ label: 'Dev box', host: 'dev-box' }))
    expect(parseBootAction(`dsh-action:save-connection?payload=${payload}`))
      .toEqual({ kind: 'save-connection', draft: { label: 'Dev box', host: 'dev-box' } })
  })

  it('reads a payload chooser request, which carries the draft it must not lose', () => {
    const payload = encodeURIComponent(JSON.stringify({ label: 'Air-gapped', host: 'vault' }))
    expect(parseBootAction(`dsh-action:pick-payload?payload=${payload}`))
      .toEqual({ kind: 'pick-payload', draft: { label: 'Air-gapped', host: 'vault' } })
  })

  it('serves nothing for another scheme or an unknown action', () => {
    expect(parseBootAction('https://example.com/retry')).toBeUndefined()
    expect(parseBootAction('dsh-action:format-disk')).toBeUndefined()
  })
})

describe('readDraft', () => {
  it('trims every value and leaves out the fields the person did not fill in', () => {
    const payload = JSON.stringify({
      label: '  Dev box  ',
      host: 'dev-box',
      user: '',
      port: '',
      identityFile: '  ',
      remoteCwd: '/srv/work',
    })
    expect(readDraft(payload)).toEqual({ label: 'Dev box', host: 'dev-box', remoteCwd: '/srv/work' })
  })

  it('splits jump hosts and drops the empties a trailing comma leaves', () => {
    expect(readDraft(JSON.stringify({ jumpHosts: 'bastion, edge,' })))
      .toEqual({ jumpHosts: ['bastion', 'edge'] })
    expect(readDraft(JSON.stringify({ jumpHosts: ' , ' }))).toEqual({})
  })

  it('keeps a port that is not a number, so the validator can say so', () => {
    expect(readDraft(JSON.stringify({ port: 'ssh' })).port).toBeNaN()
    expect(readDraft(JSON.stringify({ port: '2222' })).port).toBe(2222)
  })

  it('reads the launcher the radio chose, ignoring the field the other one owns', () => {
    const managed = JSON.stringify({ launcherKind: 'managed', launcherVersion: '0.1.0-rc.6', launcherCommand: 'dsh' })
    expect(readDraft(managed).launcher).toEqual({ kind: 'managed', version: '0.1.0-rc.6' })
    const host = JSON.stringify({ launcherKind: 'host', launcherVersion: '0.1.0-rc.6', launcherCommand: '/opt/dsh/bin/dsh' })
    expect(readDraft(host).launcher).toEqual({ kind: 'host', command: '/opt/dsh/bin/dsh' })
  })

  it('leaves a managed version out when the field is empty, and keeps an empty host command', () => {
    expect(readDraft(JSON.stringify({ launcherKind: 'managed', launcherVersion: '' })).launcher)
      .toEqual({ kind: 'managed' })
    expect(readDraft(JSON.stringify({ launcherKind: 'host', launcherCommand: '  ' })).launcher)
      .toEqual({ kind: 'host', command: '' })
  })

  it('reads a payload the form chose, and the server root beside it', () => {
    const draft = readDraft(JSON.stringify({
      launcherKind: 'archive',
      launcherArchive: ' /tmp/dsh-server-Linux-x86_64.tar.gz ',
      remoteHome: '~/.dsh-server',
    }))
    expect(draft.launcher).toEqual({ kind: 'archive', path: '/tmp/dsh-server-Linux-x86_64.tar.gz' })
    expect(draft.remoteHome).toBe('~/.dsh-server')
  })

  it('names no launcher when the draft named no choice', () => {
    expect(readDraft(JSON.stringify({ host: 'dev-box' })).launcher).toBeUndefined()
  })

  it('reads the login-shell choice as the checkbox sends it', () => {
    expect(readDraft(JSON.stringify({ loginShell: 'true' })).loginShell).toBe(true)
    expect(readDraft(JSON.stringify({ loginShell: 'false' })).loginShell).toBe(false)
    expect(readDraft(JSON.stringify({})).loginShell).toBeUndefined()
  })

  it('answers an empty draft for a payload it cannot read', () => {
    expect(readDraft(null)).toEqual({})
    expect(readDraft('not json')).toEqual({})
    expect(readDraft('[1,2]')).toEqual({})
    expect(readDraft('"text"')).toEqual({})
  })
})
