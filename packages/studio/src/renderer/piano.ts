// The piano view (DECISIONS D116): the music the transport plays, as notes
// falling onto a keyboard, over the editor when the transport's Piano button
// or the editor's Piano tab shows it, or below the score (D117). The keyboard
// has all 88 keys, or the octaves the score's notes are in. The notes are the
// score's, a muted part's too, and a seek moves them; the drums have no keys.
// Tracks hides a part's notes from the view alone (D117), and the Parts fold
// mutes it in the sound alone: the two are independent, each all on until
// changed, and a line in the view names what either has off (D153).
// Its Karaoke style shows the notes and the words as a karaoke video does (D133),
// its notes on a piano roll or a staff, and Both has the keyboard below it (D156).
import { formatTime, momentTime, type Midi, type Note } from '@lily/common/web/midi.js'
import type { PlaybackTiming } from '@lily/common/types'
import { drawKaraoke, phrasesOf, staffTracks, syllablesOf, voiceTracks, type KaraokeScene, type Phrase } from './karaoke'
import type { Part } from './playbackSetup'
import { keyOf, noteLengths, trackClefs, type StaffScene } from './staff'

/** The 88 keys of a piano, A0 to C8. */
export const LOWEST = 21
export const HIGHEST = 108
const DRUMS = 9

export type KeyRange = 'full' | 'notes'
/** Where the view is: over the editor, or below the score in the preview (D117). */
export type PianoPlace = 'source' | 'score'
/** Falling onto a keyboard, running past a line with the words below (D133), or the two, the keyboard below (D156). */
export type PianoStyle = 'keys' | 'karaoke' | 'both'
/** Karaoke's notes as bars on a row per semitone, or on a staff (D156). */
export type KaraokeLane = 'roll' | 'staff'

/** What the view shows: the music the player has and where it is. */
export interface PianoSource {
  readonly midi: Midi | undefined
  /** The score's music with its muted parts, which Karaoke shows to sing them (D133). */
  readonly score: Midi | undefined
  /** The playback map, and with it the words Karaoke shows. */
  readonly timing: PlaybackTiming | undefined
  readonly position: number
  readonly playing: boolean
  /** The score the music is of, which the hidden tracks are kept for. */
  readonly rootFile: string | undefined
  /** The parts, for the names in Tracks. */
  readonly parts: readonly Part[]
  /** The tracks the Parts fold mutes: still shown, and named in the view's notice. */
  readonly muted: ReadonlySet<number>
  /**
   * The time map of each voice `score` has at its sung times, by track
   * (D276): its words and its staff's lengths go through it.
   */
  readonly voiceTimes?: ReadonlyMap<number, (seconds: number) => number>
}

/** A note's name, with the flats and the F♯ a piano video gives them. */
export function noteName(key: number): string {
  return ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][((key % 12) + 12) % 12]
}

export function isBlack(key: number): boolean {
  return [1, 3, 6, 8, 10].includes(((key % 12) + 12) % 12)
}

/** The notes that have keys: no drums, nothing off the piano, by time. */
export function pianoNotes(midi: Midi | undefined): Note[] {
  if (!midi) return []
  return midi.notes.filter((note) => note.channel !== DRUMS && note.key >= LOWEST && note.key <= HIGHEST).sort((a, b) => a.time - b.time)
}

/**
 * The keys shown, lowest and highest: all 88, or whole octaves from the C
 * under the lowest note to the B over the highest, within the piano. Without
 * notes, the three octaves around middle C.
 */
export function keyRange(notes: readonly Note[], range: KeyRange): { low: number; high: number } {
  if (range === 'full') return { low: LOWEST, high: HIGHEST }
  if (notes.length === 0) return { low: 48, high: 83 }
  let low = HIGHEST
  let high = LOWEST
  for (const { key } of notes) {
    low = Math.min(low, key)
    high = Math.max(high, key)
  }
  return { low: Math.max(LOWEST, low - (low % 12)), high: Math.min(HIGHEST, high - (high % 12) + 11) }
}

export interface Key {
  key: number
  black: boolean
  /** From the keyboard's left edge, in pixels. */
  x: number
  width: number
}

/**
 * The keys from `low` to `high` across `width` pixels: the white ones side by
 * side, each black one over the edge between its neighbours. `low` and
 * `high` are white keys, as keyRange gives them.
 */
export function keyboard(low: number, high: number, width: number): Key[] {
  let whites = 0
  for (let key = low; key <= high; key++) if (!isBlack(key)) whites++
  const white = width / Math.max(whites, 1)
  const keys: Key[] = []
  let x = 0
  for (let key = low; key <= high; key++) {
    if (isBlack(key)) {
      const black = white * 0.62
      keys.push({ key, black: true, x: x - black / 2, width: black })
    } else {
      keys.push({ key, black: false, x, width: white })
      x += white
    }
  }
  return keys
}

