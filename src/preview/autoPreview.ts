import * as path from 'node:path'

// Refresh on save (ARCHITECTURE §3.6, DECISIONS D18). No `vscode` import:
// extension.ts feeds it saves and supplies the host, so the timing is
// unit-tested without an extension host.

export interface AutoPreviewSettings {
  /** `lily.preview.refreshOnSave`. */
  enabled: boolean
  /** `lily.preview.refreshDelay`, in milliseconds. */
  delayMs: number
}

export interface AutoPreviewHost {
  /** Read on every save, never cached (D9). */
  settings(): AutoPreviewSettings
  /** Root files that have an open preview. */
  previewedRoots(): string[]
  /** Those of `roots` that compile `file`; see `rootsIncluding`. */
  rootsIncluding(file: string, roots: string[]): Promise<string[]>
  /**
   * Compiles `rootFile` from disk and refreshes its preview. The compile
   * service kills the root's stale run, if one is still going (D3).
   */
  compile(rootFile: string): unknown
}

/** Turns saves into at most one debounced compile per previewed root. */
export class AutoPreview {
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
  async documentSaved(file: string): Promise<void> {
    if (!this.host.settings().enabled) return
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
      // A compile that began after this save has read what was saved. That is
      // the case when `LilyPond: Compile` saves the dirty document itself.
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
    this.cancel(rootFile)
    const fire = () => {
      this.timers.delete(key(rootFile))
      // Both may have changed while waiting.
      if (!this.host.settings().enabled) return
      if (!this.host.previewedRoots().some((root) => key(root) === key(rootFile))) return
      this.host.compile(rootFile)
    }
    this.timers.set(key(rootFile), setTimeout(fire, this.host.settings().delayMs))
  }
}

function key(rootFile: string): string {
  const resolved = path.resolve(rootFile)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
