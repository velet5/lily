import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import { momentTime, parseMidi, type Note } from '@lily/common/web/midi.js'
import type { TimedLyric, TimedStaff } from '@lily/common/types'
import { CONSONANT_LEAD, countIn, drawKaraoke, emptyWords, laneRange, leadLine, mixed, phrasesOf, rowOf, sectionRows, sectionsOf, shownPhrases, sung, syllablesOf, voiceTracks, wrapSyllables, balancedLines, type Syllable } from '../src/renderer/karaoke'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/ (npm run test:unit).

function note(key: number, time: number, duration: number, track = 1): Note {
  return { time, duration, track, channel: 0, key, velocity: 0.8, program: 0, gain: 1, pan: 0, detune: 0 }
}

function lyric(at: number, text: string, extra: Partial<TimedLyric> = {}): TimedLyric {
  return { at, text, hyphen: false, extender: false, line: 0, voice: '', italic: false, ...extra }
}

/** A whole note lasts two seconds: ♩ = 120. */
const seconds = (at: number) => at * 2

function syllable(start: number, end: number, text: string, extra: Partial<Syllable> = {}): Syllable {
  return { start, end, text, track: 1, line: 0, italic: false, said: false, ...extra }
}

function staff(voices: string[], id = ''): TimedStaff {
  return { id, name: '', shortName: '', group: '', groupIndex: -1, clef: 'clefs.G', clefTransposition: 0, voices }
}

function track(notes: number, ...channels: number[]): { notes: number; channels: number[] } {
  return { notes, channels }
}

