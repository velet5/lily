import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// `\include` graph → root resolution (DECISIONS D10, D18). No `vscode` import (D3).

/**
 * One alternation, scanned left to right, so that an `\include` inside a
 * comment or a string is skipped and a `%` inside a string starts no comment.
 * Only the first alternative captures.
 */
const TOKEN =
  /\\include\s*"((?:[^"\\]|\\[\s\S])*)"|\\include\b|%\{[\s\S]*?(?:%\}|$)|%[^\n]*|"(?:[^"\\]|\\[\s\S])*(?:"|$)/g

/**
 * The file names `source` includes, as written. `\include` takes a string
 * literal in practice; a name computed in Scheme is not seen.
 */
export function includeTokens(source: string): Array<{ name?: string; start: number; end: number }> {
  return [...source.matchAll(TOKEN)].filter(match => match[0].startsWith('\\include')).map(match => ({
    name: match[1]?.replace(/\\([\s\S])/g, '$1'),
    start: match.index! + Math.max(0, match[0].indexOf('"')),
    end: match.index! + match[0].length,
  }))
}

export function parseIncludes(source: string): string[] {
  return includeTokens(source).flatMap(token => token.name === undefined ? [] : [token.name])
}

/**
 * Directories given with `-I dir`, `-Idir`, `--include dir` or `--include=dir`
 * in `lily.compile.extraArgs`, resolved against the root file's directory.
 */
export function includeDirsFromArgs(args: readonly string[], rootDir: string): string[] {
  const dirs: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    let dir: string | undefined
    if (arg === '-I' || arg === '--include') dir = args[++index]
    else if (arg.startsWith('--include=')) dir = arg.slice('--include='.length)
    else if (arg.startsWith('-I')) dir = arg.slice(2)
    if (dir) dirs.push(path.resolve(rootDir, dir))
  }
  return dirs
}

export interface IncludeOptions {
  /** Extra search directories, see `includeDirsFromArgs`. */
  includeDirs?: readonly string[]
  buffers?: ReadonlyMap<string, string>
  conservative?: boolean
}

/**
 * Every file `rootFile` reaches through `\include`, itself included, as
 * canonical paths. A name is looked up the way lilypond 2.26 does it [verified]:
 * the including file's directory, the root's directory, then the `-I`
 * directories. Every hit counts, not just the first: a false edge costs one
 * recompile, a missing one leaves a stale preview. Names that resolve nowhere
 * (`english.ly` and the rest of lilypond's own library) are not part of the
 * answer.
 */
export async function includeClosure(
  rootFile: string,
  options: IncludeOptions = {},
): Promise<Set<string>> {
  return (await includeGraph(rootFile, options)).files
}

export interface IncludeGraph {
  /** As `includeClosure` returns them. */
  files: Set<string>
  /**
   * For each name that resolves nowhere, every path lilypond would look for it
   * at, absolute: a file created at one of them joins the score. Library names
   * such as `english.ly` are among them.
   */
  missing: Set<string>
}

/** `includeClosure`, and the places where includes that were not found would be. */
export async function includeGraph(
  rootFile: string,
  options: IncludeOptions = {},
): Promise<IncludeGraph> {
  const buffers = await canonicalBuffers(options.buffers)
  const root = await canonical(rootFile)
  const rootDir = path.dirname(root)
  const seen = new Set<string>([root])
  const missing = new Set<string>()
  const queue = [root]
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    let source: string
    try {
      source = buffers.get(file) ?? await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    const dirs = [path.dirname(file), rootDir, ...(options.includeDirs ?? [])]
    for (const name of parseIncludes(source)) {
      const candidates: string[] = []
      let found = false
      for (const dir of new Set(dirs)) {
        const candidate = path.resolve(dir, name)
        const real = await canonical(candidate)
        const target = buffers.has(real) ? real : await existing(candidate)
        candidates.push(candidate)
        if (target === undefined) continue
        found = true
        if (!seen.has(target)) {
          seen.add(target)
          queue.push(target)
        }
      }
      if (!found) for (const candidate of candidates) missing.add(candidate)
    }
  }
  return { files: seen, missing }
}

/**
 * Those of `roots` that compile `file`: the file itself, or a root whose
 * includes reach it. Order of `roots` is kept.
 */
export async function rootsIncluding(
  file: string,
  roots: readonly string[],
  optionsFor: (rootFile: string) => IncludeOptions = () => ({}),
): Promise<string[]> {
  const target = await canonical(file)
  const reached = await Promise.all(
    roots.map(async (root) => {
      const options = optionsFor(root)
      const closure = await includeClosure(root, options)
      if (closure.has(target)) return true
      if (options.conservative) {
        for (const source of closure) {
          const text = options.buffers?.get(source) ?? await fs.readFile(source, 'utf8').catch(() => '')
          if (includeTokens(text).some(token => token.name === undefined) || /ly:parser-include/.test(text)) return true
        }
      }
      return false
    }),
  )
  return roots.filter((_, index) => reached[index])
}

/** Symlinks and, on case-insensitive volumes, spelling must not hide a match. */
async function canonical(file: string): Promise<string> {
  return (await existing(file)) ?? path.resolve(file)
}

async function existing(file: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(file)
    return (await fs.stat(real)).isFile() ? real : undefined
  } catch {
    return undefined
  }
}

/** Editors may open a symlink while a literal include uses the real path. */
export async function canonicalBuffers(buffers?: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  return new Map(await Promise.all([...(buffers ?? [])].map(async ([file, text]) => [await canonical(file), text] as const)))
}
