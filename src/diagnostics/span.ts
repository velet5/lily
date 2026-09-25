// Where a diagnostic sits in a line of text (DECISIONS D16). Neither `vscode`
// nor Node: Lily Studio's renderer turns diagnostics into Monaco markers with
// it (D31). parse.ts re-exports it, and src/preview/pointAndClick.ts the
// `CHAR` conversions of point-and-click (D19).

const TAB_WIDTH = 8

function advance(width: number, char: string): number {
  return char === '\t' ? width + TAB_WIDTH - (width % TAB_WIDTH) : width + 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width = advance(width, char)
  return width
}

/**
 * Converts a stderr column to a 0-based UTF-16 offset into the real line text,
 * undoing tab expansion and code-point counting (ARCHITECTURE §3.5). A column
 * past the end of the line yields the line length.
 */
export function columnToCharacter(lineText: string, column: number): number {
  let width = 0
  let character = 0
  for (const char of lineText) {
    if (width >= column - 1) break
    width = advance(width, char)
    character += char.length
  }
  return character
}

/** A point-and-click `CHAR` → the editor's UTF-16 character: an astral character is two units. */
export function charToCharacter(lineText: string, char: number): number {
  let character = 0
  for (let seen = 0; seen < char && character < lineText.length; seen++) {
    character += lineText.codePointAt(character)! > 0xffff ? 2 : 1
  }
  return character
}

/** The editor's UTF-16 character → `CHAR`. */
export function characterToChar(lineText: string, character: number): number {
  return Array.from(lineText.slice(0, character)).length
}

export interface Span {
  /** 0-based UTF-16 offsets into the line; `end` is exclusive. */
  start: number
  end: number
}

// What lilypond points at, in the order tried: a command or escaped sign
// (`\foo`, `\<`), a string, a word with its duration and octave marks
// (`cis''4.`, `Foo.bar`, `é`), else the single character. Embedded Scheme is
// handled apart: lilypond points at the `(` after the `#`.
const TOKEN = /\\(?:[\p{L}-]+|.)|"(?:[^"\\]|\\.)*"?|[\p{L}\p{N}_.',!?-]+|./uy

/**
 * The part of a line a diagnostic should underline: the token at its column, or
 * the whole line (without indentation) when it has no column. Never empty unless
 * the line is, so the squiggle stays visible for "unexpected end of input".
 */
export function diagnosticSpan(lineText: string, column?: number): Span {
  if (column === undefined) {
    const start = lineText.length - lineText.trimStart().length
    return { start, end: Math.max(start, lineText.trimEnd().length) }
  }
  const start = columnToCharacter(lineText, column)
  if (start >= lineText.length || /\s/.test(lineText[start])) {
    // At whitespace or the end of the line: mark the character before instead.
    return start >= lineText.length && start > 0
      ? { start: start - 1, end: start }
      : { start, end: Math.min(lineText.length, start + 1) }
  }
  if (lineText[start] === '(') return schemeSpan(lineText, start)
  TOKEN.lastIndex = start
  const token = TOKEN.exec(lineText)
  return { start, end: start + (token ? token[0].length : 1) }
}

/** From the `#` or `$` before `(` to the matching `)`, or to the end of the line. */
function schemeSpan(lineText: string, open: number): Span {
  const start = open > 0 && /[#$]/.test(lineText[open - 1]) ? open - 1 : open
  let depth = 0
  for (let index = open; index < lineText.length; index++) {
    if (lineText[index] === '(') depth++
    else if (lineText[index] === ')' && --depth === 0) return { start, end: index + 1 }
  }
  return { start, end: lineText.trimEnd().length }
}