describe('karaoke (D133)', () => {
  test('a syllable lasts as long as its voice’s notes until the next, joined to its word by a hyphen', () => {
    const notes = [note(60, 0, 0.5), note(48, 0, 4, 3), note(62, 0.5, 0.5), note(64, 1, 0.5), note(65, 1.5, 1)]
    const lyrics = [lyric(0, 'Lan', { hyphen: true }), lyric(0.25, 'tern'), lyric(0.5, 'glow', { extender: true })]
    assert.deepEqual(syllablesOf(lyrics, seconds, notes), [
      syllable(0, 0.5, 'Lan'),
      syllable(0.5, 1, 'tern '),
      // On the track with a note at each syllable, held over the melisma, not by the other track's long note.
      syllable(1, 2.5, 'glow '),
    ])
  })

  test('a skip ends the syllable before it and is not shown', () => {
    const notes = [note(60, 0, 0.5), note(62, 0.5, 0.5), note(64, 1, 0.5)]
    const lyrics = [lyric(0, 'be', { hyphen: true }), lyric(0.25, ' '), lyric(0.5, 'held')]
    assert.deepEqual(syllablesOf(lyrics, seconds, notes), [syllable(0, 0.5, 'be'), syllable(1, 1.5, 'held ')])
  })

  test('a score whose words Tracks hides says so, not how to write them', () => {
    assert.match(emptyWords({ wordsHidden: true }), /hidden tracks: tick their singers in Tracks/)
    assert.match(emptyWords({ wordsHidden: false }), /^No words: write them in \\lyricmode/)
    assert.match(emptyWords({}), /^No words/)
  })

  test('words said to a NullVoice are nobody’s track, though a singer’s notes start with some', () => {
    const notes = [note(60, 0, 0.5, 2)]
    const lyrics = [lyric(0, 'I'), lyric(0.5, 'was'), lyric(1, 'there')]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes).map(({ track }) => track),
      [-1, -1, -1],
    )
  })

  test('a line sung to a voice with a track is on it, though most of its words are said (D138)', () => {
    const notes = [note(60, 0, 0.5, 3)]
    const lyrics = [lyric(0, 'Hold', { voice: 'tom' }), lyric(0.5, 'me', { voice: 'tom' }), lyric(1, 'now', { voice: 'tom', italic: true })]
    const syllables = syllablesOf(lyrics, seconds, notes, new Map([['tom', 3]]))
    assert.deepEqual(
      syllables.map(({ track, italic }) => [track, italic]),
      [
        [3, false],
        [3, false],
        [3, true],
      ],
    )
  })

  test('words to a voice the staves do not list are nobody’s, though they start with another’s notes (D138)', () => {
    const notes = [note(60, 0, 0.5, 1), note(62, 0.5, 0.5, 1)]
    const lyrics = [lyric(0, 'Ooh', { voice: 'backing' }), lyric(0.25, 'yeah', { voice: 'backing' })]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes, new Map([['ella', 1]])).map(({ track }) => track),
      [-1, -1],
    )
  })

  test('a name of lilypond’s no staff has is found from the notes, as a staff group’s is (D138)', () => {
    const notes = [note(60, 0, 0.5, 1), note(62, 0.5, 0.5, 1), note(48, 0, 1, 2)]
    const lyrics = [lyric(0, 'one', { voice: 'uniqueContext0' }), lyric(0.25, 'two', { voice: 'uniqueContext0' })]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes, new Map([['up', 1], ['down', 2]])).map(({ track, said }) => [track, said]),
      [
        [1, false],
        [1, false],
      ],
    )
  })

  test('a staff’s voices are on its track: the staves and the tracks with notes in order (D138)', () => {
    const tracks = [track(0), track(4, 0), track(0), track(2, 1), track(0)]
    assert.deepEqual([...voiceTracks([staff(['ann']), staff(['tom', 'echo'])], tracks)], [
      ['ann', 1],
      ['tom', 3],
      ['echo', 3],
    ])
    assert.equal(voiceTracks([staff(['ann'])], tracks).size, 0)
    assert.equal(voiceTracks(undefined, tracks).size, 0)
  })

  test('a DrumStaff has a track and no staff, so it pairs with none (D138)', () => {
    const tracks = [track(0), track(4, 0), track(0), track(4, 9), track(4, 3), track(4, 9)]
    assert.deepEqual([...voiceTracks([staff(['ann']), staff(['bass'])], tracks)], [
      ['ann', 1],
      ['bass', 4],
    ])
  })

  test('a Staff set to drums has both, so its track still pairs with it (D138)', () => {
    const tracks = [track(0), track(4, 9), track(4, 0)]
    assert.deepEqual([...voiceTracks([staff(['kit']), staff(['ann'])], tracks)], [
      ['kit', 1],
      ['ann', 2],
    ])
  })

  test('a staff \\addlyrics named is on its track, as its line reports the staff (D138)', () => {
    const tracks = [track(0), track(4, 0), track(0), track(4, 1)]
    assert.deepEqual([...voiceTracks([staff([''], 'uniqueContext0'), staff(['b'])], tracks)], [
      ['uniqueContext0', 1],
      ['b', 3],
    ])
  })

  test('a voice keeps its track when another staff has its name (D138)', () => {
    const tracks = [track(0), track(4, 0), track(0), track(4, 1)]
    assert.deepEqual([...voiceTracks([staff(['one'], 'two'), staff(['two'], 'one')], tracks)], [
      ['two', 3],
      ['one', 1],
    ])
  })

  test('a track is one with a note at a syllable however many it plays there: the melody over the chords', () => {
    const chord = (time: number) => [note(48, time, 1, 3), note(52, time, 1, 3), note(55, time, 1, 3)]
    const notes = [...chord(0), note(60, 0, 0.5), note(62, 0.5, 0.5), ...chord(1), note(64, 1, 0.5), note(65, 1.5, 0.5)]
    const lyrics = [lyric(0, 'one'), lyric(0.25, 'two'), lyric(0.5, 'three'), lyric(0.75, 'four')]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes).map(({ track }) => track),
      [1, 1, 1, 1],
    )
  })

  test('a chord under one syllable of four is not half of them', () => {
    const notes = [note(48, 0, 1, 3), note(52, 0, 1, 3), note(55, 0, 1, 3)]
    const lyrics = [lyric(0, 'I'), lyric(0.25, 'was'), lyric(0.5, 'not'), lyric(0.75, 'there')]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes).map(({ track }) => track),
      [-1, -1, -1, -1],
    )
  })

  test('a whispered run is a phrase of its own (D138)', () => {
    const phrases = phrasesOf([syllable(0, 0.5, 'a '), syllable(0.5, 1, 'lie. '), syllable(1, 1.5, 'There’s ', { italic: true })])
    assert.deepEqual(
      phrases.map(({ italic, syllables }) => [italic, syllables.length]),
      [
        [false, 2],
        [true, 1],
      ],
    )
  })

  test('a syllable without notes lasts a moment', () => {
    assert.deepEqual(syllablesOf([lyric(0, 'a b')], seconds, []), [syllable(0, 0.5, 'a b ', { track: -1, said: true })])
  })

  test('a syllable reads as the score prints it: a tie an undertie, an underscore written, no space around it', () => {
    const notes = [note(60, 0, 0.5), note(62, 0.5, 0.5), note(64, 1, 0.5)]
    const lyrics = [lyric(0, 'la~la~la', { hyphen: true }), lyric(0.25, ' la '), lyric(0.5, 'a_b')]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes).map(({ text }) => text),
      ['la\u203fla\u203fla', 'la ', 'a_b '],
    )
  })

  test('a syllable with no note of its track under it is said (D139)', () => {
    const notes = [note(60, 0, 0.5, 3)]
    const lyrics = [lyric(0, 'Hold', { voice: 'tom' }), lyric(0.5, 'Lift', { voice: 'tom' })]
    assert.deepEqual(
      syllablesOf(lyrics, seconds, notes, new Map([['tom', 3]])).map(({ said }) => said),
      [false, true],
    )
  })

  test('the lead on top with the notes of the tracks no one else sings on; the second singer below with theirs (D139)', () => {
    const notes = [note(64, 0, 1, 1), note(50, 0, 1, 3), note(40, 0, 1, 5)]
    const phrases = phrasesOf([
      syllable(0, 1, 'lead ', { line: 0, track: 1 }),
      syllable(1, 2, 'more ', { line: 0, track: 1 }),
      syllable(0.5, 1, 'Lift ', { line: 1, track: 3, said: true }),
    ])
    const sections = sectionsOf(notes, phrases)
    assert.deepEqual(
      sections.map(({ notes, phrases, said }) => [notes.map(({ track }) => track), phrases.map(({ line }) => line), said.map(({ text }) => text)]),
      [
        [[1, 5], [0], []],
        [[3], [1], ['Lift ']],
      ],
    )
    assert.equal(sectionsOf(notes, phrases.filter(({ line }) => line === 0)).length, 1)
  })

  test('singers taking turns share the top, a line sung at once with them goes below (D147)', () => {
    const notes = [note(62, 0, 1, 1), note(50, 2, 1, 3), note(64, 4, 1, 5), note(55, 4.5, 1, 7)]
    const phrases = phrasesOf([
      syllable(0, 1, 'her. ', { line: 0, track: 1 }),
      syllable(2, 3, 'him. ', { line: 1, track: 3 }),
      syllable(4, 5, 'both, ', { line: 2, track: 5 }),
      syllable(5, 6, 'both. ', { line: 2, track: 5 }),
      syllable(4.5, 5.5, 'over ', { line: 3, track: 7 }),
    ])
    assert.deepEqual(
      sectionsOf(notes, phrases).map(({ notes, phrases }) => [notes.map(({ track }) => track), phrases.map(({ line }) => line)]),
      [
        [[1, 3, 5], [0, 1, 2]],
        [[7], [3]],
      ],
    )
  })

  test('a line’s phrase ends at a gap, or at a word once it is long', () => {
    const phrases = phrasesOf([syllable(0, 0.5, 'one '), syllable(0.5, 1, 'two '), syllable(3, 3.5, 'three ')])
    assert.deepEqual(
      phrases.map((phrase) => phrase.syllables.map((s) => s.text).join('')),
      ['one two ', 'three '],
    )
    const long = Array.from({ length: 18 }, (_, i) => syllable(i * 0.5, i * 0.5 + 0.5, i % 2 ? 'tern ' : 'lan', {}))
    const words = phrasesOf(long).map((phrase) => phrase.syllables.map((s) => s.text).join(''))
    assert.ok(words.length > 1)
    // Never between the syllables of a word.
    for (const text of words) assert.ok(text.endsWith(' '), text)
    // An original line of 55 characters stays one phrase.
    const line = 'And said, Would you like to try the Pennsylvania Waltz '.split(/(?<= )/)
    assert.equal(phrasesOf(line.map((text, i) => syllable(i * 0.5, i * 0.5 + 0.5, text))).length, 1)
  })

  test('said words pause longer than sung ones before their phrase ends (D146)', () => {
    // No stop or comma: only the gaps, of 1.5 s and then 3 s, can end a phrase.
    const texts = (extra: Partial<Syllable>) =>
      phrasesOf([syllable(0, 0.5, 'late ', extra), syllable(0.5, 1, 'one ', extra), syllable(2.5, 3, 'night ', extra), syllable(6, 6.5, 'When ', extra)]).map((phrase) =>
        phrase.syllables.map((s) => s.text).join(''),
      )
    assert.deepEqual(texts({ track: -1, said: true }), ['late one night ', 'When '])
    assert.deepEqual(texts({}), ['late one ', 'night ', 'When '])
  })

  test('a stop inside closing quotes or brackets ends its phrase (D146)', () => {
    for (const words of [
      ['“Whatever happened to my Waltz?” ', 'It’s now '],
      ["'Whatever happened to my Waltz?' ", 'It’s now '],
      ['(Whatever happened to my Waltz?) ', 'It’s now '],
    ]) {
      const phrases = phrasesOf(words.map((text, i) => syllable(i * 0.5, i * 0.5 + 0.5, text)))
      assert.deepEqual(
        phrases.map((phrase) => phrase.syllables.map((s) => s.text).join('')),
        words,
      )
    }
  })

  test('a full stop ends its phrase however short (D139)', () => {
    const words = ['Ooh yeah. ', 'Oh yeah. ', 'Your shadow ']
    const phrases = phrasesOf(words.map((text, i) => syllable(i * 0.5, i * 0.5 + 0.5, text)))
    assert.deepEqual(
      phrases.map((phrase) => phrase.syllables.map((s) => s.text).join('')),
      words,
    )
  })

  test('a long enough clause ends its phrase at its comma', () => {
    const words = ['When the night was young, ', 'we sang ']
    const phrases = phrasesOf(words.map((text, i) => syllable(i, i + 0.5, text)))
    assert.deepEqual(
      phrases.map((phrase) => phrase.syllables.map((s) => s.text).join('')),
      words,
    )
  })

  test('a phrase after a gap is counted in for a second and a half', () => {
    const phrases = phrasesOf([syllable(0, 1, 'one '), syllable(10, 11, 'two ')])
    assert.equal(countIn(phrases, 5), undefined)
    assert.ok(Math.abs(countIn(phrases, 9)!.part - 1 / 3) < 1e-9)
    assert.equal(countIn(phrases, 0.5), undefined)
  })

  test('each singer’s line is its own phrase, in its colour, by time', () => {
    const phrases = phrasesOf([syllable(0, 1, 'lead ', { line: 0 }), syllable(0.5, 1, 'ooh ', { line: 1, track: 2 })])
    assert.deepEqual(
      phrases.map(({ track, start }) => ({ track, start })),
      [
        { track: 1, start: 0 },
        { track: 2, start: 0.5 },
      ],
    )
  })

  test('shows the phrase being sung and the next, each on the row of its turn', () => {
    const phrases = phrasesOf([syllable(0, 1, 'a '), syllable(3, 4, 'b '), syllable(6, 7, 'c ')])
    const texts = (now: number) => shownPhrases(phrases, now).map((phrase) => phrase?.syllables[0]!.text)
    assert.deepEqual(texts(0.5), ['a ', 'b '])
    // a is sung: c takes its row, b keeps its own.
    assert.deepEqual(texts(2), ['c ', 'b '])
    assert.deepEqual(texts(8), [undefined, undefined])
  })

  test('words more than 5 s ahead are not shown; after such a pause they start on the top row (D142)', () => {
    // a b, then a pause of 9 s, then c d e.
    const phrases = phrasesOf([syllable(0, 1, 'a '), syllable(2, 3, 'b '), syllable(12, 13, 'c '), syllable(14, 15, 'd '), syllable(16, 17, 'e ')])
    const texts = (now: number) => shownPhrases(phrases, now).map((phrase) => phrase?.syllables[0]!.text)
    assert.deepEqual(texts(0.5), ['a ', 'b '])
    // b is sung; c is 9.5 s away.
    assert.deepEqual(texts(2.5), [undefined, 'b '])
    assert.deepEqual(texts(5), [undefined, undefined])
    // 5 s before c: on the top row, though by turns it would be the second's.
    assert.deepEqual(texts(7), ['c ', undefined])
    assert.deepEqual(texts(12.5), ['c ', 'd '])
    assert.deepEqual(texts(13.5), ['e ', 'd '])
    assert.deepEqual(phrases.map((_, i) => rowOf(phrases, i)), [0, 1, 0, 1, 0])
  })

  test('a long phrase keeps the next one hidden until 5 s before it', () => {
    const phrases = phrasesOf([syllable(0, 8, 'long '), syllable(9.5, 10, 'next ')])
    const texts = (now: number) => shownPhrases(phrases, now).map((phrase) => phrase?.syllables[0]!.text)
    assert.deepEqual(texts(1), ['long ', undefined])
    assert.deepEqual(texts(5), ['long ', 'next '])
  })

  test('the line with the most words is the lead’s; the others answer on a band above it (D137)', () => {
    const phrases = phrasesOf([
      syllable(0, 1, 'ooh ', { line: 0, track: 2 }),
      syllable(2, 3, 'I ', { line: 1, track: -1 }),
      syllable(3, 4, 'was ', { line: 1, track: -1 }),
    ])
    assert.equal(leadLine(phrases), 1)
    assert.equal(leadLine([]), 0)
  })

  test('a section of two lines has a row for each, its phrase not yet over (D139)', () => {
    const phrases = phrasesOf([
      syllable(0, 30, 'Ooh. ', { line: 1, track: 2 }),
      syllable(2, 3, 'Ooh yeah. ', { line: 2, track: 3 }),
      syllable(6, 7, 'Oh yeah. ', { line: 2, track: 3 }),
      syllable(40, 41, 'Ooh. ', { line: 1, track: 2 }),
    ])
    const texts = (now: number) => sectionRows(phrases, now).map((phrase) => phrase?.syllables[0]!.text)
    assert.deepEqual(texts(2.5), ['Ooh. ', 'Ooh yeah. '])
    // The first answer is over: the next one, not it, though the held line goes on.
    assert.deepEqual(texts(4), ['Ooh. ', 'Oh yeah. '])
    assert.deepEqual(texts(31), [undefined, undefined])
    // No further ahead than SHOWN_AHEAD (D142): 6 s before it, not yet; 4 s before, shown.
    assert.deepEqual(texts(34), [undefined, undefined])
    assert.deepEqual(texts(36), ['Ooh. ', undefined])
  })

  test('a third line below shows on a row its line leaves empty (D147)', () => {
    const phrases = phrasesOf([
      syllable(0, 10, 'Ah. ', { line: 1, track: 2 }),
      syllable(0, 2, 'Oh. ', { line: 2, track: 3 }),
      syllable(3, 5, 'Hey. ', { line: 3, track: 4 }),
    ])
    const texts = (now: number) => sectionRows(phrases, now).map((phrase) => phrase?.syllables[0]!.text)
    assert.deepEqual(texts(1), ['Ah. ', 'Oh. '])
    assert.deepEqual(texts(4), ['Ah. ', 'Hey. '])
  })

  test('a phrase below keeps its row when its line’s next phrase comes (D160)', () => {
    // Hey (line 3) takes the top row Ah (line 1) left; Ah's next phrase comes while Hey is still sung.
    const phrases = phrasesOf([
      syllable(0, 2, 'Ah. ', { line: 1, track: 2 }),
      syllable(0, 6, 'Oh. ', { line: 2, track: 3 }),
      syllable(3, 8, 'Hey. ', { line: 3, track: 4 }),
      syllable(9, 11, 'Ahh. ', { line: 1, track: 2 }),
    ])
    const texts = (now: number) => sectionRows(phrases, now).map((phrase) => phrase?.syllables[0]!.text)
    assert.deepEqual(texts(1), ['Ah. ', 'Oh. '])
    assert.deepEqual(texts(3), ['Hey. ', 'Oh. '])
    // Ahh is 5 s ahead, but both rows are held: it waits, and Hey is not pushed off its row.
    assert.deepEqual(texts(5), ['Hey. ', 'Oh. '])
    // It takes the bottom row Oh left; Hey stays on top until it is sung.
    assert.deepEqual(texts(6.5), ['Hey. ', 'Ahh. '])
    assert.deepEqual(texts(8.5), [undefined, 'Ahh. '])
  })

  test('colours a syllable as it is sung, from its consonant, 60 ms before its note (D276)', () => {
    const s = syllable(1, 3, 'glow ')
    assert.equal(CONSONANT_LEAD, 0.06)
    assert.deepEqual([0, 0.94, 1.94, 2.94, 4].map((now) => Math.round(sung(s, now) * 1e9) / 1e9), [0, 0, 0.5, 1, 1])
    assert.ok(sung(s, 0.95) > 0, 'lit before its note')
  })

  test('a voice at its sung times has its words through its map; the others keep the grid (D276)', () => {
    // The lead's second note sung 100 ms late, as the player moved it; the bass on the grid.
    const notes = [note(60, 0, 0.6), note(48, 0, 0.5, 2), note(50, 0.5, 0.5, 2), note(62, 0.6, 0.4)]
    const lyrics = [lyric(0, 'Lan', { hyphen: true, voice: 'lead' }), lyric(0.25, 'tern', { voice: 'lead' }), lyric(0, 'Oh', { voice: 'bass', line: 1 }), lyric(0.25, 'no', { voice: 'bass', line: 1 })]
    const lead = (time: number) => (time === 0.5 ? 0.6 : time)
    const syllables = syllablesOf(lyrics, seconds, notes, new Map([['lead', 1], ['bass', 2]]), new Map([[1, lead]]))
    assert.deepEqual(syllables, [
      syllable(0, 0.6, 'Lan'),
      syllable(0.6, 1, 'tern '),
      syllable(0, 0.5, 'Oh ', { track: 2, line: 1 }),
      syllable(0.5, 1, 'no ', { track: 2, line: 1 }),
    ])
  })

  test('words not yet sung are their singer’s colour dimmed towards the sky (D148)', () => {
    assert.equal(mixed('#33bbee', '#170f33', 0.8), 'rgb(45, 153, 201)')
    assert.equal(mixed('#000000', '#ffffff', 0), 'rgb(255, 255, 255)')
    assert.equal(mixed('red', '#ffffff', 0.5), 'red')
  })

  test('the lane has a semitone of room over and under the notes', () => {
    assert.deepEqual(laneRange([note(60, 0, 1), note(67, 1, 1)]), { low: 59, high: 68 })
    assert.deepEqual(laneRange([]), { low: 55, high: 72 })
  })
})

