import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, mock, test } from 'node:test'

// The pure half of media/midi.js (DECISIONS D24), loaded as the webviews load it:
// the file itself, not a bundle of it. There is no AudioContext here, so the
// player runs against a clock that the tests turn.

interface Note {
  time: number
  duration: number
  track: number
  channel: number
  key: number
  velocity: number
  program: number
  gain: number
  pan: number
  detune: number
}

interface Midi {
  format: number
  division: number
  title: string
  duration: number
  notes: Note[]
  tracks: Array<{ name: string; channels: number[]; programs: number[]; notes: number }>
}

interface Player {
  state: 'stopped' | 'playing' | 'paused'
  position: number
  duration: number
  suspended: boolean
  load(midi: Midi | undefined): void
  play(): Promise<boolean>
  pause(): void
  stop(): void
  seek(seconds: number): Promise<void>
}

interface LilyMidi {
  parseMidi(bytes: Uint8Array): Midi
  instrumentName(program: number): string
  trackInstruments(track: Midi['tracks'][number]): string
  voiceOf(program: number): string
  drumOf(key: number): { sound: string; pitch?: number }
  frequencyOf(key: number, detune?: number): number
  firstNoteFrom(notes: Array<{ time: number }>, time: number): number
  formatTime(seconds: number): string
  momentTime(midi: Midi, at: number, grace?: number): number
  Player: new (options: { createContext: () => unknown; onChange?: () => void }) => Player
}

const root = path.resolve(__dirname, '../../..')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const midi: LilyMidi = require(path.join(root, 'media/midi.js'))

// ---- a Standard MIDI File writer, just enough for the tests ---------------------

function variable(value: number): number[] {
  const bytes = [value & 0x7f]
  while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80)
  return bytes
}

/** `events` are `[delta, ...bytes]`; the end of track is added. */
function track(...events: number[][]): number[] {
  const body = [...events.flatMap(([delta, ...bytes]) => [...variable(delta), ...bytes]), 0, 0xff, 0x2f, 0]
  return [0x4d, 0x54, 0x72, 0x6b, 0, 0, body.length >> 8, body.length & 0xff, ...body]
}

function file(division: number, tracks: number[][], format = 1): Uint8Array {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, division >> 8, division & 0xff]
  return Uint8Array.from([...header, ...tracks.flat()])
}

const tempo = (delta: number, bpm: number): number[] => {
  const micros = Math.round(60e6 / bpm)
  return [delta, 0xff, 0x51, 3, micros >> 16, (micros >> 8) & 0xff, micros & 0xff]
}
const name = (text: string): number[] => [0, 0xff, 0x03, text.length, ...Buffer.from(text)]

