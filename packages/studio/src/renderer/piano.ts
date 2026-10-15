// The piano view (DECISIONS D116): the music the transport plays, as notes
// falling onto a keyboard, over the editor when the transport's Piano button
// or the editor's Piano tab shows it. The keyboard has all 88 keys, or the
// octaves the score's notes are in. The notes are the player's, so a muted
// part is not there and a seek moves them; the drums have no keys.
import type { Midi, Note } from '@lily/common/web/midi.js'

/** The 88 keys of a piano, A0 to C8. */
export const LOWEST = 21
export const HIGHEST = 108
const DRUMS = 9

export type KeyRange = 'full' | 'notes'

/** What the view shows: the music the player has and where it is. */
export interface PianoSource {
  readonly midi: Midi | undefined
  readonly position: number
  readonly playing: boolean
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

/** A colour per part, as a piano video gives each hand its own. */
const PART_COLORS = ['#7cc653', '#3f78d6', '#e8a33d', '#b764d8', '#3cbfc4', '#e0584f', '#d6c64a', '#8c8fe0']
/** How many seconds of music the fall shows above the keys. */
const SECONDS_SHOWN = 3
const RANGE_KEY = 'lily-studio.piano-range'

export interface PianoViewOptions {
  /** Where the view draws; it fills it. */
  host: HTMLElement
  /** Where its keyboard selector goes, shown with the view. */
  actions: HTMLElement
  source: PianoSource
}

export class PianoView {
  private readonly canvas = document.createElement('canvas')
  private readonly empty = document.createElement('p')
  private readonly range = document.createElement('select')
  private shown = false
  private frame = 0
  private midi: Midi | undefined
  private notes: Note[] = []
  /** The longest note, so the search for what is on screen can start early enough. */
  private longest = 0
  /** The tracks with notes in the order they come, for their colours. */
  private colors = new Map<number, string>()

  constructor(private readonly options: PianoViewOptions) {
    const { host, actions } = options
    host.classList.add('piano')
    this.canvas.className = 'piano-canvas'
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', 'The notes falling onto a piano keyboard as they play')
    this.empty.className = 'piano-empty'
    this.empty.hidden = true
    host.replaceChildren(this.canvas, this.empty)
    this.range.className = 'piano-range'
    this.range.setAttribute('aria-label', 'Keys shown')
    this.range.title = 'The whole keyboard, or the octaves the score’s notes are in'
    this.range.append(new Option('All 88 keys', 'full'), new Option('The score’s notes', 'notes'))
    this.range.value = storedRange()
    this.range.addEventListener('change', () => {
      try {
        localStorage.setItem(RANGE_KEY, this.range.value)
      } catch {
        // Storage may be unavailable; the choice still holds for this run.
      }
      this.draw()
    })
    actions.replaceChildren(this.range)
    new ResizeObserver(() => this.draw()).observe(host)
  }

  get visible(): boolean {
    return this.shown
  }

  show(shown: boolean): void {
    this.shown = shown
    this.update()
  }

  /** The player changed: other music, a seek, play or pause. */
  update(): void {
    if (!this.shown) return
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
    const { midi } = this.options.source
    if (midi === this.midi) return
    this.midi = midi
    this.notes = pianoNotes(midi)
    this.longest = this.notes.reduce((longest, note) => Math.max(longest, note.duration), 0)
    this.colors = new Map()
    for (const { track } of this.notes) {
      if (!this.colors.has(track)) this.colors.set(track, PART_COLORS[this.colors.size % PART_COLORS.length])
    }
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

    const { low, high } = keyRange(this.notes, this.range.value === 'notes' ? 'notes' : 'full')
    const keys = keyboard(low, high, width)
    const byKey = new Map(keys.map((key) => [key.key, key]))
    const white = keys.find((key) => !key.black)?.width ?? width
    const keysHeight = Math.round(Math.min(Math.max(white * 5.5, 70), height * 0.3, 160))
    const top = height - keysHeight
    const midi = this.options.source.midi
    this.empty.hidden = !!midi && this.notes.length > 0
    this.empty.textContent = midi ? 'The score has no notes a piano plays.' : 'The score has no MIDI: press Add MIDI to see it played.'

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
    const now = this.options.source.position
    const perSecond = top / SECONDS_SHOWN
    const sounding = new Map<number, string>()
    const label = Math.max(9, Math.min(13, white * 0.5))
    context.font = `600 ${label}px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    const end = firstFrom(this.notes, now + SECONDS_SHOWN)
    for (let i = firstFrom(this.notes, now - this.longest); i < end; i++) {
      const note = this.notes[i]
      if (note.time + note.duration <= now) continue
      const key = byKey.get(note.key)
      if (!key) continue
      const color = this.colors.get(note.track) ?? PART_COLORS[0]
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
      // Its name at its foot, when the note is long enough; it may be wider than a black key's note.
      if (h >= label + 4) {
        context.fillStyle = '#ffffff'
        context.shadowColor = 'rgba(0, 0, 0, 0.7)'
        context.shadowBlur = 3
        context.fillText(noteName(note.key), x + w / 2, Math.min(bottom, top) - 3)
        context.shadowBlur = 0
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
        context.fillStyle = color ? '#ffffff' : '#555555'
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
}

function storedRange(): KeyRange {
  try {
    return localStorage.getItem(RANGE_KEY) === 'notes' ? 'notes' : 'full'
  } catch {
    return 'full'
  }
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + r, y)
  context.arcTo(x + width, y, x + width, y + height, r)
  context.arcTo(x + width, y + height, x, y + height, r)
  context.arcTo(x, y + height, x, y, r)
  context.arcTo(x, y, x + width, y, r)
  context.closePath()
}
