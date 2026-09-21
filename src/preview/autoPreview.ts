import * as path from 'node:path'

// Edit/save scheduling (ARCHITECTURE §3.6, DECISIONS D25). No `vscode` import:
// extension.ts feeds it changes and supplies the host, so the timing is
// unit-tested without an extension host.

export interface AutoPreviewSettings {
  /** `lily.preview.refreshOnSave`. */
  enabled: boolean
  /** `lily.preview.refreshDelay`, in milliseconds. */
  delayMs: number
  onChange?: boolean
}

export interface AutoPreviewHost {
  /** Read on every save, never cached (D9). */
  settings(): AutoPreviewSettings
  /** Root files that have an open preview. */
  previewedRoots(): string[]
  /** Those of `roots` that compile `file`; see `rootsIncluding`. */
  rootsIncluding(file: string, roots: string[]): Promise<string[]>
  /**
   * Queues the latest buffer snapshot and refreshes its preview. The host
   * coalesces pending requests while the running compilation finishes.
   */
  compile(rootFile: string): unknown
  pendingChanged?(rootFile: string, pending: boolean): void
}

/** Coalesces changes with an upper bound on debounce wait. */
export class AutoPreview {
  private readonly deadlines = new Map<string, NodeJS.Timeout>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** `clock` value at which the latest compile of each root started. */
  private readonly started = new Map<string, number>()
  private clock = 0
  private disposed = false

  constructor(private readonly host: AutoPreviewHost) {}

  /**
   * To be called for every saved file, of any language: what matters is
   * whether a previewed root includes it. Resolves once the refreshes are
   * scheduled, not when they have run.
   */
  async documentChanged(file: string): Promise<void> {
    if (this.host.settings().onChange === false) return
    return this.documentSaved(file)
  }

  async documentSaved(file: string): Promise<void> {
    if (this.disposed || !this.host.settings().enabled) return
    const roots = this.host.previewedRoots()
    if (roots.length === 0) return

    const savedAt = ++this.clock
    let affected: string[]
    try {
      affected = await this.host.rootsIncluding(file, roots)
    } catch {
      return
    }
    if (this.disposed) return
    for (const root of affected) {
      // A compile that began after this event already captured that revision.
      if ((this.started.get(key(root)) ?? 0) > savedAt) continue
      this.schedule(root)
    }
  }

  /**
   * To be called whenever a compile of `rootFile` starts, whatever started it:
   * the refresh waiting for that root has nothing left to do.
   */
  compileStarted(rootFile: string): void {
    this.started.set(key(rootFile), ++this.clock)
    this.cancel(rootFile)
  }

  /** Drops the pending refresh of `rootFile`, or all of them when omitted. */
  cancel(rootFile?: string): void {
    const keys = rootFile === undefined ? [...this.timers.keys()] : [key(rootFile)]
    for (const each of keys) {
      clearTimeout(this.timers.get(each))
      this.timers.delete(each)
      clearTimeout(this.deadlines.get(each))
      this.deadlines.delete(each)
      this.host.pendingChanged?.(rootFile ?? each, false)
    }
  }

  /** Number of refreshes waiting for their delay to pass. */
  get pending(): number {
    return this.timers.size
  }

  dispose(): void {
    this.disposed = true
    this.cancel()
  }

  /** Trailing edge: a burst of saves (Save All) restarts the delay each time. */
  private schedule(rootFile: string): void {
    clearTimeout(this.timers.get(key(rootFile)))
    this.host.pendingChanged?.(rootFile, true)
    const fire = () => {
      this.cancel(rootFile)
      // Both may have changed while waiting.
      if (!this.host.settings().enabled) return
      if (!this.host.previewedRoots().some((root) => key(root) === key(rootFile))) return
      this.host.compile(rootFile)
    }
    const delay = this.host.settings().delayMs
    this.timers.set(key(rootFile), setTimeout(fire, delay))
    if (!this.deadlines.has(key(rootFile))) {
      this.deadlines.set(key(rootFile), setTimeout(fire, Math.max(750, delay)))
    }
  }
}

function key(rootFile: string): string {
  const resolved = path.resolve(rootFile)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
