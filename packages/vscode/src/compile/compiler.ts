import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { locateLilyPond } from './locate'
import { Accelerator, type ProcessResult } from './accelerator'
import { SourceSnapshot, SnapshotUnavailableError, type SourceBuffers } from './snapshot'

// Owns LilyPond processes, including the acceleration helpers (D3, D25). No `vscode` import here or
// anywhere else under src/compile/, so the CLI and MCP server can reuse it (D11).

export interface CompileRequest {
  /** The real .ly root; optional editor texts are materialized in a private snapshot. */
  rootFile: string
  /** Value of `lily.lilypond.path`; empty means PATH, then well-known directories. */
  lilypondPath?: string
  /** Value of `lily.compile.extraArgs`, passed through verbatim. */
  extraArgs?: readonly string[]
  buffers?: SourceBuffers
  acceleration?: 'off' | 'cache' | 'auto'
  timeoutMs?: number
}

export interface CompileResult {
  /** Absolute path that was compiled. */
  rootFile: string
  /** Exit code 0. A failed run may still have pages (ARCHITECTURE §3.3). */
  ok: boolean
  /** Superseded or cancelled; carries no pages and must never be rendered. */
  cancelled: boolean
  exitCode: number | null
  /** Absolute SVG paths in page order. */
  pages: string[]
  /** Absolute paths of any MIDI files the score produced, in the order lilypond wrote them. */
  midi: string[]
  /**
   * Absolute path of the playback map that `runtime/timing.ly` wrote (D26): a
   * JSON array with one entry per file of `midi`. Only in preview compiles
   * with a runtime directory, and only when the score has a `\midi` block.
   */
  timing?: string
  stdout: string
  /** Raw and unmodified; messages are forced to English (see `compileEnv`). */
  stderr: string
  /** This run's private directory. Already deleted when `cancelled`. */
  outputDir: string | undefined
  durationMs: number
  snapshot?: SourceSnapshot
  snapshotMs?: number
  engine?: 'spawn' | 'cache' | 'warm'
  fallback?: string
}

/** What an export writes into the user's folder (D5, D20). */
export type ExportFormat = 'pdf' | 'midi'

export interface ExportRequest extends CompileRequest {
  format: ExportFormat
  /** Where the files go. Defaults to the root file's directory. */
  targetDir?: string
}

/** `pages`, `midi` and `outputDir` are empty: the run's directory is gone already. */
export interface ExportResult extends CompileResult {
  /** Absolute paths of the files written, named as lilypond names them. */
  exported: string[]
}

export interface CompileServiceOptions {
  /** Parent of the per-run directories. Defaults to the OS temp dir. */
  tmpRoot?: string
  runtimeDir?: string
}

interface Run {
  cancelled: boolean
  child?: ChildProcess
  stop?: () => void
  outputDir?: string
}

interface RunMode {
  /** Slot in `live`; a new run kills the one that holds it. */
  key: string
  /** What lilypond is to write. */
  formatArgs: readonly string[]
  /** Keep the output directory as the root's current one, or delete it with the run. */
  keep: boolean
  /** Called with the names lilypond wrote, while their directory still exists. */
  collect?(outputDir: string, produced: string[]): Promise<void>
}

const EXPORTS: Record<ExportFormat, { formatArgs: string[]; pattern: RegExp }> = {
  // Links to the author's file paths have no place in a PDF that is handed on.
  pdf: { formatArgs: ['--pdf', '-dno-point-and-click'], pattern: /\.pdf$/i },
  // No pages at all; a \midi block still writes its file [verified on 2.26].
  midi: { formatArgs: ['-dno-print-pages'], pattern: /\.midi?$/i },
}

export class CompileService {
  private readonly tmpRoot: string
  private readonly runtimeDir: string | undefined
  private readonly accelerator: Accelerator
  /** In-flight run per root file; at most one each. */
  private readonly live = new Map<string, Run>()
  /** Output directory of the last completed run per root file. */
  private readonly kept = new Map<string, string>()

  constructor(options: CompileServiceOptions = {}) {
    this.tmpRoot = options.tmpRoot ?? os.tmpdir()
    this.runtimeDir = options.runtimeDir
    this.accelerator = new Accelerator(options.runtimeDir)
  }

