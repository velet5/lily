// Karaoke's staff (DECISIONS D156): a singer's lane drawn as notes on a
// staff rather than as bars on a row per semitone. The staff stays put and
// the notes run past now from right to left, as the bars do: a head, stem,
// flags and dots by each note's length, its accidental in the key the notes
// are most likely in, ledger lines, and the score's bar lines. The clef is
// the one the score gives the singer's staff, when the notes fit it; else
// treble or bass, or both as a grand staff when one does not hold them.
import type { Note } from '@lily/common/web/midi.js'
import type { TimedStaff } from '@lily/common/types'
import { spell, type Key } from './notation'
import type { Section } from './karaoke'
import { firstFrom } from './piano'

export type ClefName = 'treble' | 'bass'

/** A clef the score gives a staff. */
export interface ScoreClef {
  clef: ClefName
  /** Steps it transposes by, as lilypond's `clefTransposition`: -7 for `treble_8`. */
  transposition: number
}

/** What the staff needs of the piece, found once for it. */
export interface StaffScene {
  /** Each note's length in whole notes, as the MIDI holds it. */
  lengths: ReadonlyMap<Note, number>
  /** The bar lines, in seconds, with the bars' numbers. */
  bars: readonly { time: number; number: number }[]
  /** The score's clef of each MIDI track that has one. */
  clefs: ReadonlyMap<number, ScoreClef>
  /** The key the notes are spelled in. */
  key: Key
}

/** Where the lane draws, in pixels, and where now is. */
export interface StaffBox {
  left: number
  right: number
  top: number
  bottom: number
  nowX: number
  perSecond: number
  now: number
  /** The first and last moment on screen, in seconds. */
  from: number
  to: number
  longest: number
  color(track: number): string
}

/** A staff's bottom and top line as steps from C-1: middle C is 28. */
const LINES: Record<ClefName, readonly [number, number]> = { treble: [30, 38], bass: [18, 26] }
const MIDDLE_C = 28
/** How far past a staff a note may be, in steps: three ledger lines and a note hanging under them. */
const LEDGERS = 7
/**
 * How far a staff's clef, signature and bar numbers reach past its top line
 * and below its bottom line, in steps, with a little air: treble's G♯ is 3.6
 * steps over it and its clef's tail 3.2 under; bass's bar numbers 2.3 over.
 */
const HEADER: Record<ClefName, { above: number; below: number }> = { treble: { above: 4.2, below: 3.6 }, bass: { above: 3, below: 2.4 } }

/** A note's step as spelled in `key`: 7 a octave, middle C 28. */
export function stepOf(pitch: number, key: Key): number {
  const { step, octave } = spell(pitch, key)
  return octave * 7 + step
}

/** The score's clef of each staff's track, from `staffTracks`; a C clef or the drums' has none. */
export function trackClefs(pairs: readonly (readonly [TimedStaff, number])[]): Map<number, ScoreClef> {
  const clefs = new Map<number, ScoreClef>()
  for (const [staff, track] of pairs) {
    const clef = staff.clef.startsWith('clefs.G') ? 'treble' : staff.clef.startsWith('clefs.F') ? 'bass' : undefined
    if (clef && !clefs.has(track)) clefs.set(track, { clef, transposition: staff.clefTransposition })
  }
  return clefs
}

/** How the lane's staves are: one or a grand staff, and what a note's step moves by to be written. */
export interface StaffLayout {
  /** From the top: one staff, or a treble over a bass. */
  staves: ClefName[]
  /** Steps added to a sounding step to write it: 7 under `treble_8`. */
  shift: number
  /** The lowest and highest step to have room for, written. */
  low: number
  high: number
}

/**
 * The staves for notes at `steps`: the score's clef when they all fit it
 * with three ledger lines at most; else, of treble and bass, the one they
 * fit, the nearer their middle first; else a grand staff.
 */
