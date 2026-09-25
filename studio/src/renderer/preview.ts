// The preview pane (DECISIONS D32): the SVG pages of the last compile, fitted
// to the pane's width and zoomable, and a click on a note that asks for its
// place in the source. Page parsing, sanitizing, zoom steps and the scroll
// anchor are media/preview.js's, the extension's webview script; the rest is
// the webview's render() cut down to one pane without a toolbar of its own.
import {
  captureAnchor,
  clampZoom,
  isSourceLink,
  quiet,
  resolveAnchor,
  sanitize,
  stepZoom,
  zoomLabel,
} from '../../../media/preview.js'
import type { CompileEvent, CompileOutcome } from '../ipc'

/** What a finished compile does to the preview. */
export interface PreviewUpdate {
  /** Show `outcome.svg` in place of the pages on screen. */
  show: boolean
  /** A line over the pages, or the text of the empty pane when there are none. */
  note?: string
}

/**
 * Pages of any run are shown, as the extension does (ARCHITECTURE §3.3); a run
 * without pages keeps the ones on screen. `hasPages`: whether pages of the same
 * score are on screen.
 */
export function previewUpdate(outcome: CompileOutcome, hasPages: boolean): PreviewUpdate {
  const pages = outcome.svg.length > 0
  switch (outcome.state) {
    case 'ok':
      return pages ? { show: true } : { show: false, note: 'LilyPond produced no pages.' }
    case 'failed':
      if (pages) return { show: true, note: 'The score has errors, so this may be incomplete.' }
      return { show: false, note: hasPages ? 'The score has errors. Showing the last version that engraved.' : 'The score has errors. Fix them to see it here.' }
    case 'no-lilypond':
    case 'error':
      return { show: false, note: hasPages ? undefined : 'The score could not be engraved.' }
    case 'no-root':
      // Nothing ran: the preview stays as it is.
      return { show: false }
  }
}

/** The page containers are this far from the pane's edges (layout.css). */
const PADDING = 16

export interface ScorePreviewOptions {
  /** The pane's scrolling body. */
  body: HTMLElement
  /** Where the zoom buttons go, in the pane's header. */
  actions: HTMLElement
  /** A click on an element that carries a `textedit:` link. */
  onReveal(href: string): void
  /** Other pages are on screen, or none (the playhead's map is out of date, D35). */
  onRender?(): void
  /** The pages changed size: zoom, or the pane was resized. */
  onLayout?(): void
}

export class ScorePreview {
  private readonly pages = document.createElement('div')
  private readonly empty = document.createElement('div')
  private readonly note = document.createElement('div')
  private readonly fitButton: HTMLButtonElement
  /** The score whose pages are on screen. */
  private rootFile: string | undefined
  private zoom = 1
  private clicked: Element | undefined
  /** The elements of the pages on screen by their `textedit:` link, in page order. */
  readonly sourceLinks = new Map<string, Element[]>()

