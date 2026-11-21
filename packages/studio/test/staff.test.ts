import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Note } from '@lily/common/web/midi.js'
import type { TimedStaff } from '@lily/common/types'
import { staffTracks, type Section } from '../src/renderer/karaoke'
import { accidentalOf, drawStaff, fifthsOf, keyOf, noteLengths, noteValue, signatureAlter, staffLayout, stepOf, trackClefs } from '../src/renderer/staff'

// Runs under `node --test` from out/test/ (npm run test:unit).

function note(key: number, time: number, duration = 0.5, track = 1): Note {
  return { time, duration, track, channel: 0, key, velocity: 0.8, program: 0, gain: 1, pan: 0, detune: 0 }
}

/** The notes of `keys`, one after another. */
function run(keys: readonly number[]): Note[] {
  return keys.map((key, i) => note(key, i * 0.5))
}

const C_MAJOR = { tonic: 0, mode: 'major', fit: 0 } as const

describe('Karaoke’s staff (D156)', () => {
  test('finds the key the notes are in, major or minor', () => {
    const c = keyOf(run([60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60]))
    assert.deepEqual([c.tonic, c.mode], [0, 'major'])
    const g = keyOf(run([67, 69, 71, 72, 74, 76, 78, 79, 74, 71, 67]))
    assert.deepEqual([g.tonic, g.mode, fifthsOf(g)], [7, 'major', 1])
    // A minor's raised seventh does not make it E major or C major.
    const a = keyOf(run([69, 71, 72, 74, 76, 77, 80, 81, 76, 72, 69, 64, 69]))
    assert.deepEqual([a.tonic, a.mode, fifthsOf(a)], [9, 'minor', 0])
    assert.deepEqual(keyOf([]), C_MAJOR)
  })

  test('counts a signature’s sharps and flats as the tonic is spelled', () => {
    assert.equal(fifthsOf({ tonic: 6, mode: 'major', fit: 0 }), 6) // F♯ major
    assert.equal(fifthsOf({ tonic: 1, mode: 'major', fit: 0 }), -5) // D♭ major
    assert.equal(fifthsOf({ tonic: 3, mode: 'minor', fit: 0 }), -6) // E♭ minor
    assert.equal(fifthsOf({ tonic: 1, mode: 'minor', fit: 0 }), 4) // C♯ minor
    assert.equal(signatureAlter(3, 1), 1) // F♯ in G
    assert.equal(signatureAlter(0, 1), 0)
    assert.equal(signatureAlter(6, -2), -1) // B♭ in B♭
    assert.equal(signatureAlter(2, -2), -1) // E♭ too
    assert.equal(signatureAlter(5, -2), 0)
  })

  test('prints an accidental only where the signature does not have it', () => {
    const g = { tonic: 7, mode: 'major', fit: 0 } as const
    assert.equal(accidentalOf(66, g), '')
    assert.equal(accidentalOf(65, g), '♮')
    assert.equal(accidentalOf(61, C_MAJOR), '♯')
    assert.equal(accidentalOf(70, C_MAJOR), '♭')
    assert.equal(accidentalOf(63, { tonic: 10, mode: 'major', fit: 0 }), '')
  })

  test('puts a note on its step: middle C is 28, seven to an octave', () => {
    assert.equal(stepOf(60, C_MAJOR), 28)
    assert.equal(stepOf(64, C_MAJOR), 30)
    assert.equal(stepOf(72, C_MAJOR), 35)
    // A flat is on the step of its letter.
    assert.equal(stepOf(70, C_MAJOR), 34)
  })

  test('takes the score’s clef when the notes fit it, else treble or bass, else a grand staff', () => {
    const steps = (keys: number[]) => keys.map((key) => stepOf(key, C_MAJOR))
    // A soprano, without a clef from the score.
    assert.deepEqual(staffLayout(steps([60, 72, 79]), undefined).staves, ['treble'])
    // A bass.
    assert.deepEqual(staffLayout(steps([40, 50, 60]), undefined).staves, ['bass'])
    // A tenor in treble_8: written an octave higher.
    const tenor = staffLayout(steps([48, 57, 67]), { clef: 'treble', transposition: -7 })
    assert.deepEqual([tenor.staves, tenor.shift], [['treble'], 7])
    // A part the score gives a bass clef, too high for it.
    assert.deepEqual(staffLayout(steps([76, 84]), { clef: 'bass', transposition: 0 }).staves, ['treble'])
    // A piano's both hands.
    const grand = staffLayout(steps([36, 60, 84]), undefined)
    assert.deepEqual(grand.staves, ['treble', 'bass'])
    assert.ok(grand.low <= 18 && grand.high >= 38)
    // Without notes, a treble staff.
    assert.deepEqual(staffLayout([], undefined).staves, ['treble'])
  })

  test('draws a note as the value nearest its length', () => {
    assert.deepEqual(noteValue(0.25), { head: 'black', flags: 0, dots: 0 })
    assert.deepEqual(noteValue(0.375), { head: 'black', flags: 0, dots: 1 })
    assert.deepEqual(noteValue(0.125), { head: 'black', flags: 1, dots: 0 })
    assert.deepEqual(noteValue(0.0625), { head: 'black', flags: 2, dots: 0 })
    assert.deepEqual(noteValue(0.5), { head: 'half', flags: 0, dots: 0 })
    assert.deepEqual(noteValue(1), { head: 'whole', flags: 0, dots: 0 })
    // Tied past a dotted whole, still a whole note's head.
    assert.deepEqual(noteValue(3), { head: 'whole', flags: 0, dots: 1 })
    // A quarter-note triplet: the dotted eighth it is nearest.
    assert.deepEqual(noteValue(1 / 6), { head: 'black', flags: 1, dots: 1 })
  })

  test('measures a note in whole notes through the tempo', () => {
    // ♩ = 120: a whole note lasts two seconds.
    const seconds = (at: number) => at * 2
    const quarter = note(60, 1, 0.5)
    const half = note(62, 1.5, 1)
    const lengths = noteLengths([quarter, half], seconds)
    assert.ok(Math.abs(lengths.get(quarter)! - 0.25) < 1e-6)
    assert.ok(Math.abs(lengths.get(half)! - 0.5) < 1e-6)
  })

  test('a voice at its sung times is measured through its map, so its notes keep their written lengths (D276)', () => {
    const seconds = (at: number) => at * 2
    // A quarter at 1 s sung 100 ms late, and the half after it on the grid: the quarter is held to it.
    const map = (time: number) => (time <= 1 ? time + 0.1 * time : time < 1.5 ? 1.1 + ((time - 1) * 0.4) / 0.5 : time)
    const quarter = note(60, 1.1, 0.4)
    const half = note(62, 1.5, 1, 2)
    const lengths = noteLengths([quarter, half], (at, n) => (n.track === 1 ? map(seconds(at)) : seconds(at)))
    assert.ok(Math.abs(lengths.get(quarter)! - 0.25) < 1e-6)
    assert.ok(Math.abs(lengths.get(half)! - 0.5) < 1e-6)
  })

  test('gives each staff’s track the score’s clef', () => {
    const staff = (clef: string, clefTransposition: number, voices: string[]): TimedStaff => ({ id: '', name: '', shortName: '', group: '', groupIndex: -1, clef, clefTransposition, voices })
    const tracks = [
      { notes: 0, channels: [] },
      { notes: 10, channels: [0] },
      { notes: 12, channels: [1] },
      { notes: 8, channels: [2] },
    ]
    const clefs = trackClefs(staffTracks([staff('clefs.G', -7, ['tenor']), staff('clefs.F', 0, ['bass']), staff('clefs.C', 0, ['viola'])], tracks))
    assert.deepEqual([...clefs], [
      [1, { clef: 'treble', transposition: -7 }],
      [2, { clef: 'bass', transposition: 0 }],
    ])
  })
})

