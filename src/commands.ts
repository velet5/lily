import * as path from 'node:path'
import * as vscode from 'vscode'
import type { CompileResult, CompileService, ExportFormat, ExportResult } from './compile/compiler'
import { getCompileSettings } from './config'
import type { CompileReporter } from './diagnostics/publish'
import type { PreviewManager, PreviewPanel, ToolbarCommand } from './preview/panel'

// The command surface (DECISIONS D20): every `lily.*` command is registered
// here, and package.json's menus, keybindings and `when` clauses point at them.

/** True while at least one preview is open; the palette's `when` clauses use it. */
export const PREVIEW_OPEN_CONTEXT = 'lily.previewOpen'

/** What a toolbar button of the webview runs. The webview cannot name any other command. */
const TOOLBAR: Record<ToolbarCommand, string> = {
  refresh: 'lily.preview.refresh',
  exportPdf: 'lily.export.pdf',
  exportMidi: 'lily.export.midi',
}

const FORMAT_NAMES: Record<ExportFormat, string> = { pdf: 'PDF', midi: 'MIDI' }

export interface CommandHost {
  compiler: CompileService
  reporter: CompileReporter
  previews: PreviewManager
  /** The one way to compile for the preview and the Problems panel (ARCHITECTURE §4). */
  compileRoot(rootFile: string): Promise<CompileResult | undefined>
  /** Tells the previews where the cursor of `editor` is. */
  followCursor(editor: vscode.TextEditor | undefined): void
}

export function runToolbarCommand(command: ToolbarCommand, preview: PreviewPanel): void {
  void vscode.commands.executeCommand(TOOLBAR[command], vscode.Uri.file(preview.rootFile))
}

export function setPreviewOpen(open: boolean): void {
  void vscode.commands.executeCommand('setContext', PREVIEW_OPEN_CONTEXT, open)
}

export function registerCommands(host: CommandHost): vscode.Disposable {
  const { compiler, reporter, previews } = host

  const activeFile = (): string | undefined => {
    const document = vscode.window.activeTextEditor?.document
    return document?.uri.scheme === 'file' ? document.uri.fsPath : undefined
  }

  /**
   * The document a command is about, or undefined once the user has been told
   * why not: the argument (explorer and toolbar pass one), else the focused
   * preview's root, else the active editor. A preview's title bar passes the
   * webview's own `webview-panel:` URI, which names no file.
   */
  const compilable = async (uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
    const file = uri instanceof vscode.Uri && uri.scheme !== 'webview-panel' ? uri : undefined
    const target = file ?? (previews.active && vscode.Uri.file(previews.active.rootFile))
    const document = target
      ? await vscode.workspace.openTextDocument(target)
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

  /** Resolves with undefined when the save was refused or lilypond could not run. */
  const compileDocument = async (
    document: vscode.TextDocument,
  ): Promise<CompileResult | undefined> => {
    if (document.isDirty && !(await document.save())) return undefined
    return host.compileRoot(document.uri.fsPath)
  }

  const compile = async (uri?: vscode.Uri): Promise<CompileResult | undefined> => {
    const document = await compilable(uri)
    return document && compileDocument(document)
  }

  const openPreview = async (uri?: vscode.Uri): Promise<void> => {
    const document = await compilable(uri)
    if (!document) return
    const { preview, created } = previews.open(document.uri.fsPath)
    // A new panel learns where the cursor is now, not at the next keypress.
    host.followCursor(vscode.window.activeTextEditor)
    // Revealing a preview that already shows the score costs no compile.
    if (created || !preview.hasPages) await compileDocument(document)
  }

  /** The preview a zoom, page or refresh command acts on; the user is told when there is none. */
  const targetPreview = (): PreviewPanel | undefined => {
    const preview = previews.target(activeFile())
    if (!preview) {
      void vscode.window.showInformationMessage(
        previews.roots().length === 0
          ? 'No LilyPond preview is open.'
          : 'Several previews are open. Focus the one you mean.',
      )
    }
    return preview
  }

  /** Recompiles a preview's root, also from an editor that shows one of its includes. */
  const refreshPreview = async (uri?: vscode.Uri): Promise<CompileResult | undefined> => {
    const preview = (uri instanceof vscode.Uri && previews.get(uri.fsPath)) || targetPreview()
    return preview && compile(vscode.Uri.file(preview.rootFile))
  }

  /**
   * A second, explicit run whose files land next to the source (D5). It is
   * reported like a compile but never shown in the preview: it has no pages.
   */
  const exportScore = async (
    format: ExportFormat,
    uri?: vscode.Uri,
  ): Promise<ExportResult | undefined> => {
    const document = await compilable(uri)
    if (!document || (document.isDirty && !(await document.save()))) return undefined
    const rootFile = document.uri.fsPath
    const name = path.basename(rootFile)

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${name} to ${FORMAT_NAMES[format]}…`,
        cancellable: true,
      },
      (_progress, token) => {
        token.onCancellationRequested(() => compiler.cancelExport(rootFile, format))
        return reporter.run(rootFile, () =>
          compiler.export({ rootFile, format, ...getCompileSettings(document.uri) }),
        )
      },
    )
    // Not awaited: the message stays up until the user dismisses it.
    if (result && !result.cancelled) void announceExport(result, format, name)
    return result
  }

  const announceExport = async (
    result: ExportResult,
    format: ExportFormat,
    name: string,
  ): Promise<void> => {
    const [first] = result.exported
    if (!first) {
      const choice = await (format === 'midi' && result.ok
        ? vscode.window.showWarningMessage(
            `${name} wrote no MIDI file. Add a \\midi { } block to its \\score.`,
          )
        : vscode.window.showErrorMessage(
            `${name} could not be exported to ${FORMAT_NAMES[format]}. See the Problems panel.`,
            'Show Output',
          ))
      if (choice) reporter.showOutput()
      return
    }
    const names = result.exported.map((file) => path.basename(file)).join(', ')
    const choice = result.ok
      ? await vscode.window.showInformationMessage(`Exported ${names}.`, 'Open', 'Reveal')
      : await vscode.window.showWarningMessage(
          `Exported ${names}, but LilyPond reported errors.`,
          'Open',
          'Reveal',
        )
    // A PDF or MIDI file belongs to the system's viewer or player, not to an editor tab.
    if (choice === 'Open') await vscode.env.openExternal(vscode.Uri.file(first))
    if (choice === 'Reveal') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(first))
    }
  }

  const commands: Record<string, (...args: never[]) => unknown> = {
    'lily.compile': compile,
    'lily.showOutput': () => reporter.showOutput(),
    'lily.preview.openToSide': openPreview,
    'lily.preview.refresh': refreshPreview,
    'lily.preview.zoomIn': () => targetPreview()?.zoom('in'),
    'lily.preview.zoomOut': () => targetPreview()?.zoom('out'),
    'lily.preview.zoomFit': () => targetPreview()?.zoom('fit'),
    'lily.preview.nextPage': () => targetPreview()?.page('next'),
    'lily.preview.previousPage': () => targetPreview()?.page('previous'),
    'lily.export.pdf': (uri?: vscode.Uri) => exportScore('pdf', uri),
    'lily.export.midi': (uri?: vscode.Uri) => exportScore('midi', uri),
  }
  return vscode.Disposable.from(
    ...Object.entries(commands).map(([id, run]) => vscode.commands.registerCommand(id, run)),
  )
}
