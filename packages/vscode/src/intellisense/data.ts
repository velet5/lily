import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// The shape of data/completions.json, which scripts/gen-completions.mjs writes
// from the installed LilyPond (DECISIONS D8, D21), and the lookups the
// completion and hover code share. No `vscode` import: unit-tested under node.

export type CommandKind = 'function' | 'music' | 'keyword' | 'markup'

export interface CommandDoc {
  /** What the entry is, in words: `music function`, `articulation`, `keyword`. */
  detail: string
  /** Argument types in call order; `[pitch]` is optional, `(music)` required. */
  signature?: string
  /** Markdown. */
  doc?: string
}

export interface CommandEntry extends CommandDoc {
  /** Without the backslash. */
  name: string
  kind: CommandKind
  /** A predefined command written out: `\stemUp` is `\override Stem.direction = #1`. */
  expansion?: string
  /** Set when the name is a markup command as well (`\override`, `\tiny`). */
  markup?: CommandDoc
}

export interface ContextEntry {
  name: string
  doc?: string
  aliases?: string[]
  accepts?: string[]
}

export interface GrobEntry {
  name: string
  doc?: string
  interfaces: string[]
  /** The user properties this grob sets by default, the likeliest to be overridden. */
  defaults?: string[]
}

export interface PropertyEntry {
  name: string
  /** `number`, `boolean`, `markup`, … as LilyPond names the type predicate. */
  type?: string
  doc?: string
}

export interface LilyData {
  /** The LilyPond version the data was generated from. */
  lilypond: string
  commands: CommandEntry[]
  contexts: ContextEntry[]
  grobs: GrobEntry[]
  interfaces: { name: string; properties: string[] }[]
  grobProperties: PropertyEntry[]
  contextProperties: PropertyEntry[]
}

/** `LilyData` with its lists keyed by name. */
export interface LilyIndex {
  data: LilyData
  commands: ReadonlyMap<string, CommandEntry>
  contexts: ReadonlyMap<string, ContextEntry>
  grobs: ReadonlyMap<string, GrobEntry>
  grobProperties: ReadonlyMap<string, PropertyEntry>
  contextProperties: ReadonlyMap<string, PropertyEntry>
  /** Commands the bundled snippets insert; completion leaves those to the snippets (D14). */
  snippetCommands: ReadonlySet<string>
  /** The user properties of a grob's interfaces, sorted; empty for an unknown grob. */
  propertiesOf(grob: string): readonly string[]
}

export function indexData(data: LilyData, snippetCommands: Iterable<string> = []): LilyIndex {
  const byName = <T extends { name: string }>(entries: T[]) =>
    new Map(entries.map((entry) => [entry.name, entry]))
  const grobs = byName(data.grobs)
  const interfaces = byName(data.interfaces)
  const properties = new Map<string, readonly string[]>()
  return {
    data,
    commands: byName(data.commands),
    contexts: byName(data.contexts),
    grobs,
    grobProperties: byName(data.grobProperties),
    contextProperties: byName(data.contextProperties),
    snippetCommands: new Set(snippetCommands),
    propertiesOf(grob) {
      let found = properties.get(grob)
      if (!found) {
        const names = (grobs.get(grob)?.interfaces ?? []).flatMap(
          (name) => interfaces.get(name)?.properties ?? [],
        )
        found = [...new Set(names)].sort()
        properties.set(grob, found)
      }
      return found
    },
  }
}

/** The commands that snippet prefixes spell exactly (`\score`, not `\new Staff`). */
export function snippetCommandsOf(snippets: Record<string, { prefix?: string | string[] }>): string[] {
  return Object.values(snippets)
    .flatMap((snippet) => snippet.prefix ?? [])
    .flatMap((prefix) => /^\\([A-Za-z]+)$/.exec(prefix)?.[1] ?? [])
}

/** Reads the shipped data; `extensionPath` is the directory that holds `data/` and `snippets/`. */
export async function loadIndex(extensionPath: string): Promise<LilyIndex> {
  const read = async (...segments: string[]) =>
    JSON.parse(await fs.readFile(path.join(extensionPath, ...segments), 'utf8'))
  const [data, snippets] = await Promise.all([
    read('data', 'completions.json'),
    // Completion works without the snippet file; it only offers a few duplicates then.
    read('snippets', 'lilypond.json').catch(() => ({})),
  ])
  return indexData(data, snippetCommandsOf(snippets))
}