  /**
   * Compiles `rootFile` to SVG in a fresh temp directory. A run still in flight
   * for the same file is killed and resolves with `cancelled: true`.
   *
   * Rejects only when the root file is unreadable or lilypond cannot be located
   * (`LilyPondNotFoundError`) or started; compile errors resolve with
   * `ok: false` and the raw stderr.
   *
   * The previous completed run's directory for this file is deleted once this
   * one completes, so read `pages` before the next result arrives.
   */
  compile(request: CompileRequest): Promise<CompileResult> {
    return this.run(request, {
      key: runKey(path.resolve(request.rootFile)),
      formatArgs: [
        '--svg', '-dpoint-and-click',
        // Where every note of the MIDI is on the page (D26); an export has no use for it.
        ...(this.runtimeDir ? [`-dinclude-settings=${path.join(this.runtimeDir, 'timing.ly')}`] : []),
      ],
      keep: true,
    })
  }

  /**
   * Compiles `rootFile` once more, for `format`, and copies what that wrote into
   * `targetDir`, replacing files of the same name. The run has its own temp
   * directory and its own slot: it neither supersedes a preview compile nor
   * touches the kept pages, only an export of the same file and format in flight.
   * Rejects like `compile()`, and when a file cannot be written.
   */
  async export(request: ExportRequest): Promise<ExportResult> {
    const rootFile = path.resolve(request.rootFile)
    const { formatArgs, pattern } = EXPORTS[request.format]
    const targetDir = path.resolve(request.targetDir ?? path.dirname(rootFile))
    let exported: string[] = []
    const result = await this.run(request, {
      key: exportKey(rootFile, request.format),
      formatArgs,
      keep: false,
      collect: async (outputDir, produced) => {
        const names = produced.filter((name) => pattern.test(name)).sort()
        await fs.mkdir(targetDir, { recursive: true })
        await Promise.all(
          names.map((name) => fs.copyFile(path.join(outputDir, name), path.join(targetDir, name))),
        )
        exported = names.map((name) => path.join(targetDir, name))
      },
    })
    return { ...result, pages: [], midi: [], outputDir: undefined, exported }
  }

