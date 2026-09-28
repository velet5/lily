import * as path from 'node:path'
import * as vscode from 'vscode'
import { CompileService, type CompileResult } from './compile/compiler'
import { includeClosure, includeDirsFromArgs, rootsIncluding } from './compile/rootFile'
import { registerCommands, runToolbarCommand, setPreviewOpen } from './commands'
import { getAutoPreviewSettings, getCompileSettings, getPreviewSettings } from './config'
import { CompileReporter } from './diagnostics/publish'
import { registerIntelliSense } from './intellisense/provider'
import { MIDI_PLAYER_VIEW_TYPE, MidiPlayerProvider } from './midi/player'
import { AutoPreview } from './preview/autoPreview'
import { LiveQueue } from './preview/liveQueue'
import { PREVIEW_VIEW_TYPE, PreviewManager, type PreviewPanel } from './preview/panel'
import { canonicalFile, charToCharacter, type SourceLocation } from './preview/pointAndClick'

// Activation and listener wiring only (ARCHITECTURE §3.2); the commands are in
// commands.ts. It must never depend on the lilypond binary being present (D9).

/** What `activate` returns; the extension-host tests reach the previews through it. */
export interface LilyApi {
  previews: PreviewManager
  /** The open viewers of MIDI files (D24). */
  midiPlayers: MidiPlayerProvider
  autoPreview: AutoPreview
  /** What a click on a note does: shows `location` in an editor outside `preview`'s column. */
  revealSource(location: SourceLocation, preview?: PreviewPanel): Promise<void>
  /** What a change of the active editor does to the previews; resolves once any compile it started has. */
  followEditor(editor: vscode.TextEditor | undefined): Promise<void>
}

/** One per extension host (D3). */
let service: CompileService | undefined

