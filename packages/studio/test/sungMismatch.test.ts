import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, mock, test, type TestContext } from 'node:test'
import { parseMidi, type Midi, type Note } from '@lily/common/web/midi.js'
import type { TimedLyric, TimedStaff } from '@lily/common/types'
import type { CompileOutcome, PlaybackTiming, SungFound, SungVoice } from '../src/ipc'
import { ScorePlayer } from '../src/renderer/player'
import {
  lineStartsOf,
  linkedFile,
  linkOffset,
  markedElements,
  pitchName,
  singerVoices,
  sungElements,
  sungMarks,
  sungProgress,
  sungStatus,
  voiceGuard,
  voiceJson,
  voiceNotes,
  voiceRegions,
  voiceSignature,
  type SungMark,
} from '../src/renderer/sungMismatch'
import { voiceTracks } from '../src/renderer/karaoke'
import { FakeAudio, FakeElement } from './fakes'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/ (npm run test:unit). From the
// singer (D276): lily-transcribe's `sung` is the Rust side's and Python's to
// test; here, what the renderer sends it and makes of its answer.

function note(key: number, time: number, duration: number, track = 1): Note {
  return { time, duration, track, channel: track - 1, key, velocity: 0.8, program: 0, gain: 1, pan: 0, detune: 0 }
}

function lyric(at: number, text: string, extra: Partial<TimedLyric> = {}): TimedLyric {
  return { at, text, hyphen: false, extender: false, line: 0, voice: 'lead', italic: false, ...extra }
}

function staff(voices: string[], id = ''): TimedStaff {
  return { id, name: '', shortName: '', group: '', groupIndex: -1, clef: 'clefs.G', clefTransposition: 0, voices }
}

/** Music at ♩ = 120, 480 ticks to the quarter: a whole note lasts two seconds, a quarter 480 ticks. */
function midi(notes: Note[]): Midi {
  const tracks = [0, 1, 2].map((track) => ({ name: '', channels: track === 0 ? [] : [track - 1], programs: [], notes: notes.filter((n) => n.track === track).length }))
  const music = { title: '', duration: Math.max(0, ...notes.map((n) => n.time + n.duration)), notes, tracks, division: 480, tempos: [{ tick: 0, seconds: 0, tempo: 500_000 }] }
  return music as Midi
}

/** The lead on track 1, three quarters and a half; a bass on track 2 in the same rhythm. */
const LEAD = [note(60, 0, 0.5), note(62, 0.5, 0.5), note(64, 1, 0.5), note(65, 1.5, 1)]
const music = midi([...LEAD, ...LEAD.map((n) => ({ ...n, key: n.key - 24, track: 2 }))])
const timing: PlaybackTiming = {
  events: [],
  bars: [],
  staves: [staff(['lead']), staff(['bass'])],
  lyrics: [lyric(0, 'We'), lyric(0.25, 'sing', { hyphen: true }), lyric(0.5, 'ing.'), lyric(0.75, ' ')],
}

describe('the voices From the singer compares (D276)', () => {
  test('the named voices with words, each on its track', () => {
    assert.deepEqual(singerVoices(timing, music), [{ voice: 'lead', track: 1 }])
    // Without words, or with a name lilypond gave it, a voice is not one.
    assert.deepEqual(singerVoices({ ...timing, lyrics: [] }, music), [])
    assert.deepEqual(singerVoices({ ...timing, staves: [staff(['uniqueContext0']), staff(['bass'])], lyrics: [lyric(0, 'We', { voice: 'uniqueContext0' })] }, music), [])
  })

  test('two voices with words on one track cannot be told apart', () => {
    const shared: PlaybackTiming = { ...timing, staves: [staff(['lead', 'alto']), staff(['bass'])], lyrics: [lyric(0, 'We'), lyric(0, 'Oh', { voice: 'alto', line: 1 })] }
    assert.deepEqual(singerVoices(shared, music), [
      { voice: 'lead', track: 1, shares: 'alto' },
      { voice: 'alto', track: 1, shares: 'lead' },
    ])
  })
})

