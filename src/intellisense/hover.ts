import type { CommandEntry, ContextEntry, GrobEntry, LilyIndex, PropertyEntry } from './data'

// Hover documentation from the generated data (DECISIONS D8, D21), and the
// Markdown that completion items show for the same entries. No `vscode` import;
// provider.ts adapts the result.

export interface LyHover {
  /** The hovered word as UTF-16 offsets into the line, end exclusive. */
  start: number
  end: number
  markdown: string
}

/** `\command`, `Context`, `GrobName`, `property-name`, `contextProperty`. */
const WORD = /\\?[A-Za-z]+(?:[-_][A-Za-z]+)*/g

/** After these a bare word is a context, a grob or a property, not a pitch or a syllable. */
const BEFORE_PATH =
  /\\(?:new|context|change|override|revert|overrideProperty|tweak|hide|omit|set|unset)\s+(?:[A-Za-z]+\.)*$/

export function hoverAt(
  index: LilyIndex,
  lineText: string,
  character: number,
  /** Text before the line, as far back as is cheap; only used to notice `\markup`. */
  textBefore = '',
): LyHover | undefined {
  const word = wordAt(lineText, character)
  if (!word || !isCode(lineText.slice(0, word.start))) return undefined
  const found = (markdown: string | undefined) => (markdown ? { ...word, markdown } : undefined)

  if (word.text.startsWith('\\')) {
    const name = word.text.slice(1)
    const command = index.commands.get(name)
    if (command) {
      return found(describeCommand(command, inMarkup(textBefore + lineText.slice(0, word.start))))
    }
    // `\Staff` opens a context definition in `\layout { \context { … } }`.
    const context = index.contexts.get(name)
    return found(context && describeContext(context))
  }

  // Bare words are music far more often than names: `Rest`, `color` and `text`
  // are also lyrics. Only a word in a property path is looked up.
  const before = lineText.slice(0, word.start)
  const after = lineText.slice(word.end)
  const inPath = before.endsWith('.') || /^\.[A-Za-z]/.test(after) || BEFORE_PATH.test(before)
  const assigned = /^\s*=(?!=)/.test(after)
  if (!inPath && !assigned) return undefined

  const context = inPath ? index.contexts.get(word.text) : undefined
  if (context) return found(describeContext(context))
  const grob = inPath ? index.grobs.get(word.text) : undefined
  if (grob) return found(describeGrob(grob))
  const contextProperty = index.contextProperties.get(word.text)
  if (contextProperty) return found(describeProperty(contextProperty, 'context property'))
  const grobProperty = index.grobProperties.get(word.text)
  return found(grobProperty && describeProperty(grobProperty, 'grob property'))
}

function wordAt(lineText: string, character: number) {
  for (const match of lineText.matchAll(WORD)) {
    const start = match.index
    const end = start + match[0].length
    // `\\` is the voice separator; the second backslash starts no command.
    if (match[0].startsWith('\\') && precedingBackslashes(lineText, start) % 2 === 1) continue
    if (character >= start && character <= end) return { start, end, text: match[0] }
    if (start > character) break
  }
  return undefined
}

export function precedingBackslashes(text: string, end: number): number {
  let count = 0
  while (end - count > 0 && text[end - count - 1] === '\\') count++
  return count
}

/** False when `linePrefix` ends inside a string or a `%` comment. */
export function isCode(linePrefix: string): boolean {
  let inString = false
  for (let i = 0; i < linePrefix.length; i++) {
    const char = linePrefix[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '%') return false
  }
  return !inString
}

/**
 * Whether `textBefore` ends inside `\markup`: in an open `{ … }` after it, or in
 * the run of commands that follows it (`\markup \bold \italic`). A heuristic, so
 * it only ever reorders or rewords what is shown.
 */
export function inMarkup(textBefore: string): boolean {
  const last = [...textBefore.matchAll(/\\markup(?:list)?(?![A-Za-z])/g)].at(-1)
  if (!last) return false
  const rest = textBefore.slice(last.index + last[0].length)
  let depth = 0
  for (const char of rest) {
    if (char === '{') depth++
    else if (char === '}' && --depth < 0) return false
  }
  return depth > 0 || /^(?:\s|\\[A-Za-z-]+|#\S+)*\\?[A-Za-z-]*$/.test(rest)
}

// --- Markdown, shared with completion.ts ------------------------------------

const code = (text: string) => '```lilypond\n' + text + '\n```'

export function describeCommand(command: CommandEntry, markup = false): string {
  const shown = markup && command.markup ? command.markup : command
  const call = `\\${command.name}${shown.signature ? ` ${shown.signature}` : ''}`
  const parts = [code(call), `*${shown.detail}*`]
  if (shown.doc) parts.push(shown.doc)
  if (shown === command && command.expansion) parts.push('Same as', code(command.expansion))
  return parts.join('\n\n')
}

export function describeContext(context: ContextEntry): string {
  const parts = [code(`\\new ${context.name}`), '*context*']
  if (context.doc) parts.push(context.doc)
  if (context.aliases?.length) parts.push(`Alias of: ${context.aliases.join(', ')}`)
  if (context.accepts?.length) parts.push(`Accepts: ${context.accepts.join(', ')}`)
  return parts.join('\n\n')
}

export function describeGrob(grob: GrobEntry): string {
  const parts = [code(`\\override ${grob.name}.property = value`), '*layout object (grob)*']
  if (grob.doc) parts.push(grob.doc)
  if (grob.defaults?.length) parts.push(`Sets by default: ${grob.defaults.join(', ')}`)
  return parts.join('\n\n')
}

export function describeProperty(property: PropertyEntry, what: string): string {
  const parts = [`\`${property.name}\` — *${what}${property.type ? `, ${property.type}` : ''}*`]
  if (property.doc) parts.push(property.doc)
  return parts.join('\n\n')
}
