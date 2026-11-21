// From the singer (DECISIONS D276): where the score differs from the singer
// of its recording. lily-transcribe's `sung` aligns one voice's words and
// pitches with the recording's lead vocals stem; this marks the voice's notes
// in the preview where they part: a note sung more than a 16th from the grid,
// a pitch not sung as written, and a phrase the stem does not sing. It is
// useful even when the alignment is rough, it writes nothing to the score,
// and it comes before any re-timing.
//
// The voice's notes are its MIDI track's (D138's `voiceTracks`), its words
// Karaoke's (`syllablesOf`), so the grid comes from the MIDI the studio
// plays, at the score's `% BPM:` and moved by its `% Audio offset:` onto the
// recording's timeline (D155). The playback map's events say nothing of the
// voice they belong to, so its note heads are found by their `textedit:`
// links: those inside the voice's music in the score's source, the braces of
// its `\new Voice = "<name>"` and the variables they use.
import { momentTime, type Midi, type Note } from '@lily/common/web/midi.js'
import { charToCharacter } from '@lily/common/span'
import type { PlaybackTiming, SungFound, SungVoice, TranscriptionEvent } from '../ipc'
import { sungGuard, sungVoiceName, type SungGuard } from './files'
import { voiceTracks } from './karaoke'
import { spell, type Key } from './notation'
import { tickAt } from './tempo'

/** How far apart a note and a syllable or an event may start and still be one, in seconds (karaoke.ts's TOGETHER). */
const TOGETHER = 0.01

/** The name `\addlyrics` gives a voice the score left without one: no line can keep its times (karaoke.ts). */
const GENERATED_NAME = /^uniqueContext\d+$/

/** A voice with words that From the singer can compare. */
export interface SingerVoice {
  /** The `Voice`'s name, as D138 reads it for Karaoke's lanes. */
  voice: string
  /** Its MIDI track. */
  track: number
  /** Another voice with words on the same track: their notes cannot be told apart yet (D276). */
  shares?: string
}

/**
 * The named voices with words in the score, each with its MIDI track, in the
 * order their words first come; a generated name is not one, as no line could
 * name it again.
 */
export function singerVoices(timing: PlaybackTiming | undefined, midi: Midi): SingerVoice[] {
  const tracks = voiceTracks(timing?.staves, midi.tracks)
  const named: string[] = []
  for (const { voice } of timing?.lyrics ?? []) {
    if (voice && !GENERATED_NAME.test(voice) && tracks.has(voice) && sungVoiceName(voice) && !named.includes(voice)) named.push(voice)
  }
  return named.map((voice) => {
    const track = tracks.get(voice)!
    const shares = named.find((other) => other !== voice && tracks.get(other) === track)
    return shares ? { voice, track, shares } : { voice, track }
  })
}

/** The notes of `track`, in the order played: by time, a chord's from its lowest. */
export function voiceNotes(midi: Midi, track: number): Note[] {
  return midi.notes.filter((note) => note.track === track).sort((a, b) => a.time - b.time || a.key - b.key)
}

/** The guard of `track`'s notes in `raw`, the score's MIDI as written: each one's start and length in its ticks. */
export function voiceGuard(raw: Midi, track: number): SungGuard {
  return sungGuard(
    voiceNotes(raw, track).map((note) => {
      const start = Math.round(tickAt(raw, note.time))
      return { start, length: Math.round(tickAt(raw, note.time + note.duration)) - start }
    }),
  )
}

/** What the comparison is kept for: the voice's rhythm and its pitches, so the marks go when either changes. */
export function voiceSignature(raw: Midi, track: number): string {
  const { count, hash } = voiceGuard(raw, track)
  return `${count} ${hash} ${voiceNotes(raw, track).map(({ key }) => key).join(',')}`
}

/** The shortest a note is sent as: `sung` refuses a length of 0. */
const SHORTEST = 0.001

/**
 * `voice`'s notes as `sung` reads them (voice.json): from `midi`, the MIDI
 * as played at the score's `% BPM:`, each moved onto the recording's timeline
 * by the `% Audio offset:` `offset` (the recording is `-offset` in when the
 * music starts, D155), with the syllable of its words that starts on it. Of
 * two lines of words sung to it (verses), the first's. `bpm` is the tempo
 * the MIDI plays at.
 */
