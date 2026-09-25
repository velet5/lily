import * as path from 'node:path'
import { displayWidth } from './span'

// Pure functions from lilypond's stderr to editor-independent diagnostics
// (DECISIONS D6, D16). No `vscode` import: the CLI and MCP server reuse this.
// Columns and spans are in span.ts, which Lily Studio's renderer uses too.

export { columnToCharacter, diagnosticSpan, type Span } from './span'

export type LySeverity = 'error' | 'warning'

export interface LyDiagnostic {
  /** Absolute path; the root file for messages that carry no location. */
  file: string
  /** 1-based; 1 for messages that carry no location. */
  line: number
  /**
   * As lilypond prints it: 1-based, counted in code points with tabs advancing
   * to the next multiple of 8. Convert with `columnToCharacter`. Absent when the
   * message names only a line, or no location at all.
   */
  column?: number
  severity: LySeverity
  /** Without the severity keyword; continuation lines are joined with `\n`. */
  message: string
}

export interface ParseOptions {
  /** Receives the messages that carry no location. */
  rootFile: string
  /** Base for relative paths; the compile cwd. Defaults to the root's directory. */
  cwd?: string
}

const KEYWORDS = 'fatal error|programming error|error|warning'
// Tried first, so that a bare message quoting a location is not read as located.
const BARE = new RegExp(`^(${KEYWORDS}): (.*)$`)
// The lazy path stops at the first `:LINE[:COL]: keyword:`; the colon of a
// Windows drive letter is not followed by digits and is skipped.
const LOCATED = new RegExp(`^(.+?):(\\d+)(?::(\\d+))?: (${KEYWORDS}): (.*)$`)

interface Header {
  file?: string
  line?: number
  column?: number
  keyword: string
  message: string
}

/**
 * Parses the stderr of a run made with English messages (`LANGUAGE=en`, D15).
 * Order of first appearance is kept; identical entries are reported once.
 */
export function parseStderr(stderr: string, options: ParseOptions): LyDiagnostic[] {
  const rootFile = path.resolve(options.rootFile)
  const cwd = options.cwd ?? path.dirname(rootFile)
  const lines = stderr.split(/\r?\n/)

  const diagnostics: LyDiagnostic[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length; ) {
    const header = parseHeader(lines[index++])
    // Anything before the first message (Guile notes, backtraces) stays in the
    // raw output only.
    if (!header) continue

    const block: string[] = []
    while (index < lines.length && !parseHeader(lines[index])) block.push(lines[index++])

    // Text parsed by Scheme is located in `<included string>` or `<string>`,
    // which is no file: the message goes to the root and names where it was.
    const inString = header.file !== undefined && /^<.*>$/.test(header.file)
    const origin = `(in ${header.file}, line ${header.line}, column ${header.column})`
    const message = [header.message, ...continuation(block, header.column), inString ? origin : '']
      .map((line) => line.trim())
      // "continuing, cross fingers" follows every programming error.
      .filter((line) => line !== '' && line !== 'continuing, cross fingers')
      .join('\n')
    const located = header.file !== undefined && !inString
    const diagnostic: LyDiagnostic = {
      file: located ? path.resolve(cwd, header.file!) : rootFile,
      line: located ? Math.max(1, header.line ?? 1) : 1,
      ...(located && header.column !== undefined ? { column: Math.max(1, header.column) } : {}),
      severity: header.keyword === 'error' || header.keyword === 'fatal error' ? 'error' : 'warning',
      // A programming error is a lilypond bug the run survived; say so.
      message: header.keyword === 'programming error' ? `programming error: ${message}` : message,
    }

    const key = JSON.stringify(diagnostic)
    if (!seen.has(key)) {
      seen.add(key)
      diagnostics.push(diagnostic)
    }
  }

  // `fatal error: failed files: "…"` closes every failed run. Next to the errors
  // that caused it, it is noise; alone, it is the only sign of the failure.
  const isSummary = (d: LyDiagnostic) => d.column === undefined && d.message.startsWith('failed files: ')
  const hasCause = diagnostics.some((d) => d.severity === 'error' && !isSummary(d))
  return hasCause ? diagnostics.filter((d) => !isSummary(d)) : diagnostics
}

function parseHeader(line: string): Header | undefined {
  const bare = BARE.exec(line)
  if (bare) return { keyword: bare[1], message: bare[2] }
  const located = LOCATED.exec(line)
  if (!located) return undefined
  return {
    file: located[1],
    line: Number(located[2]),
    column: located[3] === undefined ? undefined : Number(located[3]),
    keyword: located[4],
    message: located[5],
  }
}

/**
 * The lines of a message block that belong to the message. A message with a
 * column is followed by two context lines: the source line up to the column,
 * then the rest of it indented to the column. Message text can come before them
 * (`(search path: …)`) and after them (Guile's `In procedure car: …`).
 */
function continuation(block: readonly string[], column: number | undefined): string[] {
  if (column === undefined) return [...block]
  const indent = column - 1
  for (let index = 0; index + 1 < block.length; index++) {
    const rest = block[index + 1]
    if (
      displayWidth(block[index]) === indent &&
      rest.length >= indent &&
      rest.slice(0, indent).trim() === ''
    ) {
      return [...block.slice(0, index), ...block.slice(index + 2)]
    }
  }
  return [...block]
}
