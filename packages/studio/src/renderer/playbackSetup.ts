// The pure half of the playback setup (DECISIONS D45): the instruments a part
// can be given, the music as the setup plays it, and the bars playback can
// start from, and the parts Export MIDI may leave out (D54). player.ts shows
// it; the Rust side keeps it per score.
import { trackInstruments, type Midi, type Note } from '@lily/common/web/midi.js'
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
 * The MIDI file as Export MIDI writes it (D54, D264): each part on the
 * program the Parts fold chose for it, as `mixMidi` plays it. Its track's
 * program changes say that program, and a channel of it that plays notes with
 * none before is given one at the track's start; drums keep their kit. Every
 * other byte is as written. `midi` itself when the fold chose no program, or
 * when it is not a MIDI file (Export MIDI says so).
 */
export function withPrograms(midi: Uint8Array, setup: PlaybackSetup | undefined): Uint8Array {
  const parts = setup?.parts ?? {}
  if (!Object.values(parts).some((part) => part.program !== undefined)) return midi
  const word = (at: number) => ((midi[at] << 24) | (midi[at + 1] << 16) | (midi[at + 2] << 8) | midi[at + 3]) >>> 0
  const tag = (at: number) => String.fromCharCode(...midi.subarray(at, at + 4))
  if (midi.length < 14 || tag(0) !== 'MThd') return midi
  const chunks: Uint8Array[] = []
  let at = 0
  let track = 0
  while (at + 8 <= midi.length) {
    const end = Math.min(at + 8 + word(at + 4), midi.length)
    const program = tag(at) === 'MTrk' ? parts[track++]?.program : undefined
    chunks.push(program === undefined ? midi.subarray(at, end) : trackWithProgram(midi.subarray(at, end), program))
    at = end
  }
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let to = 0
  for (const chunk of chunks) {
    out.set(chunk, to)
    to += chunk.length
  }
  return out
}

/** An `MTrk` chunk with its program changes saying `program` (`withPrograms`). */
function trackWithProgram(chunk: Uint8Array, program: number): Uint8Array {
  const data = chunk.slice(8)
  const playing = new Set<number>()
  const changed = new Set<number>()
  let at = 0
  let status = 0
  const length = () => {
    let value = 0
    while (at < data.length) {
      const byte = data[at++]
      value = (value << 7) | (byte & 0x7f)
      if (byte < 0x80) break
    }
    return value
  }
  while (at < data.length) {
    length()
    const first = data[at]
    if (first === 0xff) {
      at += 2
      at += length()
      status = 0
      continue
    }
    if (first === 0xf0 || first === 0xf7) {
      at++
      at += length()
      status = 0
      continue
    }
    if (first & 0x80) {
      status = first
      at++
    }
    const kind = status & 0xf0
    const channel = status & 0x0f
    if (kind === 0xc0 && channel !== DRUMS) {
      data[at] = program
      changed.add(channel)
    } else if (kind === 0x90 && channel !== DRUMS && !changed.has(channel)) {
      playing.add(channel)
    }
    at += kind === 0xc0 || kind === 0xd0 ? 1 : 2
  }
  const added = [...playing].flatMap((channel) => [0, 0xc0 | channel, program])
  const out = new Uint8Array(8 + added.length + data.length)
  out.set(chunk.subarray(0, 4))
  new DataView(out.buffer).setUint32(4, added.length + data.length)
  out.set(added, 8)
  out.set(data, 8 + added.length)
  return out
}

/**
 * The parts Export MIDI offers to leave out (D54): those `setup` mutes.
 * None when it mutes every part: a file without them would be silent.
 */
export function mutedParts(parts: Part[], setup: PlaybackSetup | undefined): MutedPart[] {
  const muted = parts.filter((part) => setup?.parts?.[part.track]?.muted)
  return muted.length === parts.length ? [] : muted.map(({ track, name }) => ({ track, name }))
}

/** A part's volume in percent (D121): 100 as the score has it, 0 to 200. */
export function partVolume(setup: PlaybackSetup | undefined, track: number): number {
  return setup?.parts?.[track]?.volume ?? 100
}

