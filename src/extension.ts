import * as path from 'node:path'
import * as vscode from 'vscode'
import { CompileService, type CompileResult } from './compile/compiler'
import { includeDirsFromArgs, rootsIncluding } from './compile/rootFile'
import { getAutoPreviewSettings, getCompileSettings, getPreviewSettings } from './config'
import { CompileReporter } from './diagnostics/publish'
import { AutoPreview } from './preview/autoPreview'
import { PREVIEW_VIEW_TYPE, PreviewManager, type PreviewPanel } from './preview/panel'
import { charToCharacter, type SourceLocation } from './preview/pointAndClick'

// Activation and command/listener wiring only (ARCHITECTURE §3.2). It must never
// depend on the lilypond binary being present (DECISIONS D9).

/** What `activate` returns; the extension-host tests reach the previews through it. */
export interface LilyApi {
  previews: PreviewManager
  autoPreview: AutoPreview
  /** What a click on a note does: shows `location` in an editor outside `preview`'s column. */
  revealSource(location: SourceLocation, preview?: PreviewPanel): Promise<void>
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
    revealSource: (location, preview) => void revealSource(location, preview),
  })

  /** Score → code (D7, D19): the cursor goes to `location`, in the pane that has the code. */
  const revealSource = async (location: SourceLocation, preview?: PreviewPanel): Promise<void> => {
    const uri = vscode.Uri.file(location.file)
    let document: vscode.TextDocument
    try {
      document = await vscode.workspace.openTextDocument(uri)
    } catch {
      void vscode.window.showWarningMessage(`Cannot open ${location.file}.`)
      return
    }
    // The file was compiled from disk; an edited buffer may have fewer lines.
    const line = Math.min(location.line, document.lineCount) - 1
    const position = new vscode.Position(
      line,
      charToCharacter(document.lineAt(line).text, location.char),
    )
    await vscode.window.showTextDocument(document, {
      viewColumn: columnShowing(uri) ?? codeColumn(preview),
      selection: new vscode.Range(position, position),
    })
  }

  /** The cursor's place in a LilyPond file on disk, which is all a score can link to. */
  const cursorOf = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.languageId !== 'lilypond' || editor.document.uri.scheme !== 'file') {
      return undefined
    }
    const { line, character } = editor.selection.active
    return {
      file: editor.document.uri.fsPath,
      line,
      character,
      lineText: editor.document.lineAt(line).text,
    }
  }

  /** Code → score (D7, D19). Other editors, and the preview taking the focus, change nothing. */
  const followCursor = (editor: vscode.TextEditor | undefined): void => {
    const cursor = cursorOf(editor)
    if (cursor && getPreviewSettings().followCursor) previews.followCursor(cursor)
  }

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
    // A new panel learns where the cursor is now, not at the next keypress.
    followCursor(vscode.window.activeTextEditor)
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
    vscode.window.onDidChangeTextEditorSelection((event) => followCursor(event.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(followCursor),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('lily.preview')) {
        previews.setColors(getPreviewSettings().colors)
      }
      if (event.affectsConfiguration('lily.preview.followCursor')) {
        // Switched off: the mark goes; switched on: it appears without a keypress.
        previews.followCursor(
          getPreviewSettings().followCursor ? cursorOf(vscode.window.activeTextEditor) : undefined,
        )
      }
    }),
  )
  return { previews, autoPreview, revealSource }
}

/** The column in which `uri` already has a tab, visible or not. */
function columnShowing(uri: vscode.Uri): vscode.ViewColumn | undefined {
  const wanted = uri.toString()
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some(
      (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === wanted,
    ),
  )?.viewColumn
}

/** Where a file opened from `preview` goes: beside the score, never on top of it. */
function codeColumn(preview: PreviewPanel | undefined): vscode.ViewColumn {
  const occupied = preview?.viewColumn
  const editor = vscode.window.visibleTextEditors.find(
    (candidate) => candidate.viewColumn !== undefined && candidate.viewColumn !== occupied,
  )
  if (editor?.viewColumn) return editor.viewColumn
  return occupied === vscode.ViewColumn.One ? vscode.ViewColumn.Beside : vscode.ViewColumn.One
}

/** Kills running compiles and deletes their temp directories; VS Code awaits this. */
export function deactivate(): Promise<void> | undefined {
  return service?.dispose()
}
