// A transcribed stem as LilyPond music (DECISIONS D113): lily-transcribe's
// notes, in sixteenths from bar 1, become bars of notes and rests as a person
// would type them. Pitches are spelled in the song's key and written in
// \relative; a note longer than its place in the bar allows is split and
// tied, also across bar lines; empty bars become whole-bar rests. Pure, so
// the tests run it without a DOM or lilypond.
import type { Transcription } from '../ipc'

export type TranscribedNote = Transcription['notes'][number]

/** A pitch as LilyPond names it: a step of c d e f g a b, an alteration in semitones, and the MIDI octave (middle C is in 4). */
export interface Spelled {
  step: number
  alter: number
  octave: number
}

const STEP_PITCHES = [0, 2, 4, 5, 7, 9, 11]
const STEP_NAMES = ['c', 'd', 'e', 'f', 'g', 'a', 'b']

// Each semitone above the tonic as a degree of the scale: a chromatic note is
// the degree it most often alters, as #1, b3, #4, b6 and b7 in major, and b2,
// the major third, #4, the major sixth and the leading tone in minor.
const MAJOR_DEGREES = [0, 0, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6]
const MINOR_DEGREES = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6]
// The tonic of each pitch class as [step, alter], with the fewer accidentals in its signature.
const MAJOR_TONICS = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]] as const
const MINOR_TONICS = [[0, 0], [0, 1], [1, 0], [2, -1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [6, -1], [6, 0]] as const

export type Key = Transcription['key']

/** How a MIDI pitch is spelled in `key`. */
export function spell(pitch: number, key: Key): Spelled {
  const tonic = ((key.tonic % 12) + 12) % 12
  const [tonicStep] = (key.mode === 'minor' ? MINOR_TONICS : MAJOR_TONICS)[tonic]!
  const degree = (key.mode === 'minor' ? MINOR_DEGREES : MAJOR_DEGREES)[(((pitch - tonic) % 12) + 12) % 12]!
  const step = (tonicStep + degree) % 7
  const natural = STEP_PITCHES[step]!
  const alter = ((((pitch % 12) - natural + 18) % 12) + 12) % 12 - 6
  return { step, alter, octave: (pitch - alter - natural) / 12 - 1 }
}

/** A step and alteration as a note name in LilyPond's default (Dutch) names: es, as, bes, fis… */
export function noteName({ step, alter }: Pick<Spelled, 'step' | 'alter'>): string {
  const name = STEP_NAMES[step]!
  if (alter > 0) return name + 'is'.repeat(alter)
  if (alter < 0) return (name === 'e' || name === 'a' ? `${name}s` : `${name}es`) + 'es'.repeat(-alter - 1)
  return name
}

function tonic(key: Key): { step: number; alter: number } {
  const [step, alter] = (key.mode === 'minor' ? MINOR_TONICS : MAJOR_TONICS)[((key.tonic % 12) + 12) % 12]!
  return { step, alter }
}

/** `\key c \minor` and the like. */
export function keyCommand(key: Key): string {
  return `\\key ${noteName(tonic(key))} \\${key.mode}`
}

/** The key in words: "C minor", "F♯ major". */
export function keyWords(key: Key): string {
  const { step, alter } = tonic(key)
  return `${STEP_NAMES[step]!.toUpperCase()}${alter > 0 ? '♯' : alter < 0 ? '♭' : ''} ${key.mode}`
}

/**
 * Writes pitches in \relative, as `\relative { … }` without a start pitch
 * reads them: the first note is written in its absolute octave, each later
 * one in the octave nearest the note before (a fourth or less), marked with
 * ' or , when it is not. In a chord, each note is nearest the one before it
 * in the chord, and the chord's first note is the next one's reference.
 */
export class RelativeWriter {
  // \relative without a pitch starts from f, below middle C: the first note's octave marks are then its absolute ones.
  private reference = 3 * 7 + 3

  constructor(private readonly key: Key) {}

  /** One note or a chord; the duration goes after it. */
  write(pitches: readonly number[]): string {
    if (pitches.length === 1) return this.next(spell(pitches[0]!, this.key))
    let first: number | undefined
    const names = pitches.map((pitch) => {
      const name = this.next(spell(pitch, this.key))
      first ??= this.reference
      return name
    })
    // The chord's first note is the reference after it.
    if (first !== undefined) this.reference = first
    return `<${names.join(' ')}>`
  }

  private next(pitch: Spelled): string {
    const index = pitch.octave * 7 + pitch.step
    const distance = index - this.reference
    // The same step a fourth or less away, up or down.
    const nearest = ((distance % 7) + 10) % 7 - 3
    const octaves = (distance - nearest) / 7
    this.reference = index
    return noteName(pitch) + (octaves > 0 ? "'".repeat(octaves) : ','.repeat(-octaves))
  }
}

/** Sixteenths as a LilyPond duration. */
const DURATIONS: Record<number, string> = { 16: '1', 12: '2.', 8: '2', 6: '4.', 4: '4', 3: '8.', 2: '8', 1: '16' }
const VALUES = [16, 12, 8, 6, 4, 3, 2, 1]

/**
 * Whether a note of `length` sixteenths may start `at` sixteenths into a bar
 * of quarter beats. Halves start on a beat, quarters and dotted quarters on
 * an eighth (the syncopations of pop: a quarter on the "and", the 3-3-2 of a
 * dotted quarter on 1 and the "and" of 2), a dotted eighth on a beat or a
 * sixteenth after it.
 */
function noteFits(at: number, length: number): boolean {
  switch (length) {
    case 16:
      return at === 0
    case 12:
    case 8:
      return at % 4 === 0
    case 6:
    case 4:
      return at % 2 === 0
    case 3:
      return at % 4 <= 1
    case 2:
      return at % 2 === 0 || at % 4 === 1
    default:
      return true
  }
}

/** Rests show the beats: each starts on a multiple of its own length. */
function restFits(at: number, length: number): boolean {
  return [8, 4, 2, 1].includes(length) && at % length === 0
}

/** The lengths, in sixteenths, of the tied pieces of a note or rest from `at` to `at + length` in a bar of `bar`. */
export function pieces(at: number, length: number, bar: number, rest: boolean): number[] {
  const fits = rest ? restFits : noteFits
  const result: number[] = []
  while (length > 0) {
    const piece = VALUES.find((value) => value <= length && at + value <= bar && fits(at, value)) ?? 1
    result.push(piece)
    at += piece
    length -= piece
  }
  return result
}

export interface Layout {
  /** Sixteenths before bar 1. */
  pickup: number
  /** Bars from bar 1 to the end. */
  bars: number
  beatsPerBar: number
}

export interface VoiceText {
  /** The pickup bar's notes and rests, when there is one. */
  pickup?: string
  /** One line per bar, or per run of empty bars, each ending with a bar check. */
  bars: string[]
}

/** `\partial` for a pickup of `sixteenths`. */
export function partial(sixteenths: number): string {
  const single = DURATIONS[sixteenths]
  return `\\partial ${single ?? `16*${sixteenths}`}`
}

/**
 * `notes`, which do not overlap, as bars of `layout`, each note or chord's
 * pitches written by `pitch` (a RelativeWriter's, or drum names). Silence is
 * rests, and empty bars whole-bar rests (`R1*4`).
 */
export function voice(notes: readonly TranscribedNote[], layout: Layout, pitch: (pitches: readonly number[]) => string): VoiceText {
  const bar = layout.beatsPerBar * 4
  const start = -layout.pickup
  const end = layout.bars * bar
  // Notes and the rests between them, from the start to the end.
  const segments: { at: number; length: number; pitches?: readonly number[] }[] = []
  let now = start
  const sorted = [...notes].filter(([, length, pitches]) => length > 0 && pitches.length > 0).sort((a, b) => a[0] - b[0])
  sorted.forEach(([at, length, pitches], index) => {
    const from = Math.max(at, now)
    const until = Math.min(at + length, sorted[index + 1]?.[0] ?? end, end)
    if (until <= from) return
    if (from > now) segments.push({ at: now, length: from - now })
    segments.push({ at: from, length: until - from, pitches })
    now = until
  })
  if (now < end) segments.push({ at: now, length: end - now })

  // Each bar's words; undefined for a bar of rest.
  const words = new Map<number, string[]>()
  const rests = new Set<number>()
  for (const segment of segments) {
    let at = segment.at
    let left = segment.length
    while (left > 0) {
      const number = Math.floor(at / bar)
      const offset = at - number * bar
      const span = Math.min(left, bar - offset)
      if (!segment.pitches) {
        if (span === bar && number >= 0) rests.add(number)
        else for (const length of pieces(offset, span, bar, true)) push(words, number, `r${DURATIONS[length]}`)
      } else {
        const lengths = pieces(offset, span, bar, false)
        lengths.forEach((length, index) => {
          const written = pitch(segment.pitches!)
          const tied = index < lengths.length - 1 || span < left
          push(words, number, `${written}${DURATIONS[length]}${tied ? '~' : ''}`)
        })
      }
      at += span
      left -= span
    }
  }

  const whole = layout.beatsPerBar === 4 ? 'R1' : `R${DURATIONS[bar] ?? `4*${layout.beatsPerBar}`}`
  const lines: string[] = []
  for (let number = 0; number < layout.bars; ) {
    const label = (first: number, last: number) => (first % 4 === 0 ? ` % ${first + 1}${last > first ? `–${last + 1}` : ''}` : '')
    if (rests.has(number) && !words.has(number)) {
      let last = number
      while (rests.has(last + 1) && !words.has(last + 1)) last += 1
      const count = last - number + 1
      lines.push(`${whole}${count > 1 ? `*${count}` : ''} |${label(number, last)}`)
      number = last + 1
    } else {
      lines.push(`${(words.get(number) ?? []).join(' ')} |${label(number, number)}`)
      number += 1
    }
  }
  const pickup = layout.pickup > 0 ? (words.get(-1) ?? []).join(' ') : undefined
  return pickup === undefined ? { bars: lines } : { pickup, bars: lines }
}

function push(words: Map<number, string[]>, bar: number, word: string): void {
  const list = words.get(bar)
  if (list) list.push(word)
  else words.set(bar, [word])
}

/** General MIDI's percussion as lily-transcribe hears it, in \drummode's names. */
const DRUM_NAMES: Record<number, string> = { 35: 'bda', 36: 'bd', 38: 'sn', 40: 'sne', 42: 'hh', 44: 'hhp', 46: 'hho', 49: 'cymc', 51: 'cymr' }

/** Drum hits at once, as \drummode writes them. */
export function drums(pitches: readonly number[]): string {
  const names = pitches.map((pitch) => DRUM_NAMES[pitch] ?? 'sn')
  return names.length === 1 ? names[0]! : `<${names.join(' ')}>`
}

/**
 * A hidden \tempo that makes a pickup of `sixteenths` last `seconds` in the
 * MIDI, as long as the stem plays before bar 1, so the score's MIDI and the
 * stem start together. It counts 64ths, of which a whole number per minute
 * is close enough; LilyPond 2.24 takes no other.
 */
export function pickupTempo(sixteenths: number, seconds: number): string {
  return `\\once \\omit Score.MetronomeMark \\tempo 64 = ${Math.max(1, Math.round((240 * sixteenths) / seconds))}`
}
