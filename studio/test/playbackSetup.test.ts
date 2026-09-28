import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { momentTime, parseMidi, type Midi } from '../../media/midi.js'
import { barTime, mixMidi, momentAt, partsOf, withPart, withStartBar } from '../src/renderer/playbackSetup'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/, in studio/ (npm run test:unit).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-setup-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

function note(track: number, channel: number, program: number, time = 0) {
  return { time, duration: 0.5, track, channel, key: 60, program }
}

const MIDI: Midi = {
  title: '',
  duration: 1,
  division: 384,
  tracks: [
    { name: 'control track', channels: [], programs: [], notes: 0 },
    { name: '', channels: [0], programs: [40], notes: 1 },
    { name: '', channels: [1], programs: [0], notes: 1 },
    { name: '', channels: [9], programs: [], notes: 1 },
  ],
  notes: [note(1, 0, 40), note(2, 1, 0), note(3, 9, 0)],
}

describe('the parts and the mix', () => {
  test('a part is a track with notes, drums included', () => {
    assert.deepEqual(partsOf(MIDI), [
      { track: 1, number: 1, written: 'violin', drums: false },
      { track: 2, number: 2, written: 'acoustic grand', drums: false },
      { track: 3, number: 3, written: 'drums', drums: true },
    ])
  })

  test('muted parts are left out, the others play on the chosen program; drums keep their kit', () => {
    assert.equal(mixMidi(MIDI, undefined), MIDI)
    assert.equal(mixMidi(MIDI, {}), MIDI)
    const mixed = mixMidi(MIDI, { parts: { 1: { muted: true }, 2: { program: 73 }, 3: { program: 0 } } })
    assert.deepEqual(
      mixed.notes.map((n) => [n.track, n.program]),
      [
        [2, 73],
        [3, 0],
      ],
    )
    assert.equal(mixed.duration, MIDI.duration)
    // The parsed music is not changed.
    assert.equal(MIDI.notes[1].program, 0)
  })

  test('a part back to the way it is written leaves the setup', () => {
    let setup = withPart({}, 2, { program: 73 })
    setup = withPart(setup, 2, { muted: true })
    assert.deepEqual(setup, { parts: { 2: { program: 73, muted: true } } })
    setup = withPart(setup, 2, { program: null })
    setup = withStartBar(setup, 4)
    assert.deepEqual(setup, { parts: { 2: { muted: true } }, startBar: 4 })
    assert.deepEqual(withStartBar(withPart(setup, 2, { muted: false }), undefined), {})
  })
})

describe('the start bar', () => {
  test('a bar starts where it is first played; one without a note of its own is placed evenly', () => {
    const bars = [
      { time: 0, number: 1 },
      { time: 2, number: 2 },
      { time: 8, number: 5 },
      { time: 10, number: 2 },
    ]
    assert.equal(barTime(bars, 1), 0)
    assert.equal(barTime(bars, 2), 2)
    assert.equal(barTime(bars, 3), 4)
    assert.equal(barTime(bars, 6), undefined)
    assert.equal(barTime(bars, 0), undefined)
  })

  test('a point on a page is the moment on its system at or left of it', () => {
    const line = {
      systems: [
        { page: 0, top: 0.1, bottom: 0.2 },
        { page: 0, top: 0.3, bottom: 0.4 },
        { page: 1, top: 0.1, bottom: 0.2 },
      ],
      moments: [
        { time: 0, page: 0, x: 0.2, system: 0 },
        { time: 1, page: 0, x: 0.5, system: 0 },
        { time: 2, page: 0, x: 0.2, system: 1 },
        { time: 3, page: 0, x: 0.6, system: 1 },
        { time: 4, page: 1, x: 0.2, system: 2 },
      ],
    }
    assert.equal(momentAt(line, 0, 0.55, 0.15)?.time, 1)
    assert.equal(momentAt(line, 0, 0.1, 0.15)?.time, 0) // left of the first note: the first
    assert.equal(momentAt(line, 0, 0.7, 0.28)?.time, 3) // between systems: the nearer one
    assert.equal(momentAt(line, 1, 0.9, 0.9)?.time, 4)
    assert.equal(momentAt(line, 2, 0.5, 0.5), undefined)
  })

  test('the bars of a real score: bar 3 starts after two bars of 4/4 at 120', async (t) => {
    const score = path.join(scratch, 'parts.ly')
    await fs.writeFile(
      score,
      [
        '\\version "2.24.0"',
        '\\score {',
        '  <<',
        '    \\new Staff \\with { midiInstrument = "violin" } \\relative { c\'\'4 d e f | g1 | c,4 d e f | g1 }',
        '    \\new Staff { \\clef bass c4 d e f | g1 | c4 d e f | g1 }',
        '  >>',
        '  \\layout { }',
        '  \\midi { \\tempo 4 = 120 }',
        '}',
        '',
      ].join('\n'),
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok')
    const midi = parseMidi(outcome.midiData!)
    assert.deepEqual(
      partsOf(midi).map((part) => part.written),
      ['violin', 'acoustic grand'],
    )
    const bars = outcome.timing!.bars.map(({ at, number }) => ({ time: momentTime(midi, at), number })).sort((a, b) => a.time - b.time)
    assert.equal(barTime(bars, 3), 4)
    const mixed = mixMidi(midi, { parts: { [partsOf(midi)[0].track]: { muted: true } } })
    assert.equal(mixed.notes.length, 10)
  })
})