  private async run(request: CompileRequest, mode: RunMode): Promise<CompileResult> {
    const started = performance.now()
    const rootFile = path.resolve(request.rootFile)
    const { key } = mode

    this.kill(this.live.get(key))
    const run: Run = { cancelled: false }
    this.live.set(key, run)

    const result = (partial: Partial<CompileResult>): CompileResult => ({
      rootFile,
      ok: false,
      cancelled: false,
      exitCode: null,
      pages: [],
      midi: [],
      stdout: '',
      stderr: '',
      outputDir: partial.cancelled ? undefined : run.outputDir,
      durationMs: Math.round(performance.now() - started),
      ...partial,
    })

    let keepOutput = false
    let snapshot: SourceSnapshot | undefined
    let snapshotMs = 0
    let engine: CompileResult['engine'] = 'spawn'
    let fallback: string | undefined
    try {
      // Checked here because a missing source directory, being the child's cwd,
      // would otherwise be reported as "spawn lilypond ENOENT".
      if (!request.buffers?.has(rootFile)) await fs.access(rootFile, fs.constants.R_OK)
      const binary = await locateLilyPond({ configuredPath: request.lilypondPath })
      if (run.cancelled) return result({ cancelled: true })

      // lilypond does not create the directory part of -o; it must exist.
      run.outputDir = await fs.mkdtemp(path.join(this.tmpRoot, 'lily-'))
      if (run.cancelled) return result({ cancelled: true })

      const snapshotStart = performance.now()
      if (mode.keep && request.buffers?.size) {
        try {
          snapshot = await SourceSnapshot.create(rootFile, request.buffers, path.join(run.outputDir, 'sources'), request.extraArgs ?? [])
        } catch (error) {
          if (!(error instanceof SnapshotUnavailableError)) throw error
          // An unsupported/incomplete include is an editing diagnostic, not a
          // modal failure-to-start notification on every keystroke.
          return result({ stderr: `fatal error: ${error.message}\n`, outputDir: undefined,
            cancelled: run.cancelled })
        }
      }
      snapshotMs = Math.round(performance.now() - snapshotStart)
      if (run.cancelled) return result({ cancelled: true })
      const source = snapshot?.rootFile ?? rootFile
      const base = path.basename(rootFile, path.extname(rootFile))
      const extra = [...(request.extraArgs ?? [])]
      const timeoutMs = request.timeoutMs ?? (mode.keep && request.acceleration ? 60000 : 0)
      // Arbitrary -e/options may initialize fonts before the fork, change the
      // backend or replace its functions. Keep that entire path ordinary.
      const safeArgs = extra.every((arg, i) =>
        arg === '-I' || arg === '--include' || arg.startsWith('--include=') || arg.startsWith('-I') ||
        extra[i - 1] === '-I' || extra[i - 1] === '--include')
      const identity = mode.keep && request.acceleration !== 'off' && safeArgs
        ? await this.accelerator.identity(binary.path) : ''
      const accelerated = identity !== '' && await this.accelerator.supported(binary.path, identity)
      const common = ['--loglevel=WARNING', ...mode.formatArgs, ...extra]
      const ordinary = (cache: boolean) => this.spawn(run, binary.path, [
        ...common, ...(cache ? this.accelerator.cacheArgs() : []),
        '-o', path.join(run.outputDir!, base), source,
      ], path.dirname(rootFile), timeoutMs)
      let exit: ProcessResult | undefined
      if (run.cancelled) return result({ cancelled: true })
      if (accelerated && request.acceleration === 'auto' && ['darwin', 'linux'].includes(process.platform)) {
        const worker = this.accelerator.worker(rootFile, identity, binary.path, [
          ...common, ...this.accelerator.cacheArgs(), '-o', base,
        ])
        if (worker) {
          run.stop = () => this.accelerator.release(rootFile, worker)
          try {
            exit = await worker.run(source, run.outputDir, timeoutMs)
            engine = 'warm'
          } catch (error) {
            this.accelerator.failedWorker(rootFile, worker)
            if (run.cancelled) return result({ cancelled: true })
            fallback = error instanceof Error ? error.message : String(error)
            // A failed worker may have written partial pages. Never collect them.
            for (const name of await fs.readdir(run.outputDir)) {
              if (name !== 'sources') await fs.rm(path.join(run.outputDir, name), { recursive: true, force: true })
            }
          } finally { run.stop = undefined }
        }
      } else this.accelerator.release(rootFile)
      if (!exit) {
        const cache = accelerated && !fallback
        exit = await ordinary(cache)
        engine = cache ? 'cache' : 'spawn'
      }
      // Optimization errors must never prevent a normal compiler result. Syntax
      // errors are retried too; this costs time while a score is incomplete.
      if (!run.cancelled && engine !== 'spawn' && exit.exitCode !== 0) {
        fallback ??= 'Accelerated compile failed; retried with ordinary LilyPond.'
        for (const name of await fs.readdir(run.outputDir)) {
          if (name !== 'sources') await fs.rm(path.join(run.outputDir, name), { recursive: true, force: true })
        }
        exit = await ordinary(false)
        engine = 'spawn'
      }
      if (run.cancelled) return result({ ...exit, cancelled: true })

      const produced = await fs.readdir(run.outputDir)
      if (!run.cancelled) await mode.collect?.(run.outputDir, produced)
      // Re-checked after the last await: from here to the bookkeeping in
      // `finally` nothing yields, so a superseded or disposed run is never kept.
      if (run.cancelled) return result({ ...exit, cancelled: true })
      const absolute = (name: string) => path.join(run.outputDir!, name)
      const timing = produced.includes(`${base}.timing.json`) ? absolute(`${base}.timing.json`) : undefined
      if (snapshot) {
        // The map links to the snapshot's files just as the pages do.
        for (const file of [...orderPages(produced, base).map(absolute), ...(timing ? [timing] : [])]) {
          await fs.writeFile(file, snapshot.links(await fs.readFile(file, 'utf8')))
        }
      }
      if (run.cancelled) return result({ ...exit, cancelled: true })
      keepOutput = mode.keep
      return result({
        snapshot, snapshotMs, engine, fallback,
        ...exit,
        ok: exit.exitCode === 0,
        pages: orderPages(produced, base).map(absolute),
        midi: orderOutputs(produced, base, /\.midi?$/i).map(absolute),
        ...(timing ? { timing } : {}),
      })
    } finally {
      if (this.live.get(key) === run) this.live.delete(key)
      if (keepOutput && run.outputDir) {
        const previous = this.kept.get(key)
        this.kept.set(key, run.outputDir)
        await removeDir(previous)
      } else {
        await removeDir(run.outputDir)
      }
    }
  }

