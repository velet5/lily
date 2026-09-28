// Playback in the preview pane (DECISIONS D35): the MIDI of the last compile,
// played by @lily/common's midi.js parser, synthesizer and player (D24) behind
// the transport of the extension's media/player.js, and the notes marked as they
// sound, with a playhead through the system (D26), from preview.js's pure half. The
// main process reads the MIDI and its map together with the pages. The Parts
// fold plays each part on an instrument of its own or mutes it, and ▶ starts
// from a marked bar (D45).
import { formatTime, instrumentName, momentTime, parseMidi, Player, type Midi } from '@lily/common/web/midi.js'
import { barAt, cursorAt, scrollToShow, soundingAt, timelineOf, type Box, type Timeline } from '@lily/common/web/preview.js'
import type { CompileEvent, CompileOutcome, PlaybackSetup, PlaybackTiming } from '../ipc'
import { barTime, INSTRUMENT_GROUPS, mixMidi, momentAt, partsOf, withPart, withStartBar } from './playbackSetup'

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

const NO_MIDI = 'The score has no MIDI: press Add MIDI to hear it'
const SEEK_STEPS = 1000

export interface ScorePlayerOptions {
  /** The transport bar; the player fills it. */
  transport: HTMLElement
  /** The SVG preview: its pages and their elements by `textedit:` link (D32). */
  preview: { pageElements: HTMLCollection; sourceLinks: Map<string, Element[]> }
  /** The preview's scrolling body, scrolled to the system being played. */
  body: HTMLElement
  onError(message: string): void
  /** Add MIDI (D44): puts a `\midi` block in the score, shown while it has none. */
  onAddMidi(): void
  /** Where the Parts fold opens, above the transport (D45). */
  panel: HTMLElement
  /** The setup kept for a score, and keeping it (D45). */
  loadSetup(rootFile: string): Promise<PlaybackSetup | undefined>
  saveSetup(rootFile: string, setup: PlaybackSetup): Promise<void>
}

export class ScorePlayer {
  private readonly player = new Player({ onChange: () => this.showPlayback() })
  private readonly playButton = document.createElement('button')
  private readonly stopButton = document.createElement('button')
  private readonly seek = document.createElement('input')
  private readonly time = document.createElement('span')
  private readonly bar = document.createElement('span')
  private readonly addButton = document.createElement('button')
  private readonly markChip = document.createElement('button')
  private readonly partsButton = document.createElement('button')
  private readonly menu = document.createElement('div')
  private loaded: Loaded | undefined
  private unplayable = ''
  /** The MIDI as parsed, before the setup mutes or changes its parts. */
  private parsed: Midi | undefined
  /** How the loaded score is played (D45); the score's setup arrives after its music. */
  private setup: PlaybackSetup = {}
  private setupFor: string | undefined
  private readonly startMark = document.createElement('div')
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
    this.playButton.type = this.stopButton.type = this.addButton.type = 'button'
    this.addButton.className = 'transport-add'
    this.addButton.textContent = 'Add MIDI'
    this.addButton.title = 'Add a \\midi { } block to the score, so it can be played'
    this.addButton.hidden = true
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
    this.markChip.type = this.partsButton.type = 'button'
    this.markChip.className = 'transport-mark'
    this.markChip.hidden = true
    this.partsButton.className = 'transport-parts'
    this.partsButton.textContent = 'Parts'
    this.partsButton.title = 'Instruments, mutes and where playback starts'
    this.partsButton.setAttribute('aria-expanded', 'false')
    this.partsButton.setAttribute('aria-controls', 'playback-setup')
    options.panel.id = 'playback-setup'
    options.panel.hidden = true
    this.startMark.className = 'start-mark'
    this.menu.className = 'preview-menu'
    this.menu.setAttribute('role', 'menu')
    this.menu.hidden = true
    document.body.append(this.menu)
    transport.replaceChildren(this.playButton, this.stopButton, this.addButton, this.seek, this.bar, this.time, this.markChip, this.partsButton)

