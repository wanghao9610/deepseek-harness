/**
 * What the opener asked of this window, carried in the address it was opened
 * at. A shell that opens a window — the desktop application's New Window, a
 * link, a typed URL — cannot reach into that window's storage, so the address
 * is the only channel it has for saying what the window is for.
 */

/** Address parameter asking a window to start on a session of its own. */
const NEW_SESSION_PARAM = 'new'

/** The directives one window was opened with. */
export interface WindowBoot {
  /**
   * Start on a newly created session instead of the one this browser last
   * selected. Two windows on one session move each other, so a window opened
   * as a new one takes a session no other window is showing.
   */
  freshSession: boolean
}

/** What a window nobody asked anything of starts with. */
export const DEFAULT_WINDOW_BOOT: WindowBoot = { freshSession: false }

/** The page fields {@link consumeWindowBoot} reads and rewrites. */
export interface PageAddress {
  /** The window's current address, as `location.href`. */
  href: string
  /**
   * Show another address without navigating to it.
   * @param href - the address to show instead.
   */
  replace: (href: string) => void
}

/**
 * Read this window's directives, and take them off the address so they are
 * spent: a directive left in the address bar would fire again on every reload,
 * and reloading a window means "show me this again", not "make me another one".
 * @param page - the window's address; defaults to this page, and a run without one has no directives.
 * @returns the directives this window was opened with.
 */
export function consumeWindowBoot(page: PageAddress | undefined = browserPage()): WindowBoot {
  if (page === undefined) return DEFAULT_WINDOW_BOOT
  const url = new URL(page.href)
  if (!url.searchParams.has(NEW_SESSION_PARAM)) return DEFAULT_WINDOW_BOOT
  url.searchParams.delete(NEW_SESSION_PARAM)
  page.replace(`${url.pathname}${url.search}${url.hash}`)
  return { freshSession: true }
}

/**
 * This page's address.
 * @returns the address, or `undefined` outside a browser (node runs booting the client tree).
 */
function browserPage(): PageAddress | undefined {
  if (typeof location === 'undefined' || typeof history === 'undefined') return undefined
  return {
    href: location.href,
    replace: (href) => { history.replaceState(history.state, '', href) },
  }
}
