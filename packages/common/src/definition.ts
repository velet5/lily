// Where a `\name` the score uses is defined (DECISIONS D119): go to definition
// and the hover's preview in both apps. Neither `vscode` nor Node: Lily
// Studio's renderer bundles it, and each app reads included files its own way.

/** A word as UTF-16 offsets into its line; `end` is exclusive. */
export interface Reference {
  name: string
  start: number
  end: number
}

export interface Definition {
  /** Where the defined name starts in its text, and its length. */
  offset: number
  length: number
  /** The whole assignment, as many lines as it spans (at most PREVIEW_LINES). */
  preview: string
}

export interface Found extends Definition {
  /** The file it is in: the one asked about, or one it includes. */
  file: string
  /** That file's text, for turning `offset` into a line and a character. */
  text: string
}

export interface Sources {
  /** The text of `file`, unsaved edits included; undefined when it cannot be read. */
  read(file: string): Promise<string | undefined>
  /** The file `\include "target"` in `from` reads. */
  resolve(from: string, target: string): string
}

/** A LilyPond identifier: letters, with `-` or `_` only between them. */
const NAME = String.raw`\p{L}+(?:[-_]\p{L}+)*`
const PREVIEW_LINES = 12
/** How deep includes are followed; also stops a file that includes itself. */
const INCLUDE_DEPTH = 8

/** The `\name` at `character` in `lineText`, backslash or end included; undefined outside one or in a comment or string. */
export function referenceAt(lineText: string, character: number): Reference | undefined {
  const word = new RegExp(String.raw`\\(${NAME})`, 'gu')
  for (const match of lineText.matchAll(word)) {
    const start = match.index
    const end = start + match[0].length
    if (character < start || character > end) continue
    if (blank(lineText.slice(0, end)).slice(start, end) !== match[0]) return undefined
    return { name: match[1], start, end }
  }
  return undefined
}

/**
 * The definition of `name` in effect at `offset` of `file`: the nearest one
 * before it, looking into the files included on the way; else the first one
 * after it in `file`, which lilypond would reject but the reader still wants.
 */
export async function findDefinition(
  sources: Sources,
  file: string,
  text: string,
  name: string,
  offset: number,
): Promise<Found | undefined> {
  const before = await lastBefore(sources, file, text, name, offset, INCLUDE_DEPTH)
  if (before) return before
  const after = definitionsIn(text, name).find((definition) => definition.offset >= offset)
  return after && { ...after, file, text }
}

async function lastBefore(
  sources: Sources,
  file: string,
  text: string,
  name: string,
  offset: number,
  depth: number,
): Promise<Found | undefined> {
  const events = [
    ...definitionsIn(text, name).map((definition) => ({ at: definition.offset, definition, include: undefined })),
    ...(depth > 0 ? includesIn(text) : []).map((include) => ({ at: include.offset, definition: undefined, include })),
  ]
    .filter((event) => event.at < offset)
    .sort((a, b) => b.at - a.at)
  for (const event of events) {
    if (event.definition) return { ...event.definition, file, text }
    const included = sources.resolve(file, event.include!.target)
    const includedText = await sources.read(included)
    if (includedText === undefined) continue
    const found = await lastBefore(sources, included, includedText, name, includedText.length, depth - 1)
    if (found) return found
  }
  return undefined
}

/** The assignments of `name` in `text` (`name = …`, `"name" = …`, Scheme's `(define name …)`), in order. */
export function definitionsIn(text: string, name: string): Definition[] {
  const code = blank(text)
  // A quoted name is blanked in `code`; its length is matched there and its text checked in `text`.
  const assignment = new RegExp(String.raw`^([ \t]*)(?:${name}|"( {${name.length}})")\s*=(?!=)`, 'gmu')
  const scheme = new RegExp(String.raw`(\(define(?:-public)?\s+\(?)${name}(?=[\s)])`, 'gu')
  const definitions: Definition[] = []
  for (const pattern of [assignment, scheme]) {
    for (const match of code.matchAll(pattern)) {
      const nameOffset = match.index + match[1].length + (match[2] === undefined ? 0 : 1)
      if (text.slice(nameOffset, nameOffset + name.length) !== name) continue
      definitions.push({ offset: nameOffset, length: name.length, preview: previewAt(text, code, nameOffset) })
    }
  }
  return definitions.sort((a, b) => a.offset - b.offset)
}

/** The `\include "…"` statements of `text`: where each is and the file it names. */
export function includesIn(text: string): { offset: number; target: string }[] {
  const code = blank(text)
  const includes: { offset: number; target: string }[] = []
  // The string is blanked in `code`, so its text is read from `text`.
  for (const match of code.matchAll(/\\include\s*(?=")/g)) {
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text.slice(match.index + match[0].length))
    if (quoted) includes.push({ offset: match.index, target: quoted[1] })
  }
  return includes
}

/** 0-based line and UTF-16 character of `offset` in `text`. */
export function positionAt(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset)
  const lineStart = before.lastIndexOf('\n') + 1
  return { line: before.split('\n').length - 1, character: offset - lineStart }
}

/**
 * The assignment starting on the line of `offset`: up to the end of the line
 * where its braces, `<< >>` or Scheme parentheses close, or of its first line
 * when it opens none there.
 */
function previewAt(text: string, code: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  let depth = 0
  /** Open Scheme parentheses; a slur's `(` in music is not one. */
  let scheme = 0
  let end = code.length
  let lines = 1
  for (let i = offset; i < code.length; i++) {
    const char = code[i]
    if (char === '\n') {
      if (depth <= 0 || lines === PREVIEW_LINES) {
        end = i
        break
      }
      lines++
    } else if (char === '(' && (scheme > 0 || /#['`]?$/.test(code.slice(Math.max(0, i - 2), i)))) {
      scheme++
      depth++
    } else if (char === ')' && scheme > 0) {
      scheme--
      depth--
    } else if (scheme > 0) {
      continue
    } else if (char === '{' || code.startsWith('<<', i)) {
      depth++
      if (char === '<') i++
    } else if (char === '}' || code.startsWith('>>', i)) {
      depth--
      if (char === '>') i++
    }
  }
  const preview = text.slice(start, end).replace(/\s+$/, '')
  return depth > 0 && lines === PREVIEW_LINES ? `${preview}\n…` : preview
}

/**
 * `text` with its comments and the insides of its strings replaced by spaces,
 * offsets and line breaks kept, so that patterns match only code.
 */
function blank(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const char = text[i]
    if (char === '%') {
      const block = text[i + 1] === '{'
      const close = block ? text.indexOf('%}', i + 2) : text.indexOf('\n', i)
      const end = close < 0 ? text.length : block ? close + 2 : close
      out += spaces(text.slice(i, end))
      i = end
    } else if (char === '"') {
      let close = i + 1
      while (close < text.length && text[close] !== '"') close += text[close] === '\\' ? 2 : 1
      // The quotes stay, so that `"name" = …` is still an assignment.
      out += '"' + spaces(text.slice(i + 1, close)) + (close < text.length ? '"' : '')
      i = close + 1
    } else {
      out += char
      i++
    }
  }
  return out.slice(0, text.length)
}

const spaces = (text: string) => text.replace(/[^\n]/g, ' ')
