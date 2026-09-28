import * as path from 'node:path'
import type { SourceLocation } from './types'

// The `textedit:` links of lilypond's SVG (DECISIONS D7, D19). The extension's
// point-and-click reads them with it, and Lily Studio's tests check its
// playback map against them; the studio itself reads them in Rust (D42).

/**
 * Reads a `textedit:` link. The numbers are taken from the right, because a
 * Windows path has a colon of its own; `COLUMN`, the tab-expanded form of
 * `CHAR`, is not needed.
 */
export function parseTextEdit(href: string): SourceLocation | undefined {
  const match = /^textedit:\/\/(.+):(\d+):(\d+):\d+$/s.exec(href.trim())
  if (!match) return undefined
  let file: string
  try {
    file = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  // `/C:/scores/a.ly` when the link was written with three slashes.
  if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1)
  const line = Number(match[2])
  const char = Number(match[3])
  if (!path.isAbsolute(file) || file.includes('\0')) return undefined
  if (line < 1 || !Number.isSafeInteger(line) || !Number.isSafeInteger(char)) return undefined
  return { file: path.normalize(file), line, char }
}
