import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@deepseek-ai/tui'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HeaderComponent } from '../src/components/transcript.ts'
import { DEEPSEEK_LOGO, needsAsciiLogo, selectLogoTier } from '../src/components/logo.ts'
import { createPalette } from '../src/components/theme.ts'

const palette = createPalette(false)

/** Minimal stand-in: the banner reads only the session id off the agent. */
function bannerAgent(): Agent {
  return { session: { id: SessionId('main-session-bench') } } as unknown as Agent
}

function header(rows: number, gradient = false): HeaderComponent {
  return new HeaderComponent(bannerAgent(), () => 'Bench subtitle', palette, gradient, () => rows)
}

describe('startup banner mark', () => {
  it('picks the tier from terminal width, then drops it as rows run short', () => {
    expect(selectLogoTier(120, 60)).toBe('full')
    expect(selectLogoTier(80, 60)).toBe('compact')
    expect(selectLogoTier(48, 60)).toBe('minimal')
    expect(selectLogoTier(30, 60)).toBeUndefined()
    // Width alone is not enough: a wide but short terminal steps down, then out.
    expect(selectLogoTier(120, 36)).toBe('compact')
    expect(selectLogoTier(120, 24)).toBe('minimal')
    expect(selectLogoTier(120, 12)).toBeUndefined()
  })

  it('renders the mark above the product name and clips it to the reveal width', () => {
    const banner = header(60)
    const full = banner.render(120)
    // The mark's first row is its sparse top edge, so assert on the block as a
    // whole rather than on one row's cells.
    expect(full.slice(0, DEEPSEEK_LOGO.full.unicode.length).join('\n')).toContain('█')
    expect(full.some(line => line.includes('DEEPSEEK'))).toBe(true)
    expect(full.some(line => line.includes('main-session-bench'))).toBe(true)

    // The sweep reveal clips every row, mark included, to the revealed columns.
    banner.setRevealWidth(6)
    for (const line of banner.render(120)) expect(visibleWidth(line)).toBeLessThanOrEqual(6)
  })

  it('omits the mark entirely when the terminal cannot carry it', () => {
    const lines = header(60).render(30)
    expect(lines.every(line => !line.includes('█'))).toBe(true)
    expect(lines[0]).toContain('DEEPSEEK')
  })

  it('keeps the ASCII twin bit-equivalent to the block raster', () => {
    for (const tier of ['full', 'compact', 'minimal'] as const) {
      const { unicode, ascii } = DEEPSEEK_LOGO[tier]
      expect(ascii).toHaveLength(unicode.length)
      for (const [index, row] of unicode.entries()) {
        const twin = ascii[index]
        expect(twin).toBeDefined()
        // `▀`→`'`, `▄`→`_`, `█`→`#`; every other cell is the same space.
        expect(row.replace(/▀/gu, "'").replace(/▄/gu, '_').replace(/█/gu, '#')).toBe(twin)
      }
    }
  })

  it('falls back to printable ASCII on terminals that cannot be trusted with block drawing', () => {
    expect(needsAsciiLogo({ TERM: 'dumb' })).toBe(true)
    expect(needsAsciiLogo({ LANG: 'C' })).toBe(true)
    expect(needsAsciiLogo({ LC_ALL: 'POSIX' })).toBe(true)
    expect(needsAsciiLogo({ LANG: 'en_US.UTF-8', TERM: 'xterm-256color' })).toBe(false)
    expect(needsAsciiLogo({})).toBe(false)
  })

  // pi-tui re-renders every component each frame, so the banner sits on the
  // per-frame path for the life of the session — including through the whole
  // sweep reveal, which re-renders it once per frame at a new clip width.
  it('renders within the per-frame budget at every tier', () => {
    for (const rows of [60, 36, 24, 12]) {
      const banner = header(rows)
      const started = performance.now()
      for (let frame = 0; frame < 1_000; frame += 1) {
        banner.setRevealWidth(frame % 120)
        banner.render(120)
      }
      const perFrameMs = (performance.now() - started) / 1_000
      expect(perFrameMs).toBeLessThan(1)
    }
  })
})
