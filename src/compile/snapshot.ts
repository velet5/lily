import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { columnToCharacter, type LyDiagnostic } from '../diagnostics/parse'
import { canonicalBuffers, includeDirsFromArgs, includeTokens } from './rootFile'

interface Replacement { start: number; end: number; text: string }
interface Source { file: string; text: string; generated: string; replacements: Replacement[] }

/** Immutable editor texts captured together, before any asynchronous work. */
export type SourceBuffers = ReadonlyMap<string, string>

export class SnapshotUnavailableError extends Error {}

export class SourceSnapshot {
  readonly sources = new Map<string, string>()
  private files = new Map<string, Source>()
  rootFile = ''

  static async create(root: string, buffers: SourceBuffers, directory: string, args: readonly string[]): Promise<SourceSnapshot> {
    const snapshot = new SourceSnapshot()
    const realBuffers = await canonicalBuffers(buffers)
    const dirs = [path.dirname(root), ...includeDirsFromArgs(args, path.dirname(root))]
    const visited = new Map<string, string>()
    const dirty = buffers.size > 0
    const visit = async (file: string): Promise<string> => {
      file = path.resolve(file)
      const real = await fs.realpath(file).catch(() => file)
      const previous = visited.get(real)
      if (previous) return previous
      const text = buffers.get(file) ?? realBuffers.get(real) ?? await fs.readFile(file, 'utf8')
      const target = path.join(directory, String(visited.size), path.basename(file))
      visited.set(real, target) // before recursing: includes may be cyclic
      snapshot.sources.set(file, text)
      const replacements: Replacement[] = []
      for (const token of includeTokens(text)) {
        if (token.name === undefined) {
          if (dirty) throw new SnapshotUnavailableError(`Cannot snapshot a computed \\include in ${file}. Use literal include paths for unsaved preview.`)
          continue
        }
        let included: string | undefined
        for (const dir of [path.dirname(file), ...dirs]) {
          const candidate = path.resolve(dir, token.name)
          if (buffers.has(candidate) || await fs.stat(candidate).then(s => s.isFile(), () => false)) {
            included = candidate
            break
          }
        }
        // LilyPond's own library remains on its standard search path.
        if (included) replacements.push({ start: token.start, end: token.end, text: JSON.stringify(await visit(included)) })
      }
      if (dirty && /ly:(?:parser-include-string|parser-include-file|parse-file)\b/.test(text)) {
        throw new SnapshotUnavailableError(`Cannot snapshot Scheme-generated includes in ${file}. Use literal include paths for unsaved preview.`)
      }
      let generated = text
      for (const r of [...replacements].reverse()) generated = generated.slice(0, r.start) + r.text + generated.slice(r.end)
      snapshot.files.set(target, { file, text, generated, replacements })
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, generated)
      return target
    }
    snapshot.rootFile = await visit(root)
    return snapshot
  }

  private location(file: string, line: number, character: number): { file: string; line: number; char: number; column: number } | undefined {
    const source = this.files.get(path.normalize(file))
    if (!source) return undefined
    const lines = source.generated.split('\n')
    const offset = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + character
    let delta = 0
    let original = offset
    for (const r of source.replacements) {
      const start = r.start + delta
      if (offset < start) break
      if (offset < start + r.text.length) { original = r.start; break }
      delta += r.text.length - (r.end - r.start)
      original = offset - delta
    }
    const before = source.text.slice(0, original).split('\n')
    const prefix = before[before.length - 1]
    return { file: source.file, line: before.length, char: Array.from(prefix).length, column: visualColumn(prefix) }
  }

  diagnostic(d: LyDiagnostic): LyDiagnostic {
    const source = this.files.get(path.normalize(d.file))
    if (!source) return d
    const line = source.generated.split('\n')[d.line - 1] ?? ''
    const loc = this.location(d.file, d.line, columnToCharacter(line, d.column ?? 1))!
    return { ...d, file: loc.file, line: loc.line, ...(d.column === undefined ? {} : { column: loc.column }) }
  }

  /** Normalize before hashing: temporary paths never become page identities. */
  svg(svg: string): string {
    return svg.replace(/textedit:\/\/([^"<>]+):(\d+):(\d+):(\d+)/g, (link, encoded: string, line: string, char: string) => {
      let file: string
      try { file = decodeURIComponent(encoded) } catch { return link }
      const source = this.files.get(path.normalize(file))
      if (!source) return link
      const text = source.generated.split('\n')[Number(line) - 1] ?? ''
      const character = Array.from(text).slice(0, Number(char)).join('').length
      const loc = this.location(file, Number(line), character)!
      // LilyPond URI-encodes unsafe characters but leaves slash/colon intact.
      const encodedFile = encodeURI(loc.file).replaceAll("'", '%27').replaceAll('&', '%26')
      return `textedit://${encodedFile}:${loc.line}:${loc.char}:${loc.column}`
    })
  }
}

function visualColumn(text: string): number {
  let column = 0
  for (const char of text) column = char === '\t' ? column + 8 - column % 8 : column + 1
  return column + 1
}
