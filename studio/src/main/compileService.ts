// Compile on save for Lily Studio's main process (DECISIONS D31): finds the
// score a saved file belongs to, compiles it with the extension's
// CompileService and parses lilypond's stderr with its parser. main.ts sends
// the events to the renderer, with the MIDI to play (D35). Every compile of a
// score waits in a LiveQueue and reads the unsaved texts live preview passes
// in `buffers` (D36). The PDF tab's
// compile and Export PDF are here too (D33). No `electron` here, so the tests run it under plain Node.
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CompileResult, CompileService } from '../../../src/compile/compiler'
import { LilyPondNotFoundError } from '../../../src/compile/locate'
import { rootsIncluding } from '../../../src/compile/rootFile'
import type { SourceBuffers } from '../../../src/compile/snapshot'
import { parseStderr } from '../../../src/diagnostics/parse'
import { LiveQueue } from '../../../src/preview/liveQueue'
import { readTiming } from '../../../src/preview/panel'
import type { CompileEvent, CompileOutcome, PdfOutcome } from '../ipc'

/** The part of CompileService used here; tests pass a stand-in. */
export type Compiler = Pick<CompileService, 'compile' | 'export' | 'dispose'>

export interface StudioCompilerOptions {
  compiler: Compiler
  /** The `.ly` files that may include a saved `.ily`: the open folder's. */
  candidates(): Promise<string[]>
  emit(event: CompileEvent): void
  /**
   * Like `lily.lilypond.path`; empty means PATH, then well-known directories.
   * A function is asked on every compile: the setup may change it (D37).
   */
  lilypondPath?: string | (() => string | undefined)
  /** Parent of the PDF compiles' private directories. Defaults to the OS temp dir. */
  tmpRoot?: string
  /**
   * The unsaved texts to compile instead of the files on disk (D36), read
   * when a compile starts. None by default.
   */
  buffers?(): SourceBuffers
  /** For the SVG compiles, as `lily.preview.acceleration` (D25). Defaults to off. */
  acceleration?: 'off' | 'cache' | 'auto'
}

/** Lines of stderr kept for a run that failed without a parsable error. */
const TAIL_LINES = 12

export class StudioCompiler {
  /** The score compiled last; preferred when an include belongs to several. */
  private last: string | undefined
  /**
   * The PDF of each score since its last compile, or the PDF compile running
   * for it; a compile of the score drops it, as the sources changed.
   */
  private readonly pdfs = new Map<string, Promise<PdfOutcome | undefined>>()
  /**
   * One running and one waiting compile per score (D25): a newer request
   * replaces the waiting one, and never kills a run about to finish.
   */
  private readonly queue = new LiveQueue<CompileOutcome | undefined>()

  constructor(private readonly options: StudioCompilerOptions) {}

