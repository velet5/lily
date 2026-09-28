import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseTextEdit } from '@lily/common/textedit'
import type { SourceLocation } from '@lily/common/types'

// Point-and-click in both directions (DECISIONS D7, D19). LilyPond wraps what a
// piece of input produced in `<a xlink:href="textedit://PATH:LINE:CHAR:COLUMN">`
// (ARCHITECTURE §3.5). No `vscode` import: the mapping is tested under `node --test`.
// The `CHAR` conversions live in the Node-free @lily/common/span, which Lily
// Studio's renderer bundles, and `parseTextEdit` in @lily/common/textedit;
// they are re-exported here.
export { charToCharacter, characterToChar } from '@lily/common/span'
export { parseTextEdit } from '@lily/common/textedit'
export type { SourceLocation } from '@lily/common/types'

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

  static merge(indexes: readonly LinkIndex[]): LinkIndex {
    const files = new Map<string, Map<number, Link[]>>()
    for (const index of indexes) for (const [file, lines] of index.files) {
      let target = files.get(file)
      if (!target) files.set(file, (target = new Map()))
      for (const [line, links] of lines) target.set(line, [...(target.get(line) ?? []), ...links])
    }
    for (const lines of files.values()) for (const links of lines.values()) links.sort((a, b) => a.char - b.char)
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
