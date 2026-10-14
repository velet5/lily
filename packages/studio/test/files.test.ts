import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { parseMidi } from '@lily/common/web/midi.js'
import type { Transcription } from '../src/ipc'
import { fileRows, songTitle, stemOfScore, stemScore } from '../src/renderer/files'
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
    file: `/Music/tekila (stems)/tekila - ${stem}.wav`,
    song: 'tekila',
  })

  test('names the stem in its % Stem: line, which the preview reads back', () => {
    for (const stem of STEMS) {
      const { text, name } = stemScore(request(stem))
      assert.equal(name, stem)
      assert.equal(stemOfScore(text), `tekila - ${stem}.wav`, stem)
    }
  })

  test('is set up for the instrument, titled after the song', () => {
    const bass = stemScore(request('bass')).text
    assert.match(bass, /title = "Tekila"/)
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
    assert.deepEqual(songTitle('valeriy-meladze_-_tekila-lyubov'), { title: 'Tekila-lyubov', artist: 'Valeriy Meladze' })
    assert.deepEqual(songTitle('Queen - Bohemian Rhapsody'), { title: 'Bohemian Rhapsody', artist: 'Queen' })
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
    return stemScore({ ...request(stem), transcription: transcription(stem, family, notes) })
  }

  test('a transcribed stem has its notes, key, meter, tempo and pickup, from its start to its end', () => {
    const { text } = transcribed('bass')
    assert.equal(stemOfScore(text), 'tekila - bass.wav')
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
