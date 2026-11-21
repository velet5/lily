// Karaoke (DECISIONS D133): the piano view's other style. The notes of the
// tracks shown run from right to left past a line that is now, a row per
// semitone, and the words are below them, two phrases at a time, each
// syllable coloured as it is sung, in its singer's colour; a second singer
// has a lane and rows of their own below the lead's (D139). The words come
// with the playback map (runtime/words.ly writes them beside it), the notes
// from the score's MIDI with its muted parts too, so a part muted to sing it
// is still there. The lane is a piano roll or a staff (D156), and the
// keyboard may be below it all (D156).
import type { Note, Track } from '@lily/common/web/midi.js'
import type { TimedLyric, TimedStaff } from '@lily/common/types'
import { drawKeys, firstFrom, roundRect, type KeyRange } from './piano'
import { drawStaff, staffShare, type StaffScene } from './staff'

/** A syllable as sung: when, for how long, its text, and whose it is. */
export interface Syllable {
  /** In seconds. */
  start: number
  end: number
  /** With the space after it, unless a hyphen joins it to the next. */
  text: string
  /** The MIDI track it is sung on; -1 when not sung to a voice. */
  track: number
  line: number
  /** Whispered or said (D138). */
  italic: boolean
  /** No note of its track under it: drawn on the lane by itself (D139). */
  said: boolean
}

/** A run of syllables of one line, shown together, all italic or none. */
export interface Phrase {
  start: number
  end: number
  syllables: Syllable[]
  track: number
  line: number
  italic: boolean
}

/** A syllable without notes to go by lasts this long, or until the next. */
const BARE_SYLLABLE = 0.5
/** A gap this long between syllables starts another phrase. */
const PHRASE_GAP = 0.9
/** Between two said syllables, which have no notes to hold them, a gap this long does: a speaker's pause is longer than a singer's breath. */
const SAID_GAP = 2
/** A phrase longer than this, in characters, breaks at a word (an original line runs to 55); one this long breaks after a comma. A full stop always ends one. */
const PHRASE_CHARACTERS = 60
const CLAUSE_CHARACTERS = 16

/** How far apart a syllable and a note may start and still be sung together, in seconds. */
const TOGETHER = 0.01

const DRUMS = 9 // channel 10, which lilypond gives no other staff

/** LilyPond's lyric tie, `~`, as its `tied-lyric` markup reads as a string. */
const LYRIC_TIE = '\u203f'

/** The name `\addlyrics` gives a context the score left without one. */
const GENERATED_NAME = /^uniqueContext\d+$/

/**
 * The track a line of syllables is sung on: the one with a note starting
 * with most of them, however many notes each (a chord is not more sung than
 * a melody's one), since a Lyrics context has a MIDI track of its own and
 * the staves' tracks are not numbered by staff; of two alike, one no line
 * before took. -1 when none has a note with half of them: words said to a
 * NullVoice, which plays nothing, are not another singer's.
 */
function trackOf(starts: readonly number[], notes: readonly Note[], taken: ReadonlySet<number>): number {
  const counts = new Map<number, number>()
  for (const start of starts) {
    const under = new Set<number>()
    for (let i = firstFrom(notes, start - TOGETHER); i < notes.length && notes[i]!.time <= start + TOGETHER; i++) under.add(notes[i]!.track)
    for (const track of under) counts.set(track, (counts.get(track) ?? 0) + 1)
  }
  let best = -1
  for (const [track, count] of counts) {
    const most = best === -1 ? -1 : counts.get(best)!
    if (count > most || (count === most && taken.has(best) && !taken.has(track))) best = track
  }
  return best !== -1 && counts.get(best)! * 2 >= starts.length ? best : -1
}

/**
 * Each voice's MIDI track (D138): a staff's track is the one of its voices,
 * the staves with notes and the tracks with notes in the same order (the
 * Lyrics contexts' tracks between them have none). A DrumStaff has a track
 * and no staff, so the drums' tracks are left out, unless the staves need
 * them: a Staff set to drums has both. A staff's own id is on its track too,
 * as `\addlyrics` after `\new Staff` sings to the Staff, named if it was not;
 * a voice of that name elsewhere comes first. Empty when they do not pair up.
 */
export function voiceTracks(staves: readonly TimedStaff[] | undefined, tracks: readonly Pick<Track, 'notes' | 'channels'>[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const [{ id, voices }, track] of staffTracks(staves, tracks)) {
    if (id && !result.has(id)) result.set(id, track)
    for (const voice of voices) if (voice) result.set(voice, track)
  }
  return result
}