describe('the voice as `sung` reads it (voice.json)', () => {
  test('its notes in the order played, on the recording\'s timeline, each with the syllable that starts on it', () => {
    // The recording is 0.33 s in when the music starts: % Audio offset: -0.33.
    const sent = voiceJson(music, timing, 'lead', 1, 120, -0.33)
    assert.deepEqual(sent, {
      bpm: 120,
      notes: [
        { start: 0.33, length: 0.5, pitch: 60, syllable: 'We' },
        { start: 0.83, length: 0.5, pitch: 62, syllable: 'sing' },
        { start: 1.33, length: 0.5, pitch: 64, syllable: 'ing.' },
        // The skip is no syllable.
        { start: 1.83, length: 1, pitch: 65 },
      ],
    })
  })

  test('a chord\'s syllable is its first note\'s, a second verse\'s does not take the first\'s place, and words of other voices are not its', () => {
    const chord = midi([note(64, 0, 1), note(60, 0, 1), note(67, 1, 1)])
    const lyrics = [lyric(0, 'One'), lyric(0, 'Two', { line: 1 }), lyric(0.5, 'more'), lyric(0.5, 'else', { voice: 'alto', line: 2 })]
    const sent = voiceJson(chord, { ...timing, lyrics }, 'lead', 1, 120, 0)
    assert.deepEqual(
      sent.notes.map(({ pitch, syllable }) => [pitch, syllable]),
      [
        [60, 'One'],
        [64, undefined],
        [67, 'more'],
      ],
    )
  })

  test('a note with no length is sent with the shortest `sung` takes', () => {
    const sent = voiceJson(midi([note(60, 0, 0)]), { ...timing, lyrics: [lyric(0, 'Ah')] }, 'lead', 1, 120, 0)
    assert.equal(sent.notes[0]!.length, 0.001)
  })
})

describe('the guard of a voice\'s notes', () => {
  test('their rhythm in the MIDI\'s ticks, whatever the tempo; the signature has their pitches too', () => {
    const guard = voiceGuard(music, 1)
    assert.equal(guard.count, 4)
    assert.deepEqual(voiceGuard(music, 2), guard, 'the bass has the lead\'s rhythm')
    const repitched = midi(LEAD.map((n, i) => (i === 1 ? { ...n, key: 63 } : n)))
    assert.deepEqual(voiceGuard(repitched, 1), guard, 'a pitch corrected keeps the times')
    assert.notEqual(voiceSignature(repitched, 1), voiceSignature(music, 1), 'but not the comparison')
    const longer = midi(LEAD.map((n, i) => (i === 3 ? { ...n, duration: 2 } : n)))
    assert.notEqual(voiceGuard(longer, 1).hash, guard.hash)
    // At ♩ = 60, every note twice as late and long: the same ticks.
    const slower = { ...midi(LEAD.map((n) => ({ ...n, time: n.time * 2, duration: n.duration * 2 }))), tempos: [{ tick: 0, seconds: 0, tempo: 1_000_000 }] } as Midi
    assert.deepEqual(voiceGuard(slower, 1), guard)
  })
})

/** `sung`'s answer for `voice`: every note sure, on the grid and as written, in one phrase, unless `change` says otherwise. */
function answer(voice: SungVoice, change: (found: SungFound) => void = () => {}): SungFound {
  const found: SungFound = {
    voice: 'lead',
    notes: voice.notes.map((n) => ({ shift: 0, arrival: n.start, consonant: null, vowel: null, score: 0.5, asWritten: true, heard: n.pitch })),
    phrases: [{ first: 0, last: voice.notes.length - 1, sung: true }],
    lag: 0.072,
    tau: 0.125,
    octave: 0,
    took: 1,
  }
  change(found)
  return found
}