describe('the clef and signature fit the lane (D156)', () => {
  /** Apple Symbols' ink at 100 px from the alphabetic baseline: what each glyph reaches above it and below. */
  const INK: Record<string, [number, number]> = { '𝄞': [65.6, 7.7], '𝄢': [65.6, 0], '♯': [62.3, 9.8], '♭': [63.9, 6.3] }

  /** A 2D context that measures as a canvas does, from the baseline set, and records where each glyph's ink is filled. */
  function recorder(): { context: CanvasRenderingContext2D; inks: { text: string; top: number; bottom: number }[] } {
    const inks: { text: string; top: number; bottom: number }[] = []
    const state: Record<string | symbol, unknown> = { font: '10px sans-serif', textBaseline: 'alphabetic', textAlign: 'start' }
    const size = () => Number(/([\d.]+)px/.exec(String(state.font))?.[1] ?? 10)
    const context = new Proxy(state, {
      get: (target, key) => {
        if (key === 'measureText')
          return (text: string) => {
            const [ascent, descent] = INK[text] ?? [size() * 0.7, 0]
            // Measured from the middle, the ink reaches less above it and more below.
            const by = target.textBaseline === 'alphabetic' ? 0 : 35
            return { width: 40, actualBoundingBoxAscent: ascent - by, actualBoundingBoxDescent: descent + by, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 40 }
          }
        if (key === 'fillText')
          return (text: string, _x: number, y: number) => {
            const ink = INK[text]
            if (ink && target.textBaseline === 'alphabetic') inks.push({ text, top: y - (ink[0] * size()) / 100, bottom: y + (ink[1] * size()) / 100 })
          }
        if (key in target) return target[key]
        return () => {}
      },
      set: (target, key, value) => {
        target[key] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    return { context, inks }
  }

  test('a treble staff in five sharps over low notes keeps its clef and sharps inside, whatever baseline was set before', () => {
    // As in a second singer's lane of a video, drawn after the words left the baseline at the middle.
    const note = (time: number, key: number): Note => ({ time, duration: 0.4, track: 0, channel: 0, key, velocity: 0.8, program: 0, gain: 1, pan: 0, detune: 0 })
    const section = { notes: [59, 61, 63, 59, 61, 64].map((key, i) => note(1 + i * 0.5, key)), phrases: [], said: [] } as unknown as Section
    const staff = { lengths: new Map(), bars: [], clefs: new Map(), key: { tonic: 11, mode: 'major' as const, fit: 1 } }
    const { context, inks } = recorder()
    context.textBaseline = 'middle'
    const box = { left: 24, right: 1256, top: 40, bottom: 163, nowX: 213, perSecond: 213, now: 0.5, from: -1, to: 5, longest: 1, color: () => '#22aa99' }
    drawStaff(context, section, staff, box)
    assert.deepEqual(
      inks.map(({ text }) => text),
      ['𝄞', '♯', '♯', '♯', '♯', '♯'],
    )
    for (const { text, top, bottom } of inks) assert.ok(top >= box.top && bottom <= box.bottom, `${text} from ${top} to ${bottom}`)
  })
})
