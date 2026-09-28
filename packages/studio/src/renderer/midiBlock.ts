// Add MIDI (DECISIONS D44): where `\midi { }` goes in a score, found without
// compiling. Every `\score` that lacks one gets it, after its `\layout`; a
// score with neither gets both, or it would stop being engraved. Music at the
// top of the file, outside any `\score`, is engraved but never played, and a
// top-level `\midi` does not change that, so each such expression is wrapped
// in a `\score` of its own. Pure: no DOM, no Monaco, so node --test loads it.

/** Replace `length` characters at `offset` with `text`. */
export interface TextEdit {
  offset: number
  length: number
  text: string
}

export type MidiInsertion =
  /** `edits` in the order of their offsets; `reveal` is the first `\midi` in the text after them. */
  | { kind: 'edits'; edits: TextEdit[]; reveal: number }
  /** Every score has its `\midi` already. */
  | { kind: 'has-midi' }
  /** No `\score` and no music in the file: it is in an `\include`d one, or there is none. */
  | { kind: 'no-score' }

type Kind = 'open' | 'close' | 'command' | 'word' | 'string' | 'scheme' | 'equals'

interface Token {
  kind: Kind
  /** The command's name without its backslash; the source text for the others. */
  text: string
  start: number
  end: number
  /** A line break lies between this token and the one before it. */
  newline: boolean
}

/** Commands that take the music written after them, possibly on the next line. */
const PREFIXES = new Set([
  'absolute', 'addlyrics', 'change', 'chordmode', 'chords', 'context', 'drummode', 'drums', 'figuremode',
  'figures', 'fixed', 'grace', 'lyricmode', 'lyrics', 'lyricsto', 'new', 'notemode', 'relative', 'repeat',
  'simultaneous', 'sequential', 'transpose', 'tuplet', 'times', 'unfoldRepeats', 'with',
  // and those that take a block
  'book', 'bookpart', 'header', 'layout', 'markup', 'markuplist', 'midi', 'paper', 'score',
])

/** Top-level commands that are not music a score could be made of. */
const NOT_MUSIC = new Set([
  'version', 'include', 'language', 'header', 'paper', 'layout', 'midi', 'markup', 'markuplist',
  'book', 'bookpart', 'pointAndClickOff', 'pointAndClickOn', 'pointAndClickTypes', 'defineBarLine',
  'bookOutputName', 'bookOutputSuffix', 'sourcefilename', 'sourcefileline',
])

export function addMidiBlock(text: string): MidiInsertion {
  const tokens = tokenize(text)
  const match = matchBrackets(tokens)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const edits: TextEdit[] = []
  const reveals: number[] = []
  let scores = 0

  const markup = markupRanges(tokens, match)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== 'command' || token.text !== 'score') continue
    // `\markup \score { … }` is a picture of music, not music.
    if (tokens[i - 1]?.kind === 'command' && tokens[i - 1].text.startsWith('markup')) continue
    if (markup.some(([from, to]) => i > from && i < to)) continue
    const open = i + 1
    if (tokens[open]?.kind !== 'open' || tokens[open].text !== '{' || match[open] < 0) continue
    scores++
    const edit = scoreEdit(text, tokens, match, open, eol)
    if (edit) {
      edits.push(edit.edit)
      reveals.push(edit.reveal)
    }
  }

  if (scores === 0) {
    for (const [start, end] of topLevelMusic(tokens, match)) {
      const edit = wrapInScore(text, tokens[start].start, tokens[end - 1].end, eol)
      edits.push(edit.edit)
      reveals.push(edit.reveal)
    }
    if (edits.length === 0) return { kind: 'no-score' }
  }
  if (edits.length === 0) return { kind: 'has-midi' }

  // The first edit's `\midi`, moved by nothing: every other edit comes after it.
  return { kind: 'edits', edits, reveal: edits[0].offset + reveals[0] }
}

