// The page's side of the engine (chapter 08 of docs/research/wasm-engine):
// one dedicated worker, engine.worker.js beside the page, and compiles that a
// newer one supersedes. Files the editors do not have are read with
// `readFile`; on the web, from the user's worker on the server (D55).
import type { CompileOutcome } from '../../ipc'
import type { FromEngine, ToEngine } from './protocol'

/** The worker, as far as the host uses it: a real Worker, or a test's fake. */
export interface EngineWorker {
  onmessage: ((event: MessageEvent<FromEngine>) => void) | null
  postMessage(message: ToEngine): void
  terminate(): void
}

export class EngineHost {
  private revision = 0
  /** Compiles not yet answered, by revision; superseded ones resolve with undefined. */
  private readonly pending = new Map<number, (outcome: CompileOutcome | undefined) => void>()
  private broken?: string
  /** Resolves with the milliseconds the engine took to start; rejects when it cannot. */
  readonly ready: Promise<number>

  constructor(
    private readonly worker: EngineWorker,
    private readonly readFile: (path: string) => Promise<string | null>,
  ) {
    let started: (ms: number) => void = () => {}
    let failed: (error: Error) => void = () => {}
    this.ready = new Promise((resolve, reject) => {
      started = resolve
      failed = reject
    })
    // Nothing need wait for `ready`: a failure is also each compile's.
    this.ready.catch(() => {})
    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'ready':
          return started(data.ms)
        case 'needs-file':
          return void this.answer(data.path)
        case 'finished':
        case 'superseded':
          this.pending.get(data.revision)?.(data.type === 'finished' ? data.outcome : undefined)
          this.pending.delete(data.revision)
          return
        case 'failed':
          this.broken = data.message
          failed(new Error(data.message))
          this.pending.forEach((resolve) => resolve(undefined))
          this.pending.clear()
          return
      }
    }
  }

  /** Starts engine.worker.js beside the page. */
  static start(readFile: (path: string) => Promise<string | null>): EngineHost {
    return new EngineHost(new Worker(new URL('engine.worker.js', location.href)), readFile)
  }

  /** True once the engine could not start or stopped for good: the server's LilyPond compiles instead. */
  get failed(): boolean {
    return this.broken !== undefined
  }

  /**
   * Compiles `rootFile` with the texts of `files`; undefined when a newer
   * compile superseded it, or the engine failed.
   */
  compile(rootFile: string, files: Record<string, string>, visiblePage = 1): Promise<CompileOutcome | undefined> {
    if (this.broken !== undefined) return Promise.resolve(undefined)
    // The worker runs only the newest request it has; the ones in between are never answered.
    this.pending.forEach((resolve) => resolve(undefined))
    this.pending.clear()
    const revision = ++this.revision
    const outcome = new Promise<CompileOutcome | undefined>((resolve) => this.pending.set(revision, resolve))
    this.worker.postMessage({ type: 'compile', request: { revision, rootFile, files, visiblePage } })
    return outcome
  }

  dispose(): void {
    this.worker.terminate()
    this.pending.forEach((resolve) => resolve(undefined))
    this.pending.clear()
  }

  private async answer(path: string): Promise<void> {
    const text = await this.readFile(path).catch(() => null)
    this.worker.postMessage({ type: 'file', path, text })
  }
}
