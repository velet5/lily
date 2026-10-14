import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileRows, stemOfScore, stemScore } from '../src/renderer/files'
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

describe('a score for a stem (D112)', () => {
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
    assert.match(bass, /title = "tekila — Bass"/)
    assert.match(bass, /instrumentName = "Bass"/)
    assert.match(bass, /midiInstrument = "electric bass \(finger\)"/)
    assert.match(bass, /\\clef "bass_8"/)
    assert.match(stemScore(request('drums')).text, /\\new DrumStaff/)
    assert.match(stemScore(request('piano')).text, /\\new PianoStaff/)
    assert.match(stemScore(request('vocals')).text, /% \\new Lyrics \\lyricsto "melody"/)
    assert.match(stemScore(request('theremin')).text, /instrumentName = "Theremin"/)
  })

  test('guitar, piano and the rest are marked hard, as #1199 found them', () => {
    assert.deepEqual(
      STEMS.filter((stem) => stemScore(request(stem)).hard),
      ['guitar', 'piano', 'other', 'instrumental', 'theremin'],
    )
    assert.equal(
      stemScore(request('bass')).hint,
      'Bass clef, “Bass”, electric bass sound. Saved as bass.ly beside the stems; the stem plays under the preview.',
    )
  })

  test('quotes and backslashes in the song stay inside the title', () => {
    const { text } = stemScore({ ...request('bass'), song: 'say "hi" \\ bye\nnow' })
    assert.match(text, /title = "say \\"hi\\" \\\\ bye now — Bass"/)
  })

  test('a stem line naming another folder is ignored', () => {
    assert.equal(stemOfScore('% Stem: ../song.mp3\n'), undefined)
    assert.equal(stemOfScore('% Stem: /tmp/a.wav\n'), undefined)
    assert.equal(stemOfScore('\\version "2.24.0"\n'), undefined)
    assert.equal(stemOfScore('{ c }\n%Stem:  a - bass.wav  \n'), 'a - bass.wav')
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
  })
})
