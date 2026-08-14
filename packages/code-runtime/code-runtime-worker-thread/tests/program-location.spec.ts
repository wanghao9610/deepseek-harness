import { describe, expect, it } from 'vitest'
import { programLocation, programSyntaxLocation } from '../src/program-location.ts'

/** One wrapper line precedes the program, matching the host's strip wrapper. */
const HEADER_LINES = 1

/** A type-strip diagnostic as Node renders it: wrapped line marker, source window with a caret, message, own frames. */
function syntaxStack(markerLine: number, window: string[]): string {
  return [
    `:${markerLine}`,
    ...window,
    '',
    'SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Unexpected token `{`',
    '    at parseTypeScript (node:internal/modules/typescript:72:36)',
  ].join('\n')
}

describe('programLocation', () => {
  it('renders with and without a column', () => {
    expect(programLocation(2, 17)).toBe('program:2:17')
    expect(programLocation(2)).toBe('program:2')
  })
})

describe('programSyntaxLocation', () => {
  it('counts from the model\'s first line and takes the column from the caret', () => {
    const stack = syntaxStack(3, [
      'const a = 1;',
      'const read = await tools.read({ file_path: "x", { offset: 1 });',
      '                                                ^',
      '}',
    ])
    expect(programSyntaxLocation(stack, HEADER_LINES, 2)).toBe('program:2:49')
  })

  it('reports the line alone when the diagnostic underlines nothing', () => {
    expect(programSyntaxLocation(':2\nenum E { A }\n', HEADER_LINES, 1)).toBe('program:1')
  })

  it('reports nothing for a location outside the program', () => {
    // An unterminated program fails at the wrapper's appended brace, one line
    // past what the model wrote.
    const stack = syntaxStack(3, ['const x = (', '}', '^'])
    expect(programSyntaxLocation(stack, HEADER_LINES, 1)).toBeUndefined()
    expect(programSyntaxLocation(syntaxStack(1, ['async function __dsh_program__() {', '^']), HEADER_LINES, 1))
      .toBeUndefined()
  })

  it('reports nothing for a diagnostic that opens with no line marker', () => {
    expect(programSyntaxLocation('SyntaxError: something else\n    at parseTypeScript', HEADER_LINES, 1))
      .toBeUndefined()
  })
})
