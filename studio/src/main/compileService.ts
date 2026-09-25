// Compile on save for Lily Studio's main process (DECISIONS D31): finds the
// score a saved file belongs to, compiles it with the extension's
// CompileService and parses lilypond's stderr with its parser. main.ts sends
// the events to the renderer. No `electron` here, so the tests run it under
// plain Node.
import * as path from 'node:path'
import type { CompileResult, CompileService } from '../../../src/compile/compiler'
import { LilyPondNotFoundError } from '../../../src/compile/locate'
import { rootsIncluding } from '../../../src/compile/rootFile'
import { parseStderr } from '../../../src/diagnostics/parse'
import type { CompileEvent, CompileOutcome } from '../ipc'

/** The part of CompileService used here; tests pass a stand-in. */
export type Compiler = Pick<CompileService, 'compile' | 'dispose'>

export interface StudioCompilerOptions {
  compiler: Compiler
  /** The `.ly` files that may include a saved `.ily`: the open folder's. */
  candidates(): Promise<string[]>
  emit(event: CompileEvent): void
  /** Like `lily.lilypond.path`; empty means PATH, then well-known directories. */
  lilypondPath?: string
}

/** Lines of stderr kept for a run that failed without a parsable error. */
const TAIL_LINES = 12

export class StudioCompiler {
  /** The score compiled last; preferred when an include belongs to several. */
  private current: string | undefined

  constructor(private readonly options: StudioCompilerOptions) {}

  /**
   * Compiles the score `file` belongs to, after it was written. Resolves with
   * the outcome that was emitted, or undefined when a newer compile of the same
   * score took over; that one reports instead.
   */
  async saved(file: string): Promise<CompileOutcome | undefined> {
    const rootFile = await this.rootFor(path.resolve(file))
    if (!rootFile) {
      const outcome = empty('no-root', path.resolve(file))
      this.options.emit({ kind: 'finished', outcome })
      return outcome
    }
    return this.compile(rootFile)
  }

  /**
   * A `.ly` file is its own score. An include belongs to the scores whose
   * `\include` chains reach it (D10, D18): the last compiled score first, then
   * the folder's `.ly` files in list order.
   */
  async rootFor(file: string): Promise<string | undefined> {
    if (path.extname(file).toLowerCase() === '.ly') return file
    const candidates = (await this.options.candidates()).filter((f) => path.extname(f).toLowerCase() === '.ly')
    const roots = [...new Set([...(this.current ? [this.current] : []), ...candidates])]
    // An unreadable file reaches nothing; the others still count.
    const [first] = await rootsIncluding(file, roots).catch(() => [])
    return first
  }

  async compile(rootFile: string): Promise<CompileOutcome | undefined> {
    this.current = rootFile
    this.options.emit({ kind: 'started', rootFile })
    let outcome: CompileOutcome
    try {
      const result = await this.options.compiler.compile({
        rootFile,
        lilypondPath: this.options.lilypondPath,
        // The warm and cached engines need the extension's runtime/ files;
        // they come with live preview (step 9 of the studio plan).
        acceleration: 'off',
      })
      if (result.cancelled) return undefined
      outcome = fromResult(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = { ...empty(error instanceof LilyPondNotFoundError ? 'no-lilypond' : 'error', rootFile), message }
    }
    this.options.emit({ kind: 'finished', outcome })
    return outcome
  }

  dispose(): Promise<void> {
    return this.options.compiler.dispose()
  }
}

function empty(state: CompileOutcome['state'], rootFile: string): CompileOutcome {
  return { state, rootFile, diagnostics: [], errorCount: 0, warningCount: 0, pages: [], midi: [], durationMs: 0 }
}

export function fromResult(result: CompileResult): CompileOutcome {
  const diagnostics = parseStderr(result.stderr, { rootFile: result.rootFile })
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const outcome: CompileOutcome = {
    state: result.ok ? 'ok' : 'failed',
    rootFile: result.rootFile,
    diagnostics,
    errorCount,
    warningCount: diagnostics.length - errorCount,
    pages: result.pages,
    midi: result.midi,
    durationMs: result.durationMs,
  }
  // A crash or a Guile backtrace: nothing parsed, so show how the output ends.
  if (!result.ok && errorCount === 0) {
    const tail = result.stderr.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join('\n')
    outcome.message = tail || `lilypond exited with code ${result.exitCode}`
  }
  return outcome
}