export function voiceJson(midi: Midi, timing: PlaybackTiming | undefined, voice: string, track: number, bpm: number, offset: number): SungVoice {
  const notes = voiceNotes(midi, track)
  // On a chord, a syllable is its first note's.
  const first = notes.map((note, i) => i === 0 || note.time - notes[i - 1]!.time > TOGETHER)
  const syllables: (string | undefined)[] = notes.map(() => undefined)
  const lyrics = (timing?.lyrics ?? []).filter((lyric) => lyric.voice === voice).sort((a, b) => a.line - b.line || a.at - b.at)
  for (const lyric of lyrics) {
    const text = lyric.text.trim()
    if (text === '') continue // a skip
    const start = momentTime(midi, lyric.at)
    const index = notes.findIndex((note, i) => first[i] && Math.abs(note.time - start) <= TOGETHER)
    if (index >= 0 && syllables[index] === undefined) syllables[index] = text
  }
  return {
    bpm,
    notes: notes.map((note, i) => ({
      start: round(note.time - offset),
      length: round(Math.max(note.duration, SHORTEST)),
      pitch: note.key,
      ...(syllables[i] === undefined ? {} : { syllable: syllables[i] }),
    })),
  }
}

function round(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6
}

/** How a note's singing differs from the score. */
export type SungDifference = 'timing' | 'pitch' | 'unsung'

/** A note of the voice the comparison marks, by its index in the order played, and the title that says what differs. */
export interface SungMark {
  note: number
  kinds: SungDifference[]
  title: string
}

const NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B']

/** A MIDI pitch by name and octave, spelled in `key`: G3, F♯4, B♭2. */
export function pitchName(pitch: number, key: Key): string {
  const { step, alter, octave } = spell(pitch, key)
  const accidental = alter > 0 ? '♯'.repeat(alter) : '♭'.repeat(-alter)
  return `${NAMES[step]}${accidental}${octave}`
}

/**
 * Where `found`, `sung`'s answer, says the singer parts from `voice`'s notes,
 * spelled in `key` (D276):
 * - *sung 140 ms late*: a sure arrival more than τ, a 16th, from the grid.
 *   The arrival itself is used, not the shift, which never goes past τ:
 *   a note further off than that is where the written rhythm may be wrong;
 * - *sung A3, written G3*: a pitch not sung as written;
 * - *not in the vocals stem*: every note of a phrase that is not sung, which
 *   is not checked for either.
 */