export function activate(context: vscode.ExtensionContext): LilyApi {
  const compiler = (service = new CompileService({ runtimeDir: path.join(context.extensionPath, 'runtime') }))
  const reporter = new CompileReporter()
  const queue = new LiveQueue<CompileResult | undefined>()
  const media = vscode.Uri.joinPath(context.extensionUri, 'media')
  const midiScript = vscode.Uri.joinPath(media, 'midi.js')
  const previews = new PreviewManager({
    assets: {
      root: media,
      script: vscode.Uri.joinPath(media, 'preview.js'),
      midiScript,
      style: vscode.Uri.joinPath(media, 'preview.css'),
    },
    colors: () => getPreviewSettings().colors,
    // Left pane code, right pane score; the editor keeps the focus (D4).
    createPanel: (title) => {
      const panel = vscode.window.createWebviewPanel(PREVIEW_VIEW_TYPE, title, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      })
      panel.iconPath = {
        light: vscode.Uri.joinPath(media, 'icons', 'preview.svg'),
        dark: vscode.Uri.joinPath(media, 'icons', 'preview-dark.svg'),
      }
      setPreviewOpen(true)
      return panel
    },
    onDidClose: (rootFile) => {
      release(rootFile)
      setPreviewOpen(previews.roots().length > 0)
    },
    onDidRetarget: (previous) => release(previous),
    revealSource: (location, preview) => void revealSource(location, preview),
    runToolbarCommand,
  })

  /** What a root no longer previewed held: its pending refresh, queued compile and build directory. */
  const release = (rootFile: string): void => {
    autoPreview.cancel(rootFile)
    queue.cancel(rootFile)
    void compiler.release(rootFile)
  }

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

  let editorRequests = 0
  /**
   * The preview turns to the `.ly` file the editor shows (D27), unless a
   * previewed score includes it: then that score is still what is being edited.
   */
  const followEditor = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    const document = editor?.document
    if (document?.languageId !== 'lilypond' || document.uri.scheme !== 'file') return
    const file = document.uri.fsPath
    if (path.extname(file).toLowerCase() !== '.ly' || !getPreviewSettings().followEditor) return
    const request = ++editorRequests
    const roots = previews.roots()
    if (roots.length === 0) return
    // A file with a preview of its own only becomes the one that follows.
    const including = previews.get(file) ? [] : await rootsIncluding(file, roots, (rootFile) => ({
      buffers: buffers(),
      includeDirs: includeDirsFromArgs(getCompileSettings(vscode.Uri.file(rootFile)).extraArgs, path.dirname(rootFile)),
    })).catch(() => roots)
    // Another editor got the focus meanwhile.
    if (request !== editorRequests || including.length > 0) return
    if (!previews.retarget(file)) return
    followCursor(vscode.window.activeTextEditor)
    await compileRoot(file)
  }

  const buffers = () => new Map(vscode.workspace.textDocuments
    .filter(document => document.uri.scheme === 'file' && document.isDirty)
    .map(document => [document.uri.fsPath, document.getText()]))

  /** Every preview request passes through the same non-starving queue. */
  const compileRoot = (rootFile: string): Promise<CompileResult | undefined> => {
    autoPreview.compileStarted(rootFile)
    previews.get(rootFile)?.setUpdating(true)
    return queue.request(rootFile, async () => {
      autoPreview.compileStarted(rootFile)
      const captured = buffers()
      const versions = new Map(vscode.workspace.textDocuments.map(document => [document.uri.toString(), document.version]))
      const settings = getCompileSettings(vscode.Uri.file(rootFile))
      let relevant = new Set([rootFile])
      const current = () => {
        if (JSON.stringify(settings) !== JSON.stringify(getCompileSettings(vscode.Uri.file(rootFile)))) return false
        const documents = vscode.workspace.textDocuments
        for (const document of documents) {
          if (!relevant.has(document.uri.fsPath)) continue
          const version = versions.get(document.uri.toString())
          if (version === undefined ? document.isDirty : version !== document.version) return false
        }
        // A captured dirty include that was closed/reverted no longer represents
        // the file on disk, even though there is no open document to compare.
        return [...captured.keys()].every(file =>
          !relevant.has(file) || documents.some(document => document.uri.fsPath === file))
      }
      const run = reporter.run(rootFile, async () => {
        const [result, closure] = await Promise.all([
          compiler.compile({ rootFile, buffers: captured, ...settings }),
          includeClosure(rootFile, { buffers: captured,
            includeDirs: includeDirsFromArgs(settings.extraArgs, path.dirname(rootFile)) }),
        ])
        relevant = closure
        relevant.add(rootFile)
        for (const document of vscode.workspace.textDocuments) {
          if (document.uri.scheme === 'file' && relevant.has(await canonicalFile(document.uri.fsPath))) {
            relevant.add(document.uri.fsPath)
          }
        }
        return result
      }, current)
      await previews.get(rootFile)?.follow(run)
      previews.get(rootFile)?.setUpdating(!current())
      return run
    })
  }

  // Edits/saves in the root or its dependencies refresh that preview (D25).
  const autoPreview = new AutoPreview({
    settings: getAutoPreviewSettings,
    previewedRoots: () => previews.roots(),
    rootsIncluding: (file, roots) =>
      rootsIncluding(file, roots, (rootFile) => ({
        buffers: buffers(), conservative: true,
        includeDirs: includeDirsFromArgs(
          getCompileSettings(vscode.Uri.file(rootFile)).extraArgs,
          path.dirname(rootFile),
        ),
      })),
    // Capture buffers when the queued request starts; never save editors.
    compile: compileRoot,
    pendingChanged: (root, pending) => previews.get(root)?.setUpdating(pending),
  })

  // Exported MIDI files open in a player of their own (D24).
  const midiPlayers = new MidiPlayerProvider({
    assets: {
      root: media,
      script: vscode.Uri.joinPath(media, 'player.js'),
      midiScript,
      style: vscode.Uri.joinPath(media, 'player.css'),
    },
    readFile: (uri) => vscode.workspace.fs.readFile(uri),
    watch: (uri, listener) => {
      const folder = vscode.Uri.joinPath(uri, '..')
      const name = uri.path.slice(uri.path.lastIndexOf('/') + 1)
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, name),
      )
      watcher.onDidChange(listener)
      watcher.onDidCreate(listener)
      return watcher
    },
  })

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MIDI_PLAYER_VIEW_TYPE, midiPlayers),
    reporter,
    previews,
    autoPreview,
    registerCommands({ compiler, reporter, previews, compileRoot, followCursor }),
    registerIntelliSense(context.extensionPath),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === 'file' && event.contentChanges.length > 0) {
        reporter.invalidate(event.document.uri)
        void autoPreview.documentChanged(event.document.uri.fsPath)
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === 'file') void autoPreview.documentSaved(document.uri.fsPath)
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme === 'file') void autoPreview.documentSaved(document.uri.fsPath)
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => followCursor(event.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      followCursor(editor)
      void followEditor(editor)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (['lily.lilypond.path', 'lily.compile.extraArgs', 'lily.preview.acceleration'].some(key => event.affectsConfiguration(key))) {
        for (const root of previews.roots()) void compileRoot(root)
      }
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
  return { previews, midiPlayers, autoPreview, revealSource, followEditor }
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