// words.ly records the words in a file of their own (crates/engrave reads them through).
describe('the words of a real score', () => {
  test('each syllable with its hyphen or extender and its line, sung on its voice’s track', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff \\new Voice = "lead" { \\tempo 4 = 120 c\'4 d\' e\'2( | f\'1) }',
        '    \\new Lyrics \\lyricsto "lead" { Lan -- tern glow __ }',
        '    \\new Staff \\new Voice = "back" { r2 g2 | g1 }',
        '    \\new Lyrics \\lyricsto "back" { ooh \\markup \\italic wah }',
        '  >>',
        '  \\layout { }',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    assert.deepEqual(outcome.timing?.lyrics, [
      { at: 0, text: 'Lan', hyphen: true, extender: false, line: 0, voice: 'lead', italic: false },
      { at: 0.25, text: 'tern', hyphen: false, extender: false, line: 0, voice: 'lead', italic: false },
      { at: 0.5, text: 'glow', hyphen: false, extender: true, line: 0, voice: 'lead', italic: false },
      { at: 0.5, text: 'ooh', hyphen: false, extender: false, line: 1, voice: 'back', italic: false },
      { at: 1, text: 'wah', hyphen: false, extender: false, line: 1, voice: 'back', italic: true },
    ])
    const midi = parseMidi(outcome.midiData!)
    const voices = voiceTracks(outcome.timing!.staves, midi.tracks)
    assert.deepEqual([...voices], [
      ['lead', 1],
      ['back', 3],
    ])
    const syllables = syllablesOf(outcome.timing!.lyrics!, (at) => momentTime(midi, at), midi.notes, voices)
    // glow is held over the slur into bar 2; each Lyrics context has a track
    // of its own, so the back voice's notes are on track 3.
    assert.deepEqual(
      syllables.map(({ text, start, end, track }) => [text, start, end, track]),
      [
        ['Lan', 0, 0.5, 1],
        ['tern ', 0.5, 1, 1],
        ['glow ', 1, 4, 1],
        ['ooh ', 1, 2, 3],
        ['wah ', 2, 4, 3],
      ],
    )
  })

  test('a band’s singer stays on their voice’s track, a DrumStaff among the staves (D138)', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff \\new Voice = "lead" { \\tempo 4 = 120 c\'2 d\' | r1 }',
        '    \\new Lyrics \\lyricsto "lead" { Hold me }',
        '    \\new DrumStaff \\drummode { bd4 sn bd sn | bd sn bd sn }',
        '    \\new Staff { c4 d e f | g a b c\' }',
        '  >>',
        '  \\layout { }',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    const midi = parseMidi(outcome.midiData!)
    const voices = voiceTracks(outcome.timing!.staves, midi.tracks)
    assert.deepEqual([...voices], [['lead', 1]])
  })

  test('a line of \\addlyrics on a staff is sung on its track, a NullVoice’s is not (D138)', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff { \\tempo 4 = 120 c\'2 d\' } \\addlyrics { one two }',
        '    \\new Staff = "named" { e\'2 f\' } \\addlyrics { three four }',
        '    \\new Staff \\new Voice = "b" { g2 a }',
        '    \\new Lyrics \\lyricsto "b" { low er }',
        '    \\new NullVoice = "aside" { c2 c } \\addlyrics { said too }',
        '  >>',
        '  \\layout { }',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    const midi = parseMidi(outcome.midiData!)
    const voices = voiceTracks(outcome.timing!.staves, midi.tracks)
    const syllables = syllablesOf(outcome.timing!.lyrics!, (at) => momentTime(midi, at), midi.notes, voices)
    assert.deepEqual(
      syllables.map(({ text, end, track, said }) => [text, end, track, said]),
      [
        ['one ', 1, 1, false],
        ['two ', 2, 1, false],
        ['three ', 1, 3, false],
        ['four ', 2, 3, false],
        ['low ', 1, 5, false],
        ['er ', 2, 5, false],
        ['said ', 0.5, -1, true],
        ['too ', 1.5, -1, true],
      ],
    )
  })

  test('a line of \\addlyrics on a staff group stays sung, its staves named or not (D138)', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    const group = (staves: string) => `    \\new PianoStaff << \\new Staff ${staves.split(',')[0]} { \\tempo 4 = 120 c'2 d' } \\new Staff ${staves.split(',')[1]} { c1 } >> \\addlyrics { one two }`
    for (const lines of [[group(',')], [group('= "up",= "down"')], [group(','), '    \\new Staff \\new Voice = "b" { g2 a }', '    \\new Lyrics \\lyricsto "b" { low er }']]) {
      await fs.writeFile(score, ['\\version "2.24.0"', '\\score {', '  <<', ...lines, '  >>', '  \\layout { }', '  \\midi { }', '}', ''].join('\n'))
      const outcome = await realOutcome(t, score)
      if (!outcome) return
      assert.equal(outcome.state, 'ok', outcome.message)
      const midi = parseMidi(outcome.midiData!)
      const voices = voiceTracks(outcome.timing!.staves, midi.tracks)
      const syllables = syllablesOf(outcome.timing!.lyrics!, (at) => momentTime(midi, at), midi.notes, voices)
      assert.deepEqual(
        syllables.filter(({ line }) => line === 0).map(({ text, end, track, said }) => [text, end, track, said]),
        [
          ['one ', 1, 1, false],
          ['two ', 2, 1, false],
        ],
      )
    }
  })

  test('words to a NullVoice stay on no track beside a named staff with no named voice (D138)', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff = "piano" { \\tempo 4 = 120 c\'2 d\' }',
        '    \\new NullVoice = "aside" { c2 c }',
        '    \\new Lyrics \\lyricsto "aside" { said too }',
        '  >>',
        '  \\layout { }',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    const midi = parseMidi(outcome.midiData!)
    const voices = voiceTracks(outcome.timing!.staves, midi.tracks)
    assert.deepEqual(
      syllablesOf(outcome.timing!.lyrics!, (at) => momentTime(midi, at), midi.notes, voices).map(({ track, said }) => [track, said]),
      [
        [-1, true],
        [-1, true],
      ],
    )
  })

  test('a syllable’s text as a real score hands it on: ties, spaces, skips and written underscores', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff \\new Voice = "lead" { \\tempo 4 = 120 c\'4 d\' e\' f\' g\' a\' b\' c\'\' }',
        '    \\new Lyrics \\lyricsto "lead" { la~la la_la _ "la_la" "la~la" _la la_ end }',
        '  >>',
        '  \\layout { }',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    assert.deepEqual(
      outcome.timing?.lyrics?.map(({ text }) => text),
      ['la~la', 'la la', ' ', 'la_la', 'la~la', ' la', 'la ', 'end'],
    )
    const midi = parseMidi(outcome.midiData!)
    const voices = voiceTracks(outcome.timing!.staves, midi.tracks)
    assert.deepEqual(
      syllablesOf(outcome.timing!.lyrics!, (at) => momentTime(midi, at), midi.notes, voices).map(({ text }) => text),
      ['la\u203fla ', 'la la ', 'la_la ', 'la\u203fla ', 'la ', 'la ', 'end '],
    )
  })

  test('a repeat played by a score of its own: each time’s verse, then the second ending’s words, with the printed bars (D145)', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        'tune = {',
        '  \\tempo 4 = 120',
        "  r2 r4 c'4 |",
        '  \\repeat volta 2 {',
        '    \\unfolded \\volta 2 \\set Score.currentBarNumber = #2',
        "    d'4 e' f' g' |",
        '  }',
        '  \\alternative {',
        "    { r2 r4 c'4 | }",
        '    { \\unfolded \\set Score.currentBarNumber = #4 R1 | }',
        '  }',
        "  a'1 |",
        '}',
        'verseOne = \\lyricmode { Ah one two three four }',
        'verseTwo = \\lyricmode { five six sev -- en }',
        '\\score {',
        '  <<',
        '    \\new Staff \\new Voice = "lead" { \\tune }',
        '    \\new Lyrics \\lyricsto "lead" { \\verseOne "Oh-" end }',
        '    \\new Lyrics \\lyricsto "lead" { Oh -- \\verseTwo }',
        '  >>',
        '  \\layout { }',
        '}',
        '\\score {',
        '  \\unfoldRepeats <<',
        '    \\new Staff \\new Voice = "lead" { \\tune }',
        '    \\new Lyrics \\lyricsto "lead" { \\verseOne Oh -- \\verseTwo end }',
        '  >>',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    const timing = outcome.timing!
    assert.deepEqual(timing.bars.map(({ number }) => number).slice(0, 6), [1, 2, 3, 2, 4, 5])
    const midi = parseMidi(outcome.midiData!)
    const syllables = syllablesOf(timing.lyrics!, (at) => momentTime(midi, at), midi.notes, voiceTracks(timing.staves, midi.tracks))
    // Bar 1's last beat, bars 2 and 3, then bar 2 again and bar 4's rest, to bar 5.
    assert.deepEqual(
      syllables.map(({ text, start }) => [text, start]),
      [
        ['Ah ', 1.5],
        ['one ', 2],
        ['two ', 2.5],
        ['three ', 3],
        ['four ', 3.5],
        ['Oh', 5.5],
        ['five ', 6],
        ['six ', 6.5],
        ['sev', 7],
        ['en ', 7.5],
        ['end ', 10],
      ],
    )
    assert.equal(sectionsOf(midi.notes, phrasesOf(syllables)).length, 1)
  })

  test('a markup with a dotted pair in it keeps its syllable and warns of nothing', async (t) => {
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-karaoke-')))
    t.after(() => fs.rm(scratch, { recursive: true, force: true }))
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff \\new Voice = "lead" { c\'4 d\' e\' }',
        '    \\new Lyrics \\lyricsto "lead" { la \\markup \\override #\'(baseline-skip . 3) { bo } ti }',
        '  >>',
        '  \\layout { }',
        '  \\midi { }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok', outcome.message)
    assert.deepEqual(outcome.diagnostics, [])
    assert.equal(outcome.warningCount, 0)
    assert.deepEqual(
      outcome.timing?.lyrics?.map(({ text, italic }) => [text, italic]),
      [
        ['la', false],
        ['bo', false],
        ['ti', false],
      ],
    )
  })
})

