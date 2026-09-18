import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { locateLilyPond } from './locate'

// The only place that spawns lilypond (DECISIONS D3). No `vscode` import here or
// anywhere else under src/compile/, so the CLI and MCP server can reuse it (D11).

export interface CompileRequest {
  /** The .ly file to compile; it is read from disk, never from an editor buffer. */
  rootFile: string
  /** Value of `lily.lilypond.path`; empty means PATH, then well-known directories. */
  lilypondPath?: string
  /** Value of `lily.compile.extraArgs`, passed through verbatim. */
  extraArgs?: readonly string[]
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
  /** Absolute paths of any MIDI files the score produced. */
  midi: string[]
  stdout: string
  /** Raw and unmodified; messages are forced to English (see `compileEnv`). */
  stderr: string
  /** This run's private directory. Already deleted when `cancelled`. */
  outputDir: string | undefined
  durationMs: number
}

export interface CompileServiceOptions {
  /** Parent of the per-run directories. Defaults to the OS temp dir. */
  tmpRoot?: string
}

interface Run {
  cancelled: boolean
  child?: ChildProcess
  outputDir?: string
}

export class CompileService {
  private readonly tmpRoot: string
  /** In-flight run per root file; at most one each. */
  private readonly live = new Map<string, Run>()
  /** Output directory of the last completed run per root file. */
  private readonly kept = new Map<string, string>()

  constructor(options: CompileServiceOptions = {}) {
    this.tmpRoot = options.tmpRoot ?? os.tmpdir()
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
  async compile(request: CompileRequest): Promise<CompileResult> {
    const started = performance.now()
    const rootFile = path.resolve(request.rootFile)
    const key = runKey(rootFile)

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
    try {
      // Checked here because a missing source directory, being the child's cwd,
      // would otherwise be reported as "spawn lilypond ENOENT".
      await fs.access(rootFile, fs.constants.R_OK)
      const binary = await locateLilyPond({ configuredPath: request.lilypondPath })
      if (run.cancelled) return result({ cancelled: true })

      // lilypond does not create the directory part of -o; it must exist.
      run.outputDir = await fs.mkdtemp(path.join(this.tmpRoot, 'lily-'))
      if (run.cancelled) return result({ cancelled: true })

      const base = path.basename(rootFile, path.extname(rootFile))
      const args = [
        '--loglevel=WARNING',
        '--svg',
        '-dpoint-and-click',
        ...(request.extraArgs ?? []),
        // Last, so extra arguments cannot redirect output into the source tree (D5).
        '-o',
        path.join(run.outputDir, base),
        rootFile,
      ]
      const exit = await this.spawn(run, binary.path, args, path.dirname(rootFile))
      if (run.cancelled) return result({ ...exit, cancelled: true })

      const produced = await fs.readdir(run.outputDir)
      // Re-checked after the last await: from here to the bookkeeping in
      // `finally` nothing yields, so a superseded or disposed run is never kept.
      if (run.cancelled) return result({ ...exit, cancelled: true })
      const absolute = (name: string) => path.join(run.outputDir!, name)
      keepOutput = true
      return result({
        ...exit,
        ok: exit.exitCode === 0,
        pages: orderPages(produced, base).map(absolute),
        midi: produced.filter((name) => /\.midi?$/i.test(name)).sort().map(absolute),
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

  /** Kills the in-flight run for `rootFile`, or every run when omitted. */
  cancel(rootFile?: string): void {
    if (rootFile === undefined) {
      for (const run of this.live.values()) this.kill(run)
    } else {
      this.kill(this.live.get(runKey(path.resolve(rootFile))))
    }
  }

  /** Deletes the kept output of `rootFile`, e.g. when its preview closes (D5). */
  async release(rootFile: string): Promise<void> {
    const key = runKey(path.resolve(rootFile))
    const dir = this.kept.get(key)
    this.kept.delete(key)
    await removeDir(dir)
  }

  /** Kills every run and deletes every kept output directory. */
  async dispose(): Promise<void> {
    this.cancel()
    const dirs = [...this.kept.values()]
    this.kept.clear()
    await Promise.all(dirs.map(removeDir))
  }

  private kill(run: Run | undefined): void {
    if (!run || run.cancelled) return
    run.cancelled = true
    // Nothing to flush: the run's directory is discarded anyway.
    run.child?.kill('SIGKILL')
  }

  private spawn(
    run: Run,
    command: string,
    args: string[],
    cwd: string,
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
      child.on('error', reject)
      child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
    })
  }
}

/**
 * Page files of one run, in reading order. One page is `<base>.svg`, several are
 * `<base>-1.svg`, `<base>-2.svg`, …; `\bookOutputSuffix` and `\bookOutputName`
 * add other stems. Numbers sort numerically, so `-10` follows `-9`.
 */
export function orderPages(fileNames: readonly string[], base: string): string[] {
  const collator = new Intl.Collator('en', { numeric: true })
  const foreign = (name: string) => (name.startsWith(base) ? 0 : 1)
  const suffix = (name: string) => {
    const stem = name.slice(0, -'.svg'.length)
    return foreign(name) ? stem : stem.slice(base.length)
  }
  return fileNames
    .filter((name) => name.toLowerCase().endsWith('.svg'))
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

async function removeDir(dir: string | undefined): Promise<void> {
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })
}
