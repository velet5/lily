import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { CompileResult } from '../compile/compiler'
import { LilyPondNotFoundError } from '../compile/locate'
import { diagnosticSpan, parseStderr, type LyDiagnostic } from './parse'

// Everything a compile run tells the user outside the preview: the Problems
// panel, the "LilyPond" output channel and the status bar item (DECISIONS D3, D6,
// D16). Every compile goes through `run()`, whatever triggered it.

const DOWNLOAD_URL = 'https://lilypond.org/download.html'

type Status =
  | { kind: 'idle' }
  | { kind: 'compiling'; rootFile: string }
  | { kind: 'done'; result: CompileResult; errors: number; warnings: number }
  | { kind: 'failed'; rootFile: string; message: string }

export class CompileReporter implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('lilypond')
  private readonly channel = vscode.window.createOutputChannel('LilyPond')
  private readonly item = vscode.window.createStatusBarItem(
    'lily.compileStatus',
    vscode.StatusBarAlignment.Right,
    100,
  )
  private readonly editorListener: vscode.Disposable

  /** What each root's last completed run reported, per file URI. */
  private readonly byRoot = new Map<string, Map<string, vscode.Diagnostic[]>>()
  /** The status bar follows the most recently started run. */
  private latestRun = 0
  private status: Status = { kind: 'idle' }
  private askingForBinary = false

  constructor() {
    this.item.name = 'LilyPond Compile Status'
    this.editorListener = vscode.window.onDidChangeActiveTextEditor(() => this.render())
    this.render()
  }

  /**
   * Runs `compile` and reports it. Resolves with the result, also when cancelled,
   * or with undefined when the compile could not run at all (the user has been
   * told). Never rejects.
   */
  async run<T extends CompileResult>(
    rootFile: string,
    compile: () => Promise<T>,
    current: () => boolean = () => true,
  ): Promise<T | undefined> {
    const run = ++this.latestRun
    this.setStatus(run, { kind: 'compiling', rootFile })
    this.log(`Compiling ${rootFile}`)

    let result: T
    try {
      result = await compile()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`${path.basename(rootFile)}: ${message}\n`)
      this.setStatus(run, { kind: 'failed', rootFile, message })
      void this.explain(error, message)
      return undefined
    }

    if (result.cancelled) {
      // A superseded run reports nothing; its successor owns the diagnostics.
      this.log(`${path.basename(rootFile)}: cancelled\n`)
      this.setStatus(run, { kind: 'idle' })
      return result
    }

    if (result.engine) this.log(`Compiler: ${result.engine}${result.fallback ? `; ${result.fallback}` : ''}`)
    const diagnostics = parseStderr(result.stderr, { rootFile: result.rootFile }).map(d => result.snapshot?.diagnostic(d) ?? d)
    if (current()) await this.publish(result.rootFile, diagnostics, result.snapshot?.sources, current)
    const errors = diagnostics.filter((d) => d.severity === 'error').length
    const warnings = diagnostics.length - errors

    for (const text of [result.stdout, result.stderr]) {
      if (text.trim()) this.channel.appendLine(text.trimEnd())
    }
    this.log(`${path.basename(rootFile)}: ${summary(result, errors, warnings)}\n`)
    this.setStatus(run, { kind: 'done', result, errors, warnings })
    return result
  }

  invalidate(uri: vscode.Uri): void {
    for (const files of this.byRoot.values()) files.delete(uri.toString())
    this.collection.delete(uri)
  }

  showOutput(): void {
    this.channel.show(true)
  }

  dispose(): void {
    this.editorListener.dispose()
    this.collection.dispose()
    this.channel.dispose()
    this.item.dispose()
  }

  /** Replaces what `rootFile` reported last time, in every file it touched. */
  private async publish(rootFile: string, diagnostics: readonly LyDiagnostic[], sources?: ReadonlyMap<string, string>, current = () => true): Promise<void> {
    const next = new Map<string, vscode.Diagnostic[]>()
    const lineCache = new Map<string, Promise<string[] | undefined>>()
    for (const diagnostic of diagnostics) {
      let lines = lineCache.get(diagnostic.file)
      if (!lines) lineCache.set(diagnostic.file, (lines = sources?.has(diagnostic.file)
        ? Promise.resolve(sources.get(diagnostic.file)!.split(/\r?\n/)) : readLines(diagnostic.file)))
      const uri = vscode.Uri.file(diagnostic.file).toString()
      next.set(uri, [...(next.get(uri) ?? []), toVsCode(diagnostic, await lines)])
    }

    if (!current()) return
    const key = rootKey(rootFile)
    const touched = new Set([...(this.byRoot.get(key)?.keys() ?? []), ...next.keys()])
    this.byRoot.set(key, next)
    for (const uri of touched) {
      // An include shared by two roots shows what both reported, once.
      const merged = new Map<string, vscode.Diagnostic>()
      for (const files of this.byRoot.values()) {
        for (const d of files.get(uri) ?? []) {
          merged.set(`${d.range.start.line}:${d.range.start.character}:${d.severity}:${d.message}`, d)
        }
      }
      this.collection.set(vscode.Uri.parse(uri), [...merged.values()])
    }
  }

  private log(line: string): void {
    this.channel.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`)
  }

  private setStatus(run: number, status: Status): void {
    if (run !== this.latestRun) return
    this.status = status
    this.render()
  }

  private render(): void {
    const { item, status } = this
    if (vscode.window.activeTextEditor?.document.languageId !== 'lilypond') return item.hide()

    item.backgroundColor = undefined
    item.command = 'lily.showOutput'
    switch (status.kind) {
      case 'idle':
        item.text = 'LilyPond'
        item.tooltip = 'Compile this file'
        item.command = 'lily.compile'
        break
      case 'compiling':
        item.text = '$(sync~spin) LilyPond'
        item.tooltip = `Compiling ${path.basename(status.rootFile)}…`
        break
      case 'failed':
        item.text = '$(error) LilyPond'
        item.tooltip = `${path.basename(status.rootFile)}: ${status.message}`
        item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        break
      case 'done': {
        const { result, errors, warnings } = status
        const counts = [
          ...(errors ? [`$(error) ${errors}`] : []),
          ...(warnings ? [`$(warning) ${warnings}`] : []),
        ]
        // A run can fail without a parseable message, e.g. when lilypond crashes.
        const clean = result.ok ? '$(check) LilyPond' : '$(error) LilyPond'
        item.text = counts.length ? ['LilyPond', ...counts].join(' ') : clean
        item.tooltip = `${path.basename(result.rootFile)}: ${summary(result, errors, warnings)}`
        if (errors || warnings) item.command = 'workbench.actions.view.problems'
        if (errors || !result.ok) {
          item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
        } else if (warnings) {
          item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
        }
      }
    }
    item.show()
  }

  /** One actionable message per failure; never a stack of them (D9). */
  private async explain(error: unknown, message: string): Promise<void> {
    if (!(error instanceof LilyPondNotFoundError)) {
      const choice = await vscode.window.showErrorMessage(`LilyPond: ${message}`, 'Show Output')
      if (choice) this.showOutput()
      return
    }
    if (this.askingForBinary) return
    this.askingForBinary = true
    try {
      const choice = await vscode.window.showErrorMessage(message, 'Open Settings', 'Download')
      if (choice === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'lily.lilypond.path')
      } else if (choice === 'Download') {
        await vscode.env.openExternal(vscode.Uri.parse(DOWNLOAD_URL))
      }
    } finally {
      this.askingForBinary = false
    }
  }
}

function toVsCode(diagnostic: LyDiagnostic, lines: string[] | undefined): vscode.Diagnostic {
  const line = diagnostic.line - 1
  // Without the text (file unreadable, line past the end) fall back to the raw column.
  const text = lines?.[line]
  const span =
    text === undefined
      ? { start: (diagnostic.column ?? 1) - 1, end: diagnostic.column ?? 1 }
      : diagnosticSpan(text, diagnostic.column)
  const result = new vscode.Diagnostic(
    new vscode.Range(line, span.start, line, span.end),
    diagnostic.message,
    diagnostic.severity === 'error'
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning,
  )
  result.source = 'lilypond'
  return result
}

/** From disk, because that is what lilypond compiled; an unsaved buffer may differ. */
async function readLines(file: string): Promise<string[] | undefined> {
  try {
    return (await fs.readFile(file, 'utf8')).split(/\r?\n/)
  } catch {
    return undefined
  }
}

function summary(
  result: CompileResult & { exported?: string[] },
  errors: number,
  warnings: number,
): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  return [
    result.ok ? 'done' : `failed (exit code ${result.exitCode})`,
    count(errors, 'error'),
    count(warnings, 'warning'),
    // An export (D20) writes files, not pages.
    result.exported ? count(result.exported.length, 'file') : count(result.pages.length, 'page'),
    `${(result.durationMs / 1000).toFixed(1)} s`,
  ].join(', ')
}

function rootKey(rootFile: string): string {
  return process.platform === 'win32' ? rootFile.toLowerCase() : rootFile
}
