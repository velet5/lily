// Watches the files on disk behind Lily Studio (DECISIONS D34): those open in
// the editor, and the score compiled last with everything it `\include`s,
// plus where its missing includes would appear. A change another program made
// is reported once it settles; the studio's own saves are not changes. main.ts
// reloads the editor and recompiles the score from the report.
// No `electron` here, so the tests run it under plain Node.
import { watch, type FSWatcher } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { includeGraph } from '../../../src/compile/rootFile'

export interface FileChange {
  /** The path the editor opened it under, else its canonical path. */
  file: string
  /** False when the file is gone. */
  exists: boolean
}

export interface ScoreWatcherOptions {
  /**
   * A settled batch of changes made by another program. `score` is true when
   * one of them is part of the watched score, which should compile again.
   */
  onChange(changes: FileChange[], score: boolean): void
  /** How long the files must be quiet before a change is reported. */
  delayMs?: number
}

export class ScoreWatcher {
  /** What each watched file held when last seen; undefined while it is missing. */
  private readonly known = new Map<string, string | undefined>()
  /** Files the editor opened: canonical path → the path it used. */
  private readonly opened = new Map<string, string>()
  /** The watched score's files and missing includes, canonical. */
  private scoreFiles = new Set<string>()
  private root: string | undefined
  /** One watch per directory: a watch on a file ends when an editor saves by renaming over it. */
  private readonly directories = new Map<string, FSWatcher>()
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly options: ScoreWatcherOptions) {}

  /** The score whose files are watched. */
  get score(): string | undefined {
    return this.root
  }

  /** A file the editor opened, with the text it shows; watched from now on. */
  async open(file: string, text: string): Promise<void> {
    const real = await canonical(file)
    this.opened.set(real, file)
    this.known.set(real, text)
    this.sync()
  }

  /** Call before the studio writes `text` to `file`, so the write is not taken for a change. */
  async writing(file: string, text: string): Promise<void> {
    const real = await canonical(file)
    if (this.known.has(real)) this.known.set(real, text)
  }

  /**
   * Watches `rootFile` and its includes in place of the previous score. Called
   * after each compile, as an edit may have added or removed an include.
   */
  async watchScore(rootFile: string): Promise<void> {
    const graph = await includeGraph(rootFile)
    const next = new Set([...graph.files, ...graph.missing])
    // What a file held before is kept: a change made during the compile still counts.
    await Promise.all([...next].filter((file) => !this.known.has(file)).map(async (file) => this.known.set(file, await read(file))))
    if (this.disposed) return
    this.root = path.resolve(rootFile)
    this.scoreFiles = next
    this.sync()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    for (const watcher of this.directories.values()) watcher.close()
    this.directories.clear()
  }

  /** Forgets files no longer watched and watches the directories of the rest. */
  private sync(): void {
    if (this.disposed) return
    for (const file of this.known.keys()) {
      if (!this.opened.has(file) && !this.scoreFiles.has(file)) this.known.delete(file)
    }
    const wanted = new Set([...this.known.keys()].map((file) => path.dirname(file)))
    for (const [dir, watcher] of this.directories) {
      if (wanted.has(dir)) continue
      watcher.close()
      this.directories.delete(dir)
    }
    for (const dir of wanted) {
      if (this.directories.has(dir)) continue
      try {
        const watcher = watch(dir, (_event, name) => this.touched(dir, name?.toString()))
        // A directory that goes away ends its watch; its files read as missing.
        watcher.on('error', () => {
          watcher.close()
          if (this.directories.get(dir) === watcher) this.directories.delete(dir)
        })
        this.directories.set(dir, watcher)
      } catch {
        // A missing directory: an include there can only appear with it, which is not watched.
      }
    }
  }

  private touched(dir: string, name: string | undefined): void {
    const files = name ? [path.join(dir, name)] : [...this.known.keys()].filter((file) => path.dirname(file) === dir)
    const watched = files.filter((file) => this.known.has(file))
    if (watched.length === 0) return
    for (const file of watched) this.pending.add(file)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.options.delayMs ?? 150)
  }

  private async flush(): Promise<void> {
    const files = [...this.pending]
    this.pending.clear()
    const changes: FileChange[] = []
    let score = false
    for (const file of files) {
      if (!this.known.has(file)) continue
      const text = await read(file)
      if (this.disposed) return
      if (text === this.known.get(file)) continue
      this.known.set(file, text)
      changes.push({ file: this.opened.get(file) ?? file, exists: text !== undefined })
      if (this.scoreFiles.has(file)) score = true
    }
    if (changes.length > 0) this.options.onChange(changes, score)
  }
}

async function read(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/** The real path, as the include graph names files; the resolved path of a missing one. */
async function canonical(file: string): Promise<string> {
  try {
    return await fs.realpath(file)
  } catch {
    return path.resolve(file)
  }
}
