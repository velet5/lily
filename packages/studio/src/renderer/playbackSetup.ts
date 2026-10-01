// The pure half of the playback setup (DECISIONS D45): the instruments a part
// can be given, the music as the setup plays it, and the bars playback can
// start from, and the parts Export MIDI may leave out (D54). player.ts shows
// it; the Rust side keeps it per score.
import { trackInstruments, type Midi } from '@lily/common/web/midi.js'
import type { Moment, System } from '@lily/common/web/preview.js'
import type { TimedStaff } from '@lily/common/types'
import type { MutedPart, PlaybackSetup } from '../ipc'

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
  /** 1-based among the parts. */
  number: number
  /** What to call it, such as "S.A" or "Piano · F clef" (see `partNames`). */
  name: string
  /** What the score has it play, as lilypond names it. */
  written: string
  drums: boolean
}

/**
 * The parts of `midi`. `staves` is what the playback map says about each
 * staff, in the order of the tracks after the first; when it does not have
 * one per track, the parts are named from the tracks alone.
 */
export function partsOf(midi: Midi, staves?: TimedStaff[]): Part[] {
  const known = staves && staves.length === midi.tracks.length - 1 ? staves : undefined
  const found: (Omit<Part, 'name'> & { staff: TimedStaff })[] = []
  midi.tracks.forEach((track, index) => {
    if (track.notes === 0) return
    const drums = track.channels.length > 0 && track.channels.every((channel) => channel === DRUMS)
    found.push({
      track: index,
      number: found.length + 1,
      written: trackInstruments(track) || 'acoustic grand',
      drums,
      staff: known?.[index - 1] ?? guessedStaff(track.name, midi.notes.filter((note) => note.track === index)),
    })
  })
  const names = partNames(found)
  return found.map(({ track, number, written, drums }, index) => ({ track, number, name: names[index], written, drums }))
}

/**
 * A staff as far as a track tells: lilypond names each track
 * `<staff id>:<first voice id>`, and the clef is guessed from the pitches.
 */
function guessedStaff(name: string, notes: { key: number }[]): TimedStaff {
  const colon = name.indexOf(':')
  const keys = notes.map((note) => note.key).sort((a, b) => a - b)
  const middle = keys[Math.floor(keys.length / 2)] ?? 60
  return {
    id: colon < 0 ? '' : name.slice(0, colon),
    name: '',
    shortName: '',
    group: '',
    groupIndex: -1,
    clef: middle >= 57 ? 'clefs.G' : 'clefs.F',
    clefTransposition: 0,
    voices: colon < 0 ? [] : [name.slice(colon + 1)],
  }
}

const ROLES: [RegExp, string, string][] = [
  [/^(s|sop|sopr|soprano|sopranos|soprani)$/, 'S', 'Soprano'],
  [/^(mz|mezzo|mezzos)$/, 'Mz', 'Mezzo'],
  [/^(a|alt|alto|altos|alti|contralto)$/, 'A', 'Alto'],
  [/^(t|ten|tenor|tenors|tenori)$/, 'T', 'Tenor'],
  [/^(bar|bari|baritone|baritones)$/, 'Bar', 'Baritone'],
  [/^(b|bas|bass|basses|bassi|basso)$/, 'B', 'Bass'],
]

/** The choir voice an id names, such as `sopranos` or `altoTwo`, if any. */
function roleOf(id: string): { short: string; long: string } | undefined {
  const word = id
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .find((part) => part !== '')
  if (!word) return undefined
  const role = ROLES.find(([pattern]) => pattern.test(word))
  return role && { short: role[1], long: role[2] }
}

/** The roles of the voices and the staff, in order: "S.A", "Tenor"; undefined when not all say one. */
function rolesOf(staff: TimedStaff): string | undefined {
  const named = staff.voices.filter((voice) => voice !== '' && !/^\d+$/.test(voice))
  const fromVoices = named.map(roleOf)
  const roles = named.length === 0 || fromVoices.includes(undefined) ? [roleOf(staff.id)].filter(Boolean) : fromVoices
  const unique = roles.filter((role, index) => roles.findIndex((other) => other!.short === role!.short) === index)
  if (unique.length === 0) return undefined
  return unique.length === 1 ? unique[0]!.long : unique.map((role) => role!.short).join('.')
}

