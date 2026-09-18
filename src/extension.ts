import * as path from 'node:path'
import * as vscode from 'vscode'
import { CompileService, type CompileResult } from './compile/compiler'
import { includeDirsFromArgs, rootsIncluding } from './compile/rootFile'
import { getAutoPreviewSettings, getCompileSettings, getPreviewSettings } from './config'
import { CompileReporter } from './diagnostics/publish'
import { AutoPreview } from './preview/autoPreview'
import { PREVIEW_VIEW_TYPE, PreviewManager } from './preview/panel'

// Activation and command/listener wiring only (ARCHITECTURE §3.2). It must never
// depend on the lilypond binary being present (DECISIONS D9).

/** What `activate` returns; the extension-host tests reach the previews through it. */
export interface LilyApi {
  previews: PreviewManager
  autoPreview: AutoPreview
}

/** One per extension host (D3). */
let service: CompileService | undefined

export function activate(context: vscode.ExtensionContext): LilyApi {
  const compiler = (service = new CompileService())
  const reporter = new CompileReporter()
  const media = vscode.Uri.joinPath(context.extensionUri, 'media')
  const previews = new PreviewManager({
    assets: {
      root: media,
      script: vscode.Uri.joinPath(media, 'preview.js'),
      style: vscode.Uri.joinPath(media, 'preview.css'),
    },
    colors: () => getPreviewSettings().colors,
    // Left pane code, right pane score; the editor keeps the focus (D4).
    createPanel: (title) =>
      vscode.window.createWebviewPanel(PREVIEW_VIEW_TYPE, title, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      }),
    onDidClose: (rootFile) => void compiler.release(rootFile),
  })

  /** The document a command is about, or undefined once the user has been told why not. */
  const compilable = async (uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
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
    return document
  }

  /** Compiles what is on disk. Resolves with undefined when lilypond could not run. */
  const compileRoot = async (rootFile: string): Promise<CompileResult | undefined> => {
    // This run covers every save so far; a refresh still waiting would repeat it (D18).
    autoPreview.compileStarted(rootFile)
    const run = reporter.run(rootFile, () =>
      compiler.compile({ rootFile, ...getCompileSettings(vscode.Uri.file(rootFile)) }),
    )
    // Every compile of a previewed root refreshes its preview, whatever started it (D3).
    await previews.get(rootFile)?.follow(run)
    return run
  }

  /** Resolves with undefined when the save was refused or lilypond could not run. */
  const compileDocument = async (
    document: vscode.TextDocument,
  ): Promise<CompileResult | undefined> => {
    if (document.isDirty && !(await document.save())) return undefined
    return compileRoot(document.uri.fsPath)
  }

  // Saving a previewed root, or a file one includes, refreshes that preview (D10, D18).
  const autoPreview = new AutoPreview({
    settings: getAutoPreviewSettings,
    previewedRoots: () => previews.roots(),
    rootsIncluding: (file, roots) =>
      rootsIncluding(file, roots, (rootFile) => ({
        includeDirs: includeDirsFromArgs(
          getCompileSettings(vscode.Uri.file(rootFile)).extraArgs,
          path.dirname(rootFile),
        ),
      })),
    // The saved file is on disk already; other dirty editors are left alone.
    compile: compileRoot,
  })

  const compile = async (uri?: vscode.Uri): Promise<CompileResult | undefined> => {
    const document = await compilable(uri)
    return document && compileDocument(document)
  }

  const openPreview = async (uri?: vscode.Uri): Promise<void> => {
    const document = await compilable(uri)
    if (!document) return
    const { preview, created } = previews.open(document.uri.fsPath)
    // Revealing a preview that already shows the score costs no compile.
    if (created || !preview.hasPages) await compileDocument(document)
  }

  context.subscriptions.push(
    reporter,
    previews,
    autoPreview,
    vscode.commands.registerCommand('lily.compile', compile),
    vscode.commands.registerCommand('lily.showOutput', () => reporter.showOutput()),
    vscode.commands.registerCommand('lily.preview.openToSide', openPreview),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') void autoPreview.documentSaved(document.uri.fsPath)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lily.preview')) {
        previews.setColors(getPreviewSettings().colors)
      }
    }),
  )
  return { previews, autoPreview }
}

/** Kills running compiles and deletes their temp directories; VS Code awaits this. */
export function deactivate(): Promise<void> | undefined {
  return service?.dispose()
}