export function staffLayout(steps: readonly number[], clef: ScoreClef | undefined): StaffLayout {
  const fits = (name: ClefName, shift: number) => {
    const [bottom, top] = LINES[name]
    return steps.every((step) => step + shift >= bottom - LEDGERS && step + shift <= top + LEDGERS)
  }
  const layout = (staves: ClefName[], shift: number): StaffLayout => {
    const written = steps.map((step) => step + shift)
    return {
      staves,
      shift,
      // Room under treble_8's clef for its 8.
      low: Math.min(LINES[staves.at(-1)!][0] - (shift === 7 ? 5 : 0), ...written),
      high: Math.max(LINES[staves[0]!][1], ...written),
    }
  }
  if (clef && fits(clef.clef, -clef.transposition)) return layout([clef.clef], -clef.transposition)
  const sorted = [...steps].sort((a, b) => a - b)
  const middle = sorted.length > 0 ? sorted[sorted.length >> 1]! : 34
  const order: ClefName[] = middle >= MIDDLE_C ? ['treble', 'bass'] : ['bass', 'treble']
  for (const name of order) if (fits(name, 0)) return layout([name], 0)
  return layout(['treble', 'bass'], 0)
}

// Krumhansl and Kessler's key profiles: how well each degree fits a key, from the tonic up.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/**
 * The key `notes` are most likely in: the major or minor key whose profile
 * their time on each pitch class follows best; of two alike, the one with
 * fewer accidentals. C major without notes.
 */
export function keyOf(notes: readonly Note[]): Key {
  const weights = Array.from({ length: 12 }, () => 0)
  for (const { key, duration } of notes) weights[((key % 12) + 12) % 12] += duration
  let best: Key = { tonic: 0, mode: 'major', fit: 0 }
  if (weights.every((weight) => weight === 0)) return best
  let bestFit = -Infinity
  for (const mode of ['major', 'minor'] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
      const fit = correlation(weights, weights.map((_, pc) => profile[(pc - tonic + 12) % 12]!))
      const key: Key = { tonic, mode, fit }
      if (fit > bestFit + 1e-9 || (Math.abs(fit - bestFit) <= 1e-9 && Math.abs(fifthsOf(key)) < Math.abs(fifthsOf(best)))) {
        best = key
        bestFit = fit
      }
    }
  }
  return best
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
  const [ma, mb] = [mean(a), mean(b)]
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb)
    aa += (a[i]! - ma) ** 2
    bb += (b[i]! - mb) ** 2
  }
  return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb)
}

/** Sharps in `key`'s signature, flats as less than 0. */
export function fifthsOf(key: Key): number {
  const { step, alter } = spell(60 + key.tonic, key)
  // A major or minor key on each step, without an alteration.
  const natural = key.mode === 'major' ? [0, 2, 4, -1, 1, 3, 5] : [-3, -1, 1, -4, -2, 0, 2]
  return natural[step]! + 7 * alter
}

/** The steps (0 for C) a signature alters, in order. */
const SHARP_STEPS = [3, 0, 4, 1, 5, 2, 6]
const FLAT_STEPS = [6, 2, 5, 1, 4, 0, 3]

/** How the signature of `fifths` alters a note of `step` (0 for C to 6 for B). */
export function signatureAlter(step: number, fifths: number): number {
  if (fifths > 0) return SHARP_STEPS.indexOf(step) < fifths ? 1 : 0
  if (fifths < 0) return FLAT_STEPS.indexOf(step) < -fifths ? -1 : 0
  return 0
}

/** The accidental to print before `pitch` in `key`, or '' when the signature has it. */
export function accidentalOf(pitch: number, key: Key): string {
  const { step, alter } = spell(pitch, key)
  if (alter === signatureAlter(step, fifthsOf(key))) return ''
  return alter === 0 ? '♮' : alter === 1 ? '♯' : alter === -1 ? '♭' : alter === 2 ? '𝄪' : '𝄫'
}

/** How a note of some length is printed. */
export interface NoteValue {
  head: 'whole' | 'half' | 'black'
  flags: number
  dots: number
}

