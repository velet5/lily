// Live preview for Lily Studio's main process (DECISIONS D36): the texts of
// the files with unsaved edits, as the renderer reports them, and the timer
// that turns a burst of typing into one compile of the score they belong to.
// The compile itself reads those texts through StudioCompiler's `buffers`
// (src/compile/snapshot.ts) and goes through its LiveQueue. No `electron`
// here, so the tests run it under plain Node.
import * as path from 'node:path'
import type { SourceBuffers } from '../../../src/compile/snapshot'
import type { StudioCompiler } from './compileService'

export interface LiveCompileOptions {
  compiler: Pick<StudioCompiler, 'rootFor' | 'compile' | 'current'>
  /** Quiet time after the last edit before compiling; the extension's 150 ms (D25). */
  delayMs?: number
  /** Longest wait from the first edit of a burst; the extension's 750 ms (D25). */
  maxWaitMs?: number
  enabled?: boolean
}

export class LiveCompile {
  /** Unsaved text by absolute path; kept while live preview is off, too. */
  private readonly texts = new Map<string, string>()
  /** Files edited since the last compile was scheduled. */
  private readonly edits = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private deadline: NodeJS.Timeout | undefined
  private enabledNow: boolean
  private readonly delayMs: number
  private readonly maxWaitMs: number

  constructor(private readonly options: LiveCompileOptions) {
    this.enabledNow = options.enabled ?? true
    this.delayMs = options.delayMs ?? 150
    this.maxWaitMs = Math.max(options.maxWaitMs ?? 750, this.delayMs)
  }

  get enabled(): boolean {
    return this.enabledNow
  }

  /**
   * What compiles read instead of the files on disk: the unsaved texts while
   * live preview is on, none while it is off. A copy, so a compile keeps the
   * texts it started with.
   */
  buffers(): SourceBuffers {
    return this.enabledNow ? new Map(this.texts) : new Map()
  }

  /**
   * `file` now has the unsaved text `text`, or none: it was saved or reloaded,
   * which compile by themselves (D31, D34).
   */
  edited(file: string, text: string | undefined): void {
    file = path.resolve(file)
    if (text === undefined) {
      this.texts.delete(file)
      this.edits.delete(file)
      return
    }
    if (this.texts.get(file) === text) return
    this.texts.set(file, text)
    if (!this.enabledNow) return
    this.edits.add(file)
    this.schedule()
  }

  /**
   * On: compiles what the unsaved files belong to. Off: drops what was
   * waiting and compiles the score shown last from disk, so the preview shows
   * the saved files again.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledNow) return
    this.enabledNow = enabled
    if (enabled) {
      if (this.texts.size === 0) return
      for (const file of this.texts.keys()) this.edits.add(file)
      void this.flush()
      return
    }
    this.clearTimers()
    this.edits.clear()
    const current = this.options.compiler.current
    if (current && this.texts.size > 0) void this.options.compiler.compile(current)
  }

  dispose(): void {
    this.clearTimers()
    this.edits.clear()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.delayMs)
    this.deadline ??= setTimeout(() => void this.flush(), this.maxWaitMs)
  }

  private clearTimers(): void {
    clearTimeout(this.timer)
    clearTimeout(this.deadline)
    this.timer = this.deadline = undefined
  }

  /** Compiles each score an edited file belongs to, once. Resolves once they are queued. */
  private async flush(): Promise<void> {
    this.clearTimers()
    const files = [...this.edits]
    this.edits.clear()
    // An include no score reaches compiles nothing; unlike a save, it is not reported on every keystroke.
    const roots = await Promise.all(files.map((file) => this.options.compiler.rootFor(file).catch(() => undefined)))
    if (!this.enabledNow) return
    for (const root of new Set(roots)) {
      if (root) void this.options.compiler.compile(root)
    }
  }
}
