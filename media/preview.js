// Preview webview script (DECISIONS D17). Plain JS, no build step (D12); the
// message types are HostMessage / WebviewMessage in src/preview/panel.ts.
// media/midi.js is loaded before it and plays the score (D24).
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

  // ---- pages ------------------------------------------------------------------

  /** How far below a page's top still counts as being at its top. */
  const PAGE_SLACK = 8

  /** Index of the page at document row `y`; the last page once scrolled to the end. */
  function pageAt(pages, y, atEnd) {
    if (pages.length === 0) return -1
    return atEnd ? pages.length - 1 : captureAnchor(pages, y).page
  }

  /** Where a step from row `y` goes. Part-way down a page, "previous" is that page's top. */
  function stepPage(pages, y, direction) {
    if (pages.length === 0) return -1
    const { page } = captureAnchor(pages, y)
    if (direction > 0) return Math.min(page + 1, pages.length - 1)
    return y - pages[page].top > PAGE_SLACK ? page : Math.max(page - 1, 0)
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

  // ---- point-and-click ---------------------------------------------------------

  /** A link back into the source (DECISIONS D19); the host parses it. */
  function isSourceLink(href) {
    return /^textedit:/i.test(href.trim())
  }

  const REVEAL_MARGIN = 24

  /**
   * How far to scroll along one axis so that `[start, start + size)`, in viewport
   * coordinates, ends up centred; 0 when it can be seen as it is.
   */
  function scrollToShow(start, size, viewport) {
    if (start >= REVEAL_MARGIN && start + size <= viewport - REVEAL_MARGIN) return 0
    return Math.round(start + size / 2 - viewport / 2)
  }

  const pure = {
    MIN_ZOOM, MAX_ZOOM, clampZoom, stepZoom, zoomLabel,
    captureAnchor, resolveAnchor, pageAt, stepPage, allowedElement, allowedAttribute,
    isSourceLink, scrollToShow,
  }

  if (typeof acquireVsCodeApi !== 'function') {
    if (typeof module === 'object') module.exports = pure
    return
  }

  // ---- webview ----------------------------------------------------------------

  const PADDING = 16 // #pages padding in preview.css
  const TOOLBAR = 32 // #toolbar height in preview.css

  const vscode = acquireVsCodeApi()
  const pagesEl = document.getElementById('pages')
  const emptyEl = document.getElementById('empty')
  const noteEl = document.getElementById('note')
  const progressEl = document.getElementById('progress')
  const fitButton = document.getElementById('zoom-fit')
  const pagerEl = document.getElementById('pager')
  const pageLabel = document.getElementById('page-label')
  const previousButton = document.getElementById('page-previous')
  const nextButton = document.getElementById('page-next')
  const playButton = document.getElementById('midi-play')
  const stopButton = document.getElementById('midi-stop')
  const seekEl = document.getElementById('midi-seek')
  const timeEl = document.getElementById('midi-time')

  // Survives the webview being destroyed while its tab is hidden.
  const state = { zoom: 1, anchor: null, x: 0.5, ...vscode.getState() }
  state.zoom = clampZoom(state.zoom)
  let revision = 0
  let status = { busy: false, note: undefined }
  /** href → the `<a>` elements of the pages on screen that carry it. */
  let sourceLinks = new Map()
  const pageLinks = new WeakMap()
  let pageHashes = []
  let current = []
  let reported = ''

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

  /** The document row just under the toolbar, where a page turned to has its top. */
  function pageRow() {
    return window.scrollY + TOOLBAR + PADDING + 1
  }

  /** Updates the pager and tells the host what the toolbar shows now. */
  function showPage() {
    const rects = pageRects()
    const { scrollHeight, clientHeight } = document.documentElement
    const atEnd = window.scrollY + clientHeight >= scrollHeight - 1
    const page = pageAt(rects, pageRow(), atEnd) + 1
    pagerEl.hidden = rects.length < 2
    pageLabel.textContent = `${page} / ${rects.length}`
    previousButton.disabled = page <= 1
    nextButton.disabled = page >= rects.length
    const view = { type: 'view', page, pages: rects.length, zoom: state.zoom }
    if (JSON.stringify(view) === reported) return
    reported = JSON.stringify(view)
    vscode.postMessage(view)
  }

  function turnPage(direction) {
    const rects = pageRects()
    const page = stepPage(rects, pageRow(), direction)
    if (page < 0) return
    window.scrollTo(window.scrollX, rects[page].top - TOOLBAR - PADDING)
    showPage()
    remember()
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
    showPage()
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

  /** `href` or `xlink:href`, whichever the page uses. */
  function linkHref(link) {
    return link.href?.baseVal ?? ''
  }

  function indexLinks() {
    sourceLinks = new Map()
    for (const link of current) link.classList.remove('current')
    current = []
    for (const page of pagesEl.children) {
      let entries = pageLinks.get(page)
      if (!entries) {
        entries = []
        for (const link of page.querySelectorAll('a')) {
          const href = linkHref(link)
          if (!isSourceLink(href)) continue
          link.classList.add('source')
          entries.push([href, link])
        }
        pageLinks.set(page, entries)
      }
      for (const [href, link] of entries) {
        if (sourceLinks.has(href)) sourceLinks.get(href).push(link)
        else sourceLinks.set(href, [link])
      }
    }
  }

  /** Marks the elements the editor's cursor points at; the host re-sends after a render. */
  function highlight(message) {
    for (const link of current) link.classList.remove('current')
    current = message.hrefs.flatMap((href) => sourceLinks.get(href) ?? [])
    for (const link of current) link.classList.add('current')
    if (message.reveal && current.length > 0) {
      const rect = current[0].getBoundingClientRect()
      const { clientWidth, clientHeight } = document.documentElement
      const dx = scrollToShow(rect.left, rect.width, clientWidth)
      // The toolbar covers the top of the pane.
      const dy = scrollToShow(rect.top - TOOLBAR, rect.height, clientHeight - TOOLBAR)
      if (dx !== 0 || dy !== 0) window.scrollBy(dx, dy)
    }
    vscode.postMessage({ type: 'highlighted', elements: current.length })
  }

  function render(message) {
    if (message.revision < revision) return
    const started = performance.now()
    let reusedPages = 0
    if (message.revision !== revision) {
      // Nothing on screen yet: this is a reload, so go back to the saved place.
      const position = pagesEl.children.length > 0 ? capture(0) : state
      const previous = [...pagesEl.children]
      const next = message.pages.map((text, index) => {
        if (previous[index] && pageHashes[index] === message.hashes[index]) {
          reusedPages++
          return previous[index]
        }
        return toPage(text, index)
      })
      // Keep unchanged nodes in place; only changed/additional pages are parsed
      // and sanitized. Pagination removals cannot leave stale DOM or indexes.
      next.forEach((page, index) => {
        const old = pagesEl.children[index]
        if (old !== page) {
          if (old) old.replaceWith(page)
          else pagesEl.append(page)
        }
      })
      while (pagesEl.children.length > next.length) pagesEl.lastElementChild.remove()
      pageHashes = message.hashes
      indexLinks()
      revision = message.revision
      layout()
      restore(position, 0)
      remember()
      showStatus()
      showPage()
    }
    const renderedRevision = revision
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (renderedRevision === revision) vscode.postMessage({ type: 'rendered', revision,
        pages: pagesEl.children.length, reusedPages, renderMs: performance.now() - started })
    }))
  }

  function showStatus() {
    progressEl.hidden = !status.busy
    const hasPages = pagesEl.children.length > 0
    const note = blocked ? CLICK_TO_PLAY : status.note
    noteEl.hidden = !hasPages || !note
    noteEl.textContent = note ?? ''
    emptyEl.textContent = hasPages ? '' : status.busy ? 'Compiling…' : (note ?? '')
  }

  // ---- playback (DECISIONS D24) -------------------------------------------------

  const { parseMidi, formatTime, Player } = LilyMidi
  const NO_MIDI = 'Add a \\midi { } block to the \\score to hear it'
  const CLICK_TO_PLAY =
    'Click \u25B6\uFE0E to play: VS Code lets a preview make sound only after a click in it.'
  const SEEK_STEPS = Number(seekEl.max)

  /** The base64 that is loaded, so that a refresh with the same music plays on. */
  let loaded = null
  let unplayable = ''
  /** The host asked for sound before the user had clicked here. */
  let blocked = false
  /** While the slider is dragged it shows where the drag is, not where the music is. */
  let seeking = false
  let reportedPlayback = ''

  const player = new Player({ onChange: showPlayback })

  function showPlayback() {
    const { state, position, duration } = player
    const playing = state === 'playing'
    const ready = player.midi !== undefined
    playButton.disabled = stopButton.disabled = seekEl.disabled = !ready
    playButton.textContent = playing ? '\u275A\u275A' : '\u25B6\uFE0E'
    playButton.title = ready ? (playing ? 'Pause (Space)' : 'Play (Space)') : unplayable || NO_MIDI
    playButton.setAttribute('aria-label', ready && playing ? 'Pause' : 'Play')
    timeEl.textContent = ready ? `${formatTime(position)} / ${formatTime(duration)}` : ''
    if (!seeking) seekEl.value = String(duration > 0 ? Math.round((position / duration) * SEEK_STEPS) : 0)

    // The host hears of states, not of every tenth of a second.
    const report = { type: 'playback', state, duration, blocked }
    if (JSON.stringify(report) === reportedPlayback) return
    reportedPlayback = JSON.stringify(report)
    vscode.postMessage({ ...report, position })
  }

  /** `gesture`: the user clicked or typed here, which is what allows sound at all. */
  async function play(gesture) {
    if (!player.midi) return
    const started = await player.play()
    const refused = !started && !gesture && player.suspended
    if (refused !== blocked) {
      blocked = refused
      showStatus()
      showPlayback()
    }
  }

  function togglePlayback(gesture) {
    if (player.state === 'playing') player.pause()
    else void play(gesture)
  }

  function loadMidi(data) {
    if (data === loaded) return
    loaded = data
    unplayable = ''
    let midi
    try {
      if (data) midi = parseMidi(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)))
    } catch (error) {
      unplayable = error instanceof Error ? error.message : String(error)
    }
    player.load(midi)
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
      case 'page':
        turnPage(data.action === 'next' ? 1 : -1)
        break
      case 'highlight':
        highlight(data)
        break
      case 'midi':
        loadMidi(data.data)
        break
      case 'playback':
        if (data.action === 'stop') player.stop()
        else if (data.action === 'play') void play(false)
        else togglePlayback(false)
        break
    }
  })

  playButton.addEventListener('click', () => togglePlayback(true))
  stopButton.addEventListener('click', () => player.stop())
  seekEl.addEventListener('input', () => {
    seeking = true
    timeEl.textContent = `${formatTime((seekEl.value / SEEK_STEPS) * player.duration)} / ${formatTime(player.duration)}`
  })
  seekEl.addEventListener('change', () => {
    seeking = false
    void player.seek((seekEl.value / SEEK_STEPS) * player.duration)
  })

  // What only the host can do; it maps the name to a command of its own (D20).
  for (const [id, command] of [
    ['refresh', 'refresh'],
    ['export-pdf', 'exportPdf'],
    ['export-midi', 'exportMidi'],
  ]) {
    document
      .getElementById(id)
      .addEventListener('click', () => vscode.postMessage({ type: 'command', command }))
  }

  previousButton.addEventListener('click', () => turnPage(-1))
  nextButton.addEventListener('click', () => turnPage(1))

  document.getElementById('zoom-in').addEventListener('click', () => setZoom(stepZoom(state.zoom, 1)))
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(stepZoom(state.zoom, -1)))
  fitButton.addEventListener('click', () => setZoom(1))

  window.addEventListener('keydown', (event) => {
    if (event.altKey) return
    if (event.key === ' ') {
      // On a button, Space presses that button.
      if (event.target instanceof HTMLButtonElement || event.repeat) return
      togglePlayback(true)
    } else if (event.key === '+' || event.key === '=') setZoom(stepZoom(state.zoom, 1))
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
      showPage()
    }, 100)
  })

  // Links must not navigate the webview. VS Code's own click handler still hands
  // http(s) and mailto links (\with-url) to its opener and ignores every other
  // scheme; a textedit: link asks the host to show that place in the source (D19).
  pagesEl.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a') : null
    if (!link) return
    event.preventDefault()
    const href = linkHref(link)
    if (isSourceLink(href)) vscode.postMessage({ type: 'reveal', href })
  })

  layout()
  showStatus()
  showPage()
  showPlayback()
  vscode.postMessage({ type: 'ready' })
})()