const VALUES: readonly (NoteValue & { length: number })[] = [
  { length: 1.5, head: 'whole', flags: 0, dots: 1 },
  { length: 1, head: 'whole', flags: 0, dots: 0 },
  { length: 0.75, head: 'half', flags: 0, dots: 1 },
  { length: 0.5, head: 'half', flags: 0, dots: 0 },
  { length: 0.375, head: 'black', flags: 0, dots: 1 },
  { length: 0.25, head: 'black', flags: 0, dots: 0 },
  { length: 0.1875, head: 'black', flags: 1, dots: 1 },
  { length: 0.125, head: 'black', flags: 1, dots: 0 },
  { length: 0.09375, head: 'black', flags: 2, dots: 1 },
  { length: 0.0625, head: 'black', flags: 2, dots: 0 },
  { length: 0.03125, head: 'black', flags: 3, dots: 0 },
]

/** The note value nearest `length` whole notes: a tie or a triplet is drawn as the plain value it is closest to. */
export function noteValue(length: number): NoteValue {
  let best = VALUES[0]!
  for (const value of VALUES) if (Math.abs(Math.log(value.length / length)) < Math.abs(Math.log(best.length / length))) best = value
  const { head, flags, dots } = best
  return { head, flags, dots }
}

/**
 * Each note's length in whole notes, by `seconds`, which puts a moment in
 * whole notes at its time for that note (`momentTime`, and for a voice at
 * its sung times its time map after it, D276).
 */
export function noteLengths(notes: readonly Note[], seconds: (at: number, note: Note) => number): Map<Note, number> {
  const momentAt = (time: number, note: Note) => {
    let low = 0
    let high = 4
    while (seconds(high, note) < time && high < 1e6) high *= 2
    for (let i = 0; i < 40; i++) {
      const middle = (low + high) / 2
      if (seconds(middle, note) < time) low = middle
      else high = middle
    }
    return (low + high) / 2
  }
  return new Map(notes.map((note) => [note, momentAt(note.time + note.duration, note) - momentAt(note.time, note)]))
}

/** The track most of a section's words are sung on, or most of its notes are on. */
function sungTrack(section: Section): number | undefined {
  const counts = new Map<number, number>()
  for (const { track, syllables } of section.phrases) if (track >= 0) counts.set(track, (counts.get(track) ?? 0) + syllables.length)
  if (counts.size === 0) for (const { track } of section.notes) counts.set(track, (counts.get(track) ?? 0) + 1)
  let best: number | undefined
  for (const [track, count] of counts) if (best === undefined || count > counts.get(best)!) best = track
  return best
}

const layouts = new WeakMap<Section, { staff: StaffScene; layout: StaffLayout }>()

function layoutOf(section: Section, staff: StaffScene): StaffLayout {
  const kept = layouts.get(section)
  if (kept?.staff === staff) return kept.layout
  const track = sungTrack(section)
  const layout = staffLayout(
    section.notes.map(({ key }) => stepOf(key, staff.key)),
    track === undefined ? undefined : staff.clefs.get(track),
  )
  layouts.set(section, { staff, layout })
  return layout
}

/** The share of a section's height its lane takes as a staff: more for a grand staff, whose two staves need it. */
export function staffShare(section: Section, staff: StaffScene): number {
  return layoutOf(section, staff).staves.length > 1 ? 0.55 : 0.4
}

/** The music fonts a system may have, then any: the clefs and accidentals are their glyphs. */
const MUSIC_FONT = "Bravura, 'Noto Music', 'Apple Symbols', 'Segoe UI Symbol', 'DejaVu Sans', serif"

/** A glyph's ink height at a font size of 100 px, measured once. */
const inkHeights = new Map<string, { height: number; ascent: number; left: number; width: number }>()

