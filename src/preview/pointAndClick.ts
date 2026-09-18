import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// Point-and-click in both directions (DECISIONS D7, D19). LilyPond wraps what a
// piece of input produced in `<a xlink:href="textedit://PATH:LINE:CHAR:COLUMN">`
// (ARCHITECTURE §3.5). No `vscode` import: the mapping is tested under `node --test`.

/** A place in a source file, in the numbers LilyPond prints. */
export interface SourceLocation {
  /** Absolute and decoded. */
  file: string
  /** 1-based. */
  line: number
  /** 0-based, in code points, tabs not expanded: the `CHAR` field. */
  char: number
}

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

/** `CHAR` → the editor's UTF-16 character: an astral character is two units. */
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

/**
 * The spelling under which the index knows a file. LilyPond prints paths as it
 * was given them (ARCHITECTURE appendix A), the editor may spell the same file
 * through a symlink or in another case, so both sides are compared by realpath.
 */
export async function canonicalFile(file: string): Promise<string> {
  const real = await fs.realpath(file).catch(() => path.resolve(file))
  // VS Code spells the drive letter in lower case, LilyPond as it was given.
  return process.platform === 'win32' ? real.toLowerCase() : real
}

interface Link {
  char: number
  href: string
}

// 2.26 writes `xlink:href`; the webview reads a plain SVG 2 `href` as well.
const ANCHOR = /<a\b[^>]*?\s(?:xlink:)?href="(textedit:[^"]*)"/g
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * Where the elements of one render come from: file → line → links ordered by
 * `CHAR`. Built on the host from the SVG text (D7); the webview finds the
 * elements again by their href, which is why lookups answer with hrefs.
 */
export class LinkIndex {
  static readonly empty = new LinkIndex(new Map())

  private constructor(private readonly files: Map<string, Map<number, Link[]>>) {}

  static async build(pages: string[]): Promise<LinkIndex> {
    const byFile = new Map<string, Map<string, SourceLocation>>()
    for (const page of pages) {
      for (const [, raw] of page.matchAll(ANCHOR)) {
        // As the webview's XML parser will read the attribute.
        const href = raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name])
        const location = parseTextEdit(href)
        if (!location) continue
        let links = byFile.get(location.file)
        if (!links) byFile.set(location.file, (links = new Map()))
        links.set(href, location)
      }
    }

    const files = new Map<string, Map<number, Link[]>>()
    for (const [file, links] of byFile) {
      const key = await canonicalFile(file)
      let lines = files.get(key)
      if (!lines) files.set(key, (lines = new Map()))
      for (const [href, { line, char }] of links) {
        const onLine = lines.get(line)
        if (onLine) onLine.push({ char, href })
        else lines.set(line, [{ char, href }])
      }
    }
    for (const lines of files.values()) {
      for (const onLine of lines.values()) onLine.sort((a, b) => a.char - b.char)
    }
    return new LinkIndex(files)
  }

  /**
   * The hrefs to highlight for a cursor at `char` of `line`: the nearest link at
   * or before the cursor on that line, so a cursor anywhere in `cis'4.` finds
   * the note. Left of the line's first link it is that first link. `file` must
   * come from canonicalFile().
   */
  lookup(file: string, line: number, char: number): string[] {
    const onLine = this.files.get(file)?.get(line)
    if (!onLine) return []
    let nearest = onLine[0].char
    for (const link of onLine) if (link.char <= char) nearest = link.char
    return onLine.filter((link) => link.char === nearest).map((link) => link.href)
  }
}