/** `setup` with part `track` changed; what is back to the score's way is dropped. */
export function withPart(setup: PlaybackSetup, track: number, change: { program?: number | null; muted?: boolean; volume?: number }): PlaybackSetup {
  const part = { ...setup.parts?.[track] }
  if (change.program === null) delete part.program
  else if (change.program !== undefined) part.program = change.program
  if (change.muted === false) delete part.muted
  else if (change.muted) part.muted = true
  if (change.volume === 100) delete part.volume
  else if (change.volume !== undefined) part.volume = Math.min(Math.max(Math.round(change.volume), 0), 200)
  const parts = { ...setup.parts }
  if (Object.keys(part).length > 0) parts[track] = part
  else delete parts[track]
  return withField(setup, 'parts', Object.keys(parts).length > 0 ? parts : undefined)
}

/** The audio track's volume in percent (D155): 100 as recorded, 0 to 100. */
export function audioVolume(setup: PlaybackSetup | undefined): number {
  return setup?.audio?.volume ?? 100
}

/** `setup` with the audio track changed (D155); what is back to as recorded is dropped. */
export function withAudio(setup: PlaybackSetup, change: { muted?: boolean; volume?: number; end?: 'audio' | 'midi' }): PlaybackSetup {
  const audio = { ...setup.audio }
  if (change.muted === false) delete audio.muted
  else if (change.muted) audio.muted = true
  if (change.end === 'midi') delete audio.end
  else if (change.end === 'audio') audio.end = 'audio'
  const volume = change.volume === undefined ? undefined : Math.min(Math.max(Math.round(change.volume), 0), 100)
  if (volume === 100) delete audio.volume
  else if (volume !== undefined) audio.volume = volume
  return withField(setup, 'audio', Object.keys(audio).length > 0 ? audio : undefined)
}

/** `midi` lasting until `end` seconds, as the player plays it (D155): longer or shorter than its notes. */
export function withEnd(midi: Midi, end: number | undefined): Midi {
  return end === undefined || !(end > 0) || end === midi.duration ? midi : { ...midi, duration: end }
}

/** The tempo `midi` starts at, in quarter notes a minute, to the hundredth (D155). */
export function scoreBpm(midi: Midi): number {
  const tempo = tempoMap(midi)[0]?.tempo ?? 500_000
  return Math.round(6e9 / tempo) / 100
}

/**
 * `midi` played at `bpm` quarter notes a minute from its start (D155): every
 * time, length and tempo in it scaled alike, so a later tempo change keeps
 * its proportion and the map's moments (momentTime) stay on their notes.
 * `midi` itself without a `bpm`, or at its own.
 */
export function atTempo(midi: Midi, bpm: number | undefined): Midi {
  const stretch = tempoStretch(midi, bpm)
  if (stretch === 1) return midi
  const tempos = tempoMap(midi).map((entry) => ({ ...entry, seconds: entry.seconds * stretch, tempo: entry.tempo * stretch }))
  const notes = midi.notes.map((note) => ({ ...note, time: note.time * stretch, duration: note.duration * stretch }))
  return { ...midi, notes, duration: midi.duration * stretch, tempos } as Midi
}

/**
 * What atTempo multiplies every time and tempo (µs a quarter) of `midi` by to
 * play it at `bpm`: its first tempo, to the hundredth, over `bpm`. 1 without
 * a `bpm`, at its own, or for music without a tempo event.
 */
export function tempoStretch(midi: Midi, bpm: number | undefined): number {
  if (bpm === undefined || !(bpm > 0) || tempoMap(midi).length === 0) return 1
  const stretch = scoreBpm(midi) / bpm
  return Number.isFinite(stretch) ? stretch : 1
}

/** midi.js's tempo map, which momentTime reads: `{ tick, seconds, tempo }`, tempo in µs a quarter. */
function tempoMap(midi: Midi): { tick: number; seconds: number; tempo: number }[] {
  return (midi as Midi & { tempos?: { tick: number; seconds: number; tempo: number }[] }).tempos ?? []
}

// ---- A singer's own timing (DECISIONS D276) ----
// After atTempo (or atBars, once audio-tempo §4's bar map exists), a voice
// whose `% Audio sung` lines still fit its notes has them moved by their
// shifts, and gets a time map of its own, from the grid's seconds to the sung
// ones, which carries its other moments: its note heads and the playhead in
// the preview, and Karaoke's syllables and staff. Every other part, the bars
// and the beat keep the grid.

/** A voice's sung times: its MIDI track, and each note's shift from the grid in ms, in the order played. */
export interface SungShifts {
  track: number
  shifts: readonly number[]
}

/** A voice's time map: the seconds its moment at `seconds` on the grid is sung at. */
export type TimeMap = (seconds: number) => number