/** The first index of `notes` (by time) whose note starts at `time` or later. */
export function firstFrom(notes: readonly Note[], time: number): number {
  let low = 0
  let high = notes.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (notes[middle].time < time) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * A colour per part, as a piano video gives each hand its own: Okabe–Ito's and
 * Paul Tol's, ordered so the first ones stay apart for colour-blind eyes too
 * (D148); each at least 4.5:1 on Karaoke's sky.
 */
const PART_COLORS = ['#f0e442', '#33bbee', '#ee6677', '#aaaa00', '#009e73', '#cc79a7', '#99ddff', '#44bb99']
/** A note's name on a part's colour: dark, at least 5.6:1 on each of them (D148); white was 1.3:1 on the yellow. */
const LABEL_COLOR = '#0b0e14'
/** How many seconds of music the fall shows above the keys. */
const SECONDS_SHOWN = 3
const RANGE_KEY = 'lily-studio.piano-range'
const PLACE_KEY = 'lily-studio.piano-place'
/** Where the hidden tracks were kept across launches, until D153 made each start with every track shown. */
const HIDDEN_KEY = 'lily-studio.piano-hidden'
const STYLE_KEY = 'lily-studio.piano-style'
const MELODY_KEY = 'lily-studio.karaoke-melody'
const LANE_KEY = 'lily-studio.karaoke-lane'
const MIN_TEXT_KEY = 'lily-studio.karaoke-min-text'
/** Karaoke's words are never smaller than this many pixels until changed (D157); the box takes 8 to 96. */
export const MIN_TEXT = 24
const MIN_TEXT_RANGE = [8, 96] as const

/** The least text size `value` asks for, within the box's range; MIN_TEXT for what is not a number. */
export function minTextOf(value: string | null): number {
  const size = Number(value)
  if (value === null || value.trim() === '' || !Number.isFinite(size)) return MIN_TEXT
  return Math.round(Math.min(Math.max(size, MIN_TEXT_RANGE[0]), MIN_TEXT_RANGE[1]))
}
/** The colour of words sung to no notes of their own, as a karaoke video's. */
const WORDS_COLOR = '#ffaabb'

/** A track with keys, as Tracks lists it. */
export interface PianoTrack {
  track: number
  name: string
  color: string
}

/**
 * The tracks of `notes` in the order they first sound, each with its colour,
 * which stays when another is hidden, and its part's name.
 */
export function pianoTracks(notes: readonly Note[], parts: readonly Part[]): PianoTrack[] {
  const tracks: PianoTrack[] = []
  const seen = new Set<number>()
  for (const { track } of notes) {
    if (seen.has(track)) continue
    seen.add(track)
    const name = parts.find((part) => part.track === track)?.name ?? `Track ${track}`
    tracks.push({ track, name, color: PART_COLORS[tracks.length % PART_COLORS.length] })
  }
  return tracks
}

export interface PianoViewOptions {
  /** Where the view draws; it fills it. */
  host: HTMLElement
  /** Where its selectors go, shown with the view. */
  actions: HTMLElement
  source: PianoSource
  /** The view is to move over the source or below the score. */
  onPlace(place: PianoPlace): void
  /** Karaoke was chosen or left, shown or hidden, or its Melody ticked (D135). */
  onStyle?(): void
  /** ▶ or ❚❚ in the full window. */
  onToggle?(): void
  /**
   * Export Video, to start an export with the sounds chosen, or with none
   * given to cancel the one running (D140, D155); without it there is no such button.
   */
  onExportVideo?(chosen?: ReadonlySet<string>): void
  /** The sounds Export Video can put in, ticked as they are heard (D155); without it the button exports at once. */
  videoSounds?(): VideoSound[]
}

/** A sound Export Video can put in the video (D155): a part of the score, or a recording. */
export interface VideoSound {
  /** `track:<n>` for a part, `audio` for the audio track, `backing` for the backing track. */
  id: string
  name: string
  /** What the box starts as. */
  checked: boolean
}

export class PianoView {
  private readonly canvas = document.createElement('canvas')
  private readonly empty = document.createElement('p')
  /** What Tracks hides and the Parts fold mutes, and where to turn them back on (D153). */
  private readonly notice = document.createElement('p')
  private readonly range = document.createElement('select')
  private readonly placeSelect = document.createElement('select')
  private readonly styleSelect = document.createElement('select')
  private readonly laneSelect = document.createElement('select')
  private readonly minText = document.createElement('input')
  private readonly minTextLabel = document.createElement('label')
  private readonly melody = document.createElement('input')
  private readonly melodyLabel = document.createElement('label')
  /** In the karaoke's corner: into the full window and out (D143). */
  private readonly fullToggle = document.createElement('button')
  private readonly exportButton = document.createElement('button')
  /** Export Video's menu: what goes into the video's sound (D155). */
  private readonly soundMenu = document.createElement('div')
  private exportRunning = false
  /** In the karaoke's corner: in the full window ▶ or ❚❚ and the time, and the way in or out. */
  private readonly controls = document.createElement('div')
  private readonly controlPlay = document.createElement('button')
  private readonly controlTime = document.createElement('span')
  /** Over the karaoke for a moment: what a key just did (D154). */
  private readonly flashLabel = document.createElement('div')
  private flashTimer = 0
  private readonly tracksButton = document.createElement('button')
  private readonly tracksMenu = document.createElement('div')
  private shown = false
  private frame = 0
  private midi: Midi | undefined
  /** All the notes with keys, and those of the tracks shown. */
  private allNotes: Note[] = []
  private notes: Note[] = []
  /** The longest note, so the search for what is on screen can start early enough. */
  private longest = 0
  /** The tracks with notes in the order they come, with their colours. */
  private tracks: PianoTrack[] = []
  private colors = new Map<number, string>()
  /** The tracks Tracks hides, for the score they were hidden in. */
  private hidden = new Set<number>()
  private hiddenFor: string | undefined
  /** Karaoke's phrases, for the map and the tracks shown they were found in. */
  private phrases: Phrase[] = []
  /** Whether the score has words and Tracks hides every line of them. */
  private wordsHidden = false
  private phrasesFor: { timing: PlaybackTiming | undefined; notes: Note[] } | undefined
  /** What the staff needs, for the music and map it was found in (D156). */
  private staffFor: { midi: Midi; timing: PlaybackTiming | undefined; staff: StaffScene } | undefined

  constructor(private readonly options: PianoViewOptions) {
    const { host, actions } = options
    host.classList.add('piano')
    this.canvas.className = 'piano-canvas'
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', 'The notes falling onto a piano keyboard as they play')
    this.empty.className = 'piano-empty'
    this.empty.hidden = true
    this.notice.className = 'piano-notice'
    this.notice.hidden = true
    host.replaceChildren(this.canvas, this.empty, this.notice)
    forget(HIDDEN_KEY)
    this.range.className = 'piano-range'
    this.range.setAttribute('aria-label', 'Keys shown')
    this.range.title = 'The whole keyboard, or the octaves the score’s notes are in'
    this.range.append(new Option('All 88 keys', 'full'), new Option('The score’s notes', 'notes'))
    this.range.value = stored(RANGE_KEY) === 'notes' ? 'notes' : 'full'
    this.range.addEventListener('change', () => {
      store(RANGE_KEY, this.range.value)
      this.draw()
    })
    this.placeSelect.className = 'piano-place'
    this.placeSelect.setAttribute('aria-label', 'Where the piano is')
    this.placeSelect.title = 'Over the source, or below the score with the source still there'
    this.placeSelect.append(new Option('Over the source', 'source'), new Option('Below the score', 'score'))
    this.placeSelect.value = stored(PLACE_KEY) === 'score' ? 'score' : 'source'
    this.placeSelect.addEventListener('change', () => {
      store(PLACE_KEY, this.placeSelect.value)
      options.onPlace(this.place)
    })
    this.styleSelect.className = 'piano-style'
    this.styleSelect.setAttribute('aria-label', 'Style')
    this.styleSelect.title = 'The notes falling onto a keyboard, running past a line with the words below them, or both'
    this.styleSelect.append(new Option('Keyboard', 'keys'), new Option('Karaoke', 'karaoke'), new Option('Karaoke and keyboard', 'both'))
    const style = stored(STYLE_KEY)
    this.styleSelect.value = style === 'karaoke' || style === 'both' ? style : 'keys'
    this.styleSelect.addEventListener('change', () => {
      store(STYLE_KEY, this.styleSelect.value)
      this.styled()
      this.draw()
    })
    this.laneSelect.className = 'piano-lane'
    this.laneSelect.setAttribute('aria-label', 'Karaoke’s notes')
    this.laneSelect.title = 'Karaoke’s notes as bars on a row per semitone, or as notes on a staff'
    this.laneSelect.append(new Option('Piano roll', 'roll'), new Option('Staff', 'staff'))
    this.laneSelect.value = stored(LANE_KEY) === 'staff' ? 'staff' : 'roll'
    this.laneSelect.addEventListener('change', () => {
      store(LANE_KEY, this.laneSelect.value)
      this.styled(false)
      this.draw()
    })
    this.minText.type = 'number'
    this.minText.min = String(MIN_TEXT_RANGE[0])
    this.minText.max = String(MIN_TEXT_RANGE[1])
    this.minText.step = '2'
    this.minText.value = String(minTextOf(stored(MIN_TEXT_KEY)))
    this.minText.setAttribute('aria-label', 'Karaoke’s least text size, in pixels')
    this.minText.addEventListener('input', () => {
      if (this.minText.value.trim() === '') return
      store(MIN_TEXT_KEY, String(minTextOf(this.minText.value)))
      this.draw()
    })
    this.minText.addEventListener('change', () => {
      this.minText.value = String(minTextOf(this.minText.value))
      store(MIN_TEXT_KEY, this.minText.value)
      this.draw()
    })
    this.minTextLabel.className = 'karaoke-min-text'
    this.minTextLabel.title = 'The words are never smaller than this: a long line breaks onto more lines instead'
    this.minTextLabel.append('Min text', this.minText, 'px')
    this.melody.type = 'checkbox'
    this.melody.checked = stored(MELODY_KEY) === 'on'
    this.melody.addEventListener('change', () => {
      store(MELODY_KEY, this.melody.checked ? 'on' : 'off')
      options.onStyle?.()
    })
    this.melodyLabel.className = 'karaoke-melody'
    this.melodyLabel.title = 'Play the score’s MIDI along with the backing track'
    this.melodyLabel.append(this.melody, 'Melody')
    this.exportButton.type = 'button'
    this.exportButton.className = 'karaoke-export-button'
    this.exportButton.addEventListener('click', () => {
      if (this.exportRunning || !options.videoSounds) options.onExportVideo?.()
      else this.showSounds(this.soundMenu.hidden === true)
    })
    this.exportButton.setAttribute('aria-haspopup', 'true')
    this.soundMenu.className = 'piano-tracks karaoke-sounds'
    this.soundMenu.setAttribute('role', 'group')
    this.soundMenu.setAttribute('aria-label', 'Sound in the video')
    this.soundMenu.hidden = true
    this.soundMenu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      this.showSounds(false)
      this.exportButton.focus()
    })
    this.exporting(undefined)
    this.controls.className = 'karaoke-controls'
    this.controlPlay.type = 'button'
    this.controlPlay.className = 'karaoke-play'
    this.controlPlay.addEventListener('click', () => options.onToggle?.())
    this.controlTime.className = 'karaoke-time'
    this.fullToggle.type = 'button'
    this.fullToggle.className = 'karaoke-full-toggle'
    this.fullToggle.addEventListener('click', () => this.fullWindow(!this.full))
    this.controls.append(this.controlPlay, this.controlTime, this.fullToggle)
    this.flashLabel.className = 'karaoke-flash'
    this.flashLabel.setAttribute('aria-live', 'polite')
    host.append(this.controls, this.flashLabel)
    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.full) this.fullWindow(false)
    })
    // A double-click on the karaoke goes into the full window and out (D143).
    this.canvas.addEventListener('dblclick', () => {
      if (this.karaoke) this.fullWindow(!this.full)
    })
    this.tracksButton.type = 'button'
    this.tracksButton.className = 'piano-tracks-button'
    this.tracksButton.textContent = 'Tracks'
    this.tracksButton.title = 'The parts whose notes fall; the others still sound'
    this.tracksButton.setAttribute('aria-haspopup', 'true')
    this.tracksButton.setAttribute('aria-expanded', 'false')
    this.tracksButton.addEventListener('click', () => this.showTracks(this.tracksMenu.hidden === true))
    this.tracksMenu.className = 'piano-tracks'
    this.tracksMenu.setAttribute('role', 'group')
    this.tracksMenu.setAttribute('aria-label', 'Tracks shown')
    this.tracksMenu.hidden = true
    // A click elsewhere closes it, and so does a Tab out of it. WebKit does not
    // focus a clicked button, so a click leaves no relatedTarget to go by.
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node
      if (!this.tracksMenu.hidden && !this.tracksMenu.contains(target) && !this.tracksButton.contains(target)) this.showTracks(false)
      if (!this.soundMenu.hidden && !this.soundMenu.contains(target) && !this.exportButton.contains(target)) this.showSounds(false)
    })
    this.tracksMenu.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null
      if (to && !this.tracksMenu.contains(to) && to !== this.tracksButton) this.showTracks(false)
    })
    this.tracksMenu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      this.showTracks(false)
      this.tracksButton.focus()
    })
    document.body.append(this.tracksMenu, this.soundMenu)
    actions.replaceChildren(this.styleSelect, this.laneSelect, this.minTextLabel, this.melodyLabel, this.exportButton, this.tracksButton, this.range, this.placeSelect)
    this.styled(false)
    new ResizeObserver(() => this.draw()).observe(host)
  }

  get style(): PianoStyle {
    const value = this.styleSelect.value
    return value === 'karaoke' || value === 'both' ? value : 'keys'
  }

  /** Karaoke is shown, alone or over the keyboard. */
  get karaoke(): boolean {
    return this.style !== 'keys'
  }

  get lane(): KaraokeLane {
    return this.laneSelect.value === 'staff' ? 'staff' : 'roll'
  }

  /** Karaoke with the melody heard over a backing track (D135). */
  get melodyOn(): boolean {
    return this.melody.checked
  }

  /** Shows `text` over the karaoke for a moment; false when Karaoke is not shown, so the caller says it elsewhere. */
  flash(text: string): boolean {
    if (!this.shown || !this.karaoke) return false
    this.flashLabel.textContent = text
    this.flashLabel.classList.add('shown')
    clearTimeout(this.flashTimer)
    this.flashTimer = window.setTimeout(() => this.flashLabel.classList.remove('shown'), 900)
    return true
  }

  private get full(): boolean {
    return this.options.host.classList.contains('karaoke-full')
  }

  /** Karaoke over the whole window, its controls in a corner, or back in its pane. */
  private fullWindow(full: boolean): void {
    this.options.host.classList.toggle('karaoke-full', full)
    this.showFullToggle()
    if (full) this.options.host.focus()
    this.draw()
  }

  /** The corner's icon: four corners going out, or coming in in the full window. */
  private showFullToggle(): void {
    const full = this.full
    this.fullToggle.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${full ? 'M6 2v4H2M10 2v4h4M10 14v-4h4M6 14v-4H2' : 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4'}"/></svg>`
    this.fullToggle.title = full ? 'Back in the pane (double-click or Esc)' : 'Karaoke over the whole window (or double-click it)'
    this.fullToggle.setAttribute('aria-label', full ? 'Leave the full window' : 'Full window')
  }

  private styled(notify = true): void {
    const { karaoke, style } = this
    this.range.hidden = style === 'karaoke'
    this.laneSelect.hidden = !karaoke
    this.minTextLabel.hidden = !karaoke
    this.melodyLabel.hidden = !karaoke
    this.options.host.classList.toggle('karaoke', karaoke)
    this.exportButton.hidden = !karaoke || !this.options.onExportVideo
    if (!karaoke) this.options.host.classList.remove('karaoke-full')
    this.showFullToggle()
    if (notify) this.options.onStyle?.()
    const notes = this.lane === 'staff' ? 'The notes on a staff running past a line' : 'The notes running past a line'
    this.canvas.setAttribute(
      'aria-label',
      style === 'keys'
        ? 'The notes falling onto a piano keyboard as they play'
        : `${notes}, with the words below them, as they are sung${style === 'both' ? ', and falling onto a piano keyboard below' : ''}`,
    )
  }

  get visible(): boolean {
    return this.shown
  }

  /** Over the source or below the score, as last chosen. */
  get place(): PianoPlace {
    return this.placeSelect.value === 'score' ? 'score' : 'source'
  }

  set place(place: PianoPlace) {
    this.placeSelect.value = place
    store(PLACE_KEY, place)
  }

  show(shown: boolean): void {
    this.shown = shown
    if (!shown) {
      this.showTracks(false)
      this.options.host.classList.remove('karaoke-full')
      this.showFullToggle()
    }
    this.options.onStyle?.()
    this.update()
  }

  /** The player changed: other music, a seek, play or pause. */
  update(): void {
    if (!this.shown) return
    const { playing, position, midi } = this.options.source
    const label = playing ? '❚❚' : '▶︎'
    if (this.controlPlay.textContent !== label) this.controlPlay.textContent = label
    this.controlPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    const time = midi ? `${formatTime(position)} / ${formatTime(midi.duration)}` : ''
    if (this.controlTime.textContent !== time) this.controlTime.textContent = time
    this.draw()
    if (this.options.source.playing && !this.frame) this.frame = requestAnimationFrame(() => this.animate())
  }

  private animate(): void {
    this.frame = 0
    if (!this.shown) return
    this.draw()
    if (this.options.source.playing) this.frame = requestAnimationFrame(() => this.animate())
  }

  /** The notes of the player's music, found again when it has other music. */
  private load(): void {
    const { rootFile } = this.options.source
    const midi = this.options.source.score
    if (rootFile !== this.hiddenFor) {
      if (this.hiddenFor) hiddenTracks.set(this.hiddenFor, this.hidden)
      this.hiddenFor = rootFile
      this.hidden = new Set(rootFile ? hiddenTracks.get(rootFile) : [])
      this.midi = undefined
    }
    if (midi === this.midi) return
    this.midi = midi
    this.allNotes = pianoNotes(midi)
    this.tracks = pianoTracks(this.allNotes, this.options.source.parts)
    this.colors = new Map(this.tracks.map(({ track, color }) => [track, color]))
    this.filter()
    if (!this.tracksMenu.hidden) this.fillTracks()
  }

  /** The notes of the tracks shown. */
  private filter(): void {
    this.notes = this.hidden.size === 0 ? this.allNotes : this.allNotes.filter((note) => !this.hidden.has(note.track))
    this.longest = this.notes.reduce((longest, note) => Math.max(longest, note.duration), 0)
    this.tracksButton.classList.toggle('filtered', this.tracks.some(({ track }) => this.hidden.has(track)))
  }

  private showTracks(open: boolean): void {
    if (open) {
      this.load()
      this.fillTracks()
      const rect = this.tracksButton.getBoundingClientRect()
      this.tracksMenu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 240))}px`
      this.tracksMenu.style.top = `${rect.bottom + 4}px`
    }
    this.tracksMenu.hidden = !open
    this.tracksButton.setAttribute('aria-expanded', String(open))
    if (open) this.tracksMenu.querySelector<HTMLInputElement>('input')?.focus()
  }

  /**
   * Export Video's menu (D155): a box for each part and recording, as they
   * are heard to start with, and Export Video… to export what is ticked.
   */
  private showSounds(open: boolean): void {
    if (open) {
      const sounds = this.options.videoSounds?.() ?? []
      const heading = document.createElement('p')
      heading.className = 'karaoke-sounds-heading'
      heading.textContent = 'Sound in the video'
      const boxes = sounds.map(({ id, name, checked }) => {
        const label = document.createElement('label')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = checked
        box.value = id
        const text = document.createElement('span')
        text.textContent = name
        label.append(box, text)
        return { label, box }
      })
      const go = document.createElement('button')
      go.type = 'button'
      go.className = 'karaoke-sound-export'
      go.textContent = 'Export Video…'
      go.title = 'Save the karaoke as an MP4 video with the sound ticked'
      go.addEventListener('click', () => {
        this.showSounds(false)
        this.options.onExportVideo?.(new Set(boxes.filter(({ box }) => box.checked).map(({ box }) => box.value)))
      })
      this.soundMenu.replaceChildren(heading, ...boxes.map(({ label }) => label), go)
      const rect = this.exportButton.getBoundingClientRect()
      this.soundMenu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 240))}px`
      this.soundMenu.style.top = `${rect.bottom + 4}px`
    }
    this.soundMenu.hidden = !open
    this.exportButton.setAttribute('aria-expanded', String(open))
    if (open) this.soundMenu.querySelector<HTMLElement>('input, button')?.focus()
  }

  /** A box per track, ticked while its notes fall. */
  private fillTracks(): void {
    if (this.tracks.length === 0) {
      const none = document.createElement('p')
      none.className = 'piano-tracks-none'
      none.textContent = 'No notes on the keys'
      this.tracksMenu.replaceChildren(none)
      return
    }
    this.tracksMenu.replaceChildren(
      ...this.tracks.map(({ track, name, color }) => {
        const label = document.createElement('label')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = !this.hidden.has(track)
        box.addEventListener('change', () => this.showTrack(track, box.checked))
        const swatch = document.createElement('span')
        swatch.className = 'piano-swatch'
        swatch.style.background = color
        const text = document.createElement('span')
        text.textContent = name
        label.append(box, swatch, text)
        return label
      }),
    )
  }

  private showTrack(track: number, shown: boolean): void {
    if (shown) this.hidden.delete(track)
    else this.hidden.add(track)
    this.filter()
    this.draw()
  }

  private draw(): void {
    if (!this.shown) return
    this.load()
    const { canvas } = this
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return
    const scale = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(scale, 0, 0, scale, 0, 0)
    const midi = this.midi
    this.empty.hidden = !!midi && this.notes.length > 0
    this.empty.textContent = !midi
      ? 'The score has no MIDI: press Add MIDI to see it played.'
      : this.allNotes.length > 0
        ? 'Every track is hidden: tick one in Tracks.'
        : 'The score has no notes a piano plays.'
    const notice = midi ? trackNotice(this.tracks, this.hidden, this.options.source.muted) : ''
    if (this.notice.textContent !== notice) this.notice.textContent = notice
    this.notice.hidden = !notice || !this.empty.hidden
    const now = this.options.source.position
    if (this.karaoke) drawKaraoke(context, { ...this.karaokeScene(), width, height, now })
    else drawKeys(context, { width, height, now, notes: this.notes, longest: this.longest, range: this.keyRange, color: (track) => this.colors.get(track) ?? PART_COLORS[0]! })
  }

  private get keyRange(): KeyRange {
    return this.range.value === 'notes' ? 'notes' : 'full'
  }

  /** Export Video's label: what it does, or how far the export is and that a click cancels it, which it does at any step (D140). */
  exporting(part: number | undefined): void {
    this.exportRunning = part !== undefined
    this.exportButton.textContent = part === undefined ? 'Export Video' : `Cancel ${Math.floor(part * 100)}%`
    this.exportButton.title = part === undefined ? 'Save the karaoke as an MP4 video, with the parts and recordings you choose' : 'Stop exporting the video'
  }

  /**
   * Karaoke (D133): the notes and words of the tracks shown, the words found
   * again when the map or the tracks shown change. Export Video draws them too (D140).
   */
  karaokeScene(): KaraokeScene {
    this.load()
    const { timing } = this.options.source
    const midi = this.midi
    if (!this.phrasesFor || this.phrasesFor.timing !== timing || this.phrasesFor.notes !== this.notes) {
      this.phrasesFor = { timing, notes: this.notes }
      const syllables = midi
        ? syllablesOf(timing?.lyrics ?? [], (at) => momentTime(midi, at), this.allNotes, voiceTracks(timing?.staves, midi.tracks), this.options.source.voiceTimes)
        : []
      const shown = syllables.filter(({ track }) => !this.hidden.has(track))
      this.phrases = phrasesOf(shown)
      this.wordsHidden = syllables.length > 0 && shown.length === 0
    }
    return {
      notes: this.notes,
      longest: this.longest,
      phrases: this.phrases,
      wordsHidden: this.wordsHidden,
      color: (track) => (track < 0 ? WORDS_COLOR : (this.colors.get(track) ?? PART_COLORS[0]!)),
      name: noteName,
      staff: this.lane === 'staff' ? this.staffScene() : undefined,
      keys: this.style === 'both' ? this.keyRange : undefined,
      minText: minTextOf(this.minText.value),
    }
  }

  /** The notes' lengths, the bar lines, the clefs and the key, found again with other music or another map (D156). */
  private staffScene(): StaffScene | undefined {
    const midi = this.midi
    if (!midi) return undefined
    const { timing } = this.options.source
    if (this.staffFor?.midi !== midi || this.staffFor.timing !== timing) {
      const seconds = (at: number) => momentTime(midi, at)
      // A voice at its sung times has its written lengths through its map (D276).
      const voices = this.options.source.voiceTimes
      const sung = (at: number, note: Note) => {
        const map = voices?.get(note.track)
        return map ? map(seconds(at)) : seconds(at)
      }
      this.staffFor = {
        midi,
        timing,
        staff: {
          lengths: noteLengths(this.allNotes, sung),
          bars: (timing?.bars ?? []).map(({ at, number }) => ({ time: seconds(at), number })),
          clefs: trackClefs(staffTracks(timing?.staves, midi.tracks)),
          key: keyOf(this.allNotes),
        },
      }
    }
    return this.staffFor.staff
  }
}

