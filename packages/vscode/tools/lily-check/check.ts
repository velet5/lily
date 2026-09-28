import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CompileService } from '../../src/compile/compiler'
import { LilyPondNotFoundError } from '../../src/compile/locate'
import { diagnosticSpan, parseStderr, type LyDiagnostic } from '../../src/diagnostics/parse'

// One compile as an agent sees it (DECISIONS D11, D22): the editor's compile
// service and stderr parser, reported as one JSON document. The CLI and the MCP
// server both return exactly this. No `vscode` import.

export interface CheckRequest {
  /** The .ly file to compile; relative to `cwd`. */
  file: string
  /** Base of relative paths. Defaults to the process's working directory. */
  cwd?: string
  /** Like `lily.lilypond.path`; empty means PATH, then well-known directories. */
  lilypondPath?: string
  /** Like `lily.compile.extraArgs`. */
  extraArgs?: readonly string[]
  /** Where the pages go. Defaults to `defaultOutDir(rootFile)`. */
  outDir?: string
}

export interface CheckDiagnostic extends LyDiagnostic {
  /** The source line, for a message with a column. */
  source?: string
  /** What the column points at in `source`: a `\command`, a note, a `#( … )`. */
  token?: string
}

/** Why lilypond never ran. */
export type CheckErrorCode = 'file-not-found' | 'lilypond-not-found' | 'failed'

export interface CheckReport {
  /** lilypond exited with 0. Warnings do not count. */
  ok: boolean
  /** Absolute path that was compiled. */
  rootFile: string
  exitCode: number | null
  errorCount: number
  warningCount: number
  /** `line` and `column` are 1-based, as lilypond prints them. */
  diagnostics: CheckDiagnostic[]
  /** Absolute SVG paths in page order. A failed run may still have some. */
  pages: string[]
  midi: string[]
  /** Directory of `pages` and `midi`. */
  outputDir: string
  durationMs: number
  /** A newer check of the same file took over; only the MCP server sees this. */
  cancelled?: true
  /** Raw stderr of a failed run in which no error could be parsed. */
  stderr?: string
  /** Set when lilypond never ran; every list is empty then. */
  error?: { code: CheckErrorCode; message: string }
}

/**
 * Stable per root file, so repeated checks overwrite instead of piling up, and
 * outside the source tree (D5). The hash keeps two `score.ly` apart.
 */
export function defaultOutDir(rootFile: string): string {
  const hash = createHash('sha1').update(rootFile).digest('hex').slice(0, 8)
  const base = path.basename(rootFile, path.extname(rootFile))
  return path.join(os.tmpdir(), 'lily-check', `${base}-${hash}`)
}

/** Never rejects: whatever goes wrong is a report with `error` set. */
export async function check(service: CompileService, request: CheckRequest): Promise<CheckReport> {
  const started = performance.now()
  const cwd = request.cwd ?? process.cwd()
  const rootFile = path.resolve(cwd, request.file)
  const outputDir = request.outDir ? path.resolve(cwd, request.outDir) : defaultOutDir(rootFile)
  const report: CheckReport = {
    ok: false,
    rootFile,
    exitCode: null,
    errorCount: 0,
    warningCount: 0,
    diagnostics: [],
    pages: [],
    midi: [],
    outputDir,
    durationMs: 0,
  }

  try {
    await fs.access(rootFile, fs.constants.R_OK).catch(() => {
      throw new MissingFileError(`Cannot read ${rootFile}`)
    })
    const result = await service.compile({
      rootFile,
      lilypondPath: request.lilypondPath,
      extraArgs: request.extraArgs,
    })
    report.exitCode = result.exitCode
    if (result.cancelled) {
      report.cancelled = true
      return report
    }

    // The default directory is ours alone, so pages of an earlier, longer run
    // are cleared. A directory the caller named is only ever written into.
    if (!request.outDir) await fs.rm(outputDir, { recursive: true, force: true })
    await fs.mkdir(outputDir, { recursive: true })
    const moved = async (files: readonly string[]) => {
      const targets = files.map((file) => path.join(outputDir, path.basename(file)))
      await Promise.all(files.map((file, index) => fs.copyFile(file, targets[index])))
      return targets
    }
    report.pages = await moved(result.pages)
    report.midi = await moved(result.midi)
    // The copies are what outlives this process; the run's own directory goes.
    await service.release(rootFile)

    report.ok = result.ok
    report.diagnostics = await withSource(parseStderr(result.stderr, { rootFile }))
    report.errorCount = report.diagnostics.filter((d) => d.severity === 'error').length
    report.warningCount = report.diagnostics.length - report.errorCount
    // A crash or a Guile backtrace: nothing parsed, so hand over what there is.
    if (!result.ok && report.errorCount === 0) report.stderr = result.stderr
  } catch (error) {
    report.error = { code: errorCode(error), message: errorMessage(error) }
  } finally {
    report.durationMs = Math.round(performance.now() - started)
  }
  return report
}

class MissingFileError extends Error {}

function errorCode(error: unknown): CheckErrorCode {
  if (error instanceof MissingFileError) return 'file-not-found'
  return error instanceof LilyPondNotFoundError ? 'lilypond-not-found' : 'failed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Adds the line and token a column points at. The column counts tab stops and
 * code points (D16), so without this an agent would have to redo that arithmetic
 * to find the place. Messages without a column name no place worth quoting.
 */
async function withSource(diagnostics: readonly LyDiagnostic[]): Promise<CheckDiagnostic[]> {
  const files = new Map<string, Promise<string[]>>()
  const linesOf = (file: string) => {
    if (!files.has(file)) {
      const lines = fs.readFile(file, 'utf8').then(
        (text) => text.split(/\r?\n/),
        () => [],
      )
      files.set(file, lines)
    }
    return files.get(file)!
  }
  return Promise.all(
    diagnostics.map(async (diagnostic) => {
      if (diagnostic.column === undefined) return diagnostic
      const text = (await linesOf(diagnostic.file))[diagnostic.line - 1]
      if (text === undefined) return diagnostic
      const span = diagnosticSpan(text, diagnostic.column)
      return { ...diagnostic, source: text.trimEnd(), token: text.slice(span.start, span.end) }
    }),
  )
}