/** Notes of a voice that start this close together are a chord, which moves as one, in seconds (sung.py's TOGETHER). */
const CHORD = 0.001
/** How far after the note before it a note is put at the earliest, in seconds: the order never changes (D276). */
const AFTER = 0.001
/** A voice's map goes from the grid to its first shift over this long before its first note, and back after its last, in seconds. */
const RAMP = 1

/**
 * `midi` with the notes of each of `voices` moved by their shifts (D276),
 * and each moved voice's time map, by track. The notes are the track's in
 * the order played (by time, a chord's from its lowest, as sungMismatch's
 * `voiceNotes`), matched to the shifts in order; a chord moves by its first
 * note's. A note put at or before the one before it is put 1 ms after it,
 * and never before 0. A note that ran into the next one (legato) ends where
 * the next now starts; another keeps its length, cut at the next one's
 * start. The map runs through every note's start and the last one's end,
 * and is the identity from a second (RAMP) before the first note and after
 * the last, so it is continuous and rises: a grace note before the first
 * note is not thrown behind it. A voice whose shifts do not number its
 * notes, or are all 0, keeps the grid and has no map.
 */
export function withSung(midi: Midi, voices: readonly SungShifts[]): { midi: Midi; maps: Map<number, TimeMap> } {
  const maps = new Map<number, TimeMap>()
  const moved = new Map<Note, Note>()
  for (const { track, shifts } of voices) {
    const notes = midi.notes.filter((note) => note.track === track).sort((a, b) => a.time - b.time || a.key - b.key)
    if (notes.length === 0 || notes.length !== shifts.length || shifts.every((shift) => shift === 0)) continue
    // The chords, each with its notes, its grid start and its sung one.
    const onsets: { notes: Note[]; grid: number; sung: number }[] = []
    notes.forEach((note, i) => {
      const last = onsets.at(-1)
      if (last && note.time - last.grid <= CHORD) {
        last.notes.push(note)
        return
      }
      const sung = Math.max(note.time + shifts[i]! / 1000, last ? last.sung + AFTER : 0)
      onsets.push({ notes: [note], grid: note.time, sung })
    })
    onsets.forEach(({ notes: chord, grid, sung }, k) => {
      const next = onsets[k + 1]
      for (const note of chord) {
        const legato = next !== undefined && grid + note.duration >= next.grid - CHORD
        const end = legato ? next.sung : Math.min(sung + note.duration, next?.sung ?? Infinity)
        moved.set(note, { ...note, time: sung, duration: Math.max(end - sung, AFTER) })
      }
    })
    const first = onsets[0]!
    const last = onsets.at(-1)!
    const end = last.grid + Math.max(...last.notes.map(({ duration }) => duration))
    // From the grid to the first shift and back after the last, over a ramp: the map is continuous and rises.
    const before = Math.max(RAMP, 2 * Math.abs(first.sung - first.grid))
    const after = Math.max(RAMP, 2 * Math.abs(last.sung - last.grid))
    maps.set(
      track,
      timeMap([
        [first.grid - before, first.grid - before],
        ...onsets.map(({ grid, sung }) => [grid, sung] as const),
        [end, end + last.sung - last.grid],
        [end + after, end + after],
      ]),
    )
  }
  if (moved.size === 0) return { midi, maps }
  const notes = midi.notes.map((note) => moved.get(note) ?? note).sort((a, b) => a.time - b.time)
  const duration = Math.max(midi.duration, ...[...moved.values()].map(({ time, duration }) => time + duration))
  return { midi: { ...midi, notes, duration }, maps }
}

/**
 * The piecewise-linear map through `points` (`[grid, sung]`, by grid time,
 * the sung times rising with them), and the identity before the first and
 * after the last (D276).
 */
export function timeMap(points: readonly (readonly [number, number])[]): TimeMap {
  return (seconds) => {
    if (points.length === 0 || seconds < points[0]![0] || seconds > points.at(-1)![0]) return seconds
    let low = 0
    let high = points.length - 1
    // The last point at or before `seconds`.
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (points[middle]![0] <= seconds) low = middle
      else high = middle - 1
    }
    const [x0, y0] = points[low]!
    const following = points[low + 1]
    if (!following || following[0] === x0) return y0 + (seconds - x0)
    const [x1, y1] = following
    return y0 + ((y1 - y0) * (seconds - x0)) / (x1 - x0)
  }
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
