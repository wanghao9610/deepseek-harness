/**
 * The model-facing coordinate vocabulary shared by the runtime's two failure
 * paths: the host's parse diagnostic ({@link ./index.ts}) and the worker's
 * thrown-error stack ({@link ./bootstrap.ts}). Both restate a failure in the
 * lines and columns the model wrote, so one module owns how such a location
 * reads and how it is recovered from an engine diagnostic.
 * @module @deepseek-ai/dsh-code-runtime-worker-thread/src/program-location
 */

/** The pseudo-file every reported location names: the program the model wrote, which has no path on any disk. */
export const PROGRAM_FILE = 'program'

/**
 * Render one location in the program's own coordinates.
 * @param line - 1-based line, counted from the model's first line.
 * @param column - 1-based column; omitted when the diagnostic carries none.
 * @returns the location text used inside a reported frame.
 */
export function programLocation(line: number, column?: number): string {
  return column === undefined ? `${PROGRAM_FILE}:${line}` : `${PROGRAM_FILE}:${line}:${column}`
}

/**
 * The errored line of a type-strip diagnostic: its first line is `:<line>`,
 * counted in the wrapped source the stripper parsed.
 */
const SYNTAX_MARKER = /^[^\n]*:(\d+)(?:\n|$)/

/** The stripper's column marker: the source-window line that underlines the offending span. */
const SYNTAX_CARET = /^ *\^+$/

/**
 * Recover the failing location from a type-strip diagnostic, whose stack opens
 * with the wrapped line number and underlines the offending span in a source
 * window. A parse that fails on the wrapper's own lines — an unterminated
 * program reported at the appended brace — yields nothing rather than a
 * location outside what the model wrote.
 * @param stack - the thrown diagnostic's `stack` text.
 * @param headerLines - lines the strip wrapper adds before the program's line 1.
 * @param programLines - the program's own line count, the last line a location may name.
 * @returns the rendered location, or `undefined` when the diagnostic carries
 *   none inside the program.
 */
export function programSyntaxLocation(stack: string, headerLines: number, programLines: number): string | undefined {
  const marker = SYNTAX_MARKER.exec(stack)
  if (marker?.[1] === undefined) return undefined
  const line = Number(marker[1]) - headerLines
  if (line < 1 || line > programLines) return undefined
  // The caret rides its own line in the source window; nothing after the
  // window — the message line and the stripper's own frames — can match it.
  const caret = stack.split('\n').slice(1).find(text => SYNTAX_CARET.test(text))
  return programLocation(line, caret === undefined ? undefined : caret.indexOf('^') + 1)
}
