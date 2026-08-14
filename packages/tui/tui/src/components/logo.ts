/**
 * Static terminal rasters of the official DeepSeek icon, shown above the
 * startup banner. Source: `../../assets/deepseek-color.svg`, whose path data is
 * copied exactly from the official icon (viewBox `0 0 24 24`, fill `#4D6BFE`) —
 * the same mark the deepseek.com wordmark carries. Each tier rasterizes that
 * path into a square binary mask without redrawing its contour. The Unicode
 * form packs two source rows into `\u2580`/`\u2584`/`\u2588`; the ASCII fallback packs the
 * same two bits into `'`/`_`/`#`. Assets contain no ANSI and are never
 * generated at runtime.
 * @module @deepseek-ai/dsh-tui/components/logo
 */

/** Responsive official-icon raster tier. */
export type TuiLogoTier = 'full' | 'compact' | 'minimal'

/** One raster with a block-cell primary and bit-equivalent ASCII fallback. */
export interface TuiLogo {
  /** Two vertical source pixels per terminal cell. */
  readonly unicode: readonly string[]
  /** Same two-bit cells encoded as top `'`, bottom `_`, and both `#`. */
  readonly ascii: readonly string[]
}

const fullUnicode = Object.freeze([
  '                           ▄',
  '       ▄▄▄▄▄▄▄▄▄▄███▀      ██▄',
  '    ▄███████████████▄      ████▄  ▄▄▄▄██',
  '  ▄███████████████████▄    ████████████▀',
  ' ▄██████████████████████▄   ▀█████████▀',
  '▄███▀█████████████████████▄   ████▀▀',
  '███       ▀▀█████████▀▀▀█████████▀',
  '███          ▀███████▀█  ▀███████',
  '███▄           ▀███████▄  ▀█████▀',
  '▀███             ▀██████████████',
  ' ▀███▄            ▀███████████▀',
  '  ▀███▄      ▄▄▄    ▀████████▀',
  '    █████▄    ███▄▄   ▀█████▄▄',
  '      ▀█████████████▄▄▄▄█▀█████▀',
  '        ▀▀███████████▀▀',
])

const fullAscii = Object.freeze([
  '                           _',
  "       __________###'      ##_",
  '    _###############_      ####_  ____##',
  "  _###################_    ############'",
  " _######################_   '#########'",
  "_###'#####################_   ####''",
  "###       ''#########'''#########'",
  "###          '#######'#  '#######",
  "###_           '#######_  '#####'",
  "'###             '##############",
  " '###_            '###########'",
  "  '###_      ___    '########'",
  "    #####_    ###__   '#####__",
  "      '#############____#'#####'",
  "        ''###########''",
])

const compactUnicode = Object.freeze([
  '     ▄▄▄▄▄▄▄██▀    █▄      ▄',
  '  ▄███████████▄▄   ███▄▄████',
  ' ████████████████▄ ▀██████▀',
  '██▀▀▀▀▀████████████▄▄██▀',
  '██       ▀█████▄ ▀█████',
  '██▄        ▀████▄ ▄████',
  ' ██▄         ████████▀',
  '  ██▄    ▄▄   ▀█████▀',
  '   ▀███▄▄▄███▄  ████▄▄',
  '     ▀▀▀███████▀▀',
])

const compactAscii = Object.freeze([
  "     _______##'    #_      _",
  '  _###########__   ###__####',
  " ################_ '######'",
  "##'''''############__##'",
  "##       '#####_ '#####",
  "##_        '####_ _####",
  " ##_         ########'",
  "  ##_    __   '#####'",
  "   '###___###_  ####__",
  "     '''#######''",
])

const minimalUnicode = Object.freeze([
  '   ▄▄▄▄▄▄   ▄▄',
  ' ▄████████▄ ▀████▀',
  '█▀▀▀▀███████▄██▀',
  '█▄    ▀███ ▀███',
  '▀█▄     ▀█████',
  ' ▀█▄▄ █▄▄▀███▄',
  '    ▀▀▀▀▀▀',
])

const minimalAscii = Object.freeze([
  '   ______   __',
  " _########_ '####'",
  "#''''#######_##'",
  "#_    '### '###",
  "'#_     '#####",
  " '#__ #__'###_",
  "    ''''''",
])

/** Exact-path terminal rasters of the DeepSeek mark, by responsive tier. */
export const DEEPSEEK_LOGO = Object.freeze({
  full: Object.freeze({ unicode: fullUnicode, ascii: fullAscii }),
  compact: Object.freeze({ unicode: compactUnicode, ascii: compactAscii }),
  minimal: Object.freeze({ unicode: minimalUnicode, ascii: minimalAscii }),
}) satisfies Readonly<Record<TuiLogoTier, TuiLogo>>

/**
 * Terminal columns each tier is drawn at. A raster reads as the DeepSeek mark
 * only at roughly a third of the banner's width, so each tier claims a terminal
 * wide enough to carry it (its own art is 40, 28, and 18 columns).
 */
const TIER_COLUMNS: Readonly<Record<TuiLogoTier, number>> = Object.freeze({ full: 100, compact: 60, minimal: 40 })

/**
 * Largest raster this terminal can carry without crowding the transcript.
 * Width picks the tier, and a row budget of a third of the viewport drops to a
 * smaller mark — then out entirely — so a short terminal still opens on
 * conversation rather than on art.
 * @param innerWidth - banner width in columns, after the left gutter.
 * @param viewportRows - total terminal rows.
 * @returns the tier to draw, or `undefined` when the banner stays text-only.
 */
export function selectLogoTier(innerWidth: number, viewportRows: number): TuiLogoTier | undefined {
  const rowBudget = Math.floor(viewportRows / 3)
  for (const tier of ['full', 'compact', 'minimal'] as const) {
    const logo = DEEPSEEK_LOGO[tier]
    if (innerWidth >= TIER_COLUMNS[tier] && logo.unicode.length <= rowBudget) return tier
  }
  return undefined
}

/**
 * Whether the terminal cannot be trusted with block-drawing characters.
 * @param env - process environment to inspect.
 * @returns true when the printable-ASCII raster must be used instead.
 */
export function needsAsciiLogo(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG']
  return env['TERM'] === 'dumb' || locale === 'C' || locale === 'POSIX'
}
