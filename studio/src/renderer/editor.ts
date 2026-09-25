// The editor pane: Monaco, one model per opened file (DECISIONS D29). Edits
// survive switching files; a file is unsaved while its model's version differs
// from the version last written, so undoing back to it clears the mark.
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'

/** Step 3 attaches the TextMate grammar to this id. */
export const LANGUAGE_ID = 'lilypond'

monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.ly', '.ily', '.lyi'], aliases: ['LilyPond'] })

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
      theme: dark.matches ? 'vs-dark' : 'vs',
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      insertSpaces: true,
      renderWhitespace: 'none',
      fixedOverflowWidgets: true,
    })
    dark.addEventListener('change', () => monaco.editor.setTheme(dark.matches ? 'vs-dark' : 'vs'))
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