/** `violinOne` or `violin_1` as "Violin one", "Violin 1"; undefined for a generic or numeric id. */
function humanized(id: string): string | undefined {
  const words = id
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase())
  // Nothing but numbers, or nothing at all.
  if (words.every((word) => /^\d+$/.test(word))) return undefined
  if (words.length === 1 && /^(staff|voice|music|notes|one|two|up|down|upper|lower|rh|lh|right|left)$/.test(words[0])) return undefined
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function clefName(staff: TimedStaff): string {
  const kind = staff.clef.replace(/^clefs\./, '').replace(/_change$/, '')
  const clef = kind === 'G' || kind === 'F' || kind === 'C' ? `${kind} clef` : kind === 'percussion' ? 'drums' : `${kind} clef`
  return staff.clefTransposition !== 0 && kind === 'G' ? 'G clef 8vb' : clef
}

/** The written instrument as a player would call it: "Piano", "Organ", "Violin". */
function instrumentLabel(written: string): string {
  const first = written.split(', ')[0]
  if (/grand|acoustic$|honky|electric piano/.test(first)) return 'Piano'
  if (/organ/.test(first)) return 'Organ'
  if (first === 'orchestral harp') return 'Harp'
  if (first === 'choir aahs' || first === 'voice oohs') return 'Voice'
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/**
 * What to call each part, from what the score says about its staff:
 * - its `instrumentName` (or `shortInstrumentName`);
 * - the choir voices its voices or itself are named after: "S.A", "Tenor";
 * - in a PianoStaff or GrandStaff, the instrument and the clef: "Piano · G clef";
 * - its own id, or its only voice's: "Violin one", "Melody";
 * - in a ChoirStaff, the voices its clef and number of voices suggest:
 *   "S.A" and "T.B" for staves of two, "Soprano", "Alto", "Tenor", "Bass" for one;
 * - otherwise the instrument, with the clef when another part has it too.
 * Names that are still the same get a number.
 */
export function partNames(parts: { staff: TimedStaff; written: string; drums: boolean }[]): string[] {
  const names = parts.map(({ staff, written, drums }, index) => {
    const given = (staff.name || staff.shortName).replace(/\s+/g, ' ').trim()
    if (given) return given
    if (drums) return 'Drums'
    const roles = rolesOf(staff)
    if (roles) return roles
    if (staff.group === 'PianoStaff' || staff.group === 'GrandStaff') return `${instrumentLabel(written)} · ${clefName(staff)}`
    const own = humanized(staff.id) ?? (staff.voices.length === 1 ? humanized(staff.voices[0]) : undefined)
    if (own) return own
    if (staff.group === 'ChoirStaff') return choirGuess(parts.map((part) => part.staff), index)
    return undefined
  })
  const fallback = parts.map(({ written }) => instrumentLabel(written))
  const withClef = names.map((name, index) => {
    if (name !== undefined) return name
    const alike = fallback.filter((label, other) => names[other] === undefined && label === fallback[index]).length
    return alike > 1 ? `${fallback[index]} · ${clefName(parts[index].staff)}` : fallback[index]
  })
  return withClef.map((name, index) => {
    const same = withClef.filter((other) => other === name).length
    if (same === 1) return name
    return `${name} ${withClef.slice(0, index + 1).filter((other) => other === name).length}`
  })
}

/** A ChoirStaff staff without names, by its clef, its voices and the other staves of one voice in its group. */
function choirGuess(staves: TimedStaff[], index: number): string {
  const staff = staves[index]
  const high = staff.clef === 'clefs.G' && staff.clefTransposition === 0
  if (staff.voices.length > 1) return high ? 'S.A' : 'T.B'
  if (!high && staff.clef === 'clefs.G') return 'Tenor'
  const alike = staves
    .map((other, at) => ({ other, at }))
    .filter(({ other }) => other.groupIndex === staff.groupIndex && other.voices.length === 1 && other.clef === staff.clef && other.clefTransposition === staff.clefTransposition)
  const place = alike.findIndex(({ at }) => at === index)
  // Two treble staves are soprano and alto; two bass staves, tenor and bass.
  if (high) return place > 0 ? 'Alto' : 'Soprano'
  return place === 0 && alike.length > 1 ? 'Tenor' : 'Bass'
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

/**
 * The parts Export MIDI offers to leave out (D54): those `setup` mutes.
 * None when it mutes every part: a file without them would be silent.
 */
export function mutedParts(parts: Part[], setup: PlaybackSetup | undefined): MutedPart[] {
  const muted = parts.filter((part) => setup?.parts?.[part.track]?.muted)
  return muted.length === parts.length ? [] : muted.map(({ track, name }) => ({ track, name }))
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
