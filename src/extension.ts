import * as vscode from 'vscode'
import { CompileService, type CompileResult } from './compile/compiler'
import { getCompileSettings } from './config'
import { CompileReporter } from './diagnostics/publish'

// Activation and command/listener wiring only (ARCHITECTURE §3.2). It must never
// depend on the lilypond binary being present (DECISIONS D9).

/** One per extension host (D3). */
let service: CompileService | undefined

export function activate(context: vscode.ExtensionContext): void {
  const compiler = (service = new CompileService())
  const reporter = new CompileReporter()

  /** Resolves with undefined when there was nothing to compile or lilypond could not run. */
  const compile = async (uri?: vscode.Uri): Promise<CompileResult | undefined> => {
    const document = uri
      ? await vscode.workspace.openTextDocument(uri)
      : vscode.window.activeTextEditor?.document
    if (document?.languageId !== 'lilypond') {
      void vscode.window.showInformationMessage('Open a LilyPond file to compile it.')
      return undefined
    }
    // lilypond reads the file from disk, never the editor buffer (ARCHITECTURE §3.3).
    if (document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Save this file to disk to compile it.')
      return undefined
    }
    if (document.isDirty && !(await document.save())) return undefined

    const rootFile = document.uri.fsPath
    return reporter.run(rootFile, () =>
      compiler.compile({ rootFile, ...getCompileSettings(document.uri) }),
    )
  }

  context.subscriptions.push(
    reporter,
    vscode.commands.registerCommand('lily.compile', compile),
    vscode.commands.registerCommand('lily.showOutput', () => reporter.showOutput()),
  )
}

/** Kills running compiles and deletes their temp directories; VS Code awaits this. */
export function deactivate(): Promise<void> | undefined {
  return service?.dispose()
}
