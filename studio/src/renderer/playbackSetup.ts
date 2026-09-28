// The pure half of the playback setup (DECISIONS D45): the instruments a part
// can be given, the music as the setup plays it, and the bars playback can
// start from. player.ts shows it; the Rust side keeps it per score.
import { trackInstruments, type Midi } from '../../../media/midi.js'
import type { Moment, System } from '../../../media/preview.js'
import type { PlaybackSetup } from '../ipc'

const DRUMS = 9 // channel 10

/** The General MIDI programs a part can be played on, by family. */
export const INSTRUMENT_GROUPS: { label: string; instruments: { label: string; program: number }[] }[] = [
  {
    label: 'Keyboards',
    instruments: [
      { label: 'Piano', program: 0 },
      { label: 'Bright piano', program: 1 },
      { label: 'Electric piano', program: 4 },
      { label: 'Harpsichord', program: 6 },
      { label: 'Celesta', program: 8 },
      { label: 'Church organ', program: 19 },
      { label: 'Accordion', program: 21 },
    ],
  },
  {
    label: 'Mallets',
    instruments: [
      { label: 'Glockenspiel', program: 9 },
      { label: 'Vibraphone', program: 11 },
      { label: 'Marimba', program: 12 },
      { label: 'Xylophone', program: 13 },
      { label: 'Timpani', program: 47 },
    ],
  },
  {
    label: 'Strings',
    instruments: [
      { label: 'Violin', program: 40 },
      { label: 'Viola', program: 41 },
      { label: 'Cello', program: 42 },
      { label: 'Double bass', program: 43 },
      { label: 'String ensemble', program: 48 },
      { label: 'Pizzicato strings', program: 45 },
      { label: 'Harp', program: 46 },
      { label: 'Nylon guitar', program: 24 },
      { label: 'Steel guitar', program: 25 },
      { label: 'Electric guitar', program: 26 },
      { label: 'Acoustic bass', program: 32 },
    ],
  },
  {
    label: 'Woodwinds',
    instruments: [
      { label: 'Piccolo', program: 72 },
      { label: 'Flute', program: 73 },
      { label: 'Recorder', program: 74 },
      { label: 'Oboe', program: 68 },
      { label: 'English horn', program: 69 },
      { label: 'Clarinet', program: 71 },
      { label: 'Bassoon', program: 70 },
      { label: 'Soprano sax', program: 64 },
      { label: 'Alto sax', program: 65 },
      { label: 'Tenor sax', program: 66 },
    ],
  },
  {
    label: 'Brass',
    instruments: [
      { label: 'Trumpet', program: 56 },
      { label: 'French horn', program: 60 },
      { label: 'Trombone', program: 57 },
      { label: 'Tuba', program: 58 },
      { label: 'Brass section', program: 61 },
    ],
  },
  {
    label: 'Voices and synths',
    instruments: [
      { label: 'Choir', program: 52 },
      { label: 'Voice', program: 53 },
      { label: 'Synth lead', program: 80 },
      { label: 'Warm pad', program: 89 },
    ],
  },
]

/** A part of the score: a MIDI track with notes; lilypond writes one per staff. */
export interface Part {
  /** Its track's index, which the setup keys it by. */
  track: number
  /** 1-based among the parts, for its label. */
  number: number
  /** What the score has it play, as lilypond names it. */
  written: string
  drums: boolean
}

export function partsOf(midi: Midi): Part[] {
  const parts: Part[] = []
  midi.tracks.forEach((track, index) => {
    if (track.notes === 0) return
    const drums = track.channels.length > 0 && track.channels.every((channel) => channel === DRUMS)
    parts.push({ track: index, number: parts.length + 1, written: trackInstruments(track) || 'acoustic grand', drums })
  })
  return parts
}

/**
 * The music as `setup` plays it: the notes of muted parts left out, the
 * others on the program chosen for their part. Drums keep their kit.
 * `midi` itself when the setup changes nothing.
 */
export function mixMidi(midi: Midi, setup: PlaybackSetup | undefined): Midi {
  const parts = setup?.parts
  if (!parts || Object.keys(parts).length === 0) return midi
  const notes = []
  for (const note of midi.notes) {
    const part = parts[note.track]
    if (!part) notes.push(note)
    else if (part.muted) continue
    else notes.push(part.program === undefined || note.channel === DRUMS ? note : { ...note, program: part.program })
  }
  return { ...midi, notes }
}

/** `setup` with part `track` changed; what is back to the score's way is dropped. */
export function withPart(setup: PlaybackSetup, track: number, change: { program?: number | null; muted?: boolean }): PlaybackSetup {
  const part = { ...setup.parts?.[track] }
  if (change.program === null) delete part.program
  else if (change.program !== undefined) part.program = change.program
  if (change.muted === false) delete part.muted
  else if (change.muted) part.muted = true
  const parts = { ...setup.parts }
  if (Object.keys(part).length > 0) parts[track] = part
  else delete parts[track]
  return withField(setup, 'parts', Object.keys(parts).length > 0 ? parts : undefined)
}

/** `setup` with `startBar` set, or dropped when undefined. */
export function withStartBar(setup: PlaybackSetup, bar: number | undefined): PlaybackSetup {
  return withField(setup, 'startBar', bar)
}

function withField<K extends keyof PlaybackSetup>(setup: PlaybackSetup, key: K, value: PlaybackSetup[K] | undefined): PlaybackSetup {
  const next = { ...setup }
  if (value === undefined) delete next[key]
  else next[key] = value
  return next
}

/**
 * When bar `number` begins, in the bars of a timeline (`{ time, number }` in
 * time order, as barAt reads them): where it is first played; a bar in which
 * nothing began is placed evenly between its neighbours. Undefined past the
 * last bar and before the first.
 */
export function barTime(bars: { time: number; number: number }[], number: number): number | undefined {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    if (bar.number === number) return bar.time
    const next = bars[i + 1]
    if (next && bar.number < number && number < next.number) {
      return bar.time + ((next.time - bar.time) * (number - bar.number)) / (next.number - bar.number)
    }
  }
  return undefined
}

/**
 * The moment of the pages at a point of page `page` (`x`, `y` in fractions of
 * it): on the system under the point, or the nearest one of that page, the
 * last moment at or left of `x`, or the system's first. Undefined on a page
 * without played notes.
 */
export function momentAt(line: { moments: Moment[]; systems: System[] }, page: number, x: number, y: number): Moment | undefined {
  let system = -1
  let distance = Infinity
  line.systems.forEach((candidate, index) => {
    if (candidate.page !== page) return
    const away = y < candidate.top ? candidate.top - y : y > candidate.bottom ? y - candidate.bottom : 0
    if (away < distance) {
      distance = away
      system = index
    }
  })
  if (system < 0) return undefined
  let found: Moment | undefined
  for (const moment of line.moments) {
    if (moment.system !== system) continue
    // A little to the right still counts: the note's centre is right of its bar line.
    if (!found || moment.x <= x + 0.005) found = moment
    if (moment.x > x + 0.005) break
  }
  return found
}