  /** Kills the in-flight compile for `rootFile`, or every run, exports too, when omitted. */
  cancel(rootFile?: string): void {
    if (rootFile === undefined) {
      for (const run of this.live.values()) this.kill(run)
    } else {
      this.kill(this.live.get(runKey(path.resolve(rootFile))))
    }
  }

  /** Kills the export of `rootFile` to `format`, if one is running. */
  cancelExport(rootFile: string, format: ExportFormat): void {
    this.kill(this.live.get(exportKey(path.resolve(rootFile), format)))
  }

  /** Deletes the kept output of `rootFile`, e.g. when its preview closes (D5). */
  async release(rootFile: string): Promise<void> {
    this.cancel(rootFile)
    this.accelerator.release(path.resolve(rootFile))
    const key = runKey(path.resolve(rootFile))
    const dir = this.kept.get(key)
    this.kept.delete(key)
    await removeDir(dir)
  }

  /** Kills every run and deletes every kept output directory. */
  async dispose(): Promise<void> {
    this.cancel()
    this.accelerator.dispose()
    const dirs = [...this.kept.values()]
    this.kept.clear()
    await Promise.all(dirs.map(removeDir))
  }

  private kill(run: Run | undefined): void {
    if (!run || run.cancelled) return
    run.cancelled = true
    // Nothing to flush: the run's directory is discarded anyway.
    run.stop?.()
    run.child?.kill('SIGKILL')
  }

  private spawn(
    run: Run,
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): Promise<Pick<CompileResult, 'exitCode' | 'stdout' | 'stderr'>> {
    return new Promise((resolve, reject) => {
      // cwd is the source directory so relative \include keeps working.
      const child = spawn(command, args, {
        cwd,
        env: compileEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      run.child = child

      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      const timer = timeoutMs > 0 ? setTimeout(() => {
        stderr += '\nfatal error: LilyPond compile timed out.\n'
        child.kill('SIGKILL')
      }, timeoutMs) : undefined
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }) })
    })
  }
}

/**
 * Page files of one run, in reading order. One page is `<base>.svg`, several are
 * `<base>-1.svg`, `<base>-2.svg`, …; `\bookOutputSuffix` and `\bookOutputName`
 * add other stems. Numbers sort numerically, so `-10` follows `-9`.
 */
export function orderPages(fileNames: readonly string[], base: string): string[] {
  return orderOutputs(fileNames, base, /\.svg$/i)
}

/**
 * The files of one run with an `extension`, in the order lilypond wrote them:
 * `<base>`, then `<base>-1`, `<base>-2`, …, then other stems. MIDI files are
 * named like pages, one per `\midi` block (ARCHITECTURE §3.3).
 */
export function orderOutputs(fileNames: readonly string[], base: string, extension: RegExp): string[] {
  const collator = new Intl.Collator('en', { numeric: true })
  const foreign = (name: string) => (name.startsWith(base) ? 0 : 1)
  const suffix = (name: string) => {
    const stem = name.replace(extension, '')
    return foreign(name) ? stem : stem.slice(base.length)
  }
  return fileNames
    .filter((name) => extension.test(name))
    .sort((a, b) => foreign(a) - foreign(b) || collator.compare(suffix(a), suffix(b)))
}

/**
 * lilypond translates the `error:` / `warning:` keywords with the user's locale
 * (`Fehler:` under de_DE). LANGUAGE overrides only the message catalogue, so
 * stderr stays parseable while the locale's UTF-8 handling of paths is kept.
 */
function compileEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LANGUAGE: 'en' }
}

function runKey(rootFile: string): string {
  return process.platform === 'win32' ? rootFile.toLowerCase() : rootFile
}

/** NUL cannot occur in a path, so an export never shares a slot with a compile. */
function exportKey(rootFile: string, format: ExportFormat): string {
  return `${runKey(rootFile)}\0${format}`
}

async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
}
