import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseMidi } from '@lily/common/web/midi.js'
import type { Transcription } from '../src/ipc'
import {
  audioOffsetOfScore,
  audioOfScore,
  backingOfScore,
  bpmOfScore,
  fileRows,
  includedFile,
  musicOfScore,
  songTitle,
  startOfScore,
  stemOfScore,
  stemScore,
  sungGuard,
  sungLines,
  sungOfScore,
  sungTimesFor,
  withScoreLines,
  withSungLines,
} from '../src/renderer/files'
import type { TextEdit } from '../src/renderer/midiBlock'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/ (npm run test:unit in packages/studio/). The
// listing itself is the Rust side's (crates/engrave's tests); writing a stem's
// score is src-tauri/src/separate.rs's.

describe('fileRows', () => {
  test('adds a heading for each directory once, indented by depth', () => {
    const files = ['main.ly', 'parts/violin.ily', 'parts/strings/viola.ily', 'parts/strings/cello.ily', 'z.ily'].map(
      (relative) => ({ relative, path: `/f/${relative}` }),
    )
    assert.deepEqual(
      fileRows(files).map((row) => `${'  '.repeat(row.depth)}${row.kind === 'directory' ? `${row.name}/` : row.name}`),
      ['main.ly', 'parts/', '  violin.ily', '  strings/', '    viola.ily', '    cello.ily', 'z.ily'],
    )
  })

  test('a sibling directory gets its own heading', () => {
    const files = ['a/x/1.ly', 'a/y/2.ly'].map((relative) => ({ relative, path: `/f/${relative}` }))
    assert.deepEqual(
      fileRows(files).map((row) => [row.kind, row.name, row.depth]),
      [
        ['directory', 'a', 0],
        ['directory', 'x', 1],
        ['file', '1.ly', 2],
        ['directory', 'y', 1],
        ['file', '2.ly', 2],
      ],
    )
  })
})