export function sungMarks(voice: SungVoice, found: SungFound, key: Key): SungMark[] {
  if (found.notes.length !== voice.notes.length) {
    throw new Error(`The singer's answer has ${found.notes.length} notes for the voice's ${voice.notes.length}.`)
  }
  const unsung = new Set<number>()
  for (const { first, last, sung } of found.phrases) if (!sung) for (let i = first; i <= last; i++) unsung.add(i)
  const marks: SungMark[] = []
  voice.notes.forEach((note, i) => {
    if (unsung.has(i)) {
      marks.push({ note: i, kinds: ['unsung'], title: 'not in the vocals stem' })
      return
    }
    const { arrival, asWritten, heard } = found.notes[i]!
    const kinds: SungDifference[] = []
    const said: string[] = []
    const off = arrival === null ? 0 : arrival - note.start
    if (Math.abs(off) > found.tau + 1e-9) {
      kinds.push('timing')
      said.push(`sung ${Math.round(Math.abs(off) * 1000)} ms ${off > 0 ? 'late' : 'early'}`)
    }
    if (asWritten === false && heard !== null) {
      kinds.push('pitch')
      said.push(`sung ${pitchName(heard, key)}, written ${pitchName(note.pitch, key)}`)
    }
    if (kinds.length > 0) marks.push({ note: i, kinds, title: said.join('; ') })
  })
  return marks
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The status line once the comparison is done: each kind counted, whether the
 * preview could mark them (`shown` notes of them it found there), and that
 * nothing was written; `sung`'s warnings after.
 */
export function sungStatus(voice: string, marks: readonly SungMark[], found: SungFound, shown: number): string {
  const timing = marks.filter(({ kinds }) => kinds.includes('timing')).length
  const pitch = marks.filter(({ kinds }) => kinds.includes('pitch')).length
  const unsung = found.phrases.filter(({ sung, first, last }) => !sung && last >= first)
  const parts: string[] = []
  if (timing > 0) parts.push(`${count(timing, 'note')} sung more than a 16th off the grid`)
  if (pitch > 0) parts.push(`${count(pitch, 'pitch', 'pitches')} not sung as written`)
  if (unsung.length > 0) parts.push(`${count(unsung.length, 'phrase')} not in the vocals stem`)
  let said: string
  if (parts.length === 0) said = `${voice} keeps to its singer: every note sure enough to say is within a 16th of the grid and at its written pitch. Nothing was written`
  else {
    const where = shown > 0 ? 'marked in the preview' : `not marked in the preview, which cannot find ${voice}'s music in this file`
    said = `The score differs from ${voice}'s singer: ${parts.join(', ')}; ${where}. Nothing was written`
  }
  const warnings = (found.warnings ?? []).map((warning) => warning.replace(/\.?$/, ''))
  return [said, ...warnings].join('. ') + '.'
}

/** The status line while From the singer works on the recording `name`. */
export function sungProgress(name: string, stage: (TranscriptionEvent & { event: 'progress' })['stage'], value?: number): string {
  if (stage === 'separate') return `From the singer: separating the vocals of ${name}${value === undefined ? '' : ` (${Math.round(value * 100)} %)`}…`
  const doing = stage === 'decode' ? 'reading the vocals stem' : stage === 'pitch' ? 'hearing the pitches' : stage === 'words' ? 'finding the words' : 'listening'
  return `From the singer: ${doing} of ${name}…`
}

// ---- The voice's music in the source ----

/**
 * `text` with its comments blanked, every character a space but line
 * breaks, so offsets stay; strings are kept, and a `%` in one is not a comment.
 */
function withoutComments(text: string): string {
  const out = text.split('')
  let i = 0
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' '
  }
  while (i < text.length) {
    const char = text[i]
    if (char === '"') i = stringEnd(text, i)
    else if (char === '%' && text[i + 1] === '{') {
      const end = text.indexOf('%}', i + 2)
      const to = end < 0 ? text.length : end + 2
      blank(i, to)
      i = to
    } else if (char === '%') {
      const end = text.indexOf('\n', i)
      const to = end < 0 ? text.length : end
      blank(i, to)
      i = to
    } else i++
  }
  return out.join('')
}

/** The offset after the string that opens at `at`. */
function stringEnd(text: string, at: number): number {
  let i = at + 1
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
  return Math.min(i + 1, text.length)
}

/** The offset after the `{ }` or `<< >>` block that opens at `at`, nested ones and strings within; -1 when it does not close. */
function blockEnd(code: string, at: number): number {
  const closers: string[] = []
  let i = at
  while (i < code.length) {
    const char = code[i]!
    if (char === '"') {
      i = stringEnd(code, i)
      continue
    }
    const two = code.slice(i, i + 2)
    if (char === '{') {
      closers.push('}')
      i++
    } else if (two === '<<') {
      closers.push('>>')
      i += 2
    } else if (char === '}' || two === '>>') {
      const closer = char === '}' ? '}' : '>>'
      if (closers[closers.length - 1] === closer) closers.pop()
      i += closer.length
      if (closers.length === 0) return i
    } else i++
    if (closers.length === 0) return -1
  }
  return -1
}

/** A command's or a variable's name after its backslash. */
const IDENTIFIER = /^\\([A-Za-z]+(?:[-_][A-Za-z]+)*)/

/** lilypond's functions whose music comes after their own words (`\relative c'`, `\transpose c d`). */
const BEFORE_MUSIC = new Set(['relative', 'transpose', 'fixed', 'absolute', 'drummode', 'notemode', 'chordmode', 'unfoldRepeats', 'compressMMRests', 'compressEmptyMeasures'])

/**
 * Where the music expression that starts at or after `from` ends: past a
 * `\with { }`, a music function's words (`\relative c'`, `\transpose c d`),
 * to the end of its first block, or of the first variable it names. A name
 * neither defined here nor such a function (a variable from an included
 * file) is the expression by itself, so what follows it, another staff's
 * music, is not taken for it. -1 when it cannot tell.
 */