/** Draws `glyph` with its ink from `top` to `bottom`, its left at `x` (its right, `alignRight`). */
function glyph(context: CanvasRenderingContext2D, text: string, x: number, top: number, bottom: number, alignRight = false): number {
  // The ink is measured from the baseline and the alignment drawn with: whatever
  // was drawn before leaves its own, which would put the glyph off the staff.
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  let ink = inkHeights.get(text)
  if (!ink) {
    context.font = `100px ${MUSIC_FONT}`
    const metrics = context.measureText(text)
    const height = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent
    ink = {
      height: height > 0 ? height : 100,
      ascent: height > 0 ? metrics.actualBoundingBoxAscent : 80,
      left: metrics.actualBoundingBoxLeft,
      width: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight || metrics.width,
    }
    inkHeights.set(text, ink)
  }
  const scale = (bottom - top) / ink.height
  context.font = `${100 * scale}px ${MUSIC_FONT}`
  const width = ink.width * scale
  const left = alignRight ? x - width : x
  context.fillText(text, left + ink.left * scale, top + ink.ascent * scale)
  return width
}

/** Where a signature's sharps and flats sit on a treble staff, in steps; on a bass staff, two octaves lower. */
const SHARP_PLACES = [38, 35, 39, 36, 33, 37, 34]
const FLAT_PLACES = [34, 37, 33, 36, 32, 35, 31]

/**
 * A section's lane as a staff: its lines, clef and signature on the left,
 * the bar lines, the notes running past now, each a head, stem and flags by
 * its length, lit while it sounds; words said to no note an ✕ on the middle
 * line. Notes fade out into the clef.
 */