/** Each staff that played notes with its MIDI track, as `voiceTracks` pairs them; none when they do not pair up. */
export function staffTracks(staves: readonly TimedStaff[] | undefined, tracks: readonly Pick<Track, 'notes' | 'channels'>[]): [TimedStaff, number][] {
  const playing = (staves ?? []).filter(({ voices }) => voices.length > 0)
  const sounding = tracks.flatMap(({ notes }, track) => (track > 0 && notes > 0 ? [track] : []))
  const pitched = sounding.filter((track) => !tracks[track]!.channels.every((channel) => channel === DRUMS))
  const numbers = pitched.length === playing.length ? pitched : sounding
  if (playing.length !== numbers.length) return []
  return playing.map((staff, i) => [staff, numbers[i]!])
}

/**
 * The syllables of `lyrics`, in seconds by `seconds`, sorted by line and time.
 * A line is sung on its voice's track in `voices` (D138), on none when its
 * voice is not there (a NullVoice: answers starting with the lead's notes
 * are still not the lead's), and on the track `trackOf` finds when `voices`
 * is empty, the line has no voice, or its voice's name is lilypond's and not
 * there: a staff group's, which no staff lists, as much as a NullVoice's. A
 * syllable lasts as long as its line's track's notes until the next syllable
 * of its line, so it is held over a melisma. `notes` are by time. A skip
 * (`_`, which lilypond hands on as a space) ends the syllable before it and
 * is not shown. The text is as the score prints it: a bare
 * word's `_` is a space by now, so one still here was written in quotes and
 * stays, and a `~` is the tie between two vowels on a note. A line sung on
 * a track of `sung` is at that voice's sung times (D276): its grid seconds
 * through the voice's time map, as its notes in `notes` are already moved.
 */
export function syllablesOf(
  lyrics: readonly TimedLyric[],
  seconds: (at: number) => number,
  notes: readonly Note[],
  voices: ReadonlyMap<string, number> = new Map(),
  sung: ReadonlyMap<number, (seconds: number) => number> = new Map(),
): Syllable[] {
  const grid = lyrics
    .map((lyric) => ({ lyric, start: seconds(lyric.at) }))
    .sort((a, b) => a.lyric.line - b.lyric.line || a.start - b.start)
  const tracks = new Map<number, number>()
  for (const line of new Set(grid.map(({ lyric }) => lyric.line))) {
    const own = grid.filter(({ lyric }) => lyric.line === line)
    const { voice } = own[0]!.lyric
    // A voice the staves do not list played no notes: a NullVoice, its words said to none.
    const track = voice ? (voices.get(voice) ?? (voices.size > 0 && !GENERATED_NAME.test(voice) ? -1 : undefined)) : undefined
    tracks.set(line, track ?? trackOf(own.map(({ start }) => start), notes, new Set(tracks.values())))
  }
  // A map keeps the order of a line's syllables: it rises with the grid.
  const sorted = grid.map(({ lyric, start }) => ({ lyric, start: sung.get(tracks.get(lyric.line) ?? -1)?.(start) ?? start }))
  const syllables = sorted.map(({ lyric, start }, i) => {
    const next = sorted[i + 1]?.lyric.line === lyric.line ? sorted[i + 1]!.start : Infinity
    const track = tracks.get(lyric.line) ?? -1
    let end = start
    for (const note of notes) {
      if (note.track === track && note.time >= start - TOGETHER && note.time < next - TOGETHER) end = Math.max(end, note.time + note.duration)
    }
    const said = end === start
    if (said) end = start + BARE_SYLLABLE
    const text = lyric.text.trim().replace(/~/g, LYRIC_TIE)
    return { start, end: Math.min(end, next), text: lyric.hyphen ? text : `${text} `, track, line: lyric.line, italic: lyric.italic, said }
  })
  return syllables.filter(({ text }) => text.trim() !== '')
}