describe('a long phrase at the least text size (D157)', () => {
  // Each character 10 px wide.
  const widthOf = (text: string) => text.length * 10
  const words = (texts: string[]) => texts.map((text, i) => syllable(i, i + 1, text))
  const lines = (wrapped: Syllable[][]) => wrapped.map((line) => line.map(({ text }) => text).join('').trimEnd())

  test('breaks at word ends, each line as full as it fits', () => {
    const phrase = words(['Here ', 'comes ', 'the ', 'morn', 'ing, ', 'slow', 'ly ', 'the ', 'light'])
    assert.deepEqual(lines(wrapSyllables(phrase, widthOf, 160)), ['Here comes the', 'morning, slowly', 'the light'])
  })

  test('keeps a phrase that fits on one line, and never splits a word', () => {
    const phrase = words(['la ', 'la ', 'la'])
    assert.deepEqual(lines(wrapSyllables(phrase, widthOf, 160)), ['la la la'])
    // A word wider than the room is a line of its own, its syllables together.
    assert.deepEqual(lines(wrapSyllables(words(['su', 'per', 'cal', 'i', 'frag ', 'yes']), widthOf, 50)), ['supercalifrag', 'yes'])
  })

  test('evens the lines out rather than leave one word alone', () => {
    const phrase = words(['slow', 'ly ', 'the ', 'light ', 'is ', 'ris', 'ing,'])
    assert.deepEqual(lines(wrapSyllables(phrase, widthOf, 200)), ['slowly the light is', 'rising,'])
    assert.deepEqual(lines(balancedLines(phrase, widthOf, 200)), ['slowly the light', 'is rising,'])
    assert.deepEqual(lines(balancedLines(words(['one ', 'line']), widthOf, 200)), ['one line'])
  })
})