export function drawStaff(context: CanvasRenderingContext2D, section: Section, staff: StaffScene, box: StaffBox): void {
  const layout = layoutOf(section, staff)
  const { left, right, top, bottom, nowX, perSecond, now } = box
  // A space and a half past the notes, and room for the clef, signature and bar numbers.
  const upper = layout.staves[0]!
  const lower = layout.staves.at(-1)!
  const highest = Math.max(layout.high + 3, LINES[upper][1] + HEADER[upper].above)
  const lowest = Math.min(layout.low - 3, LINES[lower][0] - HEADER[lower].below)
  const space = Math.max(4, Math.min(14, (bottom - top) / ((highest - lowest) / 2)))
  const middle = (highest + lowest) / 2
  const centre = (top + bottom) / 2
  const y = (step: number) => centre - ((step - middle) * space) / 2
  const fifths = fifthsOf(staff.key)
  const shiftOf = (clef: ClefName) => (clef === 'bass' ? -14 : 0)
  context.save()
  context.beginPath()
  context.rect(left, top, right - left, bottom - top)
  context.clip()

  // The lines, and a grand staff's two joined at the left.
  const lineWidth = Math.max(1, space * 0.09)
  context.fillStyle = 'rgba(255, 255, 255, 0.42)'
  for (const clef of layout.staves) {
    const [low, high] = LINES[clef]
    for (let step = low; step <= high; step += 2) context.fillRect(left, y(step) - lineWidth / 2, right - left, lineWidth)
  }
  const staffTop = y(LINES[layout.staves[0]!][1])
  const staffBottom = y(LINES[layout.staves.at(-1)!][0])
  if (layout.staves.length > 1) context.fillRect(left, staffTop, Math.max(1.5, space * 0.15), staffBottom - staffTop)

  // The clef and the signature.
  context.fillStyle = 'rgba(255, 255, 255, 0.85)'
  const clefX = left + space * 0.6
  let header = 0
  for (const clef of layout.staves) {
    const [low, high] = LINES[clef]
    const width =
      clef === 'treble'
        ? glyph(context, '𝄞', clefX, y(high) - space * 1.4, y(low) + space * 1.6)
        : glyph(context, '𝄢', clefX, y(high) - space * 0.05, y(low) - space * 0.5)
    // Under treble_8's clef, its 8.
    if (clef === 'treble' && layout.shift === 7) {
      context.font = `italic 600 ${space * 1.3}px Georgia, 'Times New Roman', serif`
      context.textAlign = 'center'
      context.textBaseline = 'top'
      context.fillText('8', clefX + width / 2, y(low) + space * 1.6)
    }
    let x = clefX + width + space * 0.6
    for (let i = 0; i < Math.abs(fifths); i++) {
      const at = (fifths > 0 ? SHARP_PLACES : FLAT_PLACES)[i]! + shiftOf(clef)
      x += fifths > 0 ? glyph(context, '♯', x, y(at) - space * 1.3, y(at) + space * 1.3) : glyph(context, '♭', x, y(at) - space * 1.9, y(at) + space * 0.55)
      x += space * 0.2
    }
    header = Math.max(header, x - left + space * 0.8)
  }
  const fadeFrom = left + header
  const fade = (x: number) => Math.min(1, Math.max(0, (x - fadeFrom) / (space * 3)))

  // The bar lines, numbered above.
  const barWidth = Math.max(1, space * 0.1)
  context.font = `600 ${Math.max(9, Math.min(12, space))}px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
  context.textAlign = 'left'
  context.textBaseline = 'bottom'
  for (const { time, number } of staff.bars) {
    if (time < box.from || time > box.to) continue
    const x = nowX + (time - now) * perSecond
    const alpha = fade(x)
    if (alpha === 0) continue
    context.globalAlpha = alpha
    context.fillStyle = 'rgba(255, 255, 255, 0.45)'
    context.fillRect(x - barWidth / 2, staffTop, barWidth, staffBottom - staffTop)
    if (space >= 6) {
      context.fillStyle = 'rgba(255, 255, 255, 0.4)'
      context.fillText(String(number), x + 2, staffTop - space * 0.4)
    }
  }
  context.globalAlpha = 1

  // The notes, a chord of a track's notes alike in time and length on one stem.
  const { notes } = section
  const end = firstFrom(notes, box.to)
  const groups = new Map<string, Note[]>()
  for (let i = firstFrom(notes, box.from - box.longest); i < end; i++) {
    const note = notes[i]!
    if (note.time + note.duration < box.from) continue
    const written = stepOf(note.key, staff.key) + layout.shift
    const clef = layout.staves.length > 1 && written < MIDDLE_C ? 1 : 0
    const length = staff.lengths.get(note) ?? 0.25
    const value = noteValue(length)
    const id = `${note.track}|${Math.round(note.time * 50)}|${clef}|${value.head}${value.flags}${value.dots}`
    groups.set(id, [...(groups.get(id) ?? []), note])
  }
  const rx = space * 0.62
  const ry = space * 0.44
  for (const chord of groups.values()) {
    const first = chord[0]!
    const x = nowX + (first.time - now) * perSecond
    const alpha = fade(x)
    if (alpha === 0) continue
    const value = noteValue(staff.lengths.get(first) ?? 0.25)
    const heads = chord.map((note) => ({ note, step: stepOf(note.key, staff.key) + layout.shift })).sort((a, b) => a.step - b.step)
    const clef = layout.staves[layout.staves.length > 1 && heads[0]!.step < MIDDLE_C ? 1 : 0]!
    const [lineLow, lineHigh] = LINES[clef]
    const centreLine = (lineLow + lineHigh) / 2
    const down = heads.reduce((sum, { step }) => sum + step, 0) / heads.length >= centreLine
    const color = box.color(first.track)
    const over = chord.every((note) => note.time + note.duration <= now)
    context.globalAlpha = alpha * (over ? 0.3 : 1)
    context.strokeStyle = color
    context.fillStyle = color
    // A second's heads go either side of the stem.
    const side = heads.map(() => 0)
    for (let i = 1; i < heads.length; i++) if (heads[i]!.step - heads[i - 1]!.step === 1 && side[i - 1] === 0) side[i] = down ? -1 : 1
    const stemX = x + (down ? -rx * 0.92 : rx * 0.92)
    for (const [i, { note, step }] of heads.entries()) {
      const hx = x + side[i]! * rx * 1.84
      const hy = y(step)
      // Ledger lines from the staff out to the note.
      context.fillStyle = color
      for (let ledger = lineLow - 2; ledger >= step; ledger -= 2) context.fillRect(hx - rx * 1.55, y(ledger) - lineWidth / 2, rx * 3.1, lineWidth)
      for (let ledger = lineHigh + 2; ledger <= step; ledger += 2) context.fillRect(hx - rx * 1.55, y(ledger) - lineWidth / 2, rx * 3.1, lineWidth)
      const sounding = note.time <= now && now < note.time + note.duration
      if (sounding) {
        context.shadowColor = color
        context.shadowBlur = space * 1.6
      }
      context.fillStyle = sounding ? '#ffffff' : color
      context.strokeStyle = sounding ? '#ffffff' : color
      context.beginPath()
      if (value.head === 'whole') context.ellipse(hx, hy, rx * 1.15, ry * 1.05, 0, 0, Math.PI * 2)
      else context.ellipse(hx, hy, rx, ry, -0.35, 0, Math.PI * 2)
      if (value.head === 'black') context.fill()
      else {
        context.lineWidth = space * (value.head === 'whole' ? 0.26 : 0.2)
        context.stroke()
      }
      context.shadowBlur = 0
      context.fillStyle = color
      const accidental = accidentalOf(note.key, staff.key)
      if (accidental) {
        // Left of every head of the chord.
        const at = x - rx * (side.includes(-1) ? 3.04 : 1.2) - space * 0.25
        if (accidental === '♭') glyph(context, accidental, at, hy - space * 1.9, hy + space * 0.55, true)
        else glyph(context, accidental, at, hy - space * 1.3, hy + space * 1.3, true)
      }
      for (let dot = 0; dot < value.dots; dot++) {
        const onLine = (step - lineLow) % 2 === 0
        context.beginPath()
        context.arc(x + rx * (side.includes(1) ? 2.84 : 1) + space * (0.55 + dot * 0.5), hy - (onLine ? space / 2 : 0), space * 0.16, 0, Math.PI * 2)
        context.fill()
      }
    }
    if (value.head === 'whole') continue
    // The stem from the far head out 3.5 spaces, and its flags.
    const near = y(down ? heads.at(-1)!.step : heads[0]!.step)
    const far = y(down ? heads[0]!.step : heads.at(-1)!.step) + (down ? 3.5 : -3.5) * space
    context.fillRect(stemX - Math.max(1, space * 0.12) / 2, Math.min(near, far), Math.max(1, space * 0.12), Math.abs(far - near))
    context.lineWidth = Math.max(1.2, space * 0.22)
    context.lineCap = 'round'
    for (let flag = 0; flag < value.flags; flag++) {
      const from = far + (down ? -1 : 1) * flag * space * 0.85
      const turn = down ? -1 : 1
      context.beginPath()
      context.moveTo(stemX, from)
      context.bezierCurveTo(stemX + space * 0.2, from + turn * space * 1.1, stemX + space * 1.3, from + turn * space * 1.2, stemX + space * 0.9, from + turn * space * 2.4)
      context.stroke()
    }
    context.lineCap = 'butt'
  }

  // Words said to no note: an ✕ on the top staff's middle line, dashed when whispered.
  const [low, high] = LINES[layout.staves[0]!]
  const sayY = y((low + high) / 2)
  for (const syllable of section.said) {
    if (syllable.end < box.from || syllable.start > box.to) continue
    const x = nowX + (syllable.start - now) * perSecond
    const alpha = fade(x)
    if (alpha === 0) continue
    const sounding = syllable.start <= now && now < syllable.end
    context.globalAlpha = alpha * (syllable.end <= now ? 0.3 : 1)
    context.strokeStyle = sounding ? '#ffffff' : box.color(syllable.track)
    context.lineWidth = Math.max(1.5, space * (syllable.italic ? 0.14 : 0.22))
    context.beginPath()
    context.moveTo(x - rx, sayY - ry * 1.3)
    context.lineTo(x + rx, sayY + ry * 1.3)
    context.moveTo(x + rx, sayY - ry * 1.3)
    context.lineTo(x - rx, sayY + ry * 1.3)
    context.stroke()
  }
  context.globalAlpha = 1
  context.restore()
}