/** A sentence's end, `.`, `!` or `?`, and any closing quotes or brackets after it: `Waltz?”` (D146). */
const SENTENCE_END = /[.!?]["'”’»)\]]*\s*$/
/** A clause's end, `,`, `;` or `:`, the same way. */
const CLAUSE_END = /[,;:]["'”’»)\]]*\s*$/

/**
 * The phrases of `syllables`: a line's syllables until a gap (a longer one
 * between said syllables), a sentence's end, a clause's once long enough, a
 * long run ends at a word, or italic starts or stops; then the lines'
 * phrases by time.
 */
export function phrasesOf(syllables: readonly Syllable[]): Phrase[] {
  const phrases: Phrase[] = []
  let phrase: Phrase | undefined
  let length = 0
  for (const syllable of syllables) {
    const last = phrase?.syllables[phrase.syllables.length - 1]
    const word = !last || last.text.endsWith(' ')
    const clause = !!last && (SENTENCE_END.test(last.text) || (CLAUSE_END.test(last.text) && length >= CLAUSE_CHARACTERS))
    if (
      !phrase ||
      !last ||
      last.line !== syllable.line ||
      last.italic !== syllable.italic ||
      syllable.start - last.end > (last.said && syllable.said ? SAID_GAP : PHRASE_GAP) ||
      clause ||
      (word && length + syllable.text.length > PHRASE_CHARACTERS)
    ) {
      phrase = { start: syllable.start, end: syllable.end, syllables: [], track: syllable.track, line: syllable.line, italic: syllable.italic }
      phrases.push(phrase)
      length = 0
    }
    phrase.syllables.push(syllable)
    phrase.end = Math.max(phrase.end, syllable.end)
    length += syllable.text.length
  }
  return phrases.sort((a, b) => a.start - b.start)
}

/** Words further ahead than this, in seconds, are not shown yet (D142). */
export const SHOWN_AHEAD = 5

/**
 * The phrases on the two rows at `now`: the first not yet over and the one
 * after it, each on its row (`rowOf`), so a row changes only once its phrase
 * is sung; a phrase more than SHOWN_AHEAD away is not shown yet (D142).
 */
export function shownPhrases(phrases: readonly Phrase[], now: number): [Phrase | undefined, Phrase | undefined] {
  const first = phrases.findIndex((phrase) => phrase.end > now)
  if (first === -1) return [undefined, undefined]
  const rows: [Phrase | undefined, Phrase | undefined] = [undefined, undefined]
  for (const i of [first, first + 1]) {
    const phrase = phrases[i]
    if (phrase && phrase.start - now <= SHOWN_AHEAD) rows[rowOf(phrases, i)] = phrase
  }
  return rows
}

/**
 * The row of the `index`th phrase: the rows take turns, and the first phrase
 * after a pause that left both empty, one starting more than SHOWN_AHEAD
 * after every phrase before it ends, is on the top row (D142).
 */
export function rowOf(phrases: readonly Phrase[], index: number): 0 | 1 {
  let row: 0 | 1 = 0
  let end = -Infinity
  for (let i = 0; i <= index; i++) {
    const phrase = phrases[i]!
    row = phrase.start - end > SHOWN_AHEAD ? 0 : row === 0 ? 1 : 0
    end = Math.max(end, phrase.end)
  }
  return row
}

/**
 * A section's two rows at `now` (D139, D147): one line's phrases taking
 * turns, as `shownPhrases`; or, with two lines or more, a row for each of
 * the first two, its phrase not yet over and at most SHOWN_AHEAD away. A row
 * its line leaves empty shows a further line's phrase, so a third line is
 * not left out. Taking turns, lines that overlap (a held "Ooh" under the
 * ad-libs) would hold a phrase sung long ago as the next one. A phrase shown
 * keeps its row until it is sung (D160): one that would take a row another
 * still holds goes on the other row, or waits for one.
 */
export function sectionRows(phrases: readonly Phrase[], now: number): [Phrase | undefined, Phrase | undefined] {
  const placed = placedRows(phrases)
  if (!placed) return shownPhrases(phrases, now)
  const rows: [Phrase | undefined, Phrase | undefined] = [undefined, undefined]
  for (const { phrase, row, from } of placed) if (from <= now && now < phrase.end) rows[row] = phrase
  return rows
}

/** A phrase on a row of its section, from when it is shown until it is sung. */
interface Placed {
  phrase: Phrase
  row: 0 | 1
  from: number
}

const placements = new WeakMap<readonly Phrase[], Placed[] | undefined>()

/**
 * Where `sectionRows` shows each phrase of two lines or more, worked out once:
 * a line's phrase is ready SHOWN_AHEAD before it is sung, and not before its
 * line's phrase before it is over; the first line's goes on the top row, the
 * second's on the bottom one, a further line's on whichever is free, each on
 * the other row when its own is held, or later, when a row is let go. Each
 * holds its row until its end. Undefined with one line, which takes turns.
 */
function placedRows(phrases: readonly Phrase[]): Placed[] | undefined {
  if (placements.has(phrases)) return placements.get(phrases)
  const lines = [...new Set(phrases.map(({ line }) => line))].sort((a, b) => a - b)
  let placed: Placed[] | undefined
  if (lines.length >= 2) {
    const last = new Map<number, number>()
    const pending = phrases.map((phrase) => {
      const ready = Math.max(phrase.start - SHOWN_AHEAD, last.get(phrase.line) ?? -Infinity)
      last.set(phrase.line, Math.max(last.get(phrase.line) ?? -Infinity, phrase.end))
      const order = lines.indexOf(phrase.line)
      return { phrase, ready, order, rows: (order === 1 ? [1, 0] : [0, 1]) as (0 | 1)[] }
    })
    const held: [number, number] = [-Infinity, -Infinity]
    placed = []
    while (pending.length > 0) {
      // The one shown next: the earliest, the first line's before another's at once.
      let best = -1
      let bestFrom = Infinity
      for (const [index, candidate] of pending.entries()) {
        const from = Math.max(candidate.ready, Math.min(...held))
        if (best === -1 || from < bestFrom || (from === bestFrom && candidate.order < pending[best]!.order)) [best, bestFrom] = [index, from]
      }
      const { phrase, rows } = pending.splice(best, 1)[0]!
      // Sung before a row is free: never shown, as before.
      if (bestFrom >= phrase.end) continue
      const row = rows.find((row) => held[row] <= bestFrom)!
      held[row] = phrase.end
      placed.push({ phrase, row, from: bestFrom })
    }
  }
  placements.set(phrases, placed)
  return placed
}

/**
 * How far ahead of its note a syllable is lit, in seconds: at its consonant,
 * which a singer starts before the vowel the note is on (D276). The grid
 * moved this much earlier had 61 % of consonants within 50 ms against the
 * grid's own 28 %; a constant for the ear to set.
 */
export const CONSONANT_LEAD = 0.06

/** How much of `syllable` is sung at `now`, 0 to 1: lit from its consonant, CONSONANT_LEAD before its note, to as long before its end. */
export function sung(syllable: Syllable, now: number): number {
  const at = now + CONSONANT_LEAD
  if (at <= syllable.start) return 0
  if (at >= syllable.end) return 1
  return (at - syllable.start) / (syllable.end - syllable.start)
}

/** The lowest and highest key of `notes`, a semitone of room each side; around middle C without notes. */
export function laneRange(notes: readonly Note[]): { low: number; high: number } {
  if (notes.length === 0) return { low: 55, high: 72 }
  let low = Infinity
  let high = -Infinity
  for (const { key } of notes) {
    low = Math.min(low, key)
    high = Math.max(high, key)
  }
  return { low: low - 1, high: high + 1 }
}

/** What one frame draws. */
export interface KaraokeFrame {
  width: number
  height: number
  now: number
  /** The notes of the tracks shown, by time, and the longest of them. */
  notes: readonly Note[]
  longest: number
  phrases: readonly Phrase[]
  /** The score has words, all on tracks Tracks hides. */
  wordsHidden?: boolean
  color(track: number): string
  name(key: number): string
  /** The lane as notes on a staff, not a piano roll (D156). */
  staff?: StaffScene
  /** The keyboard below the karaoke, with these keys (D156). */
  keys?: KeyRange
  /** The words' least size, in pixels: a phrase that would be smaller wraps (D157). */
  minText?: number
}

/** What every frame of a piece draws alike: all but the size and the moment. */
export type KaraokeScene = Omit<KaraokeFrame, 'width' | 'height' | 'now'>

/** Seconds shown before now and after it; now is a quarter of the way in. */
const PAST = 1.5
const AHEAD = 4.5
/** A phrase this far after the one before gets a count-in, over this long. */
const COUNT_IN_GAP = 3
const COUNT_IN = 1.5
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"

/**
 * The phrase on the first row starting next, when nothing is being sung and
 * it comes after a gap: how far into its count-in `now` is, 0 to 1.
 */
export function countIn(phrases: readonly Phrase[], now: number): { phrase: Phrase; part: number } | undefined {
  const next = phrases.find((phrase) => phrase.start > now)
  if (!next || phrases.some((phrase) => phrase.start <= now && phrase.end > now)) return undefined
  const before = phrases.filter((phrase) => phrase.end <= next.start).at(-1)
  if (before && next.start - before.end < COUNT_IN_GAP) return undefined
  const left = next.start - now
  return left <= COUNT_IN ? { phrase: next, part: 1 - left / COUNT_IN } : undefined
}

/** A singer's part of the stage (D139): their lane's notes, their phrases, and their syllables without notes, all by time. */
export interface Section {
  notes: Note[]
  phrases: Phrase[]
  said: Syllable[]
}

/**
 * The stage's sections (D139): the lead's line on top, and every other line
 * below it, each with the notes of its tracks and its syllables said to no
 * note. Notes of a track no other line is sung on are the lead's. A line
 * never sung at once with those on top, the larger first, joins them (D147):
 * singers taking turns share the rows, each in their colour.
 */
export function sectionsOf(notes: readonly Note[], phrases: readonly Phrase[]): Section[] {
  const lead = leadLine(phrases)
  const lines = new Map<number, Phrase[]>()
  for (const phrase of phrases) lines.set(phrase.line, [...(lines.get(phrase.line) ?? []), phrase])
  const size = (line: number) => lines.get(line)!.reduce((sum, { syllables }) => sum + syllables.length, 0)
  const top = [...(lines.get(lead) ?? [])]
  const below: Phrase[] = []
  for (const line of [...lines.keys()].filter((line) => line !== lead).sort((a, b) => size(b) - size(a) || a - b)) {
    const own = lines.get(line)!
    const together = own.some((phrase) => top.some((other) => phrase.start < other.end && other.start < phrase.end))
    ;(together ? below : top).push(...own)
  }
  top.sort((a, b) => a.start - b.start)
  below.sort((a, b) => a.start - b.start)
  const theirs = new Set(below.map(({ track }) => track))
  for (const { track } of top) theirs.delete(track)
  const section = (own: Phrase[], notes: Note[]): Section => ({
    notes,
    phrases: own,
    said: own.flatMap(({ syllables }) => syllables.filter(({ said }) => said)).sort((a, b) => a.start - b.start),
  })
  const first = section(top, notes.filter(({ track }) => !theirs.has(track)))
  return below.length === 0 ? [first] : [first, section(below, notes.filter(({ track }) => theirs.has(track)))]
}

let sectionsFor: { notes: readonly Note[]; phrases: readonly Phrase[]; sections: Section[] } | undefined

/** The share of the height the keyboard has below the karaoke (D156). */
const KEYS_SHARE = 0.4

export function drawKaraoke(context: CanvasRenderingContext2D, frame: KaraokeFrame): void {
  if (frame.keys) {
    // The karaoke on top, the notes falling onto the keys below it (D156).
    const keys = Math.round(frame.height * KEYS_SHARE)
    const top = frame.height - keys
    drawKaraoke(context, { ...frame, height: top, keys: undefined })
    context.save()
    context.translate(0, top)
    drawKeys(context, { ...frame, height: keys, range: frame.keys })
    context.restore()
    return
  }
  const { width, height, notes, phrases } = frame
  drawNight(context, width, height)
  if (sectionsFor?.notes !== notes || sectionsFor.phrases !== phrases) sectionsFor = { notes, phrases, sections: sectionsOf(notes, phrases) }
  const { sections } = sectionsFor
  // The lead on top; a second singer on a lane and rows of their own below (D139).
  const part = height / sections.length
  sections.forEach((section, index) => drawSection(context, frame, section, index * part, part, index === 0, sections.length === 1))
  if (sections.length > 1) {
    context.fillStyle = 'rgba(255, 255, 255, 0.12)'
    context.fillRect(0, Math.round(part), width, 1)
  }
}

/** A section from `top`, `height` high: its lane, then its words on two rows taking turns, the sung part in the singer's colour. */
function drawSection(context: CanvasRenderingContext2D, frame: KaraokeFrame, section: Section, top: number, height: number, first: boolean, alone: boolean): void {
  const { width, now } = frame
  // At least 140 px alone (90 px shared), so a voice's two octaves are not hairlines in a small pane.
  const least = alone ? 140 : 90
  // A staff takes more of it than a roll: its heads, stems and clef need room (D156).
  const share = frame.staff ? staffShare(section, frame.staff) : 0.3
  const lane = section.notes.length > 0 || section.said.length > 0 ? Math.round(Math.min(Math.max(height * share, least), height * Math.max(share, 0.5))) : 0
  if (lane > 0) drawLane(context, frame, section, top, top + lane)
  const area = height - lane
  const size = Math.max(16, Math.min(area * 0.2, width * 0.06, 72))
  const counting = countIn(section.phrases, now)
  // On top the lines take turns, never sung at once (D147); below, a row a line.
  const rows = first ? shownPhrases(section.phrases, now) : sectionRows(section.phrases, now)
  const blocks = rows.map((phrase) => phrase && phraseBlock(context, frame, phrase, size))
  // The rows are where the section's tallest phrase puts them, whatever is shown now (D160).
  const centres = rowCentres(context, frame, section, size, top + lane, top + height)
  for (const [index, block] of blocks.entries()) {
    if (!block) continue
    const { phrase } = block
    const upcoming = phrase.start > now && rows.some((other) => other && other !== phrase && other.start <= now)
    drawPhrase(context, frame, block, centres[index]!, upcoming ? 0.9 : 1, counting?.phrase === phrase ? counting.part : undefined)
  }
  if (frame.phrases.length === 0) {
    context.font = `500 ${Math.max(13, Math.min(18, area * 0.06))}px ${FONT}`
    context.textAlign = 'center'
    context.fillStyle = 'rgba(255, 255, 255, 0.6)'
    context.fillText(emptyWords(frame), width / 2, top + lane + area / 2)
  } else if (first && rows.every((phrase) => !phrase)) {
    // A long break, its words not shown yet (D142): a note to say the music goes on.
    context.font = `300 ${size * 1.2}px ${FONT}`
    context.textAlign = 'center'
    context.fillStyle = `rgba(255, 255, 255, ${0.25 + 0.15 * Math.sin(now * 3)})`
    context.fillText('♪', width / 2, top + lane + area * 0.5)
  }
}

/** The rows' centres last found for a section, at the size, width and least text size they were found for. */
const rowsFor = new WeakMap<Section, { key: string; centres: [number, number] }>()

/**
 * A section's two rows, between `from` (the lane's foot) and `to`: at a
 * third and two thirds of the words' area, each as high as the section's
 * tallest phrase, moved apart when two such would touch, and kept within the
 * section, up from its foot but never over the lane (D157). They depend on
 * the section and the frame's size only, never on the phrases shown, so the
 * words stay where they appeared until they are sung (D160).
 */
function rowCentres(context: CanvasRenderingContext2D, frame: KaraokeFrame, section: Section, size: number, from: number, to: number): [number, number] {
  const key = `${frame.width} ${size} ${frame.minText ?? 0} ${from} ${to}`
  const kept = rowsFor.get(section)
  if (kept?.key === key) return kept.centres
  let tallest = 0
  let gap = 0
  for (const phrase of section.phrases) {
    const block = phraseBlock(context, frame, phrase, size)
    if (blockHeight(block) > tallest) [tallest, gap] = [blockHeight(block), block.size * 0.2]
  }
  const area = to - from
  const centres: [number, number] = [from + area * 0.34, from + area * 0.68]
  const overlap = centres[0] + tallest / 2 + gap - (centres[1] - tallest / 2)
  if (overlap > 0) {
    centres[0] -= overlap / 2
    centres[1] += overlap / 2
  }
  const below = centres[1] + tallest / 2 - to
  const room = centres[0] - tallest / 2 - from
  const by = below > 0 ? -Math.min(below, Math.max(room, 0)) : Math.max(-room, 0)
  centres[0] += by
  centres[1] += by
  rowsFor.set(section, { key, centres })
  return centres
}

/** What the stage says without words to show: that Tracks hides them, or how to write them. */
export function emptyWords(frame: Pick<KaraokeFrame, 'wordsHidden'>): string {
  return frame.wordsHidden
    ? 'The words are on hidden tracks: tick their singers in Tracks.'
    : 'No words: write them in \\lyricmode and sing them to a voice with \\lyricsto.'
}

/**
 * A section's lane: a row per semitone, the time running right to left past
 * now, the note sounding lit; a syllable said to no note a hollow pill across
 * the middle, dashed when whispered; the words are on the rows only (D139).
 * Or the same notes on a staff (D156).
 */
function drawLane(context: CanvasRenderingContext2D, frame: KaraokeFrame, section: Section, laneTop: number, bottom: number): void {
  const { width, now } = frame
  const { notes } = section
  const inset = Math.round(Math.min(24, width * 0.03))
  const top = laneTop + inset
  const { low, high } = laneRange(notes)
  const row = (bottom - top) / (high - low + 1)
  const perSecond = width / (PAST + AHEAD)
  const nowX = PAST * perSecond
  const h = Math.min(Math.max(row * 0.8, 8), 18)
  context.fillStyle = 'rgba(255, 255, 255, 0.035)'
  roundRect(context, inset, top, width - inset * 2, bottom - top, 10)
  context.fill()
  if (frame.staff) {
    drawStaff(context, section, frame.staff, {
      left: inset,
      right: width - inset,
      top,
      bottom,
      nowX,
      perSecond,
      now,
      from: now - PAST,
      to: now + AHEAD,
      longest: frame.longest,
      color: frame.color,
    })
    drawNow(context, nowX, top, bottom)
    return
  }
  context.fillStyle = 'rgba(255, 255, 255, 0.07)'
  for (let key = low; key <= high; key += 2) context.fillRect(inset, Math.round(bottom - (key - low + 1) * row), width - inset * 2, 1)
  const label = Math.max(9, Math.min(13, row * 0.8))
  context.font = `700 ${label}px ${FONT}`
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  const end = firstFrom(notes, now + AHEAD)
  for (let i = firstFrom(notes, now - PAST - frame.longest); i < end; i++) {
    const note = notes[i]!
    if (note.time + note.duration < now - PAST) continue
    const x = nowX + (note.time - now) * perSecond
    const w = Math.max(note.duration * perSecond - 3, 6)
    const y = bottom - (note.key - low + 1) * row + (row - h) / 2
    const sounding = note.time <= now && now < note.time + note.duration
    const color = frame.color(note.track)
    context.globalAlpha = note.time + note.duration <= now ? 0.3 : 1
    if (sounding) {
      context.shadowColor = color
      context.shadowBlur = 18
    }
    context.fillStyle = sounding ? '#ffffff' : color
    roundRect(context, x, y, w, h, h / 2)
    context.fill()
    context.shadowBlur = 0
    if (w > label * 2.4 && h >= label) {
      context.fillStyle = sounding ? color : 'rgba(10, 8, 25, 0.75)'
      context.fillText(frame.name(note.key), x + h / 2, y + h / 2 + 0.5)
    }
    context.globalAlpha = 1
  }
  const said = Math.max(h, Math.min(26, (bottom - top) * 0.3))
  const y = (top + bottom - said) / 2
  for (const syllable of section.said) {
    if (syllable.end < now - PAST || syllable.start > now + AHEAD) continue
    const x = nowX + (syllable.start - now) * perSecond
    const w = Math.max((syllable.end - syllable.start) * perSecond - 3, 6)
    const sounding = syllable.start <= now && now < syllable.end
    const color = frame.color(syllable.track)
    context.globalAlpha = syllable.end <= now ? 0.3 : 1
    context.lineWidth = 2
    context.setLineDash(syllable.italic ? [4, 3] : [])
    context.strokeStyle = color
    context.fillStyle = sounding ? color : 'rgba(10, 8, 25, 0.55)'
    roundRect(context, x, y, w, said, said / 2)
    context.fill()
    context.stroke()
    context.setLineDash([])
    context.globalAlpha = 1
  }
  drawNow(context, nowX, top, bottom)
}

/** The line that is now, glowing. */
function drawNow(context: CanvasRenderingContext2D, nowX: number, top: number, bottom: number): void {
  const glow = context.createLinearGradient(nowX - 14, 0, nowX + 14, 0)
  glow.addColorStop(0, 'rgba(255, 255, 255, 0)')
  glow.addColorStop(0.5, 'rgba(255, 255, 255, 0.18)')
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.fillStyle = glow
  context.fillRect(nowX - 14, top, 28, bottom - top)
  context.fillStyle = 'rgba(255, 255, 255, 0.85)'
  context.fillRect(Math.round(nowX) - 1, top, 2, bottom - top)
}

/** The line with the most syllables: the lead, whose words have the two rows. */
export function leadLine(phrases: readonly Phrase[]): number {
  const counts = new Map<number, number>()
  for (const { line, syllables } of phrases) counts.set(line, (counts.get(line) ?? 0) + syllables.length)
  let lead = 0
  let most = -1
  for (const [line, count] of counts) if (count > most || (count === most && line < lead)) [lead, most] = [line, count]
  return lead
}

/** The night sky's middle, which words not yet sung are dimmed towards (D148). */
const SKY = '#170f33'

/** `#rrggbb` mixed towards `#rrggbb` `toward`, `share` of it kept; other colours as they are. */
export function mixed(color: string, toward: string, share: number): string {
  const [from, to] = [color, toward].map((hex) => (/^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : undefined))
  if (from === undefined || to === undefined) return color
  const mix = (shift: number) => Math.round(((to >> shift) & 255) + (((from >> shift) & 255) - ((to >> shift) & 255)) * share)
  return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`
}

/** A phrase's lines are this many times its font size apart. */
const LINE_HEIGHT = 1.2

/**
 * `syllables` broken into lines no wider than `room` by `widthOf`, at word
 * ends only, each line as full as it can be (D157). A word wider than
 * `room` is a line of its own.
 */
export function wrapSyllables(syllables: readonly Syllable[], widthOf: (text: string) => number, room: number): Syllable[][] {
  const lines: Syllable[][] = []
  let line: Syllable[] = []
  let word: Syllable[] = []
  const text = (run: readonly Syllable[]) => run.map((syllable) => syllable.text).join('').trimEnd()
  for (const syllable of syllables) {
    word.push(syllable)
    if (!syllable.text.endsWith(' ') && syllable !== syllables.at(-1)) continue
    if (line.length > 0 && widthOf(text([...line, ...word])) > room) {
      lines.push(line)
      line = []
    }
    line.push(...word)
    word = []
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/**
 * `syllables` on as few lines as `wrapSyllables` puts them, as alike in
 * width as they can be: the narrowest room that needs no more lines (D157).
 */
export function balancedLines(syllables: readonly Syllable[], widthOf: (text: string) => number, room: number): Syllable[][] {
  const lines = wrapSyllables(syllables, widthOf, room)
  if (lines.length < 2) return lines
  let low = 0
  let high = room
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2
    if (wrapSyllables(syllables, widthOf, middle).length <= lines.length) high = middle
    else low = middle
  }
  return wrapSyllables(syllables, widthOf, high)
}

/** The lines a phrase was last broken into, for the size and width they were found at. */
const wrapped = new WeakMap<Phrase, { size: number; room: number; lines: Syllable[][] }>()

/** A phrase as drawn: its font size and its lines. */
interface PhraseBlock {
  phrase: Phrase
  style: string
  size: number
  lines: Syllable[][]
}

/**
 * A phrase fitted to the width at `size` at most; one that would be smaller
 * than the frame's least text size is that size instead, on as many lines
 * as it needs (D157).
 */
function phraseBlock(context: CanvasRenderingContext2D, frame: KaraokeFrame, phrase: Phrase, size: number): PhraseBlock {
  const style = phrase.italic ? 'italic 500' : '800'
  const room = frame.width * 0.9
  const text = phrase.syllables.map((syllable) => syllable.text).join('').trimEnd()
  context.font = `${style} ${size}px ${FONT}`
  const fit = Math.min(size, (size * room) / Math.max(context.measureText(text).width, 1))
  const least = frame.minText ?? 0
  if (fit >= least) return { phrase, style, size: fit, lines: [phrase.syllables] }
  let kept = wrapped.get(phrase)
  if (kept?.size !== least || kept.room !== room) {
    context.font = `${style} ${least}px ${FONT}`
    kept = { size: least, room, lines: balancedLines(phrase.syllables, (line) => context.measureText(line).width, room) }
    wrapped.set(phrase, kept)
  }
  return { phrase, style, size: least, lines: kept.lines }
}

function blockHeight(block: PhraseBlock): number {
  return block.lines.length * block.size * LINE_HEIGHT
}

/**
 * A phrase's lines centred at `y`, each fitted to the width, coloured as far
 * as it is sung, with its count-in dots; a whispered one italic and lighter.
 */
function drawPhrase(context: CanvasRenderingContext2D, frame: KaraokeFrame, block: PhraseBlock, y: number, alpha: number, count: number | undefined): void {
  const { width, now } = frame
  const { phrase, style, lines } = block
  context.textBaseline = 'middle'
  context.textAlign = 'left'
  context.lineJoin = 'round'
  const color = frame.color(phrase.track)
  const step = block.size * LINE_HEIGHT
  let firstLeft = 0
  for (const [index, syllables] of lines.entries()) {
    const lineY = y + (index - (lines.length - 1) / 2) * step
    const text = syllables.map((syllable) => syllable.text).join('').trimEnd()
    context.font = `${style} ${block.size}px ${FONT}`
    // A word wider than the width on a line of its own still fits it.
    const fit = Math.min(block.size, (block.size * width * 0.9) / Math.max(context.measureText(text).width, 1))
    context.font = `${style} ${fit}px ${FONT}`
    const full = context.measureText(text).width
    const left = (width - full) / 2
    if (index === 0) firstLeft = left
    let done = 0
    for (const syllable of syllables) {
      const part = sung(syllable, now)
      if (part === 0) break
      done += context.measureText(syllable.text).width * part
    }
    context.globalAlpha = alpha
    context.lineWidth = Math.max(3, fit * 0.16)
    context.strokeStyle = 'rgba(12, 8, 30, 0.9)'
    context.strokeText(text, left, lineY)
    // Not yet sung, the singer's colour dimmed, so whose it is shows before it is sung (D148).
    context.fillStyle = mixed(color, SKY, 0.8)
    context.fillText(text, left, lineY)
    if (done > 0) {
      context.save()
      context.beginPath()
      context.rect(left - fit, lineY - fit, Math.min(done, full) + fit, fit * 2)
      context.clip()
      context.shadowColor = color
      context.shadowBlur = fit * 0.3
      context.strokeText(text, left, lineY)
      context.shadowBlur = 0
      context.fillStyle = color
      context.fillText(text, left, lineY)
      context.restore()
    }
    context.globalAlpha = 1
  }
  // The count-in: three dots going out one by one before a phrase after a gap.
  if (count !== undefined) {
    const dot = block.size * 0.16
    const top = y - ((lines.length - 1) / 2) * step
    context.fillStyle = color
    for (let i = 0; i < 3; i++) {
      if (count >= (i + 1) / 3) continue
      context.beginPath()
      context.arc(firstLeft + dot + i * dot * 3, top - block.size * 0.95, dot, 0, Math.PI * 2)
      context.fill()
    }
  }
}

/** The stage: a night sky, deep blue to violet, with stars that stay put. */
function drawNight(context: CanvasRenderingContext2D, width: number, height: number): void {
  const sky = context.createLinearGradient(0, 0, 0, height)
  sky.addColorStop(0, '#0d1030')
  sky.addColorStop(0.55, SKY)
  sky.addColorStop(1, '#06060f')
  context.fillStyle = sky
  context.fillRect(0, 0, width, height)
  const haze = context.createRadialGradient(width / 2, height * 0.65, 0, width / 2, height * 0.65, Math.max(width, height) * 0.6)
  haze.addColorStop(0, 'rgba(120, 60, 200, 0.18)')
  haze.addColorStop(1, 'rgba(120, 60, 200, 0)')
  context.fillStyle = haze
  context.fillRect(0, 0, width, height)
  let seed = 7
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  for (let i = 0; i < Math.round((width * height) / 9000); i++) {
    const x = random() * width
    const y = random() * height
    const r = random() * 1.1 + 0.2
    context.fillStyle = `rgba(255, 255, 255, ${0.15 + random() * 0.45})`
    context.fillRect(x, y, r, r)
  }
}
