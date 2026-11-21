import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { momentTime, parseMidi, type Midi } from '@lily/common/web/midi.js'
import type { TimedStaff } from '@lily/common/types'
import { atTempo, audioVolume, barTime, mixMidi, momentAt, mutedParts, partNames, partsOf, partVolume, scoreBpm, timeMap, withAudio, withPart, withPrograms, withStartBar, withSung } from '../src/renderer/playbackSetup'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/, in packages/studio/ (npm run test:unit).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-setup-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

function note(track: number, channel: number, program: number, time = 0) {
  return { time, duration: 0.5, track, channel, key: 60, velocity: 90 / 127, program, gain: 1, pan: 0, detune: 0 }
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
      { track: 1, number: 1, name: 'Violin', written: 'violin', drums: false },
      { track: 2, number: 2, name: 'Piano', written: 'acoustic grand', drums: false },
      { track: 3, number: 3, name: 'Drums', written: 'drums', drums: true },
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

  test('Export MIDI offers to leave out the muted parts, unless that is all of them (D54)', () => {
    const parts = partsOf(MIDI)
    assert.deepEqual(mutedParts(parts, undefined), [])
    assert.deepEqual(mutedParts(parts, { parts: { 2: { program: 73 } } }), [])
    assert.deepEqual(mutedParts(parts, { parts: { 1: { muted: true }, 3: { muted: true }, 0: { muted: true } } }), [
      { track: 1, name: 'Violin' },
      { track: 3, name: 'Drums' },
    ])
    assert.deepEqual(mutedParts(parts, { parts: { 1: { muted: true }, 2: { muted: true }, 3: { muted: true } } }), [])
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

  test('a part is at 100 % unless set; 100 % leaves the setup, and beyond 0–200 % is that (D121)', () => {
    assert.equal(partVolume(undefined, 1), 100)
    let setup = withPart({}, 1, { volume: 40 })
    assert.deepEqual(setup, { parts: { 1: { volume: 40 } } })
    assert.equal(partVolume(setup, 1), 40)
    assert.equal(partVolume(setup, 2), 100)
    setup = withPart(setup, 2, { volume: 512.4 })
    assert.equal(partVolume(setup, 2), 200)
    assert.deepEqual(withPart(withPart(setup, 1, { volume: 100 }), 2, { volume: 100 }), {})
  })
})

describe('Export MIDI with the Parts fold’s instruments (D54, D264)', () => {
  const chunk = (tag: string, data: number[]) => [...Buffer.from(tag), 0, 0, data.length >> 8, data.length & 0xff, ...data]
  const header = chunk('MThd', [0, 1, 0, 4, 0x01, 0x80])
  const control = chunk('MTrk', [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x2f, 0])
  // A program change, then notes in running status.
  const tune = chunk('MTrk', [0, 0xc0, 0, 0, 0x90, 60, 90, 0x60, 60, 0, 0, 0xff, 0x2f, 0])
  const drums = chunk('MTrk', [0, 0xc9, 0, 0, 0x99, 36, 90, 0x60, 0x89, 36, 0, 0, 0xff, 0x2f, 0])
  // Notes and no program change.
  const bass = chunk('MTrk', [0, 0x91, 40, 90, 0x60, 0x81, 40, 0, 0, 0xff, 0x2f, 0])
  const file = Uint8Array.from([...header, ...control, ...tune, ...drums, ...bass])

  test('nothing chosen: the file as written', () => {
    assert.equal(withPrograms(file, undefined), file)
    assert.equal(withPrograms(file, { parts: { 1: { muted: true }, 3: { volume: 50 } } }), file)
  })

  test('a part’s program changes say its instrument, one is put where it has none, and drums keep their kit', () => {
    const written = withPrograms(file, { parts: { 1: { program: 73 }, 2: { program: 40 }, 3: { program: 24 } } })
    const midi = parseMidi(written)
    // midi.js lists no program of the drums' channel.
    assert.deepEqual(midi.tracks.map((track) => track.programs), [[], [73], [], [24]])
    assert.deepEqual(
      midi.notes.map((note) => [note.track, note.program]),
      parseMidi(file).notes.map((note) => [note.track, note.track === 1 ? 73 : note.track === 3 ? 24 : note.program]),
    )
    // The tune's bytes but its program; the bass's after the three bytes put at its start.
    assert.equal(written.length, file.length + 3)
    const at = header.length + control.length
    assert.deepEqual([...written.subarray(0, at + 9)], [...file.subarray(0, at + 9)])
    assert.equal(written[at + 10], 73)
    const bassAt = header.length + control.length + tune.length + drums.length
    assert.deepEqual([...written.subarray(bassAt, bassAt + 11)], [...Buffer.from('MTrk'), 0, 0, 0, bass.length - 8 + 3, 0, 0xc1, 24])
  })

  test('LilyPond’s file, which names no program for a piano: one put at the part’s start, every other byte as written', async () => {
    const sample = new Uint8Array(await fs.readFile(path.resolve(__dirname, '../../../vscode/test/fixtures/sample.midi')))
    const written = withPrograms(sample, { parts: { 1: { program: 73 } } })
    // The tune's track is the second chunk after the header's: its length three more, the three bytes after it.
    const at = 14 + 8 + ((sample[18] << 24) | (sample[19] << 16) | (sample[20] << 8) | sample[21])
    const length = (bytes: Uint8Array) => (bytes[at + 4] << 24) | (bytes[at + 5] << 16) | (bytes[at + 6] << 8) | bytes[at + 7]
    assert.equal(length(written), length(sample) + 3)
    assert.deepEqual([...written.subarray(at + 8, at + 11)], [0, 0xc0, 73])
    assert.deepEqual([...written.subarray(0, at + 4)], [...sample.subarray(0, at + 4)])
    assert.deepEqual([...written.subarray(at + 11)], [...sample.subarray(at + 8)])
    const midi = parseMidi(written)
    assert.deepEqual(midi.tracks[1].programs, [73])
    assert.ok(midi.notes.filter((note) => note.track === 1).every((note) => note.program === 73))
    assert.deepEqual(midi.notes.filter((note) => note.track !== 1), parseMidi(sample).notes.filter((note) => note.track !== 1))
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

function staff(fields: Partial<TimedStaff>): TimedStaff {
  return { id: '', name: '', shortName: '', group: '', groupIndex: -1, clef: 'clefs.G', clefTransposition: 0, voices: [''], ...fields }
}

function named(...staves: Partial<TimedStaff>[]): string[] {
  return partNames(staves.map((fields) => ({ staff: staff(fields), written: 'acoustic grand', drums: false })))
}

describe('the names of the parts', () => {
  test('the instrument name the score gives wins', () => {
    assert.deepEqual(named({ name: 'Soprano  Alto', voices: ['1', '2'] }, { shortName: 'Vc.' }), ['Soprano Alto', 'Vc.'])
  })

  test('voices named after choir voices: abbreviated when several, in full when one', () => {
    assert.deepEqual(named({ voices: ['sopranos', 'altos'] }, { id: 'tenor' }, { id: 'men', voices: ['tenorOne', 'bassVoice'] }), ['S.A', 'Tenor', 'T.B'])
    // Numbered voices say nothing; the staff's id does.
    assert.deepEqual(named({ id: 'women', voices: ['1', '2'] }, { id: 'altos', voices: ['1', '2'] }), ['Women', 'Alto'])
  })

  test('a piano staff: the instrument and the clef', () => {
    const group = { group: 'PianoStaff', groupIndex: 0 }
    assert.deepEqual(named({ ...group, id: 'up' }, { ...group, id: 'down', clef: 'clefs.F' }), ['Piano · G clef', 'Piano · F clef'])
    assert.deepEqual(partNames([{ staff: staff({ group: 'GrandStaff', clef: 'clefs.F' }), written: 'church organ', drums: false }]), ['Organ · F clef'])
  })

  test("an id that says something, the staff's or its only voice's", () => {
    assert.deepEqual(named({ id: 'violinOne' }, { id: 'viola_2' }, { voices: ['melody'] }, { id: '1', clef: 'clefs.F' }), [
      'Violin one',
      'Viola 2',
      'Melody',
      'Piano',
    ])
  })

  test('a choir without names: guessed from the clefs and the voices', () => {
    const group = { group: 'ChoirStaff', groupIndex: 0 }
    assert.deepEqual(named({ ...group, voices: ['1', '2'] }, { ...group, clef: 'clefs.F', voices: ['1', '2'] }), ['S.A', 'T.B'])
    assert.deepEqual(named(group, group, { ...group, clefTransposition: -7 }, { ...group, clef: 'clefs.F' }), ['Soprano', 'Alto', 'Tenor', 'Bass'])
    assert.deepEqual(named(group, group, { ...group, clef: 'clefs.F' }, { ...group, clef: 'clefs.F' }), ['Soprano', 'Alto', 'Tenor', 'Bass'])
  })

  test('nothing to go by: the instrument, with the clef when two parts share it, then a number', () => {
    assert.deepEqual(named({}, { clef: 'clefs.F' }), ['Piano · G clef', 'Piano · F clef'])
    assert.deepEqual(named({}, {}), ['Piano · G clef 1', 'Piano · G clef 2'])
  })

  test('without the map: from the track names lilypond writes and the pitches', () => {
    const midi: Midi = {
      ...MIDI,
      tracks: [
        { name: 'control track', channels: [], programs: [], notes: 0 },
        { name: 'women:sopranos', channels: [0], programs: [0], notes: 1 },
        { name: ':', channels: [1], programs: [0], notes: 1 },
        { name: ':', channels: [2], programs: [0], notes: 1 },
      ],
      notes: [note(1, 0, 0), { ...note(2, 1, 0), key: 72 }, { ...note(3, 2, 0), key: 40 }],
    }
    assert.deepEqual(
      partsOf(midi).map((part) => part.name),
      ['Soprano', 'Piano · G clef', 'Piano · F clef'],
    )
    // A map with a staff per track is used; one that does not fit is not.
    assert.deepEqual(
      partsOf(midi, [staff({ name: 'Upper' }), staff({}), staff({})]).map((part) => part.name),
      ['Upper', 'Piano · G clef 1', 'Piano · G clef 2'],
    )
    assert.equal(partsOf(midi, [staff({ name: 'Upper' })])[0].name, 'Soprano')
  })

  test('a real compile names a choir, a piano and a flute', async (t) => {
    const score = path.join(scratch, 'choir.ly')
    await fs.writeFile(
      score,
      String.raw`\version "2.24.0"
\score {
  <<
    \new ChoirStaff <<
      \new Staff << \new Voice = "sopranos" { \voiceOne c''4 d'' e'' f'' } \new Voice = "altos" { \voiceTwo a'4 b' c'' d'' } >>
      \new Staff { \clef bass << { c4 d e f } \\ { c,4 d, e, f, } >> }
    >>
    \new PianoStaff <<
      \new Staff { c''4 e'' g'' c''' }
      \new Staff { \clef bass c,4 e, g, c }
    >>
    \new Staff \with { instrumentName = \markup { \bold Flute } midiInstrument = "flute" } { c''4 d'' e'' f'' }
  >>
  \layout { }
  \midi { }
}
`,
    )
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome.state, 'ok')
    const midi = parseMidi(outcome.midiData!)
    assert.deepEqual(
      partsOf(midi, outcome.timing?.staves).map((part) => part.name),
      ['S.A', 'T.B', 'Piano · G clef', 'Piano · F clef', 'Flute'],
    )
  })
})

describe('the audio track and the tempo (D155)', () => {
  /**
   * Three quarter notes, C D E, 384 ticks a quarter: at ♩ = 120, and E after
   * a change to ♩ = 240 at tick 768. They sound at 0, 0.5 and 1 s; E lasts 0.25.
   */
  const TWO_TEMPOS = new Uint8Array([
    ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0x80],
    ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 45],
    ...[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20],
    ...[0, 0x90, 60, 100, 0x83, 0x00, 0x80, 60, 0],
    ...[0, 0x90, 62, 100, 0x83, 0x00, 0x80, 62, 0],
    ...[0, 0xff, 0x51, 3, 0x03, 0xd0, 0x90],
    ...[0, 0x90, 64, 100, 0x83, 0x00, 0x80, 64, 0],
    ...[0, 0xff, 0x2f, 0],
  ])

  test('the score\'s tempo is its first, in quarter notes a minute', () => {
    const midi = parseMidi(TWO_TEMPOS)
    assert.deepEqual(midi.notes.map((note) => [note.time, note.duration]), [[0, 0.5], [0.5, 0.5], [1, 0.25]])
    assert.equal(scoreBpm(midi), 120)
  })

  test('at another tempo every time is scaled alike, the later change kept in proportion', () => {
    const midi = parseMidi(TWO_TEMPOS)
    const slow = atTempo(midi, 60)
    assert.deepEqual(slow.notes.map((note) => [note.time, note.duration]), [[0, 1], [1, 1], [2, 0.5]])
    assert.equal(slow.duration, midi.duration * 2)
    assert.equal(scoreBpm(slow), 60)
    // The map's moments, in whole notes, land on the same notes.
    assert.equal(momentTime(slow, 0.5), 2)
    assert.equal(momentTime(slow, 0.625), 2.25)
    const fast = atTempo(midi, 143.5)
    assert.ok(Math.abs(fast.notes[2].time - 120 / 143.5) < 1e-9)
    assert.equal(midi.notes[2].time, 1, 'the music as parsed is left as it was')
  })

  test('at its own tempo, or none, the music is itself', () => {
    const midi = parseMidi(TWO_TEMPOS)
    assert.equal(atTempo(midi, undefined), midi)
    assert.equal(atTempo(midi, 120), midi)
    assert.equal(atTempo(midi, 0), midi)
  })

  test('the audio track\'s volume and mute, back to as recorded dropped', () => {
    assert.equal(audioVolume({}), 100)
    const quiet = withAudio({ startBar: 3 }, { volume: 42.4 })
    assert.deepEqual(quiet, { startBar: 3, audio: { volume: 42 } })
    assert.equal(audioVolume(quiet), 42)
    assert.deepEqual(withAudio(quiet, { muted: true }), { startBar: 3, audio: { volume: 42, muted: true } })
    assert.deepEqual(withAudio(quiet, { volume: 100 }), { startBar: 3 })
    assert.deepEqual(withAudio({}, { volume: 150 }), {})
    assert.deepEqual(withAudio({ audio: { muted: true } }, { muted: false }), {})
  })
})

describe('a voice at its sung times (D276)', () => {
  /** A voice on track 1, at ♩ = 120: three legato quarters, a rest, a quarter and a chord; a bass on track 2 in the same rhythm. */
  function sungNote(track: number, time: number, duration: number, key = 60) {
    return { ...note(track, track - 1, 0, time), duration, key }
  }
  const VOICE = [sungNote(1, 0.5, 0.5, 60), sungNote(1, 1, 0.5, 62), sungNote(1, 1.5, 0.25, 64), sungNote(1, 2.5, 0.5, 65), sungNote(1, 3, 1, 67), sungNote(1, 3, 1, 64)]
  const BASS = VOICE.map((n) => ({ ...n, track: 2, channel: 1, key: n.key - 24 }))
  const SONG: Midi = {
    title: '',
    duration: 4,
    division: 384,
    tracks: [
      { name: 'control track', channels: [], programs: [], notes: 0 },
      { name: '', channels: [0], programs: [0], notes: VOICE.length },
      { name: '', channels: [1], programs: [0], notes: BASS.length },
    ],
    notes: [...VOICE, ...BASS].sort((a, b) => a.time - b.time),
  }
  const of = (midi: Midi, track: number) => midi.notes.filter((n) => n.track === track).map(({ time, duration, key }) => [round(time), round(duration), key])
  const round = (seconds: number) => Math.round(seconds * 1e6) / 1e6

  test('its notes move by their shifts in order; the other parts keep the grid', () => {
    // A chord moves by its first note's (its lowest's) shift.
    const { midi, maps } = withSung(SONG, [{ track: 1, shifts: [0, 62, -40, 0, 100, 0] }])
    assert.deepEqual(of(midi, 1), [
      // Legato: it ends where the next one now starts.
      [0.5, 0.562, 60],
      [1.062, 0.398, 62],
      // Not legato: it keeps its length.
      [1.46, 0.25, 64],
      [2.5, 0.6, 65],
      [3.1, 1, 67],
      [3.1, 1, 64],
    ])
    assert.deepEqual(of(midi, 2), of(SONG, 2))
    assert.deepEqual([...maps.keys()], [1])
    assert.ok(midi.notes.every((n, i) => i === 0 || midi.notes[i - 1]!.time <= n.time), 'the notes are by time')
    assert.equal(of(SONG, 1)[1]![0], 1, 'the music given is left as it was')
  })

  test('a note is never put at or before the one before it, nor before 0', () => {
    const { midi } = withSung(SONG, [{ track: 1, shifts: [-900, -600, 0, -1200, 0, 0] }])
    assert.deepEqual(
      of(midi, 1).map(([time]) => time),
      [0, 0.4, 1.5, 1.501, 3, 3],
    )
  })

  test('its map runs through its notes\' starts, and goes back to the grid around them', () => {
    const { maps } = withSung(SONG, [{ track: 1, shifts: [0, 62, -40, 0, 100, 0] }])
    const map = maps.get(1)!
    assert.equal(round(map(1)), 1.062)
    assert.equal(round(map(1.25)), round(1.062 + (0.25 * (1.46 - 1.062)) / 0.5))
    assert.equal(round(map(3)), 3.1)
    // The last note's end keeps its shift; then a second's ramp back to the grid.
    assert.equal(round(map(4)), 4.1)
    assert.equal(round(map(4.5)), 4.55)
    assert.equal(map(5), 5)
    assert.equal(map(-0.5), -0.5)
    assert.equal(map(0), 0)
    // It rises everywhere, so what comes after another stays after it.
    const times = Array.from({ length: 700 }, (_, i) => map(i / 100 - 1))
    assert.ok(times.every((time, i) => i === 0 || time >= times[i - 1]!))
  })

  test('shifts that do not number its notes, or are all the grid, leave the music as it is', () => {
    for (const shifts of [[0, 0, 0, 0, 0, 0], [62], []]) {
      const { midi, maps } = withSung(SONG, [{ track: 1, shifts }])
      assert.equal(midi, SONG)
      assert.equal(maps.size, 0)
    }
    assert.equal(withSung(SONG, []).midi, SONG)
  })

  test('the map is linear between its points and the identity outside them', () => {
    const map = timeMap([[1, 1], [2, 2.5], [3, 3]])
    assert.deepEqual([0, 1, 1.5, 2, 2.5, 3, 4].map(map), [0, 1, 1.75, 2.5, 2.75, 3, 4])
    assert.equal(timeMap([])(7), 7)
  })
})
