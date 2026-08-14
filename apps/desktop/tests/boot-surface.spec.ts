/**
 * The local boot surface as the shell serves it: the connection list, the
 * chosen host, and a rejected edit shown with the values it is about.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom'
import { describe, expect, it } from 'vitest'

const page = readFileSync(join(import.meta.dirname, '..', 'resources', 'boot.html'), 'utf8')

/** What the shell passes the surface for one render. */
interface View {
  targets: unknown[]
  activeId: string | null
  problems: Record<string, string>
  draft?: unknown
}

/**
 * Render the surface the way the window host loads it.
 * @param state - the surface to show.
 * @param view - the connection list, when the surface shows one.
 * @returns the rendered document, its window, and everything its script reported.
 */
function render(state: string, view?: View): { document: Document; window: DOMWindow; errors: string[] } {
  const query = new URLSearchParams({ state, ...view !== undefined && { connections: JSON.stringify(view) } })
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error: Error) => {
    // "Not implemented" names a browser API jsdom lacks (scrolling the form
    // into view), not something the page got wrong.
    if (!error.message.startsWith('Not implemented:')) errors.push(error.message)
  })
  const dom = new JSDOM(page, {
    url: `file:///boot.html?${query.toString()}`,
    runScripts: 'dangerously',
    virtualConsole,
  })
  return { document: dom.window.document, window: dom.window, errors }
}

/**
 * Press one key on the surface, from the element that holds focus.
 * @param window - the rendered window.
 * @param key - the pressed key.
 * @param from - the focused element; the body when nothing is focused.
 */
function press(window: DOMWindow, key: string, from: Element): void {
  from.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
}

/**
 * Count what one control is asked to do.
 * @param element - the control to watch.
 * @returns a function returning how many clicks it has taken.
 */
function clicks(element: Element): () => number {
  let count = 0
  element.addEventListener('click', () => { count += 1 })
  return () => count
}

/**
 * Read one row of the connection list.
 * @param document - the rendered document.
 * @param index - the row's position, this machine first.
 * @returns its name, summary, and the labels of its controls.
 */
function row(document: Document, index: number): { name: string; where: string; controls: string[] } {
  const element = document.querySelectorAll('#list .row')[index]
  if (element === undefined) throw new Error(`no connection row at ${String(index)}`)
  return {
    name: element.querySelector('.name')?.textContent ?? '',
    where: element.querySelector('.where')?.textContent ?? '',
    controls: [...element.querySelectorAll('button, .badge')].map(control => control.textContent ?? ''),
  }
}