describe('the words stay where they appeared (D160)', () => {
  /** A 2D context that draws nothing and records where each text is filled, 0.5 of the font size a character wide. */
  function recorder(): { context: CanvasRenderingContext2D; filled: { text: string; y: number }[] } {
    const filled: { text: string; y: number }[] = []
    const state: Record<string | symbol, unknown> = { font: '10px sans-serif' }
    const size = () => Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10)
    const nothing = () => ({ addColorStop: () => {} })
    const context = new Proxy(state, {
      get: (target, key) => {
        if (key === 'measureText') return (text: string) => ({ width: text.length * size() * 0.5 })
        if (key === 'fillText') return (text: string, _x: number, y: number) => filled.push({ text, y })
        if (key in target) return target[key]
        return nothing
      },
      set: (target, key, value) => {
        target[key] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    return { context, filled }
  }

  test('a phrase being sung does not move when a taller one comes in beside it', () => {
    // a, then b on the second row, then a long c on the top row, shown while b is sung.
    const la = (from: number, count: number) => Array.from({ length: count }, (_, i) => syllable(from + i * 0.15, from + (i + 1) * 0.15, 'la '))
    const phrases = phrasesOf([syllable(0, 2, 'one '), syllable(3, 6, 'two '), ...la(7, 19)])
    assert.equal(phrases.length, 3)
    const yOf = (now: number, text: string) => {
      const { context, filled } = recorder()
      drawKaraoke(context, { width: 200, height: 220, now, notes: [], longest: 0, phrases, color: () => '#33bbee', name: () => '', minText: 24 })
      return [...new Set(filled.filter((fill) => fill.text === text).map(({ y }) => y))]
    }
    // At 1 s the top row shows one; at 3 s it shows the long phrase, on lines of its own.
    assert.equal(yOf(1, 'la la la la').length, 0)
    assert.ok(yOf(3, 'la la la la').length > 0)
    assert.deepEqual(yOf(3, 'two'), yOf(1, 'two'))
    assert.equal(yOf(1, 'two').length, 1)
  })
})
