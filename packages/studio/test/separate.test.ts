import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import type { SeparationModel } from '../src/ipc'
import { stemScore } from '../src/renderer/files'
import {
  baseName,
  DEFAULT_OVERLAP,
  droppedSong,
  elapsed,
  FORMATS,
  isSong,
  mixLabel,
  modelGroups,
  modelLabel,
  modelNote,
  modelStems,
  progressOf,
  QUALITIES,
  runLabel,
  scoreLabel,
  SONG_EXTENSIONS,
  songName,
  statusLine,
  stemTitle,
  transcriptionStatus,
} from '../src/renderer/separate'

// Runs under `node --test` from out/test/ (npm run test:unit in packages/studio/):
// the Separate view's pure parts (DECISIONS D112). Separating is crates/separate's
// tests; the view in the real window is the smoke test's.

/** The models as `karaoke-mlx --json models` lists them. */
const MODELS: SeparationModel[] = [
  {
    id: 'becruily',
    title: 'Mel-RoFormer Karaoke (becruily)',
    description: 'Two-stem karaoke model: lead vocals vs. instrumental with backing vocals kept.',
    task: 'karaoke',
    stems: ['instrumental', 'vocals'],
    size: 1719139254,
    installed: true,
    default: true,
    num_overlap: 8,
  },
  {
    id: 'bs-roformer-sw',
    title: 'BS-RoFormer SW, 6 stems (jarredou)',
    description: 'Splits a song into vocals, drums, bass, guitar, piano and other.',
    task: 'stems',
    stems: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'],
    size: 699412152,
    installed: false,
    default: false,
    num_overlap: 2,
  },
  {
    id: 'aufr33-viperx',
    title: 'Mel-RoFormer Karaoke (aufr33 & viperx)',
    description: 'The original Mel-RoFormer karaoke model.',
    task: 'karaoke',
    stems: ['instrumental', 'vocals'],
    size: 913096801,
    installed: true,
    default: false,
    num_overlap: 4,
  },
]

describe('the song', () => {
  test('is a file whose extension ffmpeg reads, in any case', () => {
    assert.ok(isSong('/Volumes/T5/Downloads/valeriy-meladze_-_tekila-lyubov.mp3'))
    assert.ok(isSong('/m/Song.FLAC'))
    assert.ok(isSong('/m/a.b/take 2.m4a'))
    assert.ok(!isSong('/m/score.ly'))
    assert.ok(!isSong('/m/song (stems)'))
    assert.ok(!isSong('/m/mp3'))
    assert.ok(!isSong('/m.mp3/readme'))
  })

  test('dropped with other files: the first song', () => {
    assert.equal(droppedSong(['/m/score.ly', '/m/b.wav', '/m/c.mp3']), '/m/b.wav')
    assert.equal(droppedSong(['/m/score.ly', '/m/folder']), undefined)
    assert.equal(droppedSong([]), undefined)
  })

  test('shows by its last name', () => {
    assert.equal(baseName('/Volumes/T5/Downloads/tekila.mp3'), 'tekila.mp3')
    assert.equal(baseName('/s/tekila (stems)/'), 'tekila (stems)')
  })

  test('the panel offers what the view takes (src-tauri/src/separate.rs)', () => {
    const rust = readFileSync(path.resolve(__dirname, '..', '..', 'src-tauri', 'src', 'separate.rs'), 'utf8')
    const list = rust.match(/const SONG_EXTENSIONS: &\[&str\] = &\[([^\]]*)\]/)?.[1] ?? ''
    assert.deepEqual([...list.matchAll(/"(\w+)"/g)].map((match) => match[1]), SONG_EXTENSIONS)
  })
})

describe('the model list', () => {
  test('groups Karaoke, then All instruments, in the order karaoke-mlx lists them', () => {
    const groups = modelGroups(MODELS)
    assert.deepEqual(
      groups.map((group) => [group.label, group.models.map((model) => model.id)]),
      [
        ['Karaoke', ['becruily', 'aufr33-viperx']],
        ['All instruments', ['bs-roformer-sw']],
      ],
    )
  })

  test('leaves out a group with no models', () => {
    assert.deepEqual(
      modelGroups(MODELS.filter((model) => model.task === 'stems')).map((group) => group.label),
      ['All instruments'],
    )
    assert.deepEqual(modelGroups([]), [])
  })

  test('names a karaoke model by who trained it, another by its architecture', () => {
    assert.deepEqual(MODELS.map(modelLabel), ['becruily', 'BS-RoFormer SW', 'aufr33 & viperx'])
  })

  test('says what each writes', () => {
    assert.deepEqual(MODELS.map(modelStems), ['instrumental · vocals', '6 stems', 'instrumental · vocals'])
  })

  test('notes the download a model not yet installed makes', () => {
    assert.equal(modelNote(MODELS[0]!), MODELS[0]!.description)
    assert.equal(modelNote(MODELS[1]!), `${MODELS[1]!.description} Its first separation downloads 0.7 GB.`)
  })
})