/** What the keyboard draws: the notes of the tracks shown falling onto the keys (D116). */
export interface KeysFrame {
  width: number
  height: number
  now: number
  /** By time, and the longest of them. */
  notes: readonly Note[]
  longest: number
  range: KeyRange
  color(track: number): string
}

/** The keyboard, its notes falling onto it from SECONDS_SHOWN ahead; Karaoke draws it below itself in Both (D156). */
export function drawKeys(context: CanvasRenderingContext2D, frame: KeysFrame): void {
  const { width, height, now, notes } = frame
  const { low, high } = keyRange(notes, frame.range)
  const keys = keyboard(low, high, width)
  const byKey = new Map(keys.map((key) => [key.key, key]))
  const white = keys.find((key) => !key.black)?.width ?? width
  const keysHeight = Math.round(Math.min(Math.max(white * 5.5, 70), height * 0.3, 160))
  const top = height - keysHeight

  // The stage: a dark fall, with a line at each C and a faint one at each F.
  const fall = context.createLinearGradient(0, 0, 0, top)
  fall.addColorStop(0, '#0b0e14')
  fall.addColorStop(1, '#121722')
  context.fillStyle = fall
  context.fillRect(0, 0, width, top)
  for (const key of keys) {
    const n = key.key % 12
    if (n !== 0 && n !== 5) continue
    context.fillStyle = n === 0 ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.03)'
    context.fillRect(Math.round(key.x), 0, 1, top)
  }

  // The notes from now to SECONDS_SHOWN ahead, falling; the bottom of each is where it starts.
  const perSecond = top / SECONDS_SHOWN
  const sounding = new Map<number, string>()
  const label = Math.max(9, Math.min(13, white * 0.5))
  context.font = `600 ${label}px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'bottom'
  const end = firstFrom(notes, now + SECONDS_SHOWN)
  for (let i = firstFrom(notes, now - frame.longest); i < end; i++) {
    const note = notes[i]
    if (note.time + note.duration <= now) continue
    const key = byKey.get(note.key)
    if (!key) continue
    const color = frame.color(note.track)
    const playing = note.time <= now
    if (playing) sounding.set(note.key, color)
    const bottom = top - (note.time - now) * perSecond
    const length = Math.max(note.duration * perSecond, 4)
    const inset = key.black ? 0 : key.width * 0.12
    const x = key.x + inset
    const w = key.width - inset * 2
    const y = Math.max(bottom - length, -4)
    const h = Math.min(bottom, top) - y
    if (h <= 0) continue
    context.fillStyle = color
    context.globalAlpha = playing ? 1 : 0.88
    if (playing) {
      context.shadowColor = color
      context.shadowBlur = 12
    }
    roundRect(context, x, y, w, h, Math.min(4, w / 3))
    context.fill()
    context.shadowBlur = 0
    context.globalAlpha = 1
    context.strokeStyle = 'rgba(0, 0, 0, 0.35)'
    context.lineWidth = 1
    context.stroke()
    // Its name at its foot, when the note is long enough: dark, as the part colours are light
    // (D148), outlined in the note's colour where it is wider than a black key's note.
    if (h >= label + 4) {
      const name = noteName(note.key)
      const at = Math.min(bottom, top) - 3
      context.lineWidth = 3
      context.lineJoin = 'round'
      context.strokeStyle = color
      context.strokeText(name, x + w / 2, at)
      context.fillStyle = LABEL_COLOR
      context.fillText(name, x + w / 2, at)
    }
  }

  // The keyboard: a red felt along its top, the white keys, then the black ones over them.
  context.fillStyle = '#b3261e'
  context.fillRect(0, top, width, 3)
  const keyTop = top + 3
  const whiteHeight = height - keyTop
  context.textBaseline = 'alphabetic'
  for (const key of keys) {
    if (key.black) continue
    const color = sounding.get(key.key)
    context.fillStyle = color ?? '#f7f5ef'
    context.fillRect(key.x, keyTop, key.width, whiteHeight)
    context.fillStyle = 'rgba(0, 0, 0, 0.35)'
    context.fillRect(Math.round(key.x), keyTop, 1, whiteHeight)
    if (key.width >= 9) {
      const n = key.key % 12
      const name = n === 0 && key.width >= 18 ? `C${key.key / 12 - 1}` : noteName(key.key)
      context.font = `${n === 0 ? 600 : 400} ${Math.min(13, key.width * 0.55)}px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
      context.fillStyle = color ? LABEL_COLOR : '#555555'
      context.fillText(name, key.x + key.width / 2, height - 6)
    }
  }
  const blackHeight = whiteHeight * 0.62
  for (const key of keys) {
    if (!key.black) continue
    const color = sounding.get(key.key)
    context.fillStyle = color ?? '#16181d'
    roundRect(context, key.x, keyTop - 1, key.width, blackHeight, Math.min(3, key.width / 4))
    context.fill()
    if (!color) {
      context.fillStyle = 'rgba(255, 255, 255, 0.12)'
      context.fillRect(key.x + key.width * 0.2, keyTop + blackHeight - 8, key.width * 0.6, 4)
    }
  }
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable; the choice still holds for this run.
  }
}

