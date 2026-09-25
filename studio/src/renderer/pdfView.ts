// The preview pane's PDF tab (DECISIONS D33): the score compiled once more
// with --pdf, drawn by pdf.js onto one canvas per page, fitted to the pane's
// width. It compiles only while the tab is shown; Export PDF writes that PDF
// next to the score, and nothing else here writes a file.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import type { CompileEvent, PdfOutcome } from '../ipc'

// pdf.js's worker, which esbuild.mjs bundles next to this script as a classic
// one. currentScript is only set while the script first runs.
const workerUrl = new URL('pdf.worker.js', (document.currentScript as HTMLScriptElement).src).href

/**
 * What the PDF tab says about a PDF compile, as previewUpdate does for the
 * pages; `show`: draw its files. `hasPages`: the same score's PDF is on screen.
 */
function pdfUpdate(outcome: PdfOutcome, hasPages: boolean): { show: boolean; note?: string } {
  const files = outcome.files.length > 0
  switch (outcome.state) {
    case 'ok':
      return files ? { show: true } : { show: false, note: 'LilyPond produced no PDF.' }
    case 'failed':
      return files
        ? { show: true, note: 'The score has errors, so this PDF may be incomplete.' }
        : { show: false, note: hasPages ? 'The score has errors. Showing the last PDF that engraved.' : 'The score has errors. Fix them to see the PDF.' }
    case 'no-lilypond':
    case 'error':
      return { show: false, note: outcome.message ?? 'The PDF could not be engraved.' }
  }
}

/** The pages are this far from the pane's edges (layout.css). */
const PADDING = 16

export interface PdfViewOptions {
  /** The tab's scrolling body. */
  body: HTMLElement
  /** Where Export PDF goes, in the pane's header. */
  actions: HTMLElement
  compilePdf(rootFile: string): Promise<PdfOutcome | undefined>
  exportPdf(rootFile: string): Promise<string[]>
  /** Tells the status line how an export went. */
  onExported(files: string[]): void
  onError(error: unknown): void
}

