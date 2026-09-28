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
  /**
   * After an edit, a save or a reload of `file`: its unsaved text, or
   * undefined when it matches what is on disk. Live preview compiles it (D36).
   */
  onText?(file: string, unsaved: string | undefined): void
  /** The last compile's diagnostics in `file`; marked when it opens. */
  diagnostics(file: string): LyDiagnostic[]
  /** After the selection or the cursor moved, or another file was shown. */
  onSelection?(): void
}

/** An item of the editor's context menu, shown only while text is selected (D41). */
export interface SelectionAction {
  id: string
  label: string
  /** Where it goes among the others: lower first. */
  order: number
  /** ⌘⌥ and this letter, when it has a shortcut. */
  key?: 'I'
  run(): void
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
      // The context menu in the page itself, where app.css styles it; in a
      // shadow root it had no background.
      useShadowDOM: false,
    })
    dark.addEventListener('change', () => monaco.editor.setTheme(dark.matches ? DARK_THEME : LIGHT_THEME))
    this.editor.onDidChangeCursorSelection(() => options.onSelection?.())
    this.editor.onDidChangeModel(() => options.onSelection?.())
  }

  /** Adds `action` to the top of the context menu, where it shows while text is selected. */
  addSelectionAction(action: SelectionAction): void {
    this.editor.addAction({
      id: action.id,
      label: action.label,
      precondition: 'editorHasSelection',
      contextMenuGroupId: '0_agent',
      contextMenuOrder: action.order,
      ...(action.key ? { keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyI] } : {}),
      run: () => action.run(),
    })
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
      model.onDidChangeContent(() => {
        this.text(file)
        this.options.onChange()
      })
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

  /** The selected lines of the shown file (1-based) and the selected text; undefined when nothing is selected. */
  selection(): { startLine: number; endLine: number; text: string } | undefined {
    const model = this.editor.getModel()
    const selection = this.editor.getSelection()
    if (!model || !selection || selection.isEmpty()) return undefined
    return { startLine: selection.startLineNumber, endLine: selection.endLineNumber, text: model.getValueInRange(selection) }
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

  /**
   * Replaces `file`'s text with `text`, what is on disk now, and counts it as
   * saved (D34). One undoable edit, so Undo brings back what was there; the
   * view keeps its place.
   */
  reload(file: string, text: string): void {
    const doc = this.documents.get(file)
    if (!doc) return
    if (doc.model.getValue() !== text) {
      const view = this.current === file ? this.editor.saveViewState() : null
      doc.model.pushStackElement()
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null)
      doc.model.pushStackElement()
      if (view) this.editor.restoreViewState(view)
    }
    doc.savedVersion = doc.model.getAlternativeVersionId()
    this.text(file)
    this.options.onChange()
  }

  /** The text of `file` as the editor has it, saved or not; undefined when it is not open. */
  textOf(file: string): string | undefined {
    return this.documents.get(file)?.model.getValue()
  }

  /**
   * Applies `edits` (offsets into the text as it is now) to `file` as one
   * undoable step, and puts the cursor at `reveal`, an offset into the text after them.
   */
  applyEdits(file: string, edits: { offset: number; length: number; text: string }[], reveal: number): void {
    const doc = this.documents.get(file)
    if (!doc) return
    const { model } = doc
    const operations = edits.map((edit) => {
      const start = model.getPositionAt(edit.offset)
      const end = model.getPositionAt(edit.offset + edit.length)
      return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: edit.text }
    })
    model.pushStackElement()
    model.pushEditOperations([], operations, () => null)
    model.pushStackElement()
    if (this.current !== file) return
    const position = model.getPositionAt(reveal)
    this.editor.setPosition(position)
    this.editor.revealPositionInCenterIfOutsideViewport(position)
  }

  /** Writes `file` (the one shown by default). Rejects when the write fails. */
  async save(file = this.current): Promise<void> {
    const doc = file && this.documents.get(file)
    if (!file || !doc) return
    // Edits made while the write is under way stay unsaved.
    const version = doc.model.getAlternativeVersionId()
    await this.options.save(file, doc.model.getValue())
    doc.savedVersion = version
    this.text(file)
    this.options.onChange()
  }

  private text(file: string): void {
    const doc = this.documents.get(file)
    if (doc) this.options.onText?.(file, this.isDirty(file) ? doc.model.getValue() : undefined)
  }

  async saveAll(): Promise<void> {
    for (const file of this.dirtyFiles()) await this.save(file)
  }
}
