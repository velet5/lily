// File access for Lily Studio's main process (DECISIONS D29). The renderer
// never names a path the user has not picked: it may read and write only files
// inside the folder opened with a dialog, or a file chosen with one.
// No `electron` here, so the tests can run it under plain Node.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { TEMPLATES, type TemplateId } from './templates'

/** Extensions shown in the file list and accepted by the open dialog. */
export const SCORE_EXTENSIONS = ['.ly', '.ily', '.lyi'] as const

/** Directories the file list does not descend into. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'out', 'dist'])
const MAX_DEPTH = 4
const MAX_FILES = 500

export interface ScoreFile {
  /** Absolute path. */
  path: string
  /** Relative to the folder, with `/` as separator, for display and sorting. */
  relative: string
}

export interface FolderListing {
  folder: string
  name: string
  files: ScoreFile[]
  /** True when MAX_FILES was reached and the list is cut short. */
  truncated: boolean
}

export function isScoreFile(file: string): boolean {
  return (SCORE_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase())
}

/**
 * The LilyPond files under `folder`, at most MAX_DEPTH directories down,
 * skipping hidden entries and build output. Files of a directory come before
 * its subdirectories; both sorted by name, case-insensitively.
 */
export async function listFolder(folder: string): Promise<FolderListing> {
  const root = path.resolve(folder)
  const files: ScoreFile[] = []
  let truncated = false
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

  async function walk(directory: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      return // Unreadable subdirectories are left out, not reported.
    }
    const visible = entries.filter((entry) => !entry.name.startsWith('.'))
    for (const entry of visible.filter((e) => e.isFile() && isScoreFile(e.name)).sort((a, b) => byName(a.name, b.name))) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      const absolute = path.join(directory, entry.name)
      files.push({ path: absolute, relative: path.relative(root, absolute).split(path.sep).join('/') })
    }
    if (depth >= MAX_DEPTH) return
    for (const entry of visible.filter((e) => e.isDirectory() && !SKIPPED_DIRECTORIES.has(e.name)).sort((a, b) => byName(a.name, b.name))) {
      await walk(path.join(directory, entry.name), depth + 1)
      if (truncated) return
    }
  }

  await walk(root, 0)
  return { folder: root, name: path.basename(root) || root, files, truncated }
}

/** True when `file` is `folder` itself or lies somewhere below it. */
export function isInside(folder: string, file: string): boolean {
  const relative = path.relative(path.resolve(folder), path.resolve(file))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * What the renderer may touch: the open folder and single files the user
 * picked in a dialog. Every IPC handler that takes a path asks `check` first.
 */
export class Access {
  folder: string | undefined
  private readonly picked = new Set<string>()

  allowFile(file: string): void {
    this.picked.add(path.resolve(file))
  }

  allows(file: string): boolean {
    const absolute = path.resolve(file)
    return this.picked.has(absolute) || (this.folder !== undefined && isInside(this.folder, absolute))
  }

  /** Returns the resolved path, or throws when the renderer may not use it. */
  check(file: unknown): string {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Expected an absolute path.')
    if (!isScoreFile(file)) throw new Error(`Not a LilyPond file: ${path.basename(file)}`)
    if (!this.allows(file)) throw new Error(`${file} is outside the open folder.`)
    return path.resolve(file)
  }
}

export async function readScore(file: string): Promise<string> {
  return fs.readFile(file, 'utf8')
}

export async function writeScore(file: string, text: string): Promise<void> {
  await fs.writeFile(file, text, 'utf8')
}

/**
 * Writes a new score from a template. An existing file is replaced: the save
 * dialog that chose `file` has already asked about that.
 */
export async function createFromTemplate(file: string, template: TemplateId): Promise<void> {
  const text = TEMPLATES.find((t) => t.id === template)?.text
  if (text === undefined) throw new Error(`Unknown template: ${template}`)
  await fs.writeFile(file, text, 'utf8')
}

/** `Untitled.ly`, or `Untitled 2.ly` and so on when that exists in `folder`. */
export async function unusedName(folder: string, base = 'Untitled', extension = '.ly'): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, n === 1 ? `${base}${extension}` : `${base} ${n}${extension}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
}
