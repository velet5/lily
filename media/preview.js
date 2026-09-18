// Preview webview script (DECISIONS D17). Plain JS, no build step (D12); the
// message types are HostMessage / WebviewMessage in src/preview/panel.ts.
//
// The first half is pure and is also loaded by test/preview/panel.test.ts, which
// is why the file ends with a CommonJS export that a webview never reaches.
;(function () {
  'use strict'

  // ---- zoom: 1 means "fit the pane's width" ---------------------------------

  const MIN_ZOOM = 0.25
  const MAX_ZOOM = 4
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

  function clampZoom(zoom) {
    return Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) : 1
  }

  /** The next step above (`direction > 0`) or below the current zoom. */
  function stepZoom(zoom, direction) {
    const next =
      direction > 0
        ? ZOOM_STEPS.find((step) => step > zoom * 1.001)
        : [...ZOOM_STEPS].reverse().find((step) => step < zoom * 0.999)
    return next ?? clampZoom(zoom)
  }

  function zoomLabel(zoom) {
    return Math.abs(zoom - 1) < 0.005 ? 'Fit' : `${Math.round(zoom * 100)}%`
  }

  // ---- scroll anchor ----------------------------------------------------------

  /**
   * A position as "page index + fraction of that page's height", which survives
   * a refresh and a zoom change; pixels do not. `pages` are `{ top, height }` in
   * document coordinates, `y` likewise.
   */
  function captureAnchor(pages, y) {
    if (pages.length === 0) return null
    let page = 0
    for (let i = 0; i < pages.length; i++) if (pages[i].top <= y) page = i
    const { top, height } = pages[page]
    return { page, offset: height > 0 ? (y - top) / height : 0 }
  }

  /** The document y of `anchor` in the current layout. */
  function resolveAnchor(anchor, pages) {
    if (!anchor || pages.length === 0) return 0
    const page = Math.min(Math.max(anchor.page, 0), pages.length - 1)
    // The score got shorter: the end of the last page is the closest place.
    const offset = page === anchor.page ? anchor.offset : 1
    return pages[page].top + offset * pages[page].height
  }

  // ---- SVG allow-list ---------------------------------------------------------

  // The CSP already stops scripts and inline styles. This keeps everything else a
  // .ly file could smuggle in (foreignObject, SMIL, external references) out of
  // the DOM as well.
  const ELEMENTS = new Set([
    'svg', 'g', 'a', 'defs', 'symbol', 'use', 'title', 'desc',
    'path', 'rect', 'line', 'circle', 'ellipse', 'polygon', 'polyline',
    'text', 'tspan', 'image', 'clipPath', 'mask', 'marker', 'pattern',
    'linearGradient', 'radialGradient', 'stop',
  ])
  const LINK = /^(textedit|https?|mailto):/i
  const BITMAP = /^data:image\/(png|jpeg|gif|webp);/i

  function allowedElement(name) {
    return ELEMENTS.has(name)
  }

  /** `name` is the local name, so `xlink:href` arrives as `href`. */
  function allowedAttribute(element, name, value) {
    const lower = name.toLowerCase()
    if (lower.startsWith('on') || lower === 'style') return false
    if (lower !== 'href') return true
    const target = value.trim()
    if (element === 'a') return LINK.test(target)
    if (element === 'image') return BITMAP.test(target)
    return target.startsWith('#')
  }

  const pure = {
    MIN_ZOOM, MAX_ZOOM, clampZoom, stepZoom, zoomLabel,
    captureAnchor, resolveAnchor, allowedElement, allowedAttribute,
  }

  if (typeof acquireVsCodeApi !== 'function') {
    if (typeof module === 'object') module.exports = pure
    return
  }

  // ---- webview ----------------------------------------------------------------

  const PADDING = 16 // #pages padding in preview.css

  const vscode = acquireVsCodeApi()
  const pagesEl = document.getElementById('pages')
  const emptyEl = document.getElementById('empty')
  const noteEl = document.getElementById('note')
  const progressEl = document.getElementById('progress')
  const fitButton = document.getElementById('zoom-fit')

  // Survives the webview being destroyed while its tab is hidden.
  const state = { zoom: 1, anchor: null, x: 0.5, ...vscode.getState() }
  state.zoom = clampZoom(state.zoom)
  let revision = 0
  let status = { busy: false, note: undefined }

  function pageRects() {
    return Array.from(pagesEl.children, (page) => {
      const rect = page.getBoundingClientRect()
      return { top: rect.top + window.scrollY, height: rect.height }
    })
  }

  /** The anchor under viewport row `viewportY`, and the horizontal centre. */
  function capture(viewportY) {
    const { scrollWidth, clientWidth } = document.documentElement
    return {
      anchor: captureAnchor(pageRects(), window.scrollY + viewportY),
      x: scrollWidth > 0 ? (window.scrollX + clientWidth / 2) / scrollWidth : 0.5,
    }
  }

  function restore(position, viewportY) {
    const { scrollWidth, clientWidth } = document.documentElement
    window.scrollTo(
      position.x * scrollWidth - clientWidth / 2,
      resolveAnchor(position.anchor, pageRects()) - viewportY,
    )
  }

  function layout() {
    const available = Math.max(document.documentElement.clientWidth - 2 * PADDING, 50)
    pagesEl.style.setProperty('--page-width', `${Math.round(available * state.zoom)}px`)
    fitButton.textContent = zoomLabel(state.zoom)
  }

  function remember() {
    // An empty document has no place to remember; keep the one to return to.
    if (pagesEl.children.length === 0) return
    Object.assign(state, capture(0))
    vscode.setState(state)
  }

  /** Re-lays out while the point at `viewportY` stays where it is. */
  function relayout(viewportY, change) {
    const position = capture(viewportY)
    change()
    layout()
    restore(position, viewportY)
    remember()
  }

  function setZoom(zoom, viewportY = window.innerHeight / 2) {
    relayout(viewportY, () => (state.zoom = clampZoom(zoom)))
  }

  function sanitize(element) {
    for (const child of [...element.children]) {
      if (allowedElement(child.localName)) sanitize(child)
      else child.remove()
    }
    for (const attribute of [...element.attributes]) {
      if (!allowedAttribute(element.localName, attribute.localName, attribute.value)) {
        element.removeAttributeNode(attribute)
      }
    }
  }

  /**
   * LilyPond puts `style="color:inherit;"` on every link. The CSP blocks each one
   * while parsing and logs a violation per notehead, so they go before parsing.
   * Text content cannot match: a literal `<` is always escaped there. Whatever
   * this misses is still blocked, and removed by sanitize().
   */
  function quiet(text) {
    return text
      .replace(/<style\b[\s\S]*?<\/style>/g, '')
      .replace(/(<[A-Za-z][^<>]*?)\sstyle="[^"]*"/g, '$1')
  }

  function toPage(text, index) {
    const page = document.createElement('div')
    page.className = 'page'
    page.dataset.page = String(index + 1)
    const svg = new DOMParser().parseFromString(quiet(text), 'image/svg+xml').documentElement
    if (svg.localName !== 'svg' || svg.querySelector('parsererror')) {
      page.classList.add('page-error')
      page.textContent = `Page ${index + 1} could not be displayed.`
      return page
    }
    sanitize(svg)
    if (svg.hasAttribute('viewBox')) {
      // Sized by .page; the viewBox keeps the aspect ratio.
      svg.removeAttribute('width')
      svg.removeAttribute('height')
    }
    page.append(document.importNode(svg, true))
    return page
  }

  function render(message) {
    if (message.revision !== revision) {
      // Nothing on screen yet: this is a reload, so go back to the saved place.
      const position = pagesEl.children.length > 0 ? capture(0) : state
      pagesEl.replaceChildren(...message.pages.map(toPage))
      revision = message.revision
      layout()
      restore(position, 0)
      remember()
      showStatus()
    }
    vscode.postMessage({ type: 'rendered', revision, pages: pagesEl.children.length })
  }

  function showStatus() {
    progressEl.hidden = !status.busy
    const hasPages = pagesEl.children.length > 0
    noteEl.hidden = !hasPages || !status.note
    noteEl.textContent = status.note ?? ''
    emptyEl.textContent = hasPages ? '' : status.busy ? 'Compiling…' : (status.note ?? '')
  }

  window.addEventListener('message', ({ data }) => {
    switch (data.type) {
      case 'render':
        render(data)
        break
      case 'status':
        status = data
        showStatus()
        break
      case 'colors':
        document.body.dataset.colors = data.colors
        break
      case 'zoom':
        setZoom(data.action === 'fit' ? 1 : stepZoom(state.zoom, data.action === 'in' ? 1 : -1))
        break
    }
  })

  document.getElementById('zoom-in').addEventListener('click', () => setZoom(stepZoom(state.zoom, 1)))
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(stepZoom(state.zoom, -1)))
  fitButton.addEventListener('click', () => setZoom(1))

  window.addEventListener('keydown', (event) => {
    if (event.altKey) return
    if (event.key === '+' || event.key === '=') setZoom(stepZoom(state.zoom, 1))
    else if (event.key === '-') setZoom(stepZoom(state.zoom, -1))
    else if (event.key === '0') setZoom(1)
    else return
    event.preventDefault()
  })

  // Ctrl/Cmd + wheel, which is also how a trackpad pinch arrives.
  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setZoom(state.zoom * Math.exp(-event.deltaY * 0.0025), event.clientY)
    },
    { passive: false },
  )

  window.addEventListener('resize', () => relayout(0, () => {}))

  let saving = false
  window.addEventListener('scroll', () => {
    if (saving) return
    saving = true
    setTimeout(() => {
      saving = false
      remember()
    }, 100)
  })

  // Links must not navigate the webview. VS Code's own click handler still hands
  // http(s) and mailto links (\with-url) to its opener and ignores every other
  // scheme, so a textedit: link does nothing until step 8 makes it a reveal request.
  pagesEl.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) event.preventDefault()
  })

  layout()
  showStatus()
  vscode.postMessage({ type: 'ready' })
})()