function expressionEnd(code: string, from: number, defined: ReadonlyMap<string, unknown>): number {
  let i = from
  for (let tokens = 0; tokens < 64; tokens++) {
    while (i < code.length && /\s/.test(code[i]!)) i++
    if (i >= code.length) return -1
    if (code[i] === '{' || code.startsWith('<<', i)) return blockEnd(code, i)
    const command = IDENTIFIER.exec(code.slice(i, i + 80))
    if (command) {
      i += command[0].length
      if (command[1] === 'with') {
        while (i < code.length && /\s/.test(code[i]!)) i++
        if (code[i] !== '{') return -1
        i = blockEnd(code, i)
        if (i < 0) return -1
      } else if (defined.has(command[1]!) || !BEFORE_MUSIC.has(command[1]!)) return i
      continue
    }
    // A command's word (`c'`, `bes,`) or a value that is not music.
    if (/["#=}>]/.test(code[i]!)) return -1
    while (i < code.length && !/[\s{<\\]/.test(code[i]!)) i++
  }
  return -1
}

/**
 * Where `voice`'s music is in `text`, as ranges of offsets: the expression
 * after each `\new Voice = "<voice>"` or `\context Voice = "<voice>"` (a
 * `Staff` of that name too, as `\addlyrics` sings to one, D138), and the
 * definitions of the variables used in them, and in those, at the top of
 * the file. Empty when the voice is not named in it.
 */
export function voiceRegions(text: string, voice: string): [number, number][] {
  const code = withoutComments(text)
  const defined = new Map<string, number>()
  for (const match of code.matchAll(/^([A-Za-z]+(?:[-_][A-Za-z]+)*)[ \t]*=/gm)) defined.set(match[1]!, match.index + match[0].length)
  const name = voice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regions: [number, number][] = []
  const used = new Set<string>()
  const add = (start: number, end: number) => {
    regions.push([start, end])
    for (const match of code.slice(start, end).matchAll(/\\([A-Za-z]+(?:[-_][A-Za-z]+)*)/g)) {
      const variable = match[1]!
      const at = defined.get(variable)
      if (at === undefined || used.has(variable)) continue
      used.add(variable)
      const until = expressionEnd(code, at, defined)
      if (until > at) add(at, until)
    }
  }
  const named = new RegExp(`\\\\(?:new|context)\\s+(?:Voice|Staff)\\s*=\\s*(?:"${name}"|${/^[A-Za-z]+$/.test(voice) ? `${name}(?![A-Za-z])` : '(?!)'})`, 'g')
  for (const match of code.matchAll(named)) {
    const start = match.index + match[0].length
    const end = expressionEnd(code, start, defined)
    if (end > start) add(start, end)
  }
  return regions.sort((a, b) => a[0] - b[0])
}

/** A `textedit:` link's file, line (1-based) and `CHAR` (0-based, in code points), its numbers taken from the right, as a Windows path has a colon of its own (textedit.ts). */
function parseLink(href: string): { file: string; line: number; char: number } | undefined {
  const match = /^textedit:\/\/(.+):(\d+):(\d+):\d+$/s.exec(href)
  if (!match) return undefined
  let file: string
  try {
    file = decodeURIComponent(match[1]!)
  } catch {
    return undefined
  }
  if (/^\/[A-Za-z]:[\\/]/.test(file)) file = file.slice(1)
  return { file: file.replace(/\\/g, '/'), line: Number(match[2]), char: Number(match[3]) }
}

/**
 * The file the playback map's links name for `file`: itself, or, as the
 * links name the file by its real path (a symbolic link resolved), the one
 * file of that name they point into.
 */
export function linkedFile(timing: PlaybackTiming, file: string): string {
  const wanted = file.replace(/\\/g, '/')
  const files = new Set(timing.events.flatMap(({ href }) => parseLink(href)?.file ?? []))
  if (files.has(wanted)) return wanted
  const name = wanted.split('/').pop()
  const alike = [...files].filter((linked) => linked.split('/').pop() === name)
  return alike.length === 1 ? alike[0]! : wanted
}

/** Where a `textedit:` link points in `text`, the file `file` names in the links: an offset, or undefined for another file or a place past its end. */
export function linkOffset(href: string, file: string, lineStarts: readonly number[], text: string): number | undefined {
  const link = parseLink(href)
  if (!link || link.file !== file) return undefined
  const start = lineStarts[link.line - 1]
  if (start === undefined) return undefined
  const end = lineStarts[link.line] ?? text.length
  return start + charToCharacter(text.slice(start, end), link.char)
}

/** Where each line of `text` starts. */
export function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** What one element of the preview is marked with: the kinds of its notes, and their titles. */
export interface ElementMark {
  kinds: SungDifference[]
  title: string
}

/**
 * The elements of the preview to mark: each event of the playback map that
 * `inVoice` says is the voice's, heard (by `time`) when a marked note of
 * `notes` starts, as the playback marks it `playing`: the k-th time an href
 * is played is the k-th place it is drawn when it is drawn as often, else its
 * one place (D118). The marks of the notes that start together, a chord's,
 * go on each of their elements. `notes` are the voice's in the order played,
 * in the seconds `time` gives.
 */
export function markedElements<T>(
  timing: PlaybackTiming,
  time: (at: number) => number,
  notes: readonly { time: number }[],
  marks: readonly SungMark[],
  inVoice: (href: string) => boolean,
  sourceLinks: ReadonlyMap<string, readonly T[]>,
): Map<T, ElementMark> {
  const byNote = new Map(marks.map((mark) => [mark.note, mark]))
  const uses = new Map<string, number>()
  for (const { href } of timing.events) uses.set(href, (uses.get(href) ?? 0) + 1)
  const seen = new Map<string, number>()
  const result = new Map<T, ElementMark>()
  const ordered = [...timing.events].sort((a, b) => a.at - b.at || a.grace - b.grace)
  for (const { href, at, grace } of ordered) {
    const rank = seen.get(href) ?? 0
    seen.set(href, rank + 1)
    if (grace !== 0 || !inVoice(href)) continue
    const candidates = sourceLinks.get(href) ?? []
    const element = candidates.length === uses.get(href) ? candidates[rank] : candidates.length === 1 ? candidates[0] : undefined
    if (element === undefined) continue
    const heard = time(at)
    const together: SungMark[] = []
    for (let i = firstAt(notes, heard - TOGETHER); i < notes.length && notes[i]!.time <= heard + TOGETHER; i++) {
      const mark = byNote.get(i)
      if (mark) together.push(mark)
    }
    if (together.length === 0) continue
    const kept = result.get(element) ?? { kinds: [], title: '' }
    const titles = new Set(kept.title ? kept.title.split('; ') : [])
    for (const mark of together) {
      for (const kind of mark.kinds) if (!kept.kinds.includes(kind)) kept.kinds.push(kind)
      for (const title of mark.title.split('; ')) titles.add(title)
    }
    result.set(element, { kinds: kept.kinds, title: [...titles].join('; ') })
  }
  return result
}

/** The first of `notes`, by time, at or after `time`. */
function firstAt(notes: readonly { time: number }[], time: number): number {
  let low = 0
  let high = notes.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (notes[middle]!.time < time) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * `markedElements` for the score `file`, whose text is `text`: the voice's
 * events are those whose link points inside its music there. Empty when its
 * music is not found in the file.
 */
export function sungElements<T>(
  timing: PlaybackTiming,
  midi: Midi,
  track: number,
  voice: string,
  marks: readonly SungMark[],
  file: string,
  text: string,
  sourceLinks: ReadonlyMap<string, readonly T[]>,
): Map<T, ElementMark> {
  const inVoice = marks.length === 0 ? undefined : voiceLinks(timing, voice, file, text)
  if (!inVoice) return new Map()
  return markedElements(timing, (at) => momentTime(midi, at), voiceNotes(midi, track), marks, inVoice, sourceLinks)
}

/**
 * Whether an event of the playback map is `voice`'s, in the score `file`
 * whose text is `text`: its link points inside the voice's music there.
 * Undefined when its music is not found in the file. Each href is looked up
 * once.
 */
export function voiceLinks(timing: PlaybackTiming, voice: string, file: string, text: string): ((href: string) => boolean) | undefined {
  const regions = voiceRegions(text, voice)
  if (regions.length === 0) return undefined
  const starts = lineStartsOf(text)
  const linked = linkedFile(timing, file)
  const known = new Map<string, boolean>()
  return (href) => {
    let inside = known.get(href)
    if (inside === undefined) {
      const offset = linkOffset(href, linked, starts, text)
      inside = offset !== undefined && regions.some(([start, end]) => offset >= start && offset < end)
      known.set(href, inside)
    }
    return inside
  }
}