export class PdfView {
  private readonly pages = document.createElement('div')
  private readonly empty = document.createElement('div')
  private readonly note = document.createElement('div')
  private readonly exportButton = document.createElement('button')
  /** The score the preview shows; its PDF is the one to draw. */
  private rootFile: string | undefined
  /** Whether the PDF on screen is older than the last compile of `rootFile`. */
  private stale = false
  private visible = false
  /** Counts loads; an answer to an older one is dropped. */
  private load = 0
  private documents: PDFDocumentProxy[] = []
  /** The width the pages were drawn for; a resize redraws them. */
  private drawnWidth = 0
  private resizeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: PdfViewOptions) {
    const { body, actions } = options
    this.pages.className = 'pdf-pages'
    this.empty.className = 'preview-empty placeholder'
    this.empty.textContent = 'Save a score to see its PDF here.'
    this.note.className = 'preview-note'
    this.note.hidden = true
    body.replaceChildren(this.empty, this.pages)
    body.parentElement!.append(this.note)

    this.exportButton.type = 'button'
    this.exportButton.textContent = 'Export PDF'
    this.exportButton.title = 'Save the PDF next to the score'
    this.exportButton.disabled = true
    this.exportButton.addEventListener('click', () => void this.export())
    actions.append(this.exportButton)

    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => {
        if (this.visible && Math.abs(this.width() - this.drawnWidth) > 1) void this.draw(this.load)
      }, 150)
    }).observe(body)
  }

  /** The preview's score compiled: its PDF is out of date, and redone if shown. */
  compiled(event: CompileEvent): void {
    if (event.kind !== 'finished') return
    const { state, rootFile } = event.outcome
    // Nothing ran, or lilypond cannot run: the PDF would say no more.
    if (state === 'no-root' || state === 'no-lilypond' || state === 'error') return
    this.rootFile = rootFile
    this.stale = true
    this.exportButton.disabled = false
    if (this.visible) void this.refresh()
  }

  /** The tab was shown or hidden; showing it compiles a PDF that is out of date. */
  show(visible: boolean): void {
    this.visible = visible
    if (visible && this.stale) void this.refresh()
  }

  private async refresh(): Promise<void> {
    const rootFile = this.rootFile
    if (!rootFile) return
    const load = ++this.load
    this.stale = false
    this.setNote(this.documents.length > 0 ? 'Engraving the PDF…' : undefined, 'Engraving the PDF…')
    let outcome: PdfOutcome | undefined
    try {
      outcome = await this.options.compilePdf(rootFile)
    } catch (error) {
      if (load === this.load) this.setNote(undefined, 'The PDF could not be engraved.')
      this.options.onError(error)
      return
    }
    // A newer compile asks again, or already has.
    if (!outcome || load !== this.load) return
    const same = this.pages.dataset.root === rootFile
    const update = pdfUpdate(outcome, same && this.documents.length > 0)
    if (update.show) {
      await this.open(outcome, load)
      if (load !== this.load) return
    } else if (outcome.state !== 'failed' || !same) {
      this.close()
    } else if (this.documents.length > 0 && this.pages.children.length === 0) {
      // A load this one took over had cleared the pages before drawing them.
      await this.draw(load)
      if (load !== this.load) return
    }
    this.setNote(update.note, update.note)
  }

  private async open(outcome: PdfOutcome, load: number): Promise<void> {
    GlobalWorkerOptions.workerPort ??= new Worker(workerUrl)
    const documents = await Promise.all(
      // pdf.js hands the bytes to its worker; the outcome's are not used again.
      // LilyPond's PDFs need none of its WebAssembly decoders (JPEG 2000, ICC).
      outcome.files.map((file) => getDocument({ data: file.data, useWasm: false }).promise),
    )
    if (load !== this.load) {
      for (const pdf of documents) void pdf.destroy()
      return
    }
    const same = this.pages.dataset.root === outcome.rootFile
    const top = this.options.body.scrollTop
    this.close()
    this.documents = documents
    this.pages.dataset.root = outcome.rootFile
    await this.draw(load)
    // The same score keeps its place; another starts at its top.
    this.options.body.scrollTop = same ? top : 0
  }

  /** Draws every page of the open documents at the pane's width. */
  private async draw(load: number): Promise<void> {
    const width = this.width()
    const ratio = window.devicePixelRatio || 1
    const canvases: HTMLCanvasElement[] = []
    for (const pdf of this.documents) {
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number)
        if (load !== this.load) return
        const viewport = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * ratio })
        const canvas = document.createElement('canvas')
        canvas.className = 'pdf-page'
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${width}px`
        await page.render({ canvas, viewport }).promise
        if (load !== this.load) return
        canvases.push(canvas)
      }
    }
    this.pages.replaceChildren(...canvases)
    this.drawnWidth = width
  }

  private close(): void {
    for (const pdf of this.documents) void pdf.destroy()
    this.documents = []
    this.pages.replaceChildren()
    delete this.pages.dataset.root
  }

  private width(): number {
    return Math.max(this.options.body.clientWidth - 2 * PADDING, 50)
  }

  /** `note` over the pages when there are some, else `empty` in the empty pane. */
  private setNote(note: string | undefined, empty = 'Save a score to see its PDF here.'): void {
    const hasPages = this.documents.length > 0
    this.empty.hidden = hasPages
    this.empty.textContent = hasPages ? '' : empty
    this.note.hidden = !hasPages || !note
    this.note.textContent = note ?? ''
  }

  private async export(): Promise<void> {
    if (!this.rootFile) return
    this.exportButton.disabled = true
    try {
      this.options.onExported(await this.options.exportPdf(this.rootFile))
    } catch (error) {
      this.options.onError(error)
    } finally {
      this.exportButton.disabled = false
    }
  }
}