/** The edit for the score whose `{` is `tokens[open]`; undefined when it has `\midi`. */
function scoreEdit(text: string, tokens: Token[], match: number[], open: number, eol: string): { edit: TextEdit; reveal: number } | undefined {
  const close = match[open]
  let layout = -1
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i]
    if (token.kind === 'command' && token.text === 'midi') return undefined
    if (token.kind === 'command' && token.text === 'layout' && tokens[i + 1]?.kind === 'open' && match[i + 1] > 0) layout = i
    if (token.kind === 'open' && match[i] > 0) i = match[i]
  }

  if (layout >= 0) {
    // `\midi { }` on a line of its own after the `\layout` block, indented as `\layout` is.
    const after = tokens[match[layout + 1]].end
    const insert = `${eol}${indentAt(text, tokens[layout].start)}\\midi { }`
    return { edit: { offset: after, length: 0, text: insert }, reveal: insert.indexOf('\\midi') }
  }

  const closing = tokens[close]
  const lineStart = startOfLine(text, closing.start)
  if (text.slice(lineStart, closing.start).trim() === '') {
    // `}` on its own line: both blocks on lines above it, indented as the score's body is.
    const indent = bodyIndent(text, tokens, open, close) ?? `${indentAt(text, closing.start)}  `
    const insert = `${indent}\\layout { }${eol}${indent}\\midi { }${eol}`
    return { edit: { offset: lineStart, length: 0, text: insert }, reveal: insert.indexOf('\\midi') }
  }
  // All on one line: `\score { { c4 } }` → `\score { { c4 } \layout { } \midi { } }`.
  const spaced = /\s/.test(text[closing.start - 1] ?? '')
  const insert = `${spaced ? '' : ' '}\\layout { } \\midi { } `
  return { edit: { offset: closing.start, length: 0, text: insert }, reveal: insert.indexOf('\\midi') }
}

/** The indentation of the score's first line of music, when it is on a line of its own. */
function bodyIndent(text: string, tokens: Token[], open: number, close: number): string | undefined {
  for (let i = open + 1; i < close; i++) if (tokens[i].newline) return indentAt(text, tokens[i].start)
  return undefined
}

function wrapInScore(text: string, start: number, end: number, eol: string): { edit: TextEdit; reveal: number } {
  const indent = indentAt(text, start)
  const music = text
    .slice(start, end)
    .split(/\r?\n/)
    .map((line, n) => (n === 0 ? `${indent}  ${line}` : line.trim() === '' ? line : `  ${line}`))
    .join(eol)
  const replacement = `\\score {${eol}${music}${eol}${indent}  \\layout { }${eol}${indent}  \\midi { }${eol}${indent}}`
  return { edit: { offset: start, length: end - start, text: replacement }, reveal: replacement.indexOf('\\midi') }
}

/** Token index ranges, [start, end), of the music expressions at the top of the file. */
function topLevelMusic(tokens: Token[], match: number[]): [number, number][] {
  const found: [number, number][] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    // name = value
    if ((token.kind === 'word' || token.kind === 'string') && tokens[i + 1]?.kind === 'equals') {
      i = expressionEnd(tokens, match, i + 2)
      continue
    }
    if (token.kind === 'scheme' || token.kind === 'string' || token.kind === 'equals' || token.kind === 'close') {
      i++
      continue
    }
    const end = expressionEnd(tokens, match, i)
    if (!(token.kind === 'command' && NOT_MUSIC.has(token.text))) found.push([i, end])
    i = end
  }
  return found
}

/**
 * Where the expression that starts at `tokens[i]` ends, exclusive: after its
 * first brace group (and the one after a `\with { }`), or at a line break
 * once nothing more is expected, as after `\melody`, `\pointAndClickOff` or
 * `\new Staff \melody`. A command such as `\relative` wants music, which may
 * be on the next line.
 */
function expressionEnd(tokens: Token[], match: number[], i: number): number {
  const first = i
  let afterWith = false
  let wantsMusic = false
  while (i < tokens.length) {
    const token = tokens[i]
    if (i > first && token.newline && !wantsMusic) return i
    if (token.kind === 'open') {
      const end = match[i] < 0 ? tokens.length - 1 : match[i]
      if (!afterWith) return end + 1
      afterWith = false
      i = end + 1
      continue
    }
    if (token.kind === 'close') return i
    if (i === first && (token.kind === 'scheme' || token.kind === 'string')) return i + 1
    afterWith = token.kind === 'command' && token.text === 'with'
    if (token.kind === 'command') wantsMusic = PREFIXES.has(token.text)
    i++
  }
  return i
}