    this.playButton.addEventListener('click', () => this.toggle())
    this.stopButton.addEventListener('click', () => this.player.stop())
    this.addButton.addEventListener('click', () => options.onAddMidi())
    this.markChip.addEventListener('click', () => this.setStartBar(undefined))
    this.partsButton.addEventListener('click', () => this.showPanel(options.panel.hidden === true))
    options.body.addEventListener('contextmenu', (event) => this.openMenu(event))
    this.menu.addEventListener('focusout', (event) => {
      if (!this.menu.contains(event.relatedTarget as Node | null)) this.menu.hidden = true
    })
    this.menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.menu.hidden = true
    })
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
    this.parsed = midi
    if (this.setupFor !== rootFile) {
      // Another score: its own setup, once the Rust side has it.
      this.setup = {}
      this.setupFor = rootFile
      this.options.loadSetup(rootFile).then(
        (setup) => {
          if (this.setupFor !== rootFile || !setup) return
          this.setup = setup
          this.remix()
        },
        (error: unknown) => console.error('playback setup:', error),
      )
    }
    this.player.load(midi && mixMidi(midi, this.setup))
    this.fillPanel()
  }

  /** Stops the music; the score it belongs to left the preview (D39). */
  stop(): void {
    this.player.stop()
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

  /** Draws the playhead and the start mark again after the pages moved or were shown, unless a frame will. */
  refresh(): void {
    if (this.player.state !== 'playing') this.drawPlayhead()
    this.drawStartMark()
  }

  private async play(): Promise<void> {
    if (!this.player.midi) return
    // From the start means from the start mark.
    const start = this.player.state === 'stopped' ? this.startTime() : undefined
    if (start !== undefined) await this.player.seek(start)
    // Play is a click, which lets the page make sound; this is a device that failed.
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
    this.partsButton.disabled = !ready
    if (!ready && !this.options.panel.hidden) this.showPanel(false)
    // Only once a compile has shown that the score has no MIDI, not before the first.
    this.addButton.hidden = ready || !this.loaded || !!this.unplayable

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

  // ---- the playback setup (D45) ----

  /** Plays the music as the setup now has it, from where it is. */
  private remix(): void {
    // From what the audio clock reached: what was rendered before still sounds.
    const { state, scheduled: position } = this.player
    this.player.load(this.parsed && mixMidi(this.parsed, this.setup))
    this.fillPanel()
    this.drawStartMark()
    if (state === 'stopped' || !this.player.midi) return
    void this.player.seek(position).then(() => (state === 'playing' ? this.play() : undefined))
  }

  private changeSetup(setup: PlaybackSetup): void {
    this.setup = setup
    const rootFile = this.setupFor
    if (rootFile) this.options.saveSetup(rootFile, setup).catch((error: unknown) => this.options.onError(error instanceof Error ? error.message : String(error)))
  }

  private setStartBar(bar: number | undefined): void {
    this.changeSetup(withStartBar(this.setup, bar))
    this.fillPanel()
    this.drawStartMark()
  }

  /** The bars of the music with their times; empty without a map. */
  private bars(): { time: number; number: number }[] {
    const timing = this.loaded?.timing
    const midi = this.player.midi
    if (!timing || !midi) return []
    return timing.bars.map(({ at, number }) => ({ time: momentTime(midi, at), number })).sort((a, b) => a.time - b.time)
  }

  /** When the start bar begins; undefined without one, or when the music has no such bar. */
  private startTime(): number | undefined {
    const bar = this.setup.startBar
    return bar === undefined ? undefined : barTime(this.bars(), bar)
  }

  private showPanel(open: boolean): void {
    this.options.panel.hidden = !open
    this.partsButton.setAttribute('aria-expanded', String(open))
    if (open) this.fillPanel()
  }

  /** The start mark's chip in the transport, and the fold's rows when it is open. */
  private fillPanel(): void {
    const bar = this.setup.startBar
    const valid = bar !== undefined && this.startTime() !== undefined
    this.markChip.hidden = bar === undefined || !this.player.midi
    this.markChip.textContent = `from bar ${bar} ✕`
    this.markChip.classList.toggle('invalid', !valid)
    this.markChip.title = valid ? 'Playback starts at this bar. Click to start from the beginning again.' : `The score has no bar ${bar}: playback starts from the beginning. Click to clear.`
    const { panel } = this.options
    if (panel.hidden) return
    const midi = this.parsed
    if (!midi) {
      panel.replaceChildren(paragraph('The score has no MIDI to play.'))
      return
    }
    const rows = partsOf(midi, this.loaded?.timing?.staves).map((part) => {
      const setting = this.setup.parts?.[part.track] ?? {}
      const row = document.createElement('div')
      row.className = 'part'
      row.classList.toggle('muted', !!setting.muted)
      const mute = document.createElement('button')
      mute.type = 'button'
      mute.className = 'part-mute'
      mute.textContent = setting.muted ? 'Muted' : 'On'
      mute.setAttribute('aria-pressed', String(!!setting.muted))
      mute.title = setting.muted ? `Play ${part.name} again` : `Mute ${part.name}`
      mute.addEventListener('click', () => {
        this.changeSetup(withPart(this.setup, part.track, { muted: !setting.muted }))
        this.remix()
      })
      const label = document.createElement('span')
      label.className = 'part-name'
      label.textContent = part.name
      label.title = `Part ${part.number}, written for ${part.written}`
      const select = document.createElement('select')
      select.setAttribute('aria-label', `Instrument of ${part.name}`)
      select.append(new Option(part.drums ? 'Drums' : `As written (${part.written})`, ''))
      for (const group of INSTRUMENT_GROUPS) {
        const optgroup = document.createElement('optgroup')
        optgroup.label = group.label
        for (const instrument of group.instruments) optgroup.append(new Option(instrument.label, String(instrument.program)))
        select.append(optgroup)
      }
      if (setting.program !== undefined && !select.querySelector(`option[value="${setting.program}"]`)) {
        select.append(new Option(instrumentName(setting.program), String(setting.program)))
      }
      select.value = setting.program === undefined ? '' : String(setting.program)
      // A drum kit has no pitches to play on another instrument.
      select.disabled = part.drums
      select.addEventListener('change', () => {
        this.changeSetup(withPart(this.setup, part.track, { program: select.value === '' ? null : Number(select.value) }))
        this.remix()
      })
      row.append(mute, label, select)
      return row
    })

    const start = document.createElement('div')
    start.className = 'part start'
    const startLabel = document.createElement('label')
    startLabel.className = 'part-name'
    startLabel.textContent = 'Start at bar'
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.step = '1'
    input.placeholder = '1'
    input.value = bar === undefined ? '' : String(bar)
    input.id = 'playback-start-bar'
    startLabel.htmlFor = input.id
    input.addEventListener('change', () => {
      const value = Math.floor(Number(input.value))
      this.setStartBar(input.value.trim() !== '' && value > 1 ? value : undefined)
    })
    const hasBars = this.bars().length > 0
    input.disabled = !hasBars
    const hint = document.createElement('span')
    hint.className = 'part-hint'
    hint.textContent = hasBars ? 'or right-click a bar in the SVG preview' : 'the score has no bar map'
    start.append(startLabel, input, hint)

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'part-reset'
    reset.textContent = 'Play as written'
    reset.title = 'Every part on its own instrument, none muted, from the beginning'
    reset.disabled = Object.keys(this.setup).length === 0
    reset.addEventListener('click', () => {
      this.changeSetup({})
      this.remix()
    })
    panel.replaceChildren(...rows, start, reset)
  }

  /** Right-click on the pages: start playback at the bar under the pointer. */
  private openMenu(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest('.preview-page') : null
    if (!target || !this.player.midi) return
    const pages = [...this.options.preview.pageElements]
    const page = pages.indexOf(target)
    this.timeline ??= this.buildTimeline()
    const line = this.timeline
    if (page < 0 || !line) return
    const rect = target.getBoundingClientRect()
    const moment = momentAt(line, page, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
    const bar = moment && barAt(line.bars, moment.time)
    if (bar === undefined) return
    event.preventDefault()
    const item = (label: string, action: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = label
      button.addEventListener('click', () => {
        this.menu.hidden = true
        action()
      })
      return button
    }
    const items = [
      item(`Play from bar ${bar}`, () => {
        this.setStartBar(bar)
        const time = this.startTime()
        if (time !== undefined) void this.player.seek(time).then(() => this.play())
      }),
      item(`Start playback at bar ${bar}`, () => this.setStartBar(bar)),
    ]
    if (this.setup.startBar !== undefined) items.push(item('Start from the beginning', () => this.setStartBar(undefined)))
    this.menu.replaceChildren(...items)
    this.menu.hidden = false
    const { innerWidth, innerHeight } = window
    this.menu.style.left = `${Math.min(event.clientX, innerWidth - this.menu.offsetWidth - 4)}px`
    this.menu.style.top = `${Math.min(event.clientY, innerHeight - this.menu.offsetHeight - 4)}px`
    items[0].focus()
  }

  /** A flag on the pages where playback starts; only measured while there is a mark. */
  private drawStartMark(): void {
    const time = this.startTime()
    if (time === undefined || !this.options.preview.pageElements.length) {
      this.startMark.remove()
      return
    }
    this.timeline ??= this.buildTimeline()
    const line = this.timeline
    const cursor = line ? cursorAt(line.moments, time) : undefined
    const moment = cursor && line!.moments[cursor.index]
    const system = moment && line!.systems[moment.system]
    const page = system && (this.options.preview.pageElements[system.page] as HTMLElement | undefined)
    if (!page || !cursor || !system) {
      this.startMark.remove()
      return
    }
    if (this.startMark.parentNode !== page) page.append(this.startMark)
    const { clientWidth, clientHeight } = page
    this.startMark.dataset.bar = String(this.setup.startBar)
    this.startMark.title = `Playback starts at bar ${this.setup.startBar}`
    this.startMark.style.left = `${cursor.x * clientWidth}px`
    this.startMark.style.top = `${system.top * clientHeight}px`
    this.startMark.style.height = `${(system.bottom - system.top) * clientHeight}px`
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

function paragraph(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'part-hint'
  p.textContent = text
  return p
}