const C_MAJOR = { tonic: 0, mode: 'major', fit: 1 } as const

describe('where the score differs from the singer', () => {
  const voice = voiceJson(music, timing, 'lead', 1, 120, 0)

  test('a sure arrival more than a 16th from the grid, either way; within it, or unsure, none', () => {
    const found = answer(voice, ({ notes }) => {
      notes[0]!.arrival = 0.14 // 140 ms late
      notes[1]!.arrival = 0.5 - 0.09 // within τ
      notes[2]!.arrival = 1 - 0.2 // 200 ms early
      notes[3]!.arrival = null
    })
    assert.deepEqual(sungMarks(voice, found, C_MAJOR), [
      { note: 0, kinds: ['timing'], title: 'sung 140 ms late' },
      { note: 2, kinds: ['timing'], title: 'sung 200 ms early' },
    ])
  })

  test('a pitch not sung as written, by name; one too little voiced to say is not', () => {
    const found = answer(voice, ({ notes }) => {
      notes[1]!.asWritten = false
      notes[1]!.heard = 64
      notes[1]!.arrival = 0.75
      notes[2]!.asWritten = null
      notes[2]!.heard = null
      notes[3]!.asWritten = false
      notes[3]!.heard = 66
    })
    assert.deepEqual(sungMarks(voice, found, C_MAJOR), [
      { note: 1, kinds: ['timing', 'pitch'], title: 'sung 250 ms late; sung E4, written D4' },
      { note: 3, kinds: ['pitch'], title: 'sung F♯4, written F4' },
    ])
    assert.equal(pitchName(70, { tonic: 5, mode: 'major', fit: 1 }), 'B♭4')
    assert.equal(pitchName(45, C_MAJOR), 'A2')
  })

  test('every note of a phrase the stem does not sing, and nothing else of it', () => {
    const found = answer(voice, (found) => {
      found.phrases = [
        { first: 0, last: 1, sung: false },
        { first: 2, last: 3, sung: true },
      ]
      found.notes[0]!.asWritten = false
      found.notes[0]!.heard = 70
    })
    assert.deepEqual(
      sungMarks(voice, found, C_MAJOR).map(({ note, kinds, title }) => [note, kinds, title]),
      [
        [0, ['unsung'], 'not in the vocals stem'],
        [1, ['unsung'], 'not in the vocals stem'],
      ],
    )
  })

  test('an answer for other notes is refused', () => {
    assert.throws(() => sungMarks(voice, { ...answer(voice), notes: [] }, C_MAJOR), /0 notes for the voice's 4/)
  })

  test('the status line counts each kind, says whether the preview marks them, and that nothing was written', () => {
    const found = answer(voice, (found) => {
      found.phrases = [
        { first: 0, last: 0, sung: false },
        { first: 1, last: 3, sung: true },
      ]
      found.notes[1]!.arrival = 0.8
      found.notes[2]!.asWritten = false
      found.notes[2]!.heard = 65
      found.notes[3]!.asWritten = false
      found.notes[3]!.heard = 64
      found.warnings = ['Words with no Latin letters are not aligned yet.']
    })
    const marks = sungMarks(voice, found, C_MAJOR)
    assert.equal(
      sungStatus('lead', marks, found, 3),
      'The score differs from lead\'s singer: 1 note sung more than a 16th off the grid, 2 pitches not sung as written, 1 phrase not in the vocals stem; marked in the preview. Nothing was written. Words with no Latin letters are not aligned yet.',
    )
    assert.match(sungStatus('lead', marks, found, 0), /not marked in the preview, which cannot find lead's music in this file/)
    assert.equal(
      sungStatus('lead', [], answer(voice), 0),
      'lead keeps to its singer: every note sure enough to say is within a 16th of the grid and at its written pitch. Nothing was written.',
    )
  })

  test('the status line names the stage it is at', () => {
    assert.equal(sungProgress('song.mp3', 'separate', 0.42), 'From the singer: separating the vocals of song.mp3 (42 %)…')
    assert.equal(sungProgress('song.mp3', 'words'), 'From the singer: finding the words of song.mp3…')
  })
})

describe('the voice\'s music in the source', () => {
  /** The text of each region. */
  const regions = (text: string, voice: string) => voiceRegions(text, voice).map(([start, end]) => text.slice(start, end).trim())

  test('the expression after its \\new Voice, past \\with and a command\'s words', () => {
    const text = '\\new Staff \\new Voice = "lead" \\with { \\consists "X" } \\relative c\' { c4 d } \\new Voice = "leader" { e }'
    assert.deepEqual(regions(text, 'lead'), ['\\with { \\consists "X" } \\relative c\' { c4 d }'])
    assert.deepEqual(regions('\\context Voice = lead << { c } \\\\ { d } >> { e }', 'lead'), ['<< { c } \\\\ { d } >>'])
    assert.deepEqual(regions('\\new Voice = "lead" { c }', 'alto'), [])
    // A variable from an included file is the voice's music by itself: the next staff's is not taken for it.
    assert.deepEqual(regions('<< \\new Voice = "lead" \\melody \\new Staff { \\clef bass c4 } >>', 'lead'), ['\\melody'])
    assert.deepEqual(regions('\\new Voice = "lead" \\fixed c\' \\unfoldRepeats { c4 }', 'lead'), ['\\fixed c\' \\unfoldRepeats { c4 }'])
  })

  test('the variables it uses, and theirs, wherever they are defined; comments and strings are not music', () => {
    const text = [
      'verse = { c4 d e f }',
      'melody = \\relative c\' { \\verse % \\bridge',
      '  g1 "}" %{ } %}',
      '}',
      'bridge = { a b }',
      'other = { b }',
      '\\score { \\new Voice = "lead" \\transpose c d \\melody }',
    ].join('\n')
    assert.deepEqual(regions(text, 'lead'), ['{ c4 d e f }', '\\relative c\' { \\verse % \\bridge\n  g1 "}" %{ } %}\n}', '\\transpose c d \\melody'])
  })

  test('a link is placed by its line and its CHAR in code points, in the file it names', () => {
    const text = 'a = 1\n𝄞 { c4 }\n'
    const starts = lineStartsOf(text)
    const offset = linkOffset('textedit:///s/My%20song.ly:2:4:5', '/s/My song.ly', starts, text)
    assert.equal(text.slice(offset), 'c4 }\n')
    assert.equal(linkOffset('textedit:///s/other.ly:2:4:5', '/s/My song.ly', starts, text), undefined)
    assert.equal(linkOffset('textedit:///s/My%20song.ly:9:0:1', '/s/My song.ly', starts, text), undefined)
    // The links name a score by its real path: the one file of its name.
    const linked: PlaybackTiming = { events: [{ href: 'textedit:///private/s/song.ly:1:0:1', at: 0, grace: 0, length: 0.25 }], bars: [] }
    assert.equal(linkedFile(linked, '/s/song.ly'), '/private/s/song.ly')
    assert.equal(linkedFile(linked, '/s/other.ly'), '/s/other.ly')
  })
})

describe('the marks on the preview', () => {
  const mark = (note: number, title: string): SungMark => ({ note, kinds: ['timing'], title })

  test('the voice\'s elements heard when a marked note starts, the k-th place an href is drawn the k-th time it is played', () => {
    const map: PlaybackTiming = {
      events: [
        { href: 'lead-1', at: 0, grace: 0, length: 0.25 },
        { href: 'lead-2', at: 0.25, grace: 0, length: 0.25 },
        { href: 'bass-2', at: 0.25, grace: 0, length: 0.25 },
        // Played twice, drawn twice; then a grace note, which is not a note's start.
        { href: 'lead-3', at: 0.5, grace: 0, length: 0.25 },
        { href: 'lead-3', at: 0.75, grace: 0, length: 0.25 },
        { href: 'lead-grace', at: 0.25, grace: -0.0625, length: 0.0625 },
      ],
      bars: [],
    }
    const links = new Map([
      ['lead-1', ['L1']],
      ['lead-2', ['L2']],
      ['bass-2', ['B2']],
      ['lead-3', ['L3a', 'L3b']],
      ['lead-grace', ['G']],
    ])
    const notes = [0, 0.5, 1, 1.5].map((time) => ({ time }))
    const marked = markedElements(map, (at) => at * 2, notes, [mark(1, 'sung 140 ms late'), mark(3, 'sung 200 ms early')], (href) => href.startsWith('lead'), links)
    assert.deepEqual([...marked], [
      ['L2', { kinds: ['timing'], title: 'sung 140 ms late' }],
      ['L3b', { kinds: ['timing'], title: 'sung 200 ms early' }],
    ])
  })

  test('the notes that start together share their marks', () => {
    const map: PlaybackTiming = { events: [{ href: 'chord', at: 0, grace: 0, length: 0.25 }], bars: [] }
    const marked = markedElements(map, (at) => at, [{ time: 0 }, { time: 0 }], [mark(0, 'sung 140 ms late'), { note: 1, kinds: ['pitch'], title: 'sung E4, written D4' }], () => true, new Map([['chord', ['C']]]))
    assert.deepEqual(marked.get('C'), { kinds: ['timing', 'pitch'], title: 'sung 140 ms late; sung E4, written D4' })
  })

  test('on a real score, only the lead\'s notes are marked, not its words nor the bass in its rhythm', async (t) => {
    const song = await realSong(t)
    if (!song) return
    const { score, text, outcome } = song
    const played = parseMidi(outcome.midiData!)
    const [singer] = singerVoices(outcome.timing, played)
    assert.deepEqual(singer, { voice: 'lead', track: 1 })
    const voice = voiceJson(played, outcome.timing, 'lead', singer!.track, 120, 0)
    assert.deepEqual(
      voice.notes.map(({ start, pitch, syllable }) => [start, pitch, syllable]),
      [
        [0, 60, 'Lan'],
        [0.5, 62, 'tern'],
        [1, 64, 'glow.'],
        [2, 65, 'Oh'],
      ],
    )
    assert.equal(voiceNotes(played, voiceTracks(outcome.timing!.staves, played.tracks).get('bass')!).length, 4, 'the bass, in the same rhythm')
    // The preview's elements by href, as preview.ts collects them, named by their page and place.
    const links = new Map<string, string[]>()
    outcome.svg.forEach((page, number) => {
      for (const [, href] of page.matchAll(/xlink:href="(textedit:[^"]+)"/g)) links.set(href!, [...(links.get(href!) ?? []), `${number}:${href}`])
    })
    const found = answer(voice, ({ notes }) => {
      notes[1]!.arrival = 0.65
      notes[3]!.asWritten = false
      notes[3]!.heard = 67
    })
    const marks = sungMarks(voice, found, C_MAJOR)
    const marked = sungElements(outcome.timing!, played, singer!.track, 'lead', marks, score, text, links)
    const starts = lineStartsOf(text)
    const where = [...marked].map(([element, { title }]) => {
      const offset = linkOffset(element.slice(element.indexOf(':') + 1), linkedFile(outcome.timing!, score), starts, text)!
      const line = starts.filter((start) => start <= offset).length
      return [line, text.slice(offset, offset + 2), title]
    })
    assert.deepEqual(where, [
      [2, 'd ', 'sung 150 ms late'],
      [2, 'f1', 'sung G4, written F4'],
    ])
  })
})

/** A lead with words and a bass in its rhythm, compiled as the app does; undefined after skipping `t` without lilypond. */
async function realSong(t: TestContext): Promise<{ score: string; text: string; outcome: CompileOutcome } | undefined> {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-sung-')))
  t.after(() => fs.rm(scratch, { recursive: true, force: true }))
  const score = path.join(scratch, 'song.ly')
  const text = [
    '\\version "2.24.0"',
    'melody = \\relative c\' { \\tempo 4 = 120 c4 d e2 | f1 }',
    'bassline = \\relative c { \\clef bass c4 d e2 | f1 }',
    '\\score {',
    '  <<',
    '    \\new Staff \\new Voice = "lead" { \\melody }',
    '    \\new Lyrics \\lyricsto "lead" { Lan -- tern glow. Oh }',
    '    \\new Staff \\new Voice = "bass" { \\bassline }',
    '  >>',
    '  \\layout { }',
    '  \\midi { }',
    '}',
    '',
  ].join('\n')
  await fs.writeFile(score, text)
  const outcome = await realOutcome(t, score)
  if (!outcome) return undefined
  assert.equal(outcome.state, 'ok', outcome.message)
  return { score, text, outcome }
}

/** An SVG <title>, which takes itself out of the element it was put in. */
interface Title {
  textContent: string
  owner?: Marked
  remove(): void
}

/** A preview element as much as the marks touch: its classes, attributes and children. */
class Marked {
  readonly classes = new Set<string>()
  readonly attributes = new Map<string, string>()
  readonly children: Title[] = []
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
  prepend(child: Title): void {
    child.owner = this
    this.children.unshift(child)
  }
}

describe('From the singer, in the Parts fold (D276)', () => {
  beforeEach(() => {
    const createElement = (tag: string) => (tag === 'audio' ? new FakeAudio() : new FakeElement())
    const createElementNS = (): Title => {
      const title: Title = { textContent: '', remove: () => void title.owner?.children.splice(title.owner.children.indexOf(title), 1) }
      return title
    }
    Object.assign(globalThis, { document: { createElement, createElementNS, body: new FakeElement() }, Option: FakeElement })
  })

  afterEach(() => mock.restoreAll())

  const settled = () => new Promise((resolve) => setImmediate(resolve))

  test('a voice with words has the button while the score has a recording; its answer marks its notes, says what differs, and writes nothing', async (t) => {
    const song = await realSong(t)
    if (!song) return
    const { score, text, outcome } = song
    const links = new Map<string, Marked[]>()
    for (const page of outcome.svg) for (const [, href] of page.matchAll(/xlink:href="(textedit:[^"]+)"/g)) links.set(href!, [...(links.get(href!) ?? []), new Marked()])
    const asked: [string, SungVoice][] = []
    const said: string[] = []
    let reply: (found: SungFound) => void = () => {}
    const transport = new FakeElement()
    const panel = new FakeElement()
    const fake = (element: FakeElement) => element as unknown as HTMLElement
    const player = new ScorePlayer({
      transport: fake(transport),
      panel: fake(panel),
      body: fake(new FakeElement()),
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: links as unknown as Map<string, Element[]> },
      onError: (message) => assert.fail(message),
      onAddMidi() {},
      loadSetup: async () => undefined,
      saveSetup: async () => {},
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
      setScoreLines: () => assert.fail('nothing is written'),
      onStatus: (message) => void said.push(message),
      detectSung: (voice, notes) => {
        asked.push([voice, notes])
        return new Promise((resolve) => (reply = resolve))
      },
      scoreText: (file) => (file === score ? text : undefined),
    })
    player.compiled({ kind: 'finished', outcome: { ...outcome, rootFile: score } })
    transport.find('transport-parts')!.fire('click')
    assert.equal(panel.find('part-from-singer'), undefined, 'no % Audio:')
    player.audio = { path: path.join(path.dirname(score), 'song.mp3'), url: 'song', offset: -0.5 }
    const button = panel.find('part-from-singer')!
    assert.equal(button.textContent, 'From the singer')
    button.fire('click')
    assert.equal(panel.find('part-from-singer')!.textContent, 'Listening…')
    assert.equal(panel.find('part-from-singer')!.disabled, true)
    assert.equal(asked.length, 1)
    const [voice, notes] = asked[0]!
    assert.equal(voice, 'lead')
    assert.equal(notes.bpm, 120)
    assert.deepEqual(notes.notes[0], { start: 0.5, length: 0.5, pitch: 60, syllable: 'Lan' })
    reply(answer(notes, ({ notes: found }) => {
      found[1]!.arrival = notes.notes[1]!.start + 0.15
      found[3]!.asWritten = false
      found[3]!.heard = 67
    }))
    await settled()
    const marked = [...links.values()].flat().filter((element) => element.classes.has('sung-differs'))
    assert.deepEqual(
      marked.map((element) => [element.attributes.get('data-sung'), element.children[0]?.textContent]),
      [
        ['timing', 'sung 150 ms late'],
        ['pitch', 'sung G4, written F4'],
      ],
    )
    assert.deepEqual(said.slice(-1), [
      'The score differs from lead\'s singer: 1 note sung more than a 16th off the grid, 1 pitch not sung as written; marked in the preview. Nothing was written.',
    ])
    assert.equal(panel.find('part-from-singer')!.textContent, 'From the singer')
    // The marks come off with ✕, or once the voice's notes change.
    panel.find('part-singer-clear')!.fire('click')
    assert.equal([...links.values()].flat().filter((element) => element.classes.has('sung-differs') || element.children.length > 0).length, 0)
    assert.equal(panel.find('part-singer-clear'), undefined)
  })

  test('a voice whose lines are for an earlier rhythm says so once', async (t) => {
    const song = await realSong(t)
    if (!song) return
    const said: string[] = []
    const player = new ScorePlayer({
      transport: new FakeElement() as unknown as HTMLElement,
      panel: new FakeElement() as unknown as HTMLElement,
      body: new FakeElement() as unknown as HTMLElement,
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: new Map() },
      onError: (message) => assert.fail(message),
      onAddMidi() {},
      loadSetup: async () => undefined,
      saveSetup: async () => {},
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
      onStatus: (message) => void said.push(message),
    })
    player.compiled({ kind: 'finished', outcome: song.outcome })
    const guard = voiceGuard(parseMidi(song.outcome.midiData!), 1)
    player.sung = new Map([['lead', { ...guard, shifts: [0, 62, 0, 0] }]])
    assert.deepEqual([...player.sungTimes()], [['lead', { track: 1, shifts: [0, 62, 0, 0] }]])
    assert.deepEqual(said, [])
    // The lead plays its second note 62 ms late, and the bass keeps the grid.
    const grid = parseMidi(song.outcome.midiData!)
    const starts = (midi: Midi | undefined, track: number) => voiceNotes(midi!, track).map(({ time }) => Math.round(time * 1000))
    assert.deepEqual(starts(player.score, 1), starts(grid, 1).map((ms, i) => (i === 1 ? ms + 62 : ms)))
    assert.deepEqual(starts(player.score, 2), starts(grid, 2))
    assert.deepEqual(starts(player.midi, 1), starts(player.score, 1), 'as it plays')
    const map = player.voiceTimes.get(1)!
    assert.equal(Math.round(map(voiceNotes(grid, 1)[1]!.time) * 1000), starts(grid, 1)[1]! + 62)
    player.sung = new Map([['lead', { count: 4, hash: '00000000', shifts: [0, 62, 0, 0] }]])
    player.sung = new Map([['lead', { count: 4, hash: '00000000', shifts: [0, 62, 0, 0] }]])
    assert.deepEqual(said, ['Lead\'s sung times are for an earlier rhythm; it plays as written.'])
    assert.deepEqual(starts(player.score, 1), starts(grid, 1))
    assert.equal(player.voiceTimes.size, 0)
  })
})