/** Token ranges of `\markup { … }` blocks, whose `\score`s are pictures, not music. */
function markupRanges(tokens: Token[], match: number[]): [number, number][] {
  const ranges: [number, number][] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.kind !== 'command' || (token.text !== 'markup' && token.text !== 'markuplist')) continue
    const open = tokens.findIndex((t, j) => j > i && t.kind === 'open')
    if (open > 0 && match[open] > 0) ranges.push([open, match[open]])
  }
  return ranges
}

/** For each `{` or `<<`, the index of its partner, or -1; the same for each closer. */
function matchBrackets(tokens: Token[]): number[] {
  const match = tokens.map(() => -1)
  const stack: number[] = []
  const partner: Record<string, string> = { '}': '{', '#}': '#{', '>>': '<<' }
  tokens.forEach((token, i) => {
    if (token.kind === 'open') stack.push(i)
    else if (token.kind === 'close') {
      let top = stack.length - 1
      while (top >= 0 && tokens[stack[top]].text !== partner[token.text]) top--
      if (top < 0) return
      match[i] = stack[top]
      match[stack[top]] = i
      stack.length = top
    }
  })
  return match
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  let newline = true
  const push = (kind: Kind, start: number, end: number, name?: string) => {
    tokens.push({ kind, text: name ?? text.slice(start, end), start, end, newline })
    newline = false
    i = end
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\n') {
      newline = true
      i++
    } else if (/\s/.test(c)) i++
    else if (text.startsWith('%{', i)) {
      const end = text.indexOf('%}', i + 2)
      i = end < 0 ? text.length : end + 2
    } else if (c === '%') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end
    } else if (c === '"') push('string', i, stringEnd(text, i))
    else if (text.startsWith('#{', i)) push('open', i, i + 2)
    else if (text.startsWith('#}', i)) push('close', i, i + 2)
    else if (c === '#' || c === '$') push('scheme', i, schemeEnd(text, i + 1))
    else if (c === '{' || c === '}') push(c === '{' ? 'open' : 'close', i, i + 1)
    else if (text.startsWith('<<', i)) push('open', i, i + 2)
    else if (text.startsWith('>>', i)) push('close', i, i + 2)
    else if (c === '=') push('equals', i, i + 1)
    else if (c === '\\') {
      const name = /^[A-Za-z]+(?:[-_][A-Za-z]+)*/.exec(text.slice(i + 1, i + 200))?.[0]
      if (name) push('command', i, i + 1 + name.length, name)
      else push('word', i, Math.min(i + 2, text.length))
    } else {
      let end = i + 1
      while (end < text.length && !/[\s{}"%#$\\=]/.test(text[end]) && !text.startsWith('<<', end) && !text.startsWith('>>', end)) end++
      push('word', i, end)
    }
  }
  return tokens
}

/** The end of the string that opens at `start`, past its closing quote. */
function stringEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
  return Math.min(i + 1, text.length)
}

/** The end of the Scheme expression at `i`, just after its `#` or `$`. */
function schemeEnd(text: string, i: number): number {
  while (text[i] === "'" || text[i] === '`' || text[i] === ',') i++
  if (text[i] === '"') return stringEnd(text, i)
  if (text[i] !== '(') {
    while (i < text.length && !/[\s(){}"]/.test(text[i])) i++
    return i
  }
  let depth = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      i = stringEnd(text, i)
      continue
    }
    if (c === ';') {
      const end = text.indexOf('\n', i)
      i = end < 0 ? text.length : end
      continue
    }
    if (c === '#' && text[i + 1] === '\\') i += 3 // a character literal such as #\(
    else {
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i + 1
      i++
    }
  }
  return i
}

function startOfLine(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

/** The whitespace at the start of the line that `offset` is on. */
function indentAt(text: string, offset: number): string {
  const start = startOfLine(text, offset)
  return /^[ \t]*/.exec(text.slice(start))![0]
}