describe('the settings', () => {
  test('quality is RoFormer’s Fast, Balanced and Best, Balanced first', () => {
    assert.deepEqual(QUALITIES.map(({ label, overlap }) => [label, overlap]), [
      ['Fast', 2],
      ['Balanced', 4],
      ['Best', 8],
    ])
    assert.equal(DEFAULT_OVERLAP, 4)
  })

  test('formats are those karaoke-mlx writes', () => {
    assert.deepEqual(FORMATS.map(({ format }) => format), ['wav', 'flac', 'mp3'])
  })

  test('the run button says what it makes, and Cancel while running', () => {
    assert.equal(runLabel(MODELS[0], false), 'Make karaoke')
    assert.equal(runLabel(MODELS[1], false), 'Separate instruments')
    assert.equal(runLabel(undefined, false), 'Make karaoke')
    assert.equal(runLabel(MODELS[1], true), 'Cancel')
  })
})

describe('progress', () => {
  test('separating and downloading say how far; the bar is kept between 0 and 1', () => {
    assert.deepEqual(progressOf({ event: 'progress', stage: 'separate', value: 0.384 }), { label: 'Separating', value: 0.384 })
    assert.deepEqual(progressOf({ event: 'progress', stage: 'download', value: 1.2 }), { label: 'Downloading the model (once)', value: 1 })
    assert.deepEqual(progressOf({ event: 'progress', stage: 'separate', value: -0.1 }), { label: 'Separating', value: 0 })
  })

  test('the other stages show a moving bar', () => {
    for (const stage of ['verify', 'convert', 'load', 'decode', 'mix', 'write'] as const) {
      const progress = progressOf({ event: 'progress', stage, value: 0.5 })
      assert.ok(progress && progress.value === undefined && progress.label.length > 0, stage)
    }
  })

  test('status lines, done and error are not progress', () => {
    assert.equal(progressOf({ event: 'status', message: 'separating with BS-RoFormer SW, 6 stems (jarredou)' }), undefined)
    assert.equal(progressOf({ event: 'done', outputs: [], folder: '/s', seconds: 3 }), undefined)
    assert.equal(progressOf({ event: 'error', message: 'Cancelled.', cancelled: true }), undefined)
  })

  test('the status line names the song and the stage', () => {
    assert.equal(statusLine('tekila.mp3', { label: 'Separating', value: 0.384 }), 'Stems: separating tekila.mp3 38%')
    assert.equal(statusLine('tekila.mp3', { label: 'Loading the model' }), 'Stems: loading the model tekila.mp3')
  })

  test('time as m:ss', () => {
    assert.equal(elapsed(0), '0:00')
    assert.equal(elapsed(9.9), '0:09')
    assert.equal(elapsed(134), '2:14')
    assert.equal(elapsed(3600), '60:00')
    assert.equal(elapsed(-1), '0:00')
  })
})

describe('the stems', () => {
  test('a karaoke model’s vocals are the lead vocals', () => {
    assert.deepEqual(stemTitle('vocals', 'karaoke'), { title: 'Lead vocals', hint: 'isolated voice' })
    assert.deepEqual(stemTitle('vocals', 'stems'), { title: 'Vocals', hint: 'isolated voice' })
    assert.deepEqual(stemTitle('instrumental', 'karaoke'), { title: 'Instrumental', hint: 'karaoke backing track' })
  })

  test('each of the six has a name; one karaoke-mlx adds later is capitalised', () => {
    assert.deepEqual(
      MODELS[1]!.stems.map((stem) => stemTitle(stem, 'stems').title),
      ['Vocals', 'Drums', 'Bass', 'Guitar', 'Piano', 'Other'],
    )
    assert.deepEqual(stemTitle('strings', 'stems'), { title: 'Strings', hint: '' })
  })

  test('the export button counts the ticked stems', () => {
    assert.equal(mixLabel(0, false), 'Export mix…')
    assert.equal(mixLabel(2, false), 'Export mix of 2…')
    assert.equal(mixLabel(2, true), 'Mixing…')
  })
  test('Score… says which stems get a rough draft of chords (D113)', () => {
    const labels = MODELS[1]!.stems.map((stem) => {
      const { title } = stemTitle(stem, 'stems')
      return scoreLabel(stemScore({ stem, title, file: `/s/song - ${stem}.wav`, song: 'song' }).hard)
    })
    assert.deepEqual(labels, ['Score…', 'Score…', 'Score…', 'Score… (draft)', 'Score… (draft)', 'Score… (draft)'])
  })

  test('the status line says what the transcription is doing', () => {
    assert.equal(transcriptionStatus('Bass', 'beats'), 'Transcribing the bass: finding the beats…')
    assert.equal(transcriptionStatus('Lead vocals', 'notes'), 'Transcribing the lead vocals: hearing the notes…')
  })

  test('a stem’s score is titled after the song’s file, without its extension', () => {
    assert.equal(songName('/Music/valeriy-meladze_-_tekila-lyubov.mp3'), 'valeriy-meladze_-_tekila-lyubov')
    assert.equal(songName('/Music/a.b.flac'), 'a.b')
    assert.equal(songName('/Music/.hidden'), '.hidden')
  })
})
