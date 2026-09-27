import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { formatTime, momentTime, parseMidi } from '../../media/midi.js'
import { timelineOf, type Box } from '../../media/preview.js'
import type { CompileOutcome, PlaybackTiming } from '../src/ipc'
import { playbackChange, type Loaded } from '../src/renderer/player'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/, in studio/ (npm run test:unit).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-player-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

const MIDI_A = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1])
const MIDI_B = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 2])
const MAP: PlaybackTiming = { events: [{ href: 'textedit:///s.ly:2:3:4', at: 0, grace: 0, length: 0.25 }], bars: [{ at: 0, number: 1 }] }

function outcome(partial: Partial<CompileOutcome>): CompileOutcome {
  return { state: 'ok', rootFile: '/s.ly', diagnostics: [], errorCount: 0, warningCount: 0, pages: [], svg: [], midi: [], durationMs: 1, ...partial }
}

describe('playbackChange', () => {
  const loaded: Loaded = { rootFile: '/s.ly', midi: MIDI_A, timing: MAP }

  test('the first compile, and another score, load their music', () => {
    assert.deepEqual(playbackChange(outcome({ midiData: MIDI_A, timing: MAP }), undefined), { kind: 'load', midi: MIDI_A, timing: MAP })
    // Another score without MIDI stops the first one's music.
    assert.deepEqual(playbackChange(outcome({ rootFile: '/t.ly', state: 'failed' }), loaded), { kind: 'load', midi: undefined, timing: undefined })
  })

  test('the same bytes play on; a moved map only remaps them', () => {
    assert.deepEqual(playbackChange(outcome({ midiData: MIDI_A.slice(), timing: structuredClone(MAP) }), loaded), { kind: 'keep' })
    const moved = { ...MAP, events: [{ ...MAP.events[0], href: 'textedit:///s.ly:3:3:4' }] }
    assert.deepEqual(playbackChange(outcome({ midiData: MIDI_A, timing: moved }), loaded), { kind: 'remap', timing: moved })
    assert.deepEqual(playbackChange(outcome({ midiData: MIDI_B, timing: MAP }), loaded), { kind: 'load', midi: MIDI_B, timing: MAP })
  })

  test('a failed run without MIDI keeps it; a good one without \\midi clears it', () => {
    assert.deepEqual(playbackChange(outcome({ state: 'failed' }), loaded), { kind: 'keep' })
    assert.deepEqual(playbackChange(outcome({}), loaded), { kind: 'load', midi: undefined, timing: undefined })
    assert.deepEqual(playbackChange(outcome({}), { rootFile: '/s.ly', midi: undefined, timing: undefined }), { kind: 'keep' })
  })

  test('a run that did not happen changes nothing', () => {
    for (const state of ['no-root', 'no-lilypond', 'error'] as const) {
      assert.deepEqual(playbackChange(outcome({ state, rootFile: '/t.ly' }), loaded), { kind: 'keep' })
    }
  })
})

describe('timelineOf, shared with the extension', () => {
  test('finds the events on the pages and splits the systems where the music goes back left', () => {
    const at = (x: number, y: number, page = 0): Box => ({ page, left: x - 0.01, right: x + 0.01, top: y, bottom: y + 0.05 })
    const boxes = new Map<string, Box>([['c', at(0.2, 0.1)], ['d', at(0.6, 0.1)], ['e', at(0.2, 0.4)]])
    const links = new Map([...boxes.keys()].map((href) => [href, [href]]))
    const map = {
      events: ['c', 'd', 'e'].map((href, i) => ({ href, at: i / 4, grace: 0, length: 0.25 })),
      bars: [{ at: 0, number: 1 }],
    }
    // A whole note is two seconds.
    const line = timelineOf(map, 1.5, links, (element) => boxes.get(element), (at, grace) => 2 * (at + grace))
    assert.deepEqual(line.events.map((e) => [e.element, e.time, e.end]), [['c', 0, 0.5], ['d', 0.5, 1], ['e', 1, 1.5]])
    assert.deepEqual(line.moments.map((m) => m.system), [0, 0, 1])
    assert.equal(line.systems.length, 2)
  })
})

// The Rust side reads the MIDI and its map with the pages (crates/engrave's tests).
describe('the music of a real score', () => {
  test('plays, and every note it plays is a link on the pages', async (t) => {
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(score, '\\version "2.24.0"\n\\score {\n  { \\tempo 4 = 120 c\'4 d\' e\'2 | f\'1 }\n  \\layout { }\n  \\midi { }\n}\n')
    const outcome = await realOutcome(t, score)
    if (!outcome) return
    assert.equal(outcome?.state, 'ok', outcome?.message)
    assert.ok(outcome?.midiData, 'no MIDI was read')
    const midi = parseMidi(outcome.midiData)
    assert.equal(midi.notes.length, 4)
    assert.equal(formatTime(midi.duration), '0:04')
    assert.ok(outcome.timing, 'no playback map was read')
    const hrefs = outcome.timing.events.map((event) => event.href)
    assert.equal(hrefs.length, 4)
    for (const href of hrefs) assert.ok(outcome.svg.some((page) => page.includes(href)), `${href} is on no page`)
    // Bar 2 begins two seconds in.
    const bar2 = outcome.timing.bars.find((bar) => bar.number === 2)
    assert.ok(bar2)
    assert.equal(momentTime(midi, bar2.at), 2)
  })
})
