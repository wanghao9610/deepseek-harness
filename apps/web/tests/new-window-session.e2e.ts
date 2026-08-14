// Web e2e scenario: a window opened as a new one takes a session of its own.
//
// Every window of one browser profile shares localStorage, so a second window
// restoring the shared selection opens the session the first window is already
// showing, and the two then run one conversation between them. The desktop
// application's New Window is where a user meets this: it opens another window
// on the same loopback origin, and what appeared was the previous window again.
//
// The selection is per window now — sessionStorage answers first, the shared
// cell is only the cold-start seed — and the `new` address parameter is how the
// shell that opens a window says this one starts on a session nobody else
// holds. The unit specs pin the storage rule and the workspace connect over
// hand-built stores; what only the assembled application can show is that two
// real browser windows over one profile, one real client each, land on two
// different sessions on the real host.
//
// Two pages of ONE browser context are what reproduces it: `browser.newPage`
// gives each page a context of its own, and isolated storage would pass this
// scenario with the bug still in place.
//
// Zero model calls: registering a workspace and opening blank sessions are host
// RPCs with no model involvement. A stray stream would fail loud with
// NO_ADAPTER.
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

/** The live composer of a blank session, which is what a settled window shows. */
const LIVE_COMPOSER = 'textarea:enabled[placeholder="Describe what you want to build"]'

/**
 * The session one window is showing, read from the cell that decides it.
 * @param page - the window to ask.
 * @returns the session id, or undefined while the window holds none.
 */
function shownSession(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem('dsh.sessions.current')
    return raw === null ? undefined : (JSON.parse(raw) as { sessionId?: string }).sessionId
  })
}

describe('web e2e: new-window session isolation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let profile: BrowserContext
  let firstWindow: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // One context is one browser profile: the storage both windows share.
    profile = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    firstWindow = await profile.newPage()
    tripwire = watchConsole(firstWindow)
    await firstWindow.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await firstWindow.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(firstWindow, scaffold.workspaceCwd, 'new-window-session')
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens a second window on its own session and leaves the first one where it was', async () => {
    onTestFailed(() => saveFailureShot(firstWindow, 'web-e2e-new-window-session'))
    const held = await shownSession(firstWindow)
    expect(held).toBeDefined()
    expect(scaffold.ctx.sessions.list()).toHaveLength(1)

    const newWindow = await profile.newPage()
    const newWindowTripwire = watchConsole(newWindow)
    await newWindow.goto(`${scaffold.baseUrl}?new=1`, { waitUntil: 'load' })
    await newWindow.locator(LIVE_COMPOSER).waitFor({ timeout: 30_000 })

    // The workspace's blank session is exactly the reuse hit that would put
    // both windows on one conversation, so the new window mints its own.
    const own = await shownSession(newWindow)
    expect(own).toBeDefined()
    expect(own).not.toBe(held)
    expect(scaffold.ctx.sessions.list()).toHaveLength(2)

    // The directive is spent on arrival: reloading a window means "show me
    // this again", so the address it kept carries no request for another one.
    expect(await newWindow.evaluate(() => location.search)).toBe('')
    const warningsBefore = newWindowTripwire.warnings.length
    await newWindow.reload({ waitUntil: 'load' })
    await newWindow.locator(LIVE_COMPOSER).waitFor({ timeout: 30_000 })
    acknowledgeReloadConnectionLoss(newWindowTripwire, warningsBefore)
    expect(await shownSession(newWindow)).toBe(own)
    expect(scaffold.ctx.sessions.list()).toHaveLength(2)

    // The first window never followed: the second one's selection, and the
    // shared cell it moved, are not what decides what this window shows.
    expect(await shownSession(firstWindow)).toBe(held)
    expect(await firstWindow.evaluate(() => localStorage.getItem('dsh.sessions.current'))).toContain(own)

    expect(newWindowTripwire.pageErrors).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await newWindow.close()
  }, 120_000)
})