describe('parseMidi', () => {
  test('reads what lilypond writes: title, tracks, tempo, notes in time order', () => {
    const parsed = midi.parseMidi(fs.readFileSync(path.join(root, 'test/fixtures/sample.midi')))
    assert.deepStrictEqual(
      [parsed.format, parsed.division, parsed.title, parsed.duration, parsed.notes.length],
      [1, 384, 'Sample', 15, 26],
    )
    // Two staves of eight bars in 3/4 at 96 to the crotchet; the lyrics are a silent track.
    assert.deepStrictEqual(parsed.tracks.map((entry) => entry.notes), [0, 18, 0, 8])
    assert.deepStrictEqual(parsed.tracks[1], { name: ':tune', channels: [0], programs: [0], notes: 18 })
    const [first, bass] = parsed.notes
    assert.deepStrictEqual([first.time, first.duration, first.key], [0, 0.625, 67])
    assert.deepStrictEqual([bass.time, bass.duration, bass.key, bass.channel], [0, 1.875, 43, 2])
    assert.ok(parsed.notes.every((note, index) => index === 0 || parsed.notes[index - 1].time <= note.time))
  })

  test('a tempo change applies from its tick on, in every track', () => {
    const parsed = midi.parseMidi(
      file(480, [
        track(tempo(0, 120), tempo(960, 60)),
        track([0, 0x90, 60, 100], [480, 0x80, 60, 0], [480, 0x90, 62, 100], [480, 0x80, 62, 0]),
      ]),
    )
    assert.deepStrictEqual(
      parsed.notes.map(({ time, duration }) => [time, duration]),
      [
        [0, 0.5],
        [1, 1],
      ],
    )
    assert.strictEqual(parsed.duration, 2)
  })

  test('a moment of the score is heard through the tempo map; a grace note shortly before its note', () => {
    const parsed = midi.parseMidi(
      file(480, [
        track(tempo(0, 120), tempo(960, 60)),
        track([0, 0x90, 60, 100], [480, 0x80, 60, 0], [480, 0x90, 62, 100], [480, 0x80, 62, 0]),
      ]),
    )
    // Two crotchets at 120, then one at 60 (DECISIONS D26).
    assert.deepStrictEqual([0, 0.25, 0.5, 0.75].map((at) => midi.momentTime(parsed, at)), [0, 0.5, 1, 2])
    // A grace quaver takes 11/48 of its half second.
    const grace = midi.momentTime(parsed, 0.5, -1 / 8)
    assert.ok(Math.abs(grace - (1 - (0.25 * 11) / 48)) < 1e-9, String(grace))
    // Bar 2 of the 3/4 sample at 96 to the crotchet begins where its bass note ends.
    const sample = midi.parseMidi(fs.readFileSync(path.join(root, 'test/fixtures/sample.midi')))
    assert.strictEqual(midi.momentTime(sample, 0.75), 1.875)
  })

  test('running status, and a note-on of velocity 0 as the note-off', () => {
    const parsed = midi.parseMidi(file(96, [track([0, 0x90, 60, 64], [96, 60, 0], [0, 64, 127], [96, 64, 0])], 0))
    assert.deepStrictEqual(
      parsed.notes.map(({ key, time, duration, velocity }) => [key, time, duration, velocity]),
      [
        [60, 0, 0.5, 64 / 127],
        [64, 0.5, 0.5, 1],
      ],
    )
  })

  test('a note begins with the state of its channel: program, volume, pan, bend', () => {
    const parsed = midi.parseMidi(
      file(96, [
        track(
          name('violin:one'),
          [0, 0xc1, 40],
          [0, 0xb1, 7, 127],
          [0, 0xb1, 11, 64],
          [0, 0xb1, 10, 0],
          [0, 0xe1, 0, 0x50], // a quarter tone up: half of the 200 cents above 8192
          [0, 0x91, 69, 127],
          [96, 0x81, 69, 0],
          [0, 0x99, 38, 100],
          [10, 0x89, 38, 0],
        ),
      ]),
    )
    const [violin, snare] = parsed.notes
    assert.deepStrictEqual(
      [violin.program, violin.gain, violin.pan, violin.detune],
      [40, 64 / 127, -1, 50],
    )
    assert.strictEqual(snare.channel, 9)
    assert.deepStrictEqual(parsed.tracks[0], { name: 'violin:one', channels: [1, 9], programs: [40], notes: 2 })
    assert.strictEqual(midi.trackInstruments(parsed.tracks[0]), 'violin, drums')
    assert.strictEqual(parsed.title, 'violin:one')
  })

  test('a program set in one track is heard in another that uses the channel', () => {
    const parsed = midi.parseMidi(
      file(96, [track(name('control track'), [0, 0xc0, 73]), track([0, 0x90, 72, 90], [96, 0x80, 72, 0])]),
    )
    assert.strictEqual(parsed.notes[0].program, 73)
    assert.strictEqual(parsed.title, '', "lilypond's name for an untitled score is not a title")
  })

  test('the sustain pedal holds a released note until it is lifted', () => {
    const parsed = midi.parseMidi(
      file(96, [
        track(
          [0, 0xb0, 64, 127],
          [0, 0x90, 60, 90],
          [96, 0x80, 60, 0],
          [0, 0x90, 60, 90], // struck again under the pedal: the first one ends here
          [96, 0x80, 60, 0],
          [96, 0xb0, 64, 0],
        ),
      ]),
    )
    assert.deepStrictEqual(
      parsed.notes.map(({ time, duration }) => [time, duration]),
      [
        [0, 1.5],
        [0.5, 1],
      ],
    )
  })

  test('a note that is never switched off lasts to the end', () => {
    const parsed = midi.parseMidi(file(96, [track([0, 0x90, 60, 90]), track([192, 0xff, 0x06, 0])]))
    assert.deepStrictEqual([parsed.notes[0].duration, parsed.duration], [1, 1])
  })

  test('says why a file cannot be played', () => {
    const smpte = file(96, [track()])
    smpte[12] = 0xe7
    for (const [bytes, reason] of [
      [Uint8Array.from(Buffer.from('RIFF....WAVEfmt ')), /MThd header is missing/],
      [file(96, [track()], 2), /format 2 is not supported/],
      [smpte, /SMPTE/],
      [file(96, []), /no tracks/],
      [file(96, [track([0, 0x90, 60, 90])]).slice(0, -6), /ends inside an event/],
      [file(96, [track([0, 60, 90])]), /without a status byte/],
    ] as const) {
      assert.throws(() => midi.parseMidi(bytes), reason)
    }
  })
})