function forget(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage may be unavailable; then nothing was kept either.
  }
}

/** The tracks hidden in Tracks per score, for this run only: a score opens with every track shown (D153). */
const hiddenTracks = new Map<string, ReadonlySet<number>>()

/** `names` as a sentence lists them: "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/**
 * The view's notice (D153): the tracks of `tracks` that Tracks hides, and
 * those the Parts fold mutes, each with where to turn them back on; empty
 * when every track is shown and heard.
 */
export function trackNotice(tracks: readonly PianoTrack[], hidden: ReadonlySet<number>, muted: ReadonlySet<number>): string {
  const off = (set: ReadonlySet<number>) => tracks.filter(({ track }) => set.has(track)).map(({ name }) => name)
  const notShown = off(hidden)
  const notHeard = off(muted)
  const lines = []
  if (notShown.length > 0) lines.push(`Not shown: ${listed(notShown)}. Tick ${notShown.length === 1 ? 'it' : 'them'} in Tracks to see ${notShown.length === 1 ? 'it' : 'them'}.`)
  if (notHeard.length > 0) lines.push(`Muted: ${listed(notHeard)}. Turn ${notHeard.length === 1 ? 'it' : 'them'} On in Parts to hear ${notHeard.length === 1 ? 'it' : 'them'}.`)
  return lines.join(' ')
}

export function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}
