// Playback in the preview pane (DECISIONS D35): the MIDI of the last compile,
// played by media/midi.js's parser, synthesizer and player (D24) behind the
// transport of media/player.js, and the notes marked as they sound, with a
// playhead through the system (D26), from media/preview.js's pure half. The
// main process reads the MIDI and its map together with the pages.
import { formatTime, momentTime, parseMidi, Player } from '../../../media/midi.js'
import { barAt, cursorAt, scrollToShow, soundingAt, timelineOf, type Box, type Timeline } from '../../../media/preview.js'
import type { CompileEvent, CompileOutcome, PlaybackTiming } from '../ipc'

/** The music the player has: the score, the MIDI bytes and their map. */
export interface Loaded {
  rootFile: string
  midi: Uint8Array | undefined
  timing: PlaybackTiming | undefined
}

export type PlaybackChange =
  | { kind: 'keep' }
  /** Other music, or none: load it and start from the beginning. */
  | { kind: 'load'; midi: Uint8Array | undefined; timing: PlaybackTiming | undefined }
  /** The same music with its notes elsewhere on the pages: it plays on. */
  | { kind: 'remap'; timing: PlaybackTiming | undefined }

/**
 * What a finished compile does to the music, as in the extension (D24): a run
 * that did not happen keeps it; another score replaces it; a failed run
 * without MIDI keeps it, as it keeps the pages; a good run without `\midi`
 * clears it; the same bytes again play on.
 */
