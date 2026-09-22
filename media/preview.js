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

  // ---- playback position (DECISIONS D26) ----------------------------------------

  /** A moment this far left of the one before it, as a fraction of the page width, begins a new system. */
  const SYSTEM_STEP = 0.01
  /** Room above and below the notes of a system, as a fraction of the page height. */
  const SYSTEM_MARGIN = 0.012

  /**
   * Splits `moments` (`{ page, x, top, bottom }` in fractions of their page, in
   * time order) into systems: a new one begins on another page, or where the
   * music jumps back to the left. Each moment gets its `system` index; a
   * system is `{ page, top, bottom, first, last }` around all of its moments.
   */
  function systemsOf(moments) {
    const systems = []
    for (let i = 0; i < moments.length; i++) {
      const moment = moments[i]
      let system = systems[systems.length - 1]
      if (!system || system.page !== moment.page || moment.x < moments[i - 1].x - SYSTEM_STEP) {
        system = { page: moment.page, top: moment.top, bottom: moment.bottom, first: i, last: i }
        systems.push(system)
      }
      system.top = Math.min(system.top, moment.top)
      system.bottom = Math.max(system.bottom, moment.bottom)
      system.last = i
      moment.system = systems.length - 1
    }
    for (const system of systems) {
      system.top = Math.max(system.top - SYSTEM_MARGIN, 0)
      system.bottom = Math.min(system.bottom + SYSTEM_MARGIN, 1)
    }
    return systems
  }

  /** Index of the last of `items` (sorted by `time`) that begins at or before `time`; -1 before the first. */
  function lastAt(items, time) {
    let low = 0
    let high = items.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (items[middle].time <= time) low = middle + 1
      else high = middle
    }
    return low - 1
  }

  /**
   * Where the cursor is at `time`: the moment it is in, and an `x` on the way
   * to the next moment of the same system, at the pace of the music.
   */
  function cursorAt(moments, time) {
    const index = lastAt(moments, time)
    if (index < 0) return undefined
    const moment = moments[index]
    const next = moments[index + 1]
    let x = moment.x
    if (next && next.system === moment.system && next.time > moment.time) {
      x += ((next.x - moment.x) * (time - moment.time)) / (next.time - moment.time)
    }
    return { index, x }
  }

  /**
   * The bar at `time`. `bars` are `{ time, number }` in order; bars in which
   * nothing began are missing from it and are taken to be evenly spaced.
   */
  function barAt(bars, time) {
    const index = lastAt(bars, time)
    if (index < 0) return undefined
    const bar = bars[index]
    const next = bars[index + 1]
    if (!next || next.number <= bar.number + 1) return bar.number
    const length = (next.time - bar.time) / (next.number - bar.number)
    return bar.number + Math.floor((time - bar.time) / length)
  }

  /** The latest `end` among `events[0..i]`, so that soundingAt knows how far back to look. */
  function endsOf(events) {
    let latest = -Infinity
    return events.map((event) => (latest = Math.max(latest, event.end)))
  }

  /** Indexes of the `events` (sorted by `time`) that have begun by `time` and not ended. */
  function soundingAt(events, ends, time) {
    const sounding = []
    for (let i = lastAt(events, time); i >= 0 && ends[i] > time; i--) {
      if (events[i].end > time) sounding.push(i)
    }
    return sounding.reverse()
  }

  const pure = {
    MIN_ZOOM, MAX_ZOOM, clampZoom, stepZoom, zoomLabel,
    captureAnchor, resolveAnchor, pageAt, stepPage, allowedElement, allowedAttribute,
    isSourceLink, scrollToShow, systemsOf, cursorAt, barAt, endsOf, soundingAt,
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
  const barEl = document.getElementById('midi-bar')

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
    // The playhead is placed in page fractions; the page has a new size now.
    if (player.state !== 'playing') drawPlayhead()
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
      // The notes may have moved; a reused page keeps their measured boxes.
      timeline = null
      checkMap()
      if (player.state !== 'playing') showPlayback()
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

    // The playhead follows the audio clock frame by frame while playing (D26).
    if (playing) {
      if (!wasPlaying) shownSystem = -1 // wherever the user scrolled to meanwhile, show where it starts
      if (!frame) frame = requestAnimationFrame(animatePlayhead)
    } else drawPlayhead()
    wasPlaying = playing

    // The host hears of states, not of every tenth of a second.
    const report = { type: 'playback', state, duration, blocked, timed: mapped }
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

  function loadMidi(data, map) {
    const key = JSON.stringify(map ?? null)
    const remapped = key !== timingKey
    if (remapped) {
      timingKey = key
      timing = map ?? null
      timeline = null
      checkMap()
    }
    if (data === loaded) {
      if (remapped) showPlayback()
      return
    }
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

  // ---- the playhead (DECISIONS D26) ---------------------------------------------

  const { momentTime } = LilyMidi
  /** Where the notes of the loaded MIDI are, from the host; null without a map. */
  let timing = null
  let timingKey = ''
  /** `timing` resolved against the pages on screen: built when first drawn, dropped by a render. */
  let timeline = null
  /** Whether the map's notes are on the pages: what the host is told as `timed`. */
  let mapped = false
  /** Element → its box in fractions of its page, per page node; a reused page keeps them. */
  const boxes = new WeakMap()
  /** The bar drawn through the moment being played, inside the page it is on. */
  const playhead = document.createElement('div')
  playhead.className = 'playhead'
  /** The elements marked `playing`. */
  let sounding = new Set()
  /** The system scrolled into view last; another one is scrolled to when the music reaches it. */
  let shownSystem = -1
  let wasPlaying = false
  let frame = 0

  function checkMap() {
    mapped = timing !== null && timing.events.some((event) => sourceLinks.has(event.href))
  }

  function boxOf(page, index, rect, element) {
    let cache = boxes.get(page)
    if (!cache) boxes.set(page, (cache = new Map()))
    let box = cache.get(element)
    if (!box) {
      const r = element.getBoundingClientRect()
      box = {
        page: index,
        left: (r.left - rect.left) / rect.width,
        right: (r.right - rect.left) / rect.width,
        top: (r.top - rect.top) / rect.height,
        bottom: (r.bottom - rect.top) / rect.height,
      }
      cache.set(element, box)
    }
    return box
  }

  /**
   * Finds the elements of the timing map's events on the pages by their hrefs
   * (the cursor's map, indexLinks) and works out the moments, the systems
   * they lie on and the bars, all in seconds and page fractions, so that a
   * frame is a binary search and a few style properties.
   */
  function buildTimeline() {
    const { midi } = player
    if (!timing || !midi || pagesEl.children.length === 0) return null
    const pages = [...pagesEl.children]
    const rects = pages.map((page) => page.getBoundingClientRect())
    const indexes = new Map(pages.map((page, index) => [page, index]))
    const box = (element) => {
      const page = element.closest('.page')
      const index = indexes.get(page)
      return index === undefined ? undefined : boxOf(page, index, rects[index], element)
    }

    // An href used as often as it is drawn (`\repeat unfold`, a variable used
    // twice) is paired up in order: the k-th time it is played is the k-th
    // place it is drawn. Drawn once, it is that place every time (a repeat
    // unfolded in the MIDI only). Anything else is settled once the systems are known.
    const uses = new Map()
    for (const event of timing.events) uses.set(event.href, (uses.get(event.href) ?? 0) + 1)
    const seen = new Map()
    const ordered = [...timing.events].sort((a, b) => a.at - b.at || a.grace - b.grace)
    const events = []
    for (const { href, at, grace, length } of ordered) {
      const candidates = sourceLinks.get(href) ?? []
      if (candidates.length === 0) continue // a skip, or point-and-click switched off
      const rank = seen.get(href) ?? 0
      seen.set(href, rank + 1)
      const element =
        candidates.length === uses.get(href) ? candidates[rank]
        : candidates.length === 1 ? candidates[0]
        : undefined
      events.push({
        time: momentTime(midi, at, grace),
        end: grace === 0 ? momentTime(midi, at + length, 0) : momentTime(midi, at, grace + length),
        element,
        candidates,
      })
    }
    events.sort((a, b) => a.time - b.time)
    // What has no length of its own (a syllable) lasts to the next moment.
    for (let i = events.length - 1, next = midi.duration; i >= 0; i--) {
      if (events[i].end <= events[i].time) events[i].end = next
      if (i > 0 && events[i - 1].time < events[i].time) next = events[i].time
    }

    // A moment: the events that begin together, and where that is on the page,
    // from the elements found so far: the leftmost centre, and their extent.
    const moments = []
    for (const event of events) {
      let moment = moments[moments.length - 1]
      if (!moment || moment.time !== event.time) {
        moment = { time: event.time, events: [], placed: 0, page: -1, x: 0, top: 1, bottom: 0 }
        moments.push(moment)
      }
      moment.events.push(event)
      const b = event.element && box(event.element)
      if (!b || (moment.placed > 0 && b.page !== moment.page)) continue
      const centre = (b.left + b.right) / 2
      moment.page = b.page
      moment.x = moment.placed === 0 ? centre : Math.min(moment.x, centre)
      moment.top = Math.min(moment.top, b.top)
      moment.bottom = Math.max(moment.bottom, b.bottom)
      moment.placed++
    }
    const placed = moments.filter((moment) => moment.placed > 0)
    const systems = systemsOf(placed)

    // What is left is drawn in several places and played some other number of
    // times (a cue, say): take the place on the system that is playing then.
    for (const moment of moments) {
      for (const event of moment.events) {
        if (event.element) continue
        const near = lastAt(placed, moment.time)
        const system = near >= 0 ? systems[placed[near].system] : undefined
        const within = (candidate) => {
          const b = box(candidate)
          if (!b || b.page !== system.page) return false
          const middle = (b.top + b.bottom) / 2
          return middle >= system.top && middle <= system.bottom
        }
        event.element = (system && event.candidates.find(within)) ?? event.candidates[0]
      }
    }

    const bars = timing.bars
      .map(({ at, number }) => ({ time: momentTime(midi, at, 0), number }))
      .sort((a, b) => a.time - b.time)
    return { events, ends: endsOf(events), moments: placed, systems, bars }
  }

  function showBar(number) {
    const text = number === undefined ? '' : `bar ${number}`
    if (barEl.textContent !== text) barEl.textContent = text
  }

  /** Marks what sounds now and puts the playhead through it; clears both when stopped. */
  function drawPlayhead() {
    // Nothing is measured while nothing plays: a render is not to cost a frame.
    const active = player.state !== 'stopped'
    if (active && !timeline) timeline = buildTimeline()
    const line = active ? timeline : null
    const time = player.position
    const cursor = line ? cursorAt(line.moments, time) : undefined
    const next = new Set(cursor ? soundingAt(line.events, line.ends, time).map((i) => line.events[i].element) : [])
    for (const element of sounding) if (!next.has(element)) element.classList.remove('playing')
    for (const element of next) if (!sounding.has(element)) element.classList.add('playing')
    sounding = next
    const moment = cursor && line.moments[cursor.index]
    const system = moment && line.systems[moment.system]
    const page = system && pagesEl.children[system.page]
    if (!page) {
      playhead.remove()
      shownSystem = -1
      showBar(undefined)
      return
    }
    if (playhead.parentNode !== page) page.append(playhead)
    const { clientWidth, clientHeight } = page
    playhead.style.setProperty('left', `${cursor.x * clientWidth}px`)
    playhead.style.setProperty('top', `${system.top * clientHeight}px`)
    playhead.style.setProperty('height', `${(system.bottom - system.top) * clientHeight}px`)
    showBar(barAt(line.bars, time))
    if (moment.system !== shownSystem) {
      shownSystem = moment.system
      follow(page, cursor.x, system)
    }
  }

  /** Scrolls the playhead into view when it is not, as a cursor reveal does (D19). */
  function follow(page, x, system) {
    const rect = page.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    const dx = scrollToShow(rect.left + x * rect.width - 8, 16, clientWidth)
    const dy = scrollToShow(
      rect.top + system.top * rect.height - TOOLBAR,
      (system.bottom - system.top) * rect.height,
      clientHeight - TOOLBAR,
    )
    if (dx !== 0 || dy !== 0) window.scrollBy(dx, dy)
  }

  function animatePlayhead() {
    frame = 0
    drawPlayhead()
    if (player.state === 'playing') frame = requestAnimationFrame(animatePlayhead)
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
        loadMidi(data.data, data.timing)
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