describe('a score for a stem (D112, D113)', () => {
  const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other', 'instrumental', 'theremin']
  const request = (stem: string) => ({
    stem,
    title: stem.charAt(0).toUpperCase() + stem.slice(1),
    file: `/Music/demo (stems)/demo - ${stem}.wav`,
    song: 'demo',
  })

  test('names the stem in its % Stem: line, which the preview reads back', () => {
    for (const stem of STEMS) {
      const { text, name } = stemScore(request(stem))
      assert.equal(name, stem)
      assert.equal(stemOfScore(text), `demo - ${stem}.wav`, stem)
    }
  })

  test('is set up for the instrument, titled after the song', () => {
    const bass = stemScore(request('bass')).text
    assert.match(bass, /title = "Demo"/)
    assert.match(bass, /instrument = "Bass"/)
    assert.match(bass, /instrumentName = "Bass"/)
    assert.match(bass, /midiInstrument = "electric bass \(finger\)"/)
    assert.match(bass, /\\clef "bass_8"/)
    assert.match(stemScore(request('drums')).text, /\\new DrumStaff/)
    assert.match(stemScore(request('piano')).text, /\\new PianoStaff/)
    assert.match(stemScore(request('vocals')).text, /% \\new Lyrics \\lyricsto "melody"/)
    assert.match(stemScore(request('theremin')).text, /instrumentName = "Theremin"/)
    // Without a transcription: four empty bars, to write by ear.
    assert.match(bass, /R1\*4 \|/)
    assert.match(bass, /% Write the part by ear/)
  })

  test('a song’s file name becomes its title and artist', () => {
    assert.deepEqual(songTitle('some-artist_-_some-song'), { title: 'Some-song', artist: 'Some Artist' })
    assert.deepEqual(songTitle('Some Band - Some Ballad'), { title: 'Some Ballad', artist: 'Some Band' })
    assert.deepEqual(songTitle('some_song'), { title: 'Some song' })
    assert.deepEqual(songTitle('Mixed Case Song'), { title: 'Mixed Case Song' })
  })

  test('guitar, piano and the rest are a rough draft of chords', () => {
    assert.deepEqual(
      STEMS.filter((stem) => stemScore(request(stem)).hard),
      ['guitar', 'piano', 'other', 'instrumental', 'theremin'],
    )
    assert.equal(
      stemScore(request('bass')).hint,
      'The bass’s notes, transcribed from the stem with the song’s tempo, key and bars: bass clef, electric bass sound. Saved as bass.ly beside the stems; the stem plays under the preview.',
    )
  })

  test('quotes and backslashes in the song stay inside the title', () => {
    const { text } = stemScore({ ...request('bass'), song: 'say "hi" \\ bye\nnow' })
    assert.match(text, /title = "Say \\"hi\\" \\\\ bye now"/)
  })

  test('names the backing track to sing over in its % Backing: line (D133)', () => {
    const { text } = stemScore({ ...request('vocals'), backing: '/Music/demo (karaoke)/demo - instrumental.wav' })
    assert.equal(stemOfScore(text), 'demo - vocals.wav')
    assert.equal(backingOfScore(text), 'demo - instrumental.wav')
    assert.equal(backingOfScore(stemScore(request('vocals')).text), undefined)
    assert.equal(backingOfScore('% Backing: ../karaoke.mp3\n'), undefined)
    // The music without any voice (D137).
    assert.equal(musicOfScore('% Stem: a - vocals.wav\n% Music: a - music.mp3\n'), 'a - music.mp3')
  })

  test('Karaoke starts at the % Start: line, below 0 after a silence (D149)', () => {
    assert.equal(startOfScore('% Backing: a.mp3\n% Start: 31.88\n'), 31.88)
    assert.equal(startOfScore('%Start: -4.09\n'), -4.09)
    assert.equal(startOfScore('% Start: -600\n'), -60)
    assert.equal(startOfScore('% Start: soon\n'), undefined)
    assert.equal(startOfScore('% Backing: a.mp3\n'), undefined)
  })

  test('a stem line naming another folder is ignored', () => {
    assert.equal(stemOfScore('% Stem: ../song.mp3\n'), undefined)
    assert.equal(stemOfScore('% Stem: /tmp/a.wav\n'), undefined)
    assert.equal(stemOfScore('\\version "2.24.0"\n'), undefined)
    assert.equal(stemOfScore('{ c }\n%Stem:  a - bass.wav  \n'), 'a - bass.wav')
  })

  /** A song at ♩ = 120 in C minor whose bar 1 starts 0.2 s into the stem, four bars long. */
  const transcription = (stem: string, family: Transcription['family'], notes: Transcription['notes']): Transcription => ({
    stem,
    family,
    seconds: 8.2,
    bpm: 120,
    steady: true,
    beatsPerBar: 4,
    barOne: 0.2,
    pickup: 2,
    bars: 4,
    key: { tonic: 0, mode: 'minor', fit: 0.8 },
    notes,
  })
  const BASS: Transcription['notes'] = [
    [-2, 2, [36]],
    [0, 4, [36]],
    [6, 6, [43]],
    [16, 8, [41]],
    [32, 4, [39]],
  ]
  const CHORDS: Transcription['notes'] = [
    [0, 4, [48, 63, 67]],
    [8, 8, [53, 68, 72]],
  ]
  const DRUMS: Transcription['notes'] = [
    [0, 2, [36, 42]],
    [2, 2, [42]],
    [4, 2, [38, 42]],
  ]
  const transcribed = (stem: string) => {
    const family = stem === 'drums' ? 'drums' : ['bass', 'vocals'].includes(stem) ? 'melody' : 'chords'
    const notes = family === 'drums' ? DRUMS : family === 'melody' ? BASS : CHORDS
    const heard = stem === 'vocals' ? { words: WORDS, language: 'en' } : {}
    return stemScore({ ...request(stem), transcription: { ...transcription(stem, family, notes), ...heard } })
  }
  /** On BASS's notes: none on bar 1's first, two words on bar 2's. */
  const WORDS: Transcription['words'] = [
    [-2, 'Lan', true],
    [6, 'tern', false],
    [16, 'glow it', false],
    [32, '1962!', false],
  ]

  test('transcribed vocals have the words heard, a syllable a note, sung to the tune (D134)', () => {
    const { text } = transcribed('vocals')
    assert.match(text, /words = \\lyricmode \{\n  Lan --\n  _ tern\n  glow_it\n  "1962!"\n\}/)
    assert.match(text, /\n    \\new Lyrics \\lyricsto "melody" \{ \\words \}/)
    // Without words, the line waits for them.
    assert.match(stemScore({ ...request('vocals'), transcription: transcription('vocals', 'melody', BASS) }).text, /% \\new Lyrics \\lyricsto/)
  })

  test('a transcribed stem has its notes, key, meter, tempo and pickup, from its start to its end', () => {
    const { text } = transcribed('bass')
    assert.equal(stemOfScore(text), 'demo - bass.wav')
    assert.match(text, /% Transcribed from the stem by Lily Studio: ♩ = 120, 4\/4, C minor, 4 bars\./)
    assert.match(text, /bass = \\relative \{\n  \\clef "bass_8"\n  \\key c \\minor\n  \\time 4\/4/)
    // The pickup lasts as long as the stem plays before bar 1: two sixteenths in 0.2 s.
    assert.match(text, /\\partial 8\n.*\n.*\n  \\once \\omit Score\.MetronomeMark \\tempo 64 = 2400\n  c,8 \|\n  \\tempo 4 = 120\n/)
    assert.match(text, /  c4 r8 g'4\. r4 \| % 1\n  f2 r2 \|\n  es4 r4 r2 \|\n  R1 \|\n  \\bar "\|\."/)
  })

  test('a drifting song says its MIDI drifts, and a tempo between whole numbers says by how much', () => {
    const drifting = stemScore({ ...request('bass'), transcription: { ...transcription('bass', 'melody', BASS), steady: false } }).text
    assert.match(drifting, /% The song's tempo drifts: the MIDI keeps ♩ = 120 and drifts from the stem\./)
    const between = stemScore({ ...request('bass'), transcription: { ...transcription('bass', 'melody', BASS), bpm: 120.4, seconds: 200 } }).text
    assert.match(between, /% The stem's tempo is ♩ = 120\.4: the MIDI's 120 is 0\.7 s off it by the end\./)
  })

  test('piano is two staves parted at middle C; drums a drum staff; a low voice an octave down', () => {
    const piano = transcribed('piano').text
    assert.match(piano, /upper = \\relative \{[^}]*<es' g>4/)
    assert.match(piano, /lower = \\relative \{[^}]*c4 r4/)
    assert.match(transcribed('drums').text, /<bd hh>8 hh8 <sn hh>8/)
    assert.match(transcribed('vocals').text, /\\clef "treble_8"/)
  })

  describe('with lilypond', () => {
    let scratch = ''
    before(async () => {
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-stem-score-'))
    })
    after(() => fs.rm(scratch, { recursive: true, force: true }))

    test('every stem’s score engraves without errors or warnings, with MIDI', async (t) => {
      for (const stem of STEMS) {
        const { name, text } = stemScore(request(stem))
        const score = path.join(scratch, `${name}.ly`)
        await fs.writeFile(score, text)
        const outcome = await realOutcome(t, score)
        if (!outcome) return
        assert.equal(outcome.state, 'ok', `${stem}: ${outcome.message ?? ''}`)
        assert.deepEqual([outcome.errorCount, outcome.warningCount], [0, 0], `${stem}: ${JSON.stringify(outcome.diagnostics)}`)
        assert.ok(outcome.midiData, `${stem} has MIDI`)
      }
    })

    test('every stem’s transcribed score engraves without errors or warnings, with MIDI', async (t) => {
      for (const stem of STEMS) {
        const { name, text } = transcribed(stem)
        const score = path.join(scratch, `${name}-transcribed.ly`)
        await fs.writeFile(score, text)
        const outcome = await realOutcome(t, score)
        if (!outcome) return
        assert.equal(outcome.state, 'ok', `${stem}: ${outcome.message ?? ''}`)
        assert.deepEqual([outcome.errorCount, outcome.warningCount], [0, 0], `${stem}: ${JSON.stringify(outcome.diagnostics)}`)
        assert.ok(outcome.midiData, `${stem} has MIDI`)
      }
    })

    test('a drifting song’s MIDI follows the stem bar by bar (D135)', async (t) => {
      const drifting = { ...transcription('bass', 'melody', BASS), steady: false, barTimes: [0.2, 2.2, 4.4, 6.4, 8.8] }
      const { text } = stemScore({ ...request('bass'), transcription: drifting })
      assert.match(text, /songTempo = \{\n  \\omit Score\.MetronomeMark\n  s16\*2\n  \\tempo 64 = 1920 s1 \| \\tempo 64 = 1745 s1 \| \\tempo 64 = 1920 s1 \| \\tempo 64 = 1600 s1 \|\n\}/)
      assert.match(text, /\} << \\bass \\songTempo >>/)
      assert.doesNotMatch(text, /\\tempo 4 = 120/)
      const score = path.join(scratch, 'bass-drifting.ly')
      await fs.writeFile(score, text)
      const outcome = await realOutcome(t, score)
      if (!outcome?.midiData) return
      assert.deepEqual([outcome.errorCount, outcome.warningCount], [0, 0], JSON.stringify(outcome.diagnostics))
      // A whole number of 64ths a minute: a millisecond a bar at most.
      const starts = parseMidi(outcome.midiData).notes.map((note) => Math.round(note.time * 100) / 100)
      assert.deepEqual(starts, [0, 0.2, 0.95, 2.2, 4.4])
    })

    test('the transcribed score’s MIDI keeps time with the stem: bar 1 at 0.2 s, then ♩ = 120', async (t) => {
      const score = path.join(scratch, 'bass-timed.ly')
      await fs.writeFile(score, transcribed('bass').text)
      const outcome = await realOutcome(t, score)
      if (!outcome?.midiData) return
      const starts = parseMidi(outcome.midiData).notes.map((note) => Math.round(note.time * 1000) / 1000)
      assert.deepEqual(starts, [0, 0.2, 0.95, 2.2, 4.2])
    })
  })
})

describe('includedFile', () => {
  test('beside the including file, with .. and . resolved', () => {
    assert.equal(includedFile('/songs/main.ly', 'figures.ily'), '/songs/figures.ily')
    assert.equal(includedFile('/songs/parts/piano.ily', '../common/./global.ily'), '/songs/common/global.ily')
    assert.equal(includedFile('/songs/main.ly', '/lib/x.ily'), '/lib/x.ily')
  })
})

describe('the audio track\'s lines (D155)', () => {
  /** `text` with `edits` applied, as the editor applies them. */
  const applied = (text: string, edits: TextEdit[]) =>
    [...edits].sort((a, b) => b.offset - a.offset).reduce((result, { offset, length, text: put }) => result.slice(0, offset) + put + result.slice(offset + length), text)

  test('the recording, its offset and the tempo are read from their lines', () => {
    const text = '\\version "2.24.0"\n% Audio: Song (live).mp3\n% Audio offset: -1.25\n% BPM: 143.5\n{ c }\n'
    assert.equal(audioOfScore(text), 'Song (live).mp3')
    assert.equal(audioOffsetOfScore(text), -1.25)
    assert.equal(bpmOfScore(text), 143.5)
    // Not % Audio offset: for % Audio:, nor the other way.
    assert.equal(audioOfScore('% Audio offset: 2\n'), undefined)
    assert.equal(audioOffsetOfScore('% Audio: 2.mp3\n'), 0)
  })

  test('to the hundredth, within their limits', () => {
    assert.equal(audioOffsetOfScore('% Audio offset: 2.345\n'), 2.35)
    assert.equal(audioOffsetOfScore('% Audio offset: .5\n'), 0.5)
    assert.equal(audioOffsetOfScore('% Audio offset: -99999\n'), -3600)
    assert.equal(audioOffsetOfScore('% Audio offset: soon\n'), 0)
    assert.equal(bpmOfScore('% BPM: 120.004\n'), 120)
    assert.equal(bpmOfScore('% BPM: 0\n'), undefined)
    assert.equal(bpmOfScore('% BPM: 1000\n'), undefined)
    assert.equal(bpmOfScore('% BPM: fast\n'), undefined)
    assert.equal(bpmOfScore('{ c }\n'), undefined)
    // A recording elsewhere than beside the score is not played.
    assert.equal(audioOfScore('% Audio: ../song.mp3\n'), undefined)
  })

  test('a new line goes after the score\'s own lines, else after \\version, else first', () => {
    const own = '\\version "2.24.0"\n\n% Stem: a.wav\n% Start: 3\n{ c }\n'
    assert.equal(applied(own, withScoreLines(own, { Audio: 'a.mp3', BPM: '90.5' })), '\\version "2.24.0"\n\n% Stem: a.wav\n% Start: 3\n% Audio: a.mp3\n% BPM: 90.5\n{ c }\n')
    const version = '\\version "2.24.0"\n{ c }\n'
    assert.equal(applied(version, withScoreLines(version, { 'Audio offset': '-0.5' })), '\\version "2.24.0"\n% Audio offset: -0.5\n{ c }\n')
    assert.equal(applied('{ c }\n', withScoreLines('{ c }\n', { BPM: '60' })), '% BPM: 60\n{ c }\n')
    assert.equal(applied('\\version "2.24.0"', withScoreLines('\\version "2.24.0"', { BPM: '60' })), '\\version "2.24.0"\n% BPM: 60')
  })

  test('a line there is rewritten in place, or taken out with its line break', () => {
    const text = '\\version "2.24.0"\r\n% Audio: a.mp3\r\n% Audio offset: 2\r\n% BPM: 90\r\n{ c }\r\n'
    assert.equal(applied(text, withScoreLines(text, { 'Audio offset': '-1.5' })), text.replace('% Audio offset: 2', '% Audio offset: -1.5'))
    assert.equal(applied(text, withScoreLines(text, { Audio: undefined, 'Audio offset': undefined })), '\\version "2.24.0"\r\n% BPM: 90\r\n{ c }\r\n')
    // Taking out one line and adding another: the new one goes after a line that stays.
    assert.equal(applied(text, withScoreLines(text, { BPM: undefined, Start: '4' })), '\\version "2.24.0"\r\n% Audio: a.mp3\r\n% Audio offset: 2\r\n% Start: 4\r\n{ c }\r\n')
    assert.deepEqual(withScoreLines('{ c }\n', { BPM: undefined }), [])
  })
})

describe('a voice\'s sung times, `% Audio sung` (D276)', () => {
  /** `text` with `edits` applied, as the editor applies them. */
  const applied = (text: string, edits: TextEdit[]) =>
    [...edits].sort((a, b) => b.offset - a.offset).reduce((result, { offset, length, text: put }) => result.slice(0, offset) + put + result.slice(offset + length), text)
  const notes = [
    { start: 0, length: 480 },
    { start: 480, length: 240 },
    { start: 720, length: 240 },
  ]

  test('the guard is the note count and the FNV-1a hash of their rhythm in ticks', () => {
    // FNV-1a's offset basis, for no notes.
    assert.deepEqual(sungGuard([]), { count: 0, hash: '811c9dc5' })
    const guard = sungGuard(notes)
    assert.equal(guard.count, 3)
    assert.match(guard.hash, /^[0-9a-f]{8}$/)
    assert.deepEqual(sungGuard(notes.map((note) => ({ ...note }))), guard, 'the same rhythm, the same hash')
    assert.notEqual(sungGuard([notes[0]!, { start: 480, length: 480 }, notes[2]!]).hash, guard.hash, 'a length changed')
    assert.notEqual(sungGuard([notes[1]!, notes[0]!, notes[2]!]).hash, guard.hash, 'the order changed')
    assert.notEqual(sungGuard(notes.slice(0, 2)).hash, guard.hash)
  })

  test('the lines are the guard, then the shifts, 16 a line, signed, and . for the grid', () => {
    const shifts = Array.from({ length: 18 }, (_, i) => (i === 2 ? 62 : i === 4 ? -71 : i === 17 ? 55.4 : 0))
    const lines = sungLines('lead', { count: 18, hash: '5e0c41a7' }, shifts)
    assert.deepEqual(lines, [
      '% Audio sung lead: 18 5e0c41a7',
      '% Audio sung lead: . . +62 . -71 . . . . . . . . . . .',
      '% Audio sung lead: . +55',
    ])
    assert.deepEqual(sungLines('lead', { count: 2, hash: '00000000' }, [0, -0.2]), ['% Audio sung lead: 2 00000000', '% Audio sung lead: . .'], 'a voice on the grid is dots')
    assert.throws(() => sungLines('lead', { count: 3, hash: '00000000' }, [0]), /3 notes, not 1/)
    assert.throws(() => sungLines('a: b', { count: 0, hash: '00000000' }, []), /cannot name a voice/)
  })

  test('each voice\'s lines are read, wherever they are, and what does not read so is its problem', () => {
    const text = [
      '\\version "2.24.0"',
      '% Audio: song.mp3',
      '% Audio sung lead: 3 5E0C41A7',
      '% Audio sung lead: . +62',
      '% Audio sung alto: 1 00000000',
      '{ c }',
      '%   Audio sung lead :  -71  ',
      '% Audio sung bass: soon',
      '% Audio sung tenor: 2 00000000',
      '% Audio sung tenor: . 6.5',
      '% Audio sung baritone: 2 00000000',
      '% Audio sung baritone: .',
    ].join('\r\n')
    const read = sungOfScore(text)
    assert.deepEqual(read.get('lead'), { count: 3, hash: '5e0c41a7', shifts: [0, 62, -71] })
    assert.deepEqual(read.get('alto'), { problem: 'it has 0 shifts for 1 notes' })
    assert.deepEqual(read.get('bass'), { problem: 'its first line is not its note count and hash' })
    assert.deepEqual(read.get('tenor'), { problem: '6.5 is not a shift in ms' })
    assert.deepEqual(read.get('baritone'), { problem: 'it has 1 shifts for 2 notes' })
    // Not the audio track's lines, nor theirs these.
    assert.equal(audioOfScore(text), 'song.mp3')
    assert.equal(sungOfScore('% Audio: song.mp3\n% Audio offset: 1\n').size, 0)
    assert.deepEqual(sungOfScore(sungLines('lead', sungGuard(notes), [0, 62, -71]).join('\n')).get('lead'), { ...sungGuard(notes), shifts: [0, 62, -71] }, 'what is written reads back')
  })

  test('times for other notes are not used, and the status line says why', () => {
    const guard = sungGuard(notes)
    assert.deepEqual(sungTimesFor({ ...guard, shifts: [0, 62, 0] }, 'lead', guard), { shifts: [0, 62, 0] })
    assert.equal(sungTimesFor(undefined, 'lead', guard), undefined)
    const stale = { stale: 'lead\'s sung times are for an earlier rhythm; it plays as written' }
    assert.deepEqual(sungTimesFor({ ...guard, shifts: [0, 62, 0] }, 'lead', sungGuard([...notes, { start: 960, length: 480 }])), stale, 'a note added')
    assert.deepEqual(sungTimesFor({ ...guard, shifts: [0, 62, 0] }, 'lead', sungGuard([notes[0]!, { start: 480, length: 480 }, notes[2]!])), stale, 'a rhythm changed')
    assert.deepEqual(sungTimesFor({ problem: 'its first line is not its note count and hash' }, 'lead', guard), {
      stale: 'lead\'s % Audio sung lines cannot be read (its first line is not its note count and hash); it plays as written',
    })
  })

  test('a voice\'s lines are replaced together where its first was, and the others are kept', () => {
    const text = '\\version "2.24.0"\n% Audio: a.mp3\n% Audio sung lead: 2 00000000\n% Audio sung alto: 1 11111111\n% Audio sung alto: .\n% Audio sung lead: . .\n{ c }\n'
    const lines = ['% Audio sung lead: 2 22222222', '% Audio sung lead: +5 .']
    assert.equal(
      applied(text, withSungLines(text, 'lead', lines)),
      '\\version "2.24.0"\n% Audio: a.mp3\n% Audio sung lead: 2 22222222\n% Audio sung lead: +5 .\n% Audio sung alto: 1 11111111\n% Audio sung alto: .\n{ c }\n',
    )
    assert.equal(applied(text, withSungLines(text, 'lead', undefined)), '\\version "2.24.0"\n% Audio: a.mp3\n% Audio sung alto: 1 11111111\n% Audio sung alto: .\n{ c }\n')
    assert.deepEqual(withSungLines(text, 'bass', undefined), [], 'nothing to take out')
  })

  test('a voice\'s first lines go after the score\'s own and the other voices\' sung ones, else after \\version, else first', () => {
    const own = '\\version "2.24.0"\n% Audio: a.mp3\n% BPM: 113.76\n{ c }\n'
    const lines = ['% Audio sung lead: 1 22222222', '% Audio sung lead: .']
    assert.equal(applied(own, withSungLines(own, 'lead', lines)), '\\version "2.24.0"\n% Audio: a.mp3\n% BPM: 113.76\n% Audio sung lead: 1 22222222\n% Audio sung lead: .\n{ c }\n')
    const others = '% Audio: a.mp3\n% Audio sung alto: 1 11111111\n% Audio sung alto: .\n{ c }\n'
    assert.equal(applied(others, withSungLines(others, 'lead', lines)), '% Audio: a.mp3\n% Audio sung alto: 1 11111111\n% Audio sung alto: .\n% Audio sung lead: 1 22222222\n% Audio sung lead: .\n{ c }\n')
    assert.equal(applied('\\version "2.24.0"\r\n{ c }\r\n', withSungLines('\\version "2.24.0"\r\n{ c }\r\n', 'lead', lines)), '\\version "2.24.0"\r\n% Audio sung lead: 1 22222222\r\n% Audio sung lead: .\r\n{ c }\r\n')
    assert.equal(applied('{ c }', withSungLines('{ c }', 'lead', lines)), '% Audio sung lead: 1 22222222\n% Audio sung lead: .\n{ c }')
    // The last line, with no line break after it.
    const last = '% Audio: a.mp3'
    assert.equal(applied(last, withSungLines(last, 'lead', lines)), '% Audio: a.mp3\n% Audio sung lead: 1 22222222\n% Audio sung lead: .')
  })
})