  /** The score compiled last, or asked for last. */
  get current(): string | undefined {
    return this.last
  }

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
    const roots = [...new Set([...(this.last ? [this.last] : []), ...candidates])]
    // An unreadable file reaches nothing; the others still count.
    const buffers = this.options.buffers?.()
    const [first] = await rootsIncluding(file, roots, () => ({ buffers })).catch(() => [])
    return first
  }

  /**
   * Compiles `rootFile` once the compile of it that is running has been
   * reported. Resolves undefined when a newer request replaced this one
   * before it started, or the run was cancelled; that one reports instead.
   */
  compile(rootFile: string): Promise<CompileOutcome | undefined> {
    this.last = rootFile
    return this.queue.request(rootFile, () => this.run(rootFile))
  }

  private async run(rootFile: string): Promise<CompileOutcome | undefined> {
    this.pdfs.delete(rootFile)
    // Taken now, not when asked: the texts as they are when lilypond starts.
    const buffers = this.options.buffers?.()
    this.options.emit({ kind: 'started', rootFile })
    let outcome: CompileOutcome
    try {
      const result = await this.options.compiler.compile({
        rootFile,
        lilypondPath: this.lilypondPath(),
        ...(buffers?.size ? { buffers } : {}),
        acceleration: this.options.acceleration ?? 'off',
      })
      if (result.cancelled) return undefined
      outcome = fromResult(result)
      outcome.svg = await readPages(result.pages)
      Object.assign(outcome, await readPlayback(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = { ...empty(error instanceof LilyPondNotFoundError ? 'no-lilypond' : 'error', rootFile), message }
    }
    this.options.emit({ kind: 'finished', outcome })
    return outcome
  }

  /**
   * The PDF of `rootFile` for the PDF tab: compiled once more with `--pdf` into
   * a private directory that is deleted at once, so nothing is written next to
   * the score. Kept until the score compiles again. Resolves undefined when a
   * newer PDF compile of the score took over.
   */
  pdf(rootFile: string): Promise<PdfOutcome | undefined> {
    const kept = this.pdfs.get(rootFile)
    if (kept) return kept
    const pending = this.compilePdf(rootFile)
    this.pdfs.set(rootFile, pending)
    // Only a PDF that engraved is kept; anything else is tried again when asked.
    void pending.then((outcome) => {
      if (outcome?.state !== 'ok' && this.pdfs.get(rootFile) === pending) this.pdfs.delete(rootFile)
    })
    return pending
  }

  /**
   * Export PDF: writes the PDF of `rootFile` into the score's directory,
   * replacing files of the same name, and resolves with their paths. Only
   * when asked, and only a PDF that engraved without errors.
   */
  async exportPdf(rootFile: string): Promise<string[]> {
    let outcome = await this.pdf(rootFile)
    // Superseded by a PDF compile of newer sources: wait for that one.
    if (!outcome) outcome = await this.pdf(rootFile)
    if (!outcome) throw new Error('The PDF was not engraved; try again.')
    if (outcome.state !== 'ok' || outcome.files.length === 0) {
      throw new Error(outcome.message ?? 'The score has errors, so there is no PDF to export. Fix them first.')
    }
    const dir = path.dirname(rootFile)
    const written = outcome.files.map((file) => path.join(dir, file.name))
    await Promise.all(outcome.files.map((file, i) => fs.writeFile(written[i], file.data)))
    return written
  }

  private async compilePdf(rootFile: string): Promise<PdfOutcome | undefined> {
    let targetDir: string | undefined
    try {
      targetDir = await fs.mkdtemp(path.join(this.options.tmpRoot ?? os.tmpdir(), 'lily-studio-pdf-'))
      const result = await this.options.compiler.export({
        rootFile,
        lilypondPath: this.lilypondPath(),
        acceleration: 'off',
        format: 'pdf',
        targetDir,
      })
      if (result.cancelled) return undefined
      const files = await Promise.all(
        result.exported.map(async (file) => ({ name: path.basename(file), data: new Uint8Array(await fs.readFile(file)) })),
      )
      const { state, errorCount, message } = fromResult(result)
      return { state: state === 'ok' ? 'ok' : 'failed', rootFile, files, errorCount, durationMs: result.durationMs, ...(message ? { message } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const state = error instanceof LilyPondNotFoundError ? 'no-lilypond' : 'error'
      return { state, rootFile, files: [], errorCount: 0, durationMs: 0, message }
    } finally {
      if (targetDir) await fs.rm(targetDir, { recursive: true, force: true })
    }
  }

  private lilypondPath(): string | undefined {
    const configured = this.options.lilypondPath
    return typeof configured === 'function' ? configured() : configured
  }

  dispose(): Promise<void> {
    return this.options.compiler.dispose()
  }
}

/**
 * The text of the pages for the preview (step 5 of the studio plan), read now:
 * the run's directory is emptied when the next compile of the score ends. A
 * page that is gone already leaves none.
 */
async function readPages(pages: string[]): Promise<string[]> {
  try {
    return await Promise.all(pages.map((page) => fs.readFile(page, 'utf8')))
  } catch {
    return []
  }
}

/**
 * The music the preview plays (D35), read now for the same reason as the
 * pages: the first MIDI file of the run, as the extension's preview plays
 * (D24), and its entry of the playback map (D26). A map that cannot be read
 * only costs the playhead.
 */
async function readPlayback(result: CompileResult): Promise<Pick<CompileOutcome, 'midiData' | 'timing'>> {
  const [first] = result.midi
  if (first === undefined) return {}
  let midiData: Uint8Array
  try {
    midiData = new Uint8Array(await fs.readFile(first))
  } catch {
    return {}
  }
  const timing = result.timing ? await readTiming(result.timing, 0).catch(() => undefined) : undefined
  return { midiData, ...(timing ? { timing } : {}) }
}

function empty(state: CompileOutcome['state'], rootFile: string): CompileOutcome {
  return { state, rootFile, diagnostics: [], errorCount: 0, warningCount: 0, pages: [], svg: [], midi: [], durationMs: 0 }
}

export function fromResult(result: CompileResult): CompileOutcome {
  // A compile of unsaved texts names the snapshot's files (D25); the markers need the real ones.
  const diagnostics = parseStderr(result.stderr, { rootFile: result.rootFile }).map((d) => result.snapshot?.diagnostic(d) ?? d)
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const outcome: CompileOutcome = {
    state: result.ok ? 'ok' : 'failed',
    rootFile: result.rootFile,
    diagnostics,
    errorCount,
    warningCount: diagnostics.length - errorCount,
    pages: result.pages,
    svg: [],
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