  constructor(private readonly options: ScorePreviewOptions) {
    const { body, actions } = options
    this.pages.className = 'preview-pages'
    this.empty.className = 'preview-empty placeholder'
    this.empty.textContent = 'Save a score to see it here.'
    this.note.className = 'preview-note'
    this.note.hidden = true
    body.classList.remove('placeholder')
    body.replaceChildren(this.empty, this.pages)
    body.parentElement!.append(this.note)

    const zoomButton = (label: string, title: string, action: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.title = title
      button.addEventListener('click', action)
      return button
    }
    this.fitButton = zoomButton('Fit', 'Fit to width', () => this.setZoom(1))
    actions.append(
      zoomButton('−', 'Zoom out', () => this.setZoom(stepZoom(this.zoom, -1))),
      this.fitButton,
      zoomButton('+', 'Zoom in', () => this.setZoom(stepZoom(this.zoom, 1))),
    )

    // Links must not navigate the window; a textedit: one asks for its source.
    this.pages.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null
      if (!link) return
      event.preventDefault()
      const href = linkHref(link)
      if (!isSourceLink(href)) return
      this.clicked?.classList.remove('current')
      link.classList.add('current')
      this.clicked = link
      options.onReveal(href)
    })
    // Ctrl/Cmd + wheel, which is also how a trackpad pinch arrives.
    body.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return
        event.preventDefault()
        this.setZoom(this.zoom * Math.exp(-event.deltaY * 0.0025), event.clientY - body.getBoundingClientRect().top)
      },
      { passive: false },
    )
    new ResizeObserver(() => this.relayout(0, () => {})).observe(body)
    this.layout()
  }

  /**
   * The editor shows a file of `rootFile`, or of no score (undefined): pages
   * of another score leave at once, and a note says what comes (D39).
   */
  showScore(rootFile: string | undefined): void {
    if (rootFile !== undefined && rootFile === this.rootFile) return
    if (this.rootFile !== undefined) this.clear()
    this.showNote(rootFile === undefined ? 'This file is not part of a score. Open the .ly file that \\includes it to see the music.' : 'Engraving…')
  }

  compiled(event: CompileEvent): void {
    if (event.kind === 'started') {
      if (this.pages.children.length === 0) this.empty.textContent = 'Engraving…'
      return
    }
    const { outcome } = event
    const same = outcome.rootFile === this.rootFile
    const update = previewUpdate(outcome, same && this.pages.children.length > 0)
    if (update.show) this.render(outcome.rootFile, outcome.svg, same)
    else if (outcome.state !== 'no-root' && !same) this.clear()
    if (outcome.state === 'no-root') return
    this.showNote(update.note)
  }

  private render(rootFile: string, svg: string[], same: boolean): void {
    // Another score starts at its top; the same one keeps its place.
    const anchor = same ? captureAnchor(this.pageRects(), this.options.body.scrollTop) : null
    this.pages.replaceChildren(...svg.map(toPage))
    this.rootFile = rootFile
    this.clicked = undefined
    this.sourceLinks.clear()
    for (const link of this.pages.querySelectorAll('a')) {
      const href = linkHref(link)
      if (!isSourceLink(href)) continue
      link.classList.add('source')
      const links = this.sourceLinks.get(href)
      if (links) links.push(link)
      else this.sourceLinks.set(href, [link])
    }
    this.layout()
    this.options.body.scrollTop = resolveAnchor(anchor, this.pageRects())
    this.options.onRender?.()
  }

  private clear(): void {
    this.pages.replaceChildren()
    this.sourceLinks.clear()
    this.rootFile = undefined
    this.clicked = undefined
    this.options.onRender?.()
  }

  /** The page elements on screen, in order. */
  get pageElements(): HTMLCollection {
    return this.pages.children
  }

  private showNote(note: string | undefined): void {
    const hasPages = this.pages.children.length > 0
    this.empty.hidden = hasPages
    this.empty.textContent = hasPages ? '' : (note ?? 'Open a score to see it here.')
    this.note.hidden = !hasPages || !note
    this.note.textContent = note ?? ''
  }

  /** Page boxes in the body's scroll coordinates. */
  private pageRects(): { top: number; height: number }[] {
    const { body } = this.options
    const origin = body.getBoundingClientRect().top - body.scrollTop
    return Array.from(this.pages.children, (page) => {
      const rect = page.getBoundingClientRect()
      return { top: rect.top - origin, height: rect.height }
    })
  }

  private layout(): void {
    const available = Math.max(this.options.body.clientWidth - 2 * PADDING, 50)
    this.pages.style.setProperty('--page-width', `${Math.round(available * this.zoom)}px`)
    this.fitButton.textContent = zoomLabel(this.zoom)
  }

  /** Re-lays out while the point at `y` (from the body's top) stays where it is. */
  private relayout(y: number, change: () => void): void {
    const { body } = this.options
    const anchor = captureAnchor(this.pageRects(), body.scrollTop + y)
    const x = body.scrollWidth > 0 ? (body.scrollLeft + body.clientWidth / 2) / body.scrollWidth : 0.5
    change()
    this.layout()
    body.scrollTop = resolveAnchor(anchor, this.pageRects()) - y
    body.scrollLeft = x * body.scrollWidth - body.clientWidth / 2
    this.options.onLayout?.()
  }

  private setZoom(zoom: number, y = this.options.body.clientHeight / 2): void {
    this.relayout(y, () => (this.zoom = clampZoom(zoom)))
  }
}

/** `href` or `xlink:href`, whichever the page uses. */
function linkHref(link: Element): string {
  return (link as SVGAElement).href?.baseVal ?? ''
}

function toPage(text: string, index: number): HTMLElement {
  const page = document.createElement('div')
  page.className = 'preview-page'
  page.dataset.page = String(index + 1)
  const svg = new DOMParser().parseFromString(quiet(text), 'image/svg+xml').documentElement
  if (svg.localName !== 'svg' || svg.querySelector('parsererror')) {
    page.classList.add('preview-page-error')
    page.textContent = `Page ${index + 1} could not be displayed.`
    return page
  }
  sanitize(svg)
  if (svg.hasAttribute('viewBox')) {
    // Sized by .preview-page; the viewBox keeps the aspect ratio.
    svg.removeAttribute('width')
    svg.removeAttribute('height')
  }
  page.append(document.importNode(svg, true))
  return page
}