export function playbackChange(outcome: CompileOutcome, loaded: Loaded | undefined): PlaybackChange {
  if (outcome.state !== 'ok' && outcome.state !== 'failed') return { kind: 'keep' }
  const { midiData: midi, timing } = outcome
  if (loaded?.rootFile !== outcome.rootFile) return { kind: 'load', midi, timing }
  if (!midi) {
    return outcome.state === 'failed' || !loaded.midi ? { kind: 'keep' } : { kind: 'load', midi: undefined, timing: undefined }
  }
  if (!loaded.midi || !sameBytes(midi, loaded.midi)) return { kind: 'load', midi, timing }
  return JSON.stringify(timing ?? null) === JSON.stringify(loaded.timing ?? null) ? { kind: 'keep' } : { kind: 'remap', timing }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

const NO_MIDI = 'Add a \\midi { } block to the \\score to hear it'
const SEEK_STEPS = 1000

export interface ScorePlayerOptions {
  /** The transport bar; the player fills it. */
  transport: HTMLElement
  /** The SVG preview: its pages and their elements by `textedit:` link (D32). */
  preview: { pageElements: HTMLCollection; sourceLinks: Map<string, Element[]> }
  /** The preview's scrolling body, scrolled to the system being played. */
  body: HTMLElement
  onError(message: string): void
}

export class ScorePlayer {
  private readonly player = new Player({ onChange: () => this.showPlayback() })
  private readonly playButton = document.createElement('button')
  private readonly stopButton = document.createElement('button')
  private readonly seek = document.createElement('input')
  private readonly time = document.createElement('span')
  private readonly bar = document.createElement('span')
  private loaded: Loaded | undefined
  private unplayable = ''
  /** While the slider is dragged it shows where the drag is, not where the music is. */
  private seeking = false

  // The playhead (D26).
  /** The map resolved against the pages on screen: built when first drawn, dropped by a render. */
  private timeline: Timeline<Element> | null = null
  /** Element → its box in fractions of its page, per page node. */
  private readonly boxes = new WeakMap<Element, Map<Element, Box>>()
  private readonly playhead = document.createElement('div')
  private sounding = new Set<Element>()
  /** The system scrolled into view last; another is scrolled to when the music reaches it. */
  private shownSystem = -1
  private wasPlaying = false
  private frame = 0

  constructor(private readonly options: ScorePlayerOptions) {
    const { transport } = options
    this.playhead.className = 'playhead'
    this.playButton.type = this.stopButton.type = 'button'
    this.playButton.className = 'transport-play'
    this.stopButton.textContent = '■︎'
    this.stopButton.title = 'Stop'
    this.stopButton.setAttribute('aria-label', 'Stop')
    this.seek.type = 'range'
    this.seek.min = '0'
    this.seek.max = String(SEEK_STEPS)
    this.seek.value = '0'
    this.seek.setAttribute('aria-label', 'Playback position')
    this.time.className = 'transport-time'
    this.bar.className = 'transport-bar'
    transport.setAttribute('role', 'toolbar')
    transport.setAttribute('aria-label', 'Playback')
    transport.replaceChildren(this.playButton, this.stopButton, this.seek, this.bar, this.time)

    this.playButton.addEventListener('click', () => this.toggle())
    this.stopButton.addEventListener('click', () => this.player.stop())
    this.seek.addEventListener('input', () => {
      this.seeking = true
      this.time.textContent = this.times((Number(this.seek.value) / SEEK_STEPS) * this.player.duration)
    })
    this.seek.addEventListener('change', () => {
      this.seeking = false
      this.shownSystem = -1
      void this.player.seek((Number(this.seek.value) / SEEK_STEPS) * this.player.duration)
    })
    this.showPlayback()
  }

  compiled(event: CompileEvent): void {
    if (event.kind !== 'finished') return
    const { outcome } = event
    const change = playbackChange(outcome, this.loaded)
    if (change.kind === 'keep') return
    const { rootFile } = outcome
    if (change.kind === 'remap') {
      this.loaded = { ...this.loaded!, timing: change.timing }
      this.timeline = null
      this.showPlayback()
      return
    }
    this.loaded = { rootFile, midi: change.midi, timing: change.timing }
    this.timeline = null
    this.unplayable = ''
    let midi
    try {
      if (change.midi) midi = parseMidi(change.midi)
    } catch (error) {
      this.unplayable = error instanceof Error ? error.message : String(error)
    }
    this.player.load(midi)
  }

  toggle(): void {
    if (this.player.state === 'playing') this.player.pause()
    else void this.play()
  }

  /** Other pages are on screen: the playhead is found on them again. */
  rendered(): void {
    this.timeline = null
    this.refresh()
  }

  /** Draws the playhead again after the pages moved or were shown, unless a frame will. */
  refresh(): void {
    if (this.player.state !== 'playing') this.drawPlayhead()
  }

  private async play(): Promise<void> {
    if (!this.player.midi) return
    // Electron lets a page make sound without a click; this is a device that failed.
    if (!(await this.player.play()) && this.player.suspended) this.options.onError('The sound could not be started.')
  }

  private times(position: number): string {
    return `${formatTime(position)} / ${formatTime(this.player.duration)}`
  }

  private showPlayback(): void {
    const { state, position, duration } = this.player
    const playing = state === 'playing'
    const ready = this.player.midi !== undefined
    this.playButton.disabled = this.stopButton.disabled = this.seek.disabled = !ready
    this.playButton.textContent = playing ? '❚❚' : '▶︎'
    this.playButton.title = ready ? (playing ? 'Pause (Space)' : 'Play (Space)') : this.unplayable || NO_MIDI
    this.playButton.setAttribute('aria-label', ready && playing ? 'Pause' : 'Play')
    this.time.textContent = ready ? this.times(position) : ''
    if (!this.seeking) this.seek.value = String(duration > 0 ? Math.round((position / duration) * SEEK_STEPS) : 0)
    this.options.transport.dataset.state = ready ? state : 'empty'

    // The playhead follows the audio clock frame by frame while playing.
    if (playing) {
      if (!this.wasPlaying) this.shownSystem = -1 // wherever the user scrolled to, show where it starts
      if (!this.frame) this.frame = requestAnimationFrame(() => this.animate())
    } else this.drawPlayhead()
    this.wasPlaying = playing
  }

  private animate(): void {
    this.frame = 0
    this.drawPlayhead()
    if (this.player.state === 'playing') this.frame = requestAnimationFrame(() => this.animate())
  }

  /** The map's events found on the pages; null while there is nothing to find them on. */
  private buildTimeline(): Timeline<Element> | null {
    const { midi } = this.player
    const timing = this.loaded?.timing
    const pages = [...this.options.preview.pageElements]
    if (!timing || !midi || pages.length === 0) return null
    const rects = pages.map((page) => page.getBoundingClientRect())
    // Behind the PDF tab the pages have no size; measure them once they are shown.
    if (rects[0].width === 0) return null
    const indexes = new Map(pages.map((page, index) => [page, index]))
    const box = (element: Element): Box | undefined => {
      const page = element.closest('.preview-page')
      const index = page ? indexes.get(page) : undefined
      if (!page || index === undefined) return undefined
      let cache = this.boxes.get(page)
      if (!cache) this.boxes.set(page, (cache = new Map()))
      let found = cache.get(element)
      if (!found) {
        const rect = rects[index]
        const r = element.getBoundingClientRect()
        found = {
          page: index,
          left: (r.left - rect.left) / rect.width,
          right: (r.right - rect.left) / rect.width,
          top: (r.top - rect.top) / rect.height,
          bottom: (r.bottom - rect.top) / rect.height,
        }
        cache.set(element, found)
      }
      return found
    }
    return timelineOf(timing, midi.duration, this.options.preview.sourceLinks, box, (at, grace) => momentTime(midi, at, grace))
  }

  /** Marks what sounds now and puts the playhead through it; clears both when stopped. */
  private drawPlayhead(): void {
    // Nothing is measured while nothing plays: a render is not to cost a frame.
    const active = this.player.state !== 'stopped'
    if (active && !this.timeline) this.timeline = this.buildTimeline()
    const line = active ? this.timeline : null
    const time = this.player.position
    const cursor = line ? cursorAt(line.moments, time) : undefined
    const next = new Set<Element>()
    if (line && cursor) {
      for (const i of soundingAt(line.events, line.ends, time)) {
        const element = line.events[i].element
        if (element) next.add(element)
      }
    }
    for (const element of this.sounding) if (!next.has(element)) element.classList.remove('playing')
    for (const element of next) if (!this.sounding.has(element)) element.classList.add('playing')
    this.sounding = next
    const moment = line && cursor ? line.moments[cursor.index] : undefined
    const system = moment && line!.systems[moment.system]
    const page = system && (this.options.preview.pageElements[system.page] as HTMLElement | undefined)
    if (!page || !cursor || !moment || !system) {
      this.playhead.remove()
      this.shownSystem = -1
      this.showBar(undefined)
      return
    }
    if (this.playhead.parentNode !== page) page.append(this.playhead)
    const { clientWidth, clientHeight } = page
    this.playhead.style.left = `${cursor.x * clientWidth}px`
    this.playhead.style.top = `${system.top * clientHeight}px`
    this.playhead.style.height = `${(system.bottom - system.top) * clientHeight}px`
    this.showBar(barAt(line!.bars, time))
    if (moment.system !== this.shownSystem && !this.seeking) {
      this.shownSystem = moment.system
      this.follow(page, cursor.x, system)
    }
  }

  private showBar(number: number | undefined): void {
    const text = number === undefined ? '' : `bar ${number}`
    if (this.bar.textContent !== text) this.bar.textContent = text
  }

  /** Scrolls the playhead into view when it is not, as a click-to-source reveal would. */
  private follow(page: HTMLElement, x: number, system: { top: number; bottom: number }): void {
    const { body } = this.options
    const view = body.getBoundingClientRect()
    const rect = page.getBoundingClientRect()
    const dx = scrollToShow(rect.left - view.left + x * rect.width - 8, 16, body.clientWidth)
    const dy = scrollToShow(rect.top - view.top + system.top * rect.height, (system.bottom - system.top) * rect.height, body.clientHeight)
    if (dx !== 0 || dy !== 0) body.scrollBy(dx, dy)
  }
}