describe('the boot surface', () => {
  it('shows what a slow start is doing rather than only a spinner', () => {
    const query = new URLSearchParams({ state: 'starting', note: 'installing @deepseek-ai/dsh@latest' })
    const dom = new JSDOM(page, { url: `file:///boot.html?${query.toString()}`, runScripts: 'dangerously' })
    expect(dom.window.document.querySelector('#message')?.textContent)
      .toBe('installing @deepseek-ai/dsh@latest…')
  })

  it('gives a slow start a way out, which is the only exit from a long install', () => {
    const query = new URLSearchParams({ state: 'starting', note: 'installing @deepseek-ai/dsh@latest' })
    const dom = new JSDOM(page, { url: `file:///boot.html?${query.toString()}`, runScripts: 'dangerously' })
    const actions = [...dom.window.document.querySelectorAll('.actions a')]
    expect(actions.map(link => link.getAttribute('href'))).toEqual([
      'dsh-action:cancel-start',
      'dsh-action:manage-connections',
      'dsh-action:open-log',
      'dsh-action:quit',
    ])
  })

  it('offers to start a stopped runtime again rather than claiming it is starting', () => {
    const query = new URLSearchParams({ state: 'stopped' })
    const dom = new JSDOM(page, { url: `file:///boot.html?${query.toString()}`, runScripts: 'dangerously' })
    expect(dom.window.document.querySelector('.actions a.primary')?.getAttribute('href')).toBe('dsh-action:retry')
    expect(dom.window.document.querySelector('#headline')?.textContent).toContain('not running')
  })

  it('explains a failed start and offers the connection list', () => {
    const { document, errors } = render('failed')
    expect(errors).toEqual([])
    expect(document.body.className).toBe('failed')
    expect([...document.querySelectorAll('.actions a')].map(link => link.getAttribute('href')))
      .toContain('dsh-action:manage-connections')
  })

  it('lists this machine first, then every stored host', () => {
    const { document, errors } = render('connections', {
      targets: [
        { id: 'box', label: 'Dev box', host: 'dev-box', user: 'haowang', remoteCwd: '/srv/work' },
        { id: 'gpu', label: 'GPU rig', host: 'gpu-1', port: 2222 },
      ],
      activeId: 'box',
      problems: {},
    })
    expect(errors).toEqual([])
    expect(row(document, 0).name).toBe('This machine')
    expect(row(document, 1)).toEqual({
      name: 'Dev box',
      where: 'haowang@dev-box · /srv/work · dsh@latest',
      controls: ['Serving', 'Edit', 'Remove'],
    })
    expect(row(document, 2).where).toBe('gpu-1:2222 · dsh@latest')
  })

  it('says where each host gets its launcher from', () => {
    const { document } = render('connections', {
      targets: [
        { id: 'a', label: 'Pinned', host: 'a', launcher: { kind: 'managed', version: '0.1.0-rc.6' } },
        { id: 'b', label: 'Host', host: 'b', launcher: { kind: 'host', command: '/opt/dsh/bin/dsh' } },
      ],
      activeId: null,
      problems: {},
    })
    expect(row(document, 1).where).toBe('a · dsh@0.1.0-rc.6')
    expect(row(document, 2).where).toBe('b · /opt/dsh/bin/dsh')
  })

  it('offers to install the launcher by default, and shows only the chosen field', () => {
    const { document } = render('connections', { targets: [], activeId: null, problems: {} })
    expect(document.querySelector<HTMLInputElement>('#launcher-managed')?.checked).toBe(true)
    expect(document.querySelector<HTMLElement>('#managed-field')?.style.display).toBe('')
    expect(document.querySelector<HTMLElement>('#host-field')?.style.display).toBe('none')
  })

  it('offers sending a payload, and shows only that field when it is chosen', () => {
    const { document } = render('connections', {
      targets: [],
      activeId: null,
      problems: {},
      draft: { id: 'd', label: 'Air-gapped', host: 'vault', launcher: { kind: 'archive', path: '/tmp/p.tar.gz' } },
    })
    expect(document.querySelector<HTMLInputElement>('#launcher-archive')?.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#launcherArchive')?.value).toBe('/tmp/p.tar.gz')
    expect(document.querySelector<HTMLElement>('#archive-field')?.style.display).toBe('')
    expect(document.querySelector<HTMLElement>('#managed-field')?.style.display).toBe('none')
    expect(document.querySelector<HTMLElement>('#host-field')?.style.display).toBe('none')
  })

  it('keeps the server root on the form', () => {
    const { document } = render('connections', {
      targets: [],
      activeId: null,
      problems: { remoteHome: 'enter an absolute directory' },
      draft: { id: 'd', label: 'X', host: 'x', remoteHome: '/srv/dsh' },
    })
    expect(document.querySelector<HTMLInputElement>('#remoteHome')?.value).toBe('/srv/dsh')
    expect(document.querySelector('#problem-remoteHome')?.textContent).toContain('absolute directory')
  })

  it('loads a host launcher into its own field, hiding the version', () => {
    const { document } = render('connections', {
      targets: [],
      activeId: null,
      problems: {},
      draft: { id: 'draft', label: 'Host', host: 'b', launcher: { kind: 'host', command: '/opt/dsh/bin/dsh' } },
    })
    expect(document.querySelector<HTMLInputElement>('#launcher-host')?.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('#launcherCommand')?.value).toBe('/opt/dsh/bin/dsh')
    expect(document.querySelector<HTMLElement>('#managed-field')?.style.display).toBe('none')
  })

  it('offers to connect to every host but the one already serving', () => {
    const { document } = render('connections', {
      targets: [{ id: 'box', label: 'Dev box', host: 'dev-box' }],
      activeId: null,
      problems: {},
    })
    expect(row(document, 0).controls).toEqual(['Serving'])
    expect(row(document, 1).controls).toEqual(['Connect', 'Edit', 'Remove'])
  })

  it('keeps a rejected edit on screen with the problem it is about', () => {
    const { document, errors } = render('connections', {
      targets: [],
      activeId: null,
      problems: { host: 'enter a host name, address, or ssh config alias' },
      draft: { id: 'draft', label: 'Broken', host: '-oProxyCommand=x', loginShell: 'false' },
    })
    expect(errors).toEqual([])
    expect(document.querySelector<HTMLInputElement>('#host')?.value).toBe('-oProxyCommand=x')
    expect(document.querySelector<HTMLInputElement>('#label')?.value).toBe('Broken')
    expect(document.querySelector<HTMLInputElement>('#loginShell')?.checked).toBe(false)
    expect(document.querySelector('#problem-host')?.textContent).toContain('enter a host name')
    expect(document.querySelector('#form-title')?.textContent).toBe('Edit Broken')
  })

  it('starts on an empty form when nothing was rejected', () => {
    const { document } = render('connections', { targets: [], activeId: null, problems: {} })
    expect(document.querySelector<HTMLInputElement>('#host')?.value).toBe('')
    expect(document.querySelector('#form-title')?.textContent).toBe('Add a host')
  })

  it('leaves the connection list on Escape', () => {
    const { document, window, errors } = render('connections', { targets: [], activeId: null, problems: {} })
    const done = document.getElementById('done')
    if (done === null) throw new Error('the connection list has no Done control')
    const taken = clicks(done)
    press(window, 'Escape', document.body)
    expect(taken()).toBe(1)
    expect(errors).toEqual([])
  })

  it('saves the host being edited on Enter in one of its fields', () => {
    const { document, window } = render('connections', { targets: [], activeId: null, problems: {} })
    const save = document.getElementById('save')
    const host = document.getElementById('host')
    if (save === null || host === null) throw new Error('the connection form is incomplete')
    const taken = clicks(save)
    press(window, 'Enter', host)
    expect(taken()).toBe(1)
  })

  it('retries a failed start on Enter while nothing else holds focus', () => {
    const { document, window } = render('failed')
    const retry = document.querySelector('.actions a.primary')
    if (retry === null) throw new Error('the failed surface offers no retry')
    const taken = clicks(retry)
    press(window, 'Enter', document.body)
    press(window, 'Enter', retry)
    // The focused link answers Enter with itself; the surface must not run it twice.
    expect(taken()).toBe(1)
  })

  it('renders an empty list rather than failing on a payload it cannot read', () => {
    const query = new URLSearchParams({ state: 'connections', connections: 'not json' })
    const dom = new JSDOM(page, { url: `file:///boot.html?${query.toString()}`, runScripts: 'dangerously' })
    expect(dom.window.document.querySelectorAll('#list .row')).toHaveLength(1)
  })
})