describe('General MIDI', () => {
  test('programs have the names that midiInstrument takes', () => {
    assert.deepStrictEqual([0, 40, 73, 127].map(midi.instrumentName), ['acoustic grand', 'violin', 'flute', 'gunshot'])
    assert.strictEqual(midi.instrumentName(200), 'program 200')
  })

  test('every program and every percussion key has a sound', () => {
    const voices = new Set(Array.from({ length: 128 }, (_, program) => midi.voiceOf(program)))
    assert.ok(!voices.has(undefined as never))
    assert.deepStrictEqual(
      [0, 19, 24, 40, 45, 56, 71, 73].map(midi.voiceOf),
      ['piano', 'organ', 'pluck', 'strings', 'pluck', 'brass', 'reed', 'flute'],
    )
    assert.deepStrictEqual([36, 38, 42, 45, 49, 76].map((key) => midi.drumOf(key).sound), [
      'kick', 'snare', 'hat', 'tom', 'cymbal', 'click',
    ])
  })

  test('pitch: A4 is 440 Hz, and detune is in cents', () => {
    assert.strictEqual(midi.frequencyOf(69), 440)
    assert.strictEqual(midi.frequencyOf(57), 220)
    assert.ok(Math.abs(midi.frequencyOf(68, 100) - 440) < 1e-9)
  })
})

describe('Player', () => {
  test('formatTime and firstNoteFrom', () => {
    assert.deepStrictEqual([0, 9.9, 75, 3600, NaN, -1].map(midi.formatTime), ['0:00', '0:09', '1:15', '60:00', '0:00', '0:00'])
    const notes = [0, 1, 1, 2.5].map((time) => ({ time }))
    assert.deepStrictEqual([0, 0.5, 1, 2.6].map((time) => midi.firstNoteFrom(notes, time)), [0, 1, 1, 4])
  })

  // Web Audio as far as the synthesizer touches it. Every node is the same
  // stand-in; what is recorded is when oscillators start, which is the schedule.
  function fakeContext(state: 'running' | 'suspended') {
    const starts: number[] = []
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
      setTargetAtTime() {},
    })
    const node = (): Record<string, unknown> => ({
      gain: param(), frequency: param(), pan: param(), Q: param(), threshold: param(), knee: param(),
      ratio: param(), attack: param(), release: param(),
      connect: (next: unknown) => next,
      disconnect() {},
      setPeriodicWave() {},
      start: (when: number) => starts.push(Math.round(when * 1000) / 1000),
      stop() {},
    })
    const context = {
      state,
      currentTime: 10,
      sampleRate: 8000,
      destination: node(),
      createGain: node, createOscillator: node, createBiquadFilter: node, createStereoPanner: node,
      createDynamicsCompressor: node, createBufferSource: node,
      createPeriodicWave: () => ({}),
      createBuffer: () => ({ getChannelData: () => new Float32Array(8) }),
      resume: () => new Promise<void>(() => {}), // what a browser does while it waits for a click
      close: async () => {},
    }
    return { context, starts }
  }

  const song = () =>
    midi.parseMidi(
      file(96, [track(tempo(0, 60), [0, 0x90, 60, 90], [96, 0x80, 60, 0], [0, 0x90, 62, 90], [96, 0x80, 62, 0], [0, 0x90, 64, 90], [96, 0x80, 64, 0])]),
    )

  test('schedules ahead of the audio clock, pauses, seeks and stops at the end', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    try {
      const { context, starts } = fakeContext('running')
      const states: string[] = []
      const player = new midi.Player({ createContext: () => context, onChange: () => states.push(player.state) })
      assert.strictEqual(await player.play(), false, 'nothing is loaded')

      player.load(song())
      assert.deepStrictEqual([player.state, player.position, player.duration], ['stopped', 0, 3])
      assert.strictEqual(await player.play(), true)
      // Music time 0 is a little after "now"; only the first note is within the look-ahead.
      assert.deepStrictEqual(starts, [10.06])

      context.currentTime = 10.06 + 0.7
      mock.timers.tick(50)
      assert.deepStrictEqual(starts, [10.06, 11.06])
      assert.ok(Math.abs(player.position - 0.7) < 1e-9)

      player.pause()
      context.currentTime = 50
      assert.deepStrictEqual([player.state, Math.round(player.position * 10)], ['paused', 7])

      // Into the last note: it is struck, so it is not started in the middle.
      await player.seek(2.5)
      assert.deepStrictEqual([player.state, player.position], ['paused', 2.5])
      assert.strictEqual(await player.play(), true)
      assert.strictEqual(starts.length, 2)

      context.currentTime = 50.06 + 0.5
      mock.timers.tick(50)
      assert.deepStrictEqual([player.state, player.position], ['stopped', 0])
      assert.deepStrictEqual([...new Set(states)].sort(), ['paused', 'playing', 'stopped'])
    } finally {
      mock.timers.reset()
    }
  })

  test('says so when the browser wants a click first, and stays stopped', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    try {
      const { context, starts } = fakeContext('suspended')
      const player = new midi.Player({ createContext: () => context })
      player.load(song())
      const playing = player.play()
      mock.timers.tick(300)
      assert.strictEqual(await playing, false)
      assert.deepStrictEqual([player.state, player.suspended, starts], ['stopped', true, []])

      // The click came.
      context.state = 'running'
      assert.strictEqual(await player.play(), true)
      assert.strictEqual(player.suspended, false)
    } finally {
      mock.timers.reset()
    }
  })
})
