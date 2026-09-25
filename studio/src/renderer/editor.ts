// The editor pane: Monaco, one model per opened file (DECISIONS D29). Edits
// survive switching files; a file is unsaved while its model's version differs
// from the version last written, so undoing back to it clears the mark.
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import type { LyDiagnostic } from '../../../src/diagnostics/parse'
import { charToCharacter, columnToCharacter } from '../../../src/diagnostics/span'
import { toMarkers } from './diagnostics'
import { DARK_THEME, LIGHT_THEME, languageConfiguration, loadGrammar, theme, tokensProvider } from './grammar'

export const LANGUAGE_ID = 'lilypond'
/** Owner of the compile's markers (D31). */
const MARKER_OWNER = 'lilypond'

monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.ly', '.ily', '.lyi'], aliases: ['LilyPond'] })
monaco.languages.setLanguageConfiguration(LANGUAGE_ID, languageConfiguration())
// Monaco waits for the grammar before it colours a LilyPond model.
monaco.languages.setTokensProvider(LANGUAGE_ID, loadGrammar().then(tokensProvider))
monaco.editor.defineTheme(LIGHT_THEME, theme(false))
monaco.editor.defineTheme(DARK_THEME, theme(true))

interface Document {
  model: monaco.editor.ITextModel
  savedVersion: number
  viewState: monaco.editor.ICodeEditorViewState | null
}

export interface ScoreEditorOptions {
  container: HTMLElement
  save(file: string, text: string): Promise<void>
  /** After an edit, a save, or a switch to another file. */
  onChange(): void
  /** The last compile's diagnostics in `file`; marked when it opens. */
  diagnostics(file: string): LyDiagnostic[]
}

export class ScoreEditor {
  private readonly editor: monaco.editor.IStandaloneCodeEditor
  private readonly documents = new Map<string, Document>()
  private current: string | undefined

  constructor(private readonly options: ScoreEditorOptions) {
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    this.editor = monaco.editor.create(options.container, {
      model: null,
      automaticLayout: true,
      theme: dark.matches ? DARK_THEME : LIGHT_THEME,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: 'none',
      fixedOverflowWidgets: true,
    })
    dark.addEventListener('change', () => monaco.editor.setTheme(dark.matches ? DARK_THEME : LIGHT_THEME))
  }

  get file(): string | undefined {
    return this.current
  }

  isOpen(file: string): boolean {
    return this.documents.has(file)
  }

  isDirty(file: string): boolean {
    const doc = this.documents.get(file)
    return !!doc && doc.model.getAlternativeVersionId() !== doc.savedVersion
  }

  dirtyFiles(): string[] {
    return [...this.documents.keys()].filter((file) => this.isDirty(file))
  }

  /** Shows `file`; `text` is its content on disk, needed only the first time. */
  show(file: string, text?: string): void {
    let doc = this.documents.get(file)
    if (!doc) {
      if (text === undefined) throw new Error(`${file} is not open.`)
      const model = monaco.editor.createModel(text, LANGUAGE_ID, monaco.Uri.file(file))
      doc = { model, savedVersion: model.getAlternativeVersionId(), viewState: null }
      model.onDidChangeContent(() => this.options.onChange())
      this.documents.set(file, doc)
      this.mark(file)
    }
    if (this.current === file) return
    const previous = this.current && this.documents.get(this.current)
    if (previous) previous.viewState = this.editor.saveViewState()
    this.current = file
    this.editor.setModel(doc.model)
    if (doc.viewState) this.editor.restoreViewState(doc.viewState)
    this.editor.focus()
    this.options.onChange()
  }

  /**
   * Marks the last compile's diagnostics in `file`, if it is open. Monaco moves
   * the marks along with later edits until the next compile replaces them.
   */
  mark(file: string): void {
    const model = this.documents.get(file)?.model
    if (!model) return
    const markers = toMarkers(this.options.diagnostics(file), (line) => model.getLineContent(line), model.getLineCount())
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      markers.map((marker) => ({
        ...marker,
        severity: marker.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        source: 'LilyPond',
      })),
    )
  }

  /** Puts the cursor of the shown file where a diagnostic points (1-based, lilypond's column). */
  reveal(line: number, column?: number): void {
    this.place(line, (text) => (column === undefined ? 0 : columnToCharacter(text, column)))
  }

  /** Puts the cursor of the shown file where a point-and-click link points (1-based line, `CHAR`). */
  revealSource(line: number, char: number): void {
    this.place(line, (text) => charToCharacter(text, char))
  }

  private place(line: number, character: (lineText: string) => number): void {
    const model = this.editor.getModel()
    if (!model) return
    const lineNumber = Math.min(line, model.getLineCount())
    const position = { lineNumber, column: character(model.getLineContent(lineNumber)) + 1 }
    this.editor.setPosition(position)
    this.editor.revealPositionInCenterIfOutsideViewport(position)
    this.editor.focus()
  }

  /** Writes `file` (the one shown by default). Rejects when the write fails. */
  async save(file = this.current): Promise<void> {
    const doc = file && this.documents.get(file)
    if (!file || !doc) return
    // Edits made while the write is under way stay unsaved.
    const version = doc.model.getAlternativeVersionId()
    await this.options.save(file, doc.model.getValue())
    doc.savedVersion = version
    this.options.onChange()
  }

  async saveAll(): Promise<void> {
    for (const file of this.dirtyFiles()) await this.save(file)
  }
}
