import type { LilyIndex } from './data'
import {
  describeCommand,
  describeContext,
  describeGrob,
  describeProperty,
  inMarkup,
  isCode,
  precedingBackslashes,
} from './hover'

// Context-aware completion from the generated data (DECISIONS D8, D21): what is
// offered depends on what stands before the cursor. No `vscode` import;
// provider.ts adapts the result.

export type LyCompletionKind = 'function' | 'music' | 'keyword' | 'markup' | 'context' | 'grob' | 'property'

export interface LyCompletion {
  /** Also the inserted text. Commands include their backslash. */
  label: string
  kind: LyCompletionKind
  /** One line beside the label. */
  detail?: string
  /** Markdown. */
  doc?: string
  /** Orders the list; items without it sort by label. */
  sortText?: string
}

export interface LyCompletionList {
  /** How many UTF-16 units before the cursor the accepted item replaces. */
  replace: number
  items: LyCompletion[]
}

/** The characters after which VS Code should ask without waiting for a letter. */
export const TRIGGER_CHARACTERS = ['\\', '.', ' ']

const NEW_CONTEXT = /\\(?:new|context|change)\s+([A-Za-z]*)$/
/** `\layout { \context { \Staff … } }`: the definition to modify is named with a backslash. */
const CONTEXT_DEFINITION = /\\context\s*\{\s*(\\[A-Za-z]*)$/
const PROPERTY_PATH =
  /\\(override|revert|overrideProperty|tweak|hide|omit|set|unset)\s+((?:[A-Za-z]+\.)*)([A-Za-z][A-Za-z-]*)?$/
const COMMAND = /\\(?:[A-Za-z]+(?:[-_][A-Za-z]+)*[-_]?)?$/

/**
 * What to offer at the end of `textBefore`: the document up to the cursor, or
 * its last few dozen lines - only the last line must be complete.
 */
export function completionsAt(index: LilyIndex, textBefore: string): LyCompletionList | undefined {
  const linePrefix = textBefore.slice(textBefore.lastIndexOf('\n') + 1)
  if (!isCode(linePrefix) || inBlockComment(textBefore)) return undefined

  const newContext = NEW_CONTEXT.exec(textBefore)
  if (newContext) return { replace: newContext[1].length, items: contexts(index) }

  const definition = CONTEXT_DEFINITION.exec(textBefore)
  if (definition) return { replace: definition[1].length, items: contexts(index, '\\') }

  const path = PROPERTY_PATH.exec(textBefore)
  if (path) {
    const segments = path[2].split('.').filter(Boolean)
    const items = pathItems(index, path[1], segments)
    return items && { replace: (path[3] ?? '').length, items }
  }

  const command = COMMAND.exec(linePrefix)
  // A backslash after an odd run of them completes `\\`, the voice separator.
  if (command && precedingBackslashes(linePrefix, command.index) % 2 === 0) {
    return { replace: command[0].length, items: commands(index, inMarkup(textBefore)) }
  }
  // Asked with a space or a dot somewhere else: say nothing, so nothing pops up.
  return undefined
}

/** What can stand after `command` and the dotted `segments` already typed. */
function pathItems(index: LilyIndex, command: string, segments: string[]): LyCompletion[] | undefined {
  const [first, second] = segments
  if (command === 'set' || command === 'unset') {
    if (segments.length === 0) return [...contextProperties(index), ...contexts(index, '', '1')]
    return segments.length === 1 ? contextProperties(index) : undefined
  }
  if (segments.length === 0) {
    // `\tweak color #red` needs no grob; the others start with a grob or `Context.`.
    const properties = command === 'tweak' ? grobProperties(index, undefined) : []
    return [...properties, ...grobs(index, '1'), ...contexts(index, '', '2')]
  }
  const grob = index.contexts.has(first) ? second : first
  if (grob === undefined) return grobs(index)
  if (command === 'hide' || command === 'omit') return undefined
  // Below `Grob.property` come sub-properties (`bound-details.left.text`), which the data lacks.
  const depth = index.contexts.has(first) ? 2 : 1
  return segments.length === depth ? grobProperties(index, grob) : undefined
}

function commands(index: LilyIndex, markup: boolean): LyCompletion[] {
  const items: LyCompletion[] = []
  for (const command of index.data.commands) {
    if (index.snippetCommands.has(command.name)) continue
    const asMarkup = markup && (command.kind === 'markup' || command.markup !== undefined)
    const shown = asMarkup && command.markup ? command.markup : command
    items.push({
      label: `\\${command.name}`,
      kind: asMarkup ? 'markup' : command.kind,
      detail: shown.signature ? `${shown.detail}: ${shown.signature}` : shown.detail,
      doc: describeCommand(command, asMarkup),
      // Inside `\markup` its commands come first, elsewhere last; nothing is hidden,
      // because `inMarkup` is a guess.
      sortText: `${(markup ? asMarkup : command.kind !== 'markup') ? '0' : '1'}${command.name}`,
    })
  }
  return items
}

function contexts(index: LilyIndex, prefix = '', group = ''): LyCompletion[] {
  return index.data.contexts.map((context) => ({
    label: prefix + context.name,
    kind: 'context',
    detail: 'context',
    doc: describeContext(context),
    sortText: group + context.name,
  }))
}

function grobs(index: LilyIndex, group = ''): LyCompletion[] {
  return index.data.grobs.map((grob) => ({
    label: grob.name,
    kind: 'grob',
    detail: 'layout object',
    doc: describeGrob(grob),
    sortText: group + grob.name,
  }))
}

/** The properties of `grob`, those it sets by default first; every property when the grob is unknown. */
function grobProperties(index: LilyIndex, grob: string | undefined): LyCompletion[] {
  const known = grob === undefined ? [] : index.propertiesOf(grob)
  const names = known.length > 0 ? known : index.data.grobProperties.map((property) => property.name)
  const defaults = new Set(grob === undefined ? [] : index.grobs.get(grob)?.defaults)
  return names.flatMap((name) => {
    const property = index.grobProperties.get(name)
    if (!property) return []
    return {
      label: name,
      kind: 'property',
      detail: property.type,
      doc: describeProperty(property, 'grob property'),
      sortText: `${grob === undefined || defaults.has(name) ? '0' : '1'}${name}`,
    }
  })
}

function contextProperties(index: LilyIndex): LyCompletion[] {
  return index.data.contextProperties.map((property) => ({
    label: property.name,
    kind: 'property',
    detail: property.type,
    doc: describeProperty(property, 'context property'),
    sortText: `0${property.name}`,
  }))
}

function inBlockComment(textBefore: string): boolean {
  return textBefore.lastIndexOf('%{') > textBefore.lastIndexOf('%}')
}
