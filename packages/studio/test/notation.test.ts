import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { drums, keyCommand, keyWords, noteName, partial, pickupTempo, pieces, RelativeWriter, spell, voice } from '../src/renderer/notation'

// Runs under `node --test` from out/test/ (npm run test:unit in packages/studio/):
// a transcribed stem as LilyPond music (DECISIONS D113). Engraving it is
// files.test.ts's, through lily-outcome.

const C_MINOR = { tonic: 0, mode: 'minor', fit: 0.8 } as const
const C_MAJOR = { tonic: 0, mode: 'major', fit: 0.8 } as const
const name = (pitch: number, key: typeof C_MINOR | typeof C_MAJOR = C_MINOR) => noteName(spell(pitch, key))

describe('spelling in the key', () => {
  test('a minor key spells its scale with flats, and its leading tone and major sixth natural', () => {
    assert.deepEqual([60, 62, 63, 65, 67, 68, 70].map((pitch) => name(pitch)), ['c', 'd', 'es', 'f', 'g', 'as', 'bes'])
    assert.deepEqual([71, 69, 64, 66, 61].map((pitch) => name(pitch)), ['b', 'a', 'e', 'fis', 'des'])
  })

  test('a major key spells its chromatic notes as #1, b3, #4, b6 and b7', () => {
    assert.deepEqual([61, 63, 66, 68, 70].map((pitch) => name(pitch, C_MAJOR)), ['cis', 'es', 'fis', 'as', 'bes'])
    assert.deepEqual([66, 70, 61].map((pitch) => noteName(spell(pitch, { tonic: 6, mode: 'major', fit: 1 }))), ['fis', 'ais', 'cis'])
    assert.deepEqual([63, 70, 59].map((pitch) => noteName(spell(pitch, { tonic: 3, mode: 'major', fit: 1 }))), ['es', 'bes', 'ces'])
  })

  test('the octave is the written note’s: middle C is in 4, and C♯ minor’s B-sharp under it in 3', () => {
    assert.deepEqual(spell(60, C_MINOR), { step: 0, alter: 0, octave: 4 })
    assert.deepEqual(spell(36, C_MINOR), { step: 0, alter: 0, octave: 2 })
    assert.deepEqual(spell(60, { tonic: 1, mode: 'minor', fit: 1 }), { step: 6, alter: 1, octave: 3 })
  })

  test('names: es, as, bes, double flats and sharps', () => {
    assert.deepEqual(
      [
        [2, -1],
        [5, -1],
        [6, -1],
        [2, -2],
        [5, -2],
        [1, -2],
        [3, 1],
        [3, 2],
      ].map(([step, alter]) => noteName({ step: step!, alter: alter! })),
      ['es', 'as', 'bes', 'eses', 'ases', 'deses', 'fis', 'fisis'],
    )
  })

  test('the key: its command and its words', () => {
    assert.equal(keyCommand(C_MINOR), '\\key c \\minor')
    assert.equal(keyCommand({ tonic: 3, mode: 'major', fit: 1 }), '\\key es \\major')
    assert.equal(keyCommand({ tonic: 8, mode: 'minor', fit: 1 }), '\\key gis \\minor')
    assert.equal(keyWords({ tonic: 10, mode: 'major', fit: 1 }), 'B♭ major')
    assert.equal(keyWords({ tonic: 6, mode: 'minor', fit: 1 }), 'F♯ minor')
  })
})

describe('\\relative', () => {
  test('the first note is in its absolute octave, then each is nearest the one before', () => {
    const writer = new RelativeWriter(C_MINOR)
    // C2, G2 (a fifth up: written below, then '), C2, F2, C3, B♭1.
    assert.deepEqual([[36], [43], [36], [41], [48], [34]].map((pitches) => writer.write(pitches)), ['c,', "g'", 'c,', 'f', "c'", 'bes,'])
  })

  test('a chord’s notes are each nearest the one before, and its first is the next one’s reference', () => {
    const writer = new RelativeWriter(C_MAJOR)
    assert.equal(writer.write([60, 64, 67]), "<c' e g>")
    assert.equal(writer.write([72]), "c'")
    assert.equal(writer.write([48, 55, 76]), "<c,, g' e''>")
    assert.equal(writer.write([50]), 'd')
  })
})

describe('bars', () => {
  test('a note is split where its place in the bar asks, and tied', () => {
    assert.deepEqual(pieces(0, 16, 16, false), [16])
    assert.deepEqual(pieces(0, 7, 16, false), [6, 1])
    assert.deepEqual(pieces(6, 6, 16, false), [6])
    assert.deepEqual(pieces(1, 7, 16, false), [3, 4])
    assert.deepEqual(pieces(4, 12, 16, false), [12])
    assert.deepEqual(pieces(3, 2, 16, false), [1, 1])
  })

  test('rests show the beats', () => {
    assert.deepEqual(pieces(2, 14, 16, true), [2, 4, 8])
    assert.deepEqual(pieces(1, 7, 16, true), [1, 2, 4])
    assert.deepEqual(pieces(6, 6, 16, true), [2, 4])
  })

  test('a voice: the pickup, notes tied across bar lines, and runs of empty bars as one rest', () => {
    const writer = new RelativeWriter(C_MINOR)
    const text = voice(
      [
        [-2, 2, [36]],
        [0, 6, [36]],
        [6, 14, [43]],
        [64, 4, [41]],
      ],
      { pickup: 2, bars: 6, beatsPerBar: 4 },
      (pitches) => writer.write(pitches),
    )
    assert.deepEqual(text, {
      pickup: 'c,8',
      bars: ["c4. g'4.~ g4~ | % 1", 'g4 r4 r2 |', 'R1*2 |', 'f4 r4 r2 | % 5', 'R1 |'],
    })
  })

  test('three beats a bar rest as R2.', () => {
    const text = voice([], { pickup: 0, bars: 5, beatsPerBar: 3 }, drums)
    assert.deepEqual(text, { bars: ['R2.*5 | % 1–5'] })
  })

  test('drums are named as \\drummode names them', () => {
    assert.equal(drums([36]), 'bd')
    assert.equal(drums([36, 38, 42]), '<bd sn hh>')
  })

  test('the pickup: \\partial, and a MIDI tempo that makes it last as the stem’s start does', () => {
    assert.equal(partial(2), '\\partial 8')
    assert.equal(partial(5), '\\partial 16*5')
    // Two sixteenths in 0.2104 s: 8 64ths at 2281 a minute.
    assert.equal(pickupTempo(2, 0.2104), '\\once \\omit Score.MetronomeMark \\tempo 64 = 2281')
  })
})
