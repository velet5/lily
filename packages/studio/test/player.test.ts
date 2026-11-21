import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import { formatTime, momentTime, parseMidi, Player, type Midi } from '@lily/common/web/midi.js'
import { timelineOf, type Box } from '@lily/common/web/preview.js'
import type { CompileOutcome, PlaybackSetup, PlaybackTiming, ScoreMeter, TempoFound } from '../src/ipc'
import { playbackChange, ScorePlayer, StemStrip, type Loaded, type ScorePlayerOptions, type StripAudio } from '../src/renderer/player'
import { FakeAudio, FakeElement, FOUND, fakeContext, scoreMidi } from './fakes'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/, in packages/studio/ (npm run test:unit).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-player-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

const MIDI_A = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 1])
const MIDI_B = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 2])
/** How long the device is kept with nothing playing (midi.js, D151). */
const REST_MS = 10000
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

  test('the web engine’s pages before their music keep it; the music, when it comes, is loaded as ever (D264)', () => {
    assert.deepEqual(playbackChange(outcome({ performing: true }), loaded), { kind: 'keep' })
    assert.deepEqual(playbackChange(outcome({ performing: true, state: 'failed' }), loaded), { kind: 'keep' })
    // Another score's pages stop the first one's music until its own comes.
    assert.deepEqual(playbackChange(outcome({ performing: true, rootFile: '/t.ly' }), loaded), { kind: 'load', midi: undefined, timing: undefined })
    assert.deepEqual(playbackChange(outcome({ midiData: MIDI_B, timing: MAP }), loaded), { kind: 'load', midi: MIDI_B, timing: MAP })
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

  test('each event\'s time is asked with its href, so a voice at its sung times is placed at them; a bar\'s has none (D276)', () => {
    const at = (x: number): Box => ({ page: 0, left: x - 0.01, right: x + 0.01, top: 0.1, bottom: 0.15 })
    const boxes = new Map<string, Box>([['lead', at(0.5)], ['bass', at(0.5)], ['next', at(0.7)]])
    const links = new Map([...boxes.keys()].map((href) => [href, [href]]))
    const map = {
      events: [
        { href: 'lead', at: 0.25, grace: 0, length: 0.25 },
        { href: 'bass', at: 0.25, grace: 0, length: 0.25 },
        { href: 'next', at: 0.5, grace: 0, length: 0.25 },
      ],
      bars: [{ at: 0.25, number: 2 }],
    }
    const asked: (string | undefined)[] = []
    // The lead sung 100 ms late.
    const line = timelineOf(map, 2, links, (element) => boxes.get(element), (at, grace, href) => {
      asked.push(href)
      return 2 * (at + grace) + (href === 'lead' ? 0.1 : 0)
    })
    assert.deepEqual(line.events.map((e) => [e.element, e.time, e.end]), [['bass', 0.5, 1], ['lead', 0.6, 1.1], ['next', 1, 1.5]])
    assert.deepEqual(line.moments.map((m) => m.time), [0.5, 0.6, 1])
    assert.deepEqual(line.bars, [{ time: 0.5, number: 2 }])
    assert.ok(asked.includes(undefined) && asked.includes('lead'))
  })

  test('an empty syllable has no place: its system keeps its own band', () => {
    // Bar 37 of *Song K*: the tenors' `""` begins with the
    // altos' next word, on the last of three systems. Its `<a>` draws nothing and
    // is measured as a point at the page's top left corner: the moment went
    // back to the left edge and began a system whose band was the whole page
    // (D152).
    const at = (x: number, y: number): Box => ({ page: 0, left: x - 0.01, right: x + 0.01, top: y, bottom: y + 0.05 })
    const boxes = new Map<string, Box>([
      ['c', at(0.2, 0.1)],
      ['d', at(0.1, 0.7)],
      ['did', at(0.6, 0.7)],
      ['empty', { page: 0, left: 0, right: 0, top: 0, bottom: 0 }],
    ])
    const links = new Map([...boxes.keys()].map((href) => [href, [href]]))
    const map = {
      events: [
        { href: 'c', at: 0, grace: 0, length: 0.25 },
        { href: 'd', at: 0.25, grace: 0, length: 0.25 },
        { href: 'did', at: 0.5, grace: 0, length: 0.25 },
        { href: 'empty', at: 0.5, grace: 0, length: 0 },
      ],
      bars: [],
    }
    const line = timelineOf(map, 1, links, (element) => boxes.get(element), (at, grace) => at + grace)
    assert.deepEqual(line.moments.map((m) => [m.system, m.x]), [[0, 0.2], [1, 0.1], [1, 0.6]])
    assert.ok(line.systems[1].top > 0.6, `the band begins at ${line.systems[1].top}`)
    // It still sounds, as the syllable it is.
    assert.ok(line.events.some((e) => e.element === 'empty'))
  })

  test('pairs a variable played four times with its places as they are read, not as the SVG lists them', () => {
    // The SVG lists bar 2 before bar 1 on the first system, and the next system before both.
    const at = (x: number, y: number): Box => ({ page: 0, left: x - 0.01, right: x + 0.01, top: y, bottom: y + 0.01 })
    const boxes = new Map<string, Box>([
      ['next system, bar 4', at(0.6, 0.5)],
      ['bar 2', at(0.6, 0.1)],
      ['bar 1', at(0.2, 0.105)],
      ['next system, bar 3', at(0.2, 0.5)],
    ])
    const links = new Map([['v', [...boxes.keys()]]])
    const map = { events: [0, 1, 2, 3].map((at) => ({ href: 'v', at, grace: 0, length: 0.25 })), bars: [] }
    const line = timelineOf(map, 4, links, (element) => boxes.get(element), (at, grace) => at + grace)
    assert.deepEqual(
      line.events.map((e) => e.element),
      ['bar 1', 'bar 2', 'next system, bar 3', 'next system, bar 4'],
    )
    assert.deepEqual(line.moments.map((m) => m.system), [0, 0, 1, 1])
  })

  test('a variable played more often than drawn goes to the place nearest the cursor, below the melody', () => {
    // The melody alone is placed, so each system's band is its staff; the
    // guitar's variable is drawn twice on the first system and once on the
    // second (on the staff below the melody), and played four times.
    const at = (x: number, y: number): Box => ({ page: 0, left: x - 0.01, right: x + 0.01, top: y, bottom: y + 0.01 })
    const boxes = new Map<string, Box>([
      ['melody 1', at(0.1, 0.1)],
      ['melody 2', at(0.5, 0.1)],
      ['melody 3', at(0.1, 0.5)],
      ['melody 4', at(0.5, 0.5)],
      ['guitar, bar 1', at(0.15, 0.25)],
      ['guitar, bar 2', at(0.55, 0.25)],
      ['guitar, next system', at(0.15, 0.65)],
    ])
    const links = new Map<string, string[]>([
      ...[1, 2, 3, 4].map((n): [string, string[]] => [`m${n}`, [`melody ${n}`]]),
      ['g', ['guitar, bar 1', 'guitar, bar 2', 'guitar, next system']],
    ])
    const map = {
      events: [
        ...[0, 1, 2, 3].map((at) => ({ href: `m${at + 1}`, at, grace: 0, length: 0.25 })),
        ...[0, 1, 2, 3].map((at) => ({ href: 'g', at: at + 0.25, grace: 0, length: 0.25 })),
      ],
      bars: [],
    }
    const line = timelineOf(map, 4, links, (element) => boxes.get(element), (at, grace) => at + grace)
    assert.deepEqual(
      line.events.filter((e) => e.element?.startsWith('guitar')).map((e) => e.element),
      ['guitar, bar 1', 'guitar, bar 2', 'guitar, next system', 'guitar, next system'],
    )
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

describe('the Stem strip and the score', () => {
  const STEM: StripAudio = { label: 'Stem', path: '/s/bass.wav', url: 'bass' }
  const BACKING: StripAudio = { label: 'Backing', path: '/s/backing.wav', url: 'backing' }
  /** Between the transport's play and its first sample (midi.js). */
  const LEAD_IN = 0.06
  let audio: FakeAudio
  let now: number
  let players: Player[]
  /** What the strip told the status line. */
  let errors: string[]

  beforeEach(() => {
    now = 100_000
    players = []
    errors = []
    mock.method(performance, 'now', () => now)
    const createElement = (tag: string) => (tag === 'audio' ? (audio = new FakeAudio()) : new FakeElement())
    Object.assign(globalThis, { document: { createElement }, Option: class { constructor(readonly text: string, readonly value: string) {} } })
  })

  afterEach(() => {
    for (const player of players) player.dispose()
    mock.restoreAll()
    assert.deepEqual(errors, [])
  })

  /** Where the recording was sent, to the millisecond. */
  const sent = () => audio.sent.map((place) => Math.round(place * 1000) / 1000)

  /** A strip on the real transport, whose `seek` counts as ScorePlayer's does. */
  function linkedTo(...audios: StripAudio[]) {
    const { context, clock } = fakeContext()
    let seeks = 0
    let strip: StemStrip | undefined
    const follow = () => strip?.follow(player.scheduled, player.state === 'playing')
    const player = new Player({ createContext: () => context, onChange: follow })
    players.push(player)
    player.load({ notes: [], duration: 180 } as unknown as Midi)
    const score = {
      get ready() {
        return true
      },
      get playing() {
        return player.state === 'playing'
      },
      get scheduled() {
        return player.scheduled
      },
      get seeks() {
        return seeks
      },
      play: async () => void (await player.play()),
      pause: () => player.pause(),
    }
    const host = new FakeElement()
    const shown = new StemStrip({ host: host as unknown as HTMLElement, score, onError: (message) => errors.push(message) })
    strip = shown
    const part = (name: string) => host.children.find((child) => child.className === `stem-strip-${name}`)!
    shown.show(audios)
    audio.loaded()
    /** The music has played for `seconds`, on its clock, the wall's and the recording's. */
    const pass = (seconds: number) => {
      clock.time += seconds
      now += seconds * 1000
      if (!audio.paused) audio.reach(audio.currentTime + seconds)
      follow()
    }
    return {
      strip: shown,
      player,
      clock,
      pass,
      /** The transport's ▶, past its lead-in. */
      play: async () => {
        await player.play()
        clock.time += LEAD_IN
      },
      seekTransport: (seconds: number) => {
        seeks++
        return player.seek(seconds)
      },
      /** The transport's ■ and the bar it stops at. */
      stopTransport: () => {
        seeks++
        player.stop()
      },
      /** What ScorePlayer.remix() does, a mute during playback. */
      remix: async () => {
        const { scheduled } = player
        player.load(player.midi)
        await player.seek(scheduled)
        await player.play()
        clock.time += LEAD_IN
      },
      moveSlider: (seconds: number) => {
        const slider = host.children[4]
        slider.value = String((seconds / audio.duration) * 1000)
        slider.fire('change')
      },
      /** The strip's choice between its recordings. */
      choose: (index: number) => {
        const choice = host.children[1]
        choice.value = String(index)
        choice.fire('change')
      },
      click: (name: 'with' | 'play' | 'close') => part(name).fire('click'),
      pressed: () => part('with').attributes.get('aria-pressed'),
      tooltip: () => part('with').title,
    }
  }

  /** The strip's ▶ awaits the score before the recording. */
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  /** Under mock timers: what waits has started waiting, the timers move, it has its turn. */
  const turn = async (ms: number) => {
    await settled()
    mock.timers.tick(ms)
    await settled()
  }

  test('a backing track starts linked, a stem does not, and the next score does not inherit it', () => {
    const { strip, pressed } = linkedTo(BACKING, STEM)
    assert.equal(pressed(), 'true')
    assert.equal(strip.backing, true)
    strip.show([])
    strip.show([STEM])
    assert.equal(pressed(), 'false')
    assert.equal(strip.backing, false)
  })

  test('the next score\'s ▶ plays its stem alone', async () => {
    const { strip, player, click } = linkedTo(BACKING)
    strip.show([])
    strip.show([STEM])
    click('play')
    await settled()
    assert.equal(audio.paused, false)
    assert.equal(player.state, 'stopped')
  })

  test('✕ ends the link', () => {
    const { strip, pressed, click } = linkedTo(BACKING)
    click('close')
    assert.equal(pressed(), 'false')
    assert.equal(strip.backing, false)
    strip.show([STEM])
    assert.equal(pressed(), 'false')
  })

  test('With score starts a stem from where the user put it', async () => {
    const { player, click, moveSlider, pass } = linkedTo(STEM)
    moveSlider(12)
    click('with')
    audio.sent = []
    click('play')
    await settled()
    assert.equal(player.state, 'playing')
    assert.equal(audio.paused, false)
    pass(5)
    assert.deepEqual(sent(), [])
    assert.equal(audio.currentTime, 17)
  })

  test('the transport\'s ▶ too starts a linked stem from where it is', async () => {
    const { play, click, moveSlider } = linkedTo(STEM)
    moveSlider(12)
    click('with')
    audio.sent = []
    await play()
    assert.equal(audio.paused, false)
    assert.deepEqual(sent(), [])
  })

  for (const recording of [STEM, BACKING]) {
    test(`moving the slider moves a linked ${recording.label} alone, and it stays moved`, async () => {
      const { player, play, click, moveSlider, pass } = linkedTo(recording)
      if (recording === STEM) click('with')
      await play()
      pass(10)
      moveSlider(40)
      audio.sent = []
      for (let i = 0; i < 40; i++) pass(0.1)
      assert.deepEqual(sent(), [])
      assert.ok(Math.abs(player.scheduled - 14) < 0.001, `the score is at ${player.scheduled}`)
    })
  }

  test('a stem that drifts from the score is left to it: each jump is heard', async () => {
    const { play, click, pass } = linkedTo(STEM)
    click('with')
    await play()
    audio.sent = []
    pass(10)
    audio.reach(11)
    pass(3)
    assert.deepEqual(sent(), [])
  })

  test('a seek of the transport takes a linked stem along, as far from the score as it was', async () => {
    const { play, click, moveSlider, seekTransport, pass } = linkedTo(STEM)
    moveSlider(12)
    click('with')
    await play()
    pass(1)
    audio.sent = []
    await seekTransport(30)
    assert.deepEqual(sent(), [42])
    await seekTransport(0)
    assert.deepEqual(sent(), [42, 12])
  })

  test('while paused a seek moves the score alone, and they go on each from where it is', async () => {
    const { player, play, click, moveSlider, seekTransport, pass } = linkedTo(STEM)
    click('with')
    await play()
    pass(5)
    player.pause()
    moveSlider(22)
    audio.sent = []
    await seekTransport(10)
    assert.deepEqual(sent(), [])
    await play()
    pass(1)
    audio.sent = []
    await seekTransport(30)
    assert.deepEqual(sent(), [42])
  })

  test('a moved stem stays as far from the score as the slider put it', async () => {
    const { play, click, moveSlider, seekTransport, pass } = linkedTo(STEM)
    click('with')
    await play()
    pass(5)
    moveSlider(20)
    audio.sent = []
    await seekTransport(30)
    assert.deepEqual(sent(), [45])
  })

  test('linking a stem already playing beside the score takes the distance between them', async () => {
    const { play, click, moveSlider, seekTransport, pass } = linkedTo(STEM)
    await play()
    moveSlider(12)
    click('play')
    await settled()
    click('with')
    pass(1)
    audio.sent = []
    await seekTransport(30)
    assert.deepEqual(sent(), [42])
  })

  test('a seek to before the stem\'s start puts it at its start', async () => {
    const { player, play, click, seekTransport } = linkedTo(STEM)
    await player.seek(10)
    audio.reach(2)
    click('with')
    await play()
    audio.sent = []
    await seekTransport(1)
    assert.deepEqual(sent(), [0])
  })

  test('a seek of the transport moves a backing track at once, however soon after another', async () => {
    const { play, seekTransport, pass } = linkedTo(BACKING)
    await play()
    pass(1)
    audio.sent = []
    await seekTransport(30)
    audio.seeking = true
    await seekTransport(60)
    assert.deepEqual(sent(), [30, 60])
  })

  test('a backing track that strays is put back, then left alone for 2 s', async () => {
    const { play, pass } = linkedTo(BACKING)
    await play()
    pass(5)
    audio.reach(5.2)
    pass(0.1)
    assert.deepEqual(sent(), [])
    audio.reach(6)
    pass(0.1)
    assert.deepEqual(sent(), [5.2])
    audio.reach(7)
    pass(1)
    assert.deepEqual(sent(), [5.2])
    pass(1.1)
    assert.deepEqual(sent(), [5.2, 7.3])
  })

  test('the next seek of the transport brings a moved backing track back to the score', async () => {
    const { play, moveSlider, seekTransport, pass } = linkedTo(BACKING)
    await play()
    pass(5)
    moveSlider(40)
    audio.sent = []
    await seekTransport(20)
    assert.deepEqual(sent(), [20])
    pass(1)
    assert.deepEqual(sent(), [20])
  })

  test('so does ■: the next ▶ has the backing track from the score\'s start', async () => {
    const { play, moveSlider, stopTransport, pass } = linkedTo(BACKING)
    await play()
    pass(5)
    moveSlider(40)
    stopTransport()
    assert.equal(audio.paused, true)
    audio.sent = []
    await play()
    assert.deepEqual(sent(), [0])
  })

  test('a paused backing track goes on from the slider, with the score from where it was', async () => {
    const { player, play, moveSlider, pass } = linkedTo(BACKING)
    await play()
    pass(5)
    player.pause()
    moveSlider(40)
    audio.sent = []
    await play()
    pass(3)
    assert.deepEqual(sent(), [])
  })

  test('a remix puts a backing track back at once: load reports a stop, so it starts again', async () => {
    const { play, pass, remix } = linkedTo(BACKING)
    await play()
    pass(5)
    audio.reach(9)
    audio.sent = []
    await remix()
    assert.deepEqual(sent(), [5])
    assert.equal(audio.paused, false)
  })

  test('a remix leaves a moved recording where the slider put it', async () => {
    const { play, moveSlider, pass, remix } = linkedTo(BACKING)
    await play()
    pass(5)
    moveSlider(40)
    audio.sent = []
    await remix()
    assert.deepEqual(sent(), [])
  })

  test('a linked stem goes on from where it is after a remix', async () => {
    const { play, click, moveSlider, pass, seekTransport, remix } = linkedTo(STEM)
    moveSlider(12)
    click('with')
    await play()
    pass(1)
    audio.sent = []
    await remix()
    assert.deepEqual(sent(), [])
    await seekTransport(30)
    assert.deepEqual(sent(), [42])
  })

  test('a stem that played to its end starts again on the next pass, and goes on following', async () => {
    const { play, click, stopTransport, seekTransport, pass } = linkedTo(STEM)
    click('with')
    await play()
    pass(5)
    audio.finish()
    stopTransport()
    audio.sent = []
    await play()
    assert.equal(audio.paused, false)
    assert.deepEqual(sent(), [0])
    await seekTransport(30)
    assert.deepEqual(sent(), [0, 30])
  })

  test('a recording chosen during playback comes in with the score, however long it takes to load', async () => {
    const { play, player, pass, choose, seekTransport } = linkedTo(BACKING, STEM)
    await play()
    pass(5)
    choose(1)
    assert.equal(audio.paused, true)
    // A tick of the transport while nothing is known of it.
    pass(0.5)
    audio.loaded()
    assert.ok(Math.abs(audio.currentTime - player.scheduled) < 0.001, `the stem is at ${audio.currentTime}, the score at ${player.scheduled}`)
    audio.sent = []
    await seekTransport(30)
    assert.deepEqual(sent(), [30])
  })

  test('chosen while nothing plays, a recording keeps its place', async () => {
    const { moveSlider, choose } = linkedTo(STEM, BACKING)
    moveSlider(12)
    choose(1)
    audio.loaded()
    assert.equal(audio.currentTime, 12)
  })

  test('the tooltip of With score says what it does to the recording chosen', () => {
    const { click, tooltip, choose } = linkedTo(BACKING, STEM)
    assert.match(tooltip(), /keeps to the score’s place/)
    click('with')
    assert.match(tooltip(), /score’s place/)
    assert.doesNotMatch(tooltip(), /from where it is/)
    choose(1)
    audio.loaded()
    assert.match(tooltip(), /each from where it is/)
    click('with')
    assert.match(tooltip(), /each from where it is/)
  })

  test('another score starts from no distance at all', async () => {
    const { strip, play, moveSlider, pass, seekTransport } = linkedTo(BACKING)
    await play()
    pass(5)
    moveSlider(40)
    strip.show([])
    strip.show([BACKING])
    audio.sent = []
    await seekTransport(30)
    await play()
    pass(0.5)
    assert.deepEqual(sent(), [30])
  })

  test('a pause during a play still waiting is no failure', async () => {
    const { player, play } = linkedTo(BACKING)
    audio.buffering = true
    await play()
    player.pause()
    await settled()
    assert.equal(audio.paused, true)
    assert.deepEqual(errors, [])
  })

  test('nor is another recording chosen during one', async () => {
    const { play, choose } = linkedTo(BACKING, STEM)
    audio.buffering = true
    await play()
    choose(1)
    await settled()
    assert.deepEqual(errors, [])
  })

  test('a recording that cannot be played says so', async () => {
    const { play } = linkedTo(BACKING)
    audio.play = () => Promise.reject(new DOMException('The source is not supported.', 'NotSupportedError'))
    await play()
    await settled()
    assert.deepEqual(errors.splice(0), ['The stem could not be played: The source is not supported.'])
  })

  test('after the device rested a linked recording waits for the score and goes on with it (D151)', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    try {
      const { player, clock, play, pass } = linkedTo(BACKING)
      await play()
      pass(5)
      player.pause()
      assert.equal(audio.paused, true)
      mock.timers.tick(REST_MS)
      await settled()
      assert.equal(clock.state, 'suspended')

      // The clock stood still; the place is the score's, and neither was read while it did.
      clock.resumeMs = 550
      audio.sent = []
      const playing = player.play()
      await turn(300)
      assert.equal(audio.paused, true, 'not ahead of a score still waiting for its device')
      await turn(250)
      assert.equal(await playing, true)
      assert.equal(audio.paused, false)
      clock.time += LEAD_IN
      for (let i = 0; i < 40; i++) pass(0.1)
      assert.deepEqual(sent(), [], 'nothing to put back')
      assert.ok(Math.abs(player.scheduled - 9) < 0.001, `the score is at ${player.scheduled}`)
    } finally {
      mock.timers.reset()
    }
  })

  test('a linked stem too keeps its distance across a rest (D151)', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    try {
      const { player, clock, click, moveSlider, play, pass, seekTransport } = linkedTo(STEM)
      moveSlider(12)
      click('with')
      await play()
      pass(1)
      player.pause()
      mock.timers.tick(REST_MS)
      await settled()
      assert.equal(clock.state, 'suspended')
      audio.sent = []
      const playing = player.play()
      await turn(0)
      assert.equal(await playing, true)
      clock.time += LEAD_IN
      pass(1)
      await seekTransport(30)
      assert.deepEqual(sent(), [42])
    } finally {
      mock.timers.reset()
    }
  })
})

/** One track of one note, 480 ticks to the quarter. */
const ONE_PART = new Uint8Array([
  0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0x01, 0xe0,
  0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 13,
  0, 0x90, 60, 100,
  0x83, 0x60, 0x80, 60, 0,
  0, 0xff, 0x2f, 0,
])

describe('the transport after the audio device rested (D151)', () => {
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  const pass = async (ms: number) => {
    await settled()
    mock.timers.tick(ms)
    await settled()
  }
  let errors: string[]

  beforeEach(() => {
    errors = []
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    Object.assign(globalThis, {
      document: { createElement: () => new FakeElement(), body: new FakeElement() },
      Option: FakeElement,
      requestAnimationFrame: () => 1,
    })
  })

  afterEach(() => {
    mock.timers.reset()
    Reflect.deleteProperty(globalThis, 'AudioContext')
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  })

  /** ScorePlayer on a device that has played, been paused and been let go. */
  async function rested(resumeMs: number) {
    const { context, clock } = fakeContext()
    // `new AudioContext()` hands back the object a constructor returns.
    Object.assign(globalThis, { AudioContext: function () { return context } })
    const transport = new FakeElement()
    const panel = new FakeElement()
    const fake = (element: FakeElement) => element as unknown as HTMLElement
    const player = new ScorePlayer({
      transport: fake(transport),
      panel: fake(panel),
      body: fake(new FakeElement()),
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: new Map() },
      onError: (message) => errors.push(message),
      onAddMidi() {},
      loadSetup: async () => undefined,
      saveSetup: async () => {},
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
    })
    player.compiled({ kind: 'finished', outcome: outcome({ midiData: ONE_PART }) })
    await player.play()
    player.pause()
    await pass(REST_MS)
    assert.equal(clock.state, 'suspended')
    clock.resumeMs = resumeMs
    return { player, clock, transport, panel }
  }

  test('a slow resume is no failure: ▶ plays, and nothing is said', async () => {
    const { player } = await rested(550)
    const playing = player.play()
    await pass(300)
    assert.equal(player.playing, false)
    await pass(250)
    await playing
    assert.equal(player.playing, true)
    assert.deepEqual(errors, [])
  })

  test('■ while it starts is no failure either', async () => {
    const { player } = await rested(550)
    const playing = player.play()
    await pass(100)
    player.stop()
    await pass(450)
    await playing
    assert.equal(player.playing, false)
    assert.deepEqual(errors, [])
  })

  test('a device that never comes back says so', async () => {
    const { player } = await rested(60_000)
    const playing = player.play()
    await pass(5000)
    await playing
    assert.deepEqual(errors, ['The sound could not be started.'])
  })

  test('a mute while it starts keeps the press', async () => {
    const { player, transport, panel } = await rested(550)
    transport.find('transport-parts')!.fire('click')
    const playing = player.play()
    await pass(100)
    panel.find('part-mute')!.fire('click')
    await pass(550)
    await playing
    await settled()
    assert.equal(player.playing, true)
    assert.deepEqual(errors, [])
  })
})

describe('the Parts fold while Karaoke silences the parts (D135)', () => {
  let heard: Map<number, number>

  beforeEach(() => {
    heard = new Map()
    mock.method(Player.prototype, 'setTrackVolume', (track: number, volume: number) => void heard.set(track, volume))
    const document = { createElement: () => new FakeElement(), body: new FakeElement() }
    Object.assign(globalThis, { document, Option: FakeElement })
  })

  afterEach(() => mock.restoreAll())

  /** A score of one part, with the fold open on it. */
  function fold() {
    const transport = new FakeElement()
    const panel = new FakeElement()
    const saved: unknown[] = []
    const fake = (element: FakeElement) => element as unknown as HTMLElement
    const options: ScorePlayerOptions = {
      transport: fake(transport),
      panel: fake(panel),
      body: fake(new FakeElement()),
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: new Map() },
      onError: (message) => assert.fail(message),
      onAddMidi() {},
      loadSetup: async () => undefined,
      saveSetup: async (_, setup) => void saved.push(setup),
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
    }
    const player = new ScorePlayer(options)
    player.compiled({ kind: 'finished', outcome: outcome({ midiData: ONE_PART }) })
    transport.find('transport-parts')!.fire('click')
    const track = [...heard.keys()][0]
    return { player, saved, track, slider: panel.find('part-volume')! }
  }

  test('the slider, heard as it is dragged, stays silent and keeps what it is set to', () => {
    const { player, saved, track, slider } = fold()
    player.silence(true)
    slider.value = '150'
    slider.fire('input')
    assert.equal(heard.get(track), 0)
    slider.fire('change')
    assert.equal(heard.get(track), 0)
    assert.deepEqual(saved, [{ parts: { [track]: { volume: 150 } } }])
    player.silence(false)
    assert.equal(heard.get(track), 1.5)
  })

  test('so does its double-click', () => {
    const { player, track, slider } = fold()
    slider.value = '150'
    slider.fire('input')
    slider.fire('change')
    player.silence(true)
    slider.value = '100'
    slider.fire('dblclick')
    assert.equal(heard.get(track), 0)
    player.silence(false)
    assert.equal(heard.get(track), 1)
  })

  test('with the parts not silenced, both are heard at once', () => {
    const { track, slider } = fold()
    slider.value = '150'
    slider.fire('input')
    assert.equal(heard.get(track), 1.5)
    slider.fire('dblclick')
    assert.equal(heard.get(track), 1)
  })
})

describe('the audio track and the tempo in the Parts fold (D155)', () => {
  let audio: FakeAudio

  beforeEach(() => {
    const createElement = (tag: string) => (tag === 'audio' ? (audio = new FakeAudio()) : new FakeElement())
    Object.assign(globalThis, { document: { createElement, body: new FakeElement() }, Option: FakeElement })
  })

  afterEach(() => mock.restoreAll())

  /** A score of one part at ♩ = 120, with the fold open on it, and what it asked to write to the score. */
  function fold(options: Partial<ScorePlayerOptions> = {}) {
    const transport = new FakeElement()
    const panel = new FakeElement()
    const saved: unknown[] = []
    const lines: Record<string, string | undefined>[] = []
    const chosen: string[] = []
    const fake = (element: FakeElement) => element as unknown as HTMLElement
    const player = new ScorePlayer({
      transport: fake(transport),
      panel: fake(panel),
      body: fake(new FakeElement()),
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: new Map() },
      onError: (message) => assert.fail(message),
      onAddMidi() {},
      loadSetup: async () => undefined,
      saveSetup: async (_, setup) => void saved.push(setup),
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
      setScoreLines: (written) => void lines.push(written),
      chooseAudio: () => void chosen.push('chosen'),
      ...options,
    })
    player.compiled({ kind: 'finished', outcome: outcome({ midiData: ONE_PART }) })
    transport.find('transport-parts')!.fire('click')
    const find = (className: string) => panel.find(className)!
    const change = (className: string, value: string) => {
      const input = find(className)
      input.value = value
      input.fire('change')
    }
    return { player, panel, saved, lines, chosen, find, change }
  }

  test('without a recording the fold offers Add audio…, and nothing where none can be chosen', () => {
    const { find, chosen, panel } = fold()
    find('part-add-audio').fire('click')
    assert.deepEqual(chosen, ['chosen'])
    assert.equal(panel.find('part-volume')?.max, '200', 'only the part has a volume')
    assert.equal(fold({ chooseAudio: undefined }).panel.find('part-add-audio'), undefined)
  })

  test('the tempo is written to the score, to the hundredth; the score\'s own or none takes the line out', () => {
    const { find, change, lines } = fold()
    assert.equal(find('part-bpm').placeholder, '120')
    change('part-bpm', '143.456')
    change('part-bpm', '120')
    change('part-bpm', '')
    change('part-bpm', '5000')
    assert.deepEqual(lines, [{ BPM: '143.46' }, { BPM: undefined }, { BPM: undefined }, { BPM: undefined }])
  })

  test('at another tempo the music, as heard and as written, is scaled, and the fold says so', () => {
    const { player, find } = fold()
    assert.equal(player.midi?.duration, 0.5)
    player.bpm = 60
    assert.equal(player.midi?.duration, 1)
    assert.equal(player.score?.notes[0].duration, 1)
    assert.equal(find('part-bpm').value, '60')
    assert.match(find('part tempo').children[2].textContent, /0\.5× as fast/)
    player.bpm = undefined
    assert.equal(player.midi?.duration, 0.5)
  })

  test('a recording has its row: its offset written to the score, its volume and mute kept in the setup', () => {
    const { player, find, change, lines, saved } = fold()
    player.audio = { path: '/s/Song.mp3', url: 'song', offset: -1.5 }
    assert.equal(find('part audio').children[1].textContent, 'Audio · Song.mp3')
    assert.equal(find('part-offset-value').value, '-1.5')
    change('part-offset-value', '2.345')
    change('part-offset-value', '0')
    const volume = find('part audio').find('part-volume')!
    assert.equal(volume.max, '100')
    volume.value = '40'
    volume.fire('input')
    assert.equal(audio.volume, 0.4)
    volume.fire('change')
    find('part audio').children[0].fire('click')
    assert.equal(audio.volume, 0)
    assert.deepEqual(saved, [{ audio: { volume: 40 } }, { audio: { volume: 40, muted: true } }])
    find('part-remove').fire('click')
    assert.deepEqual(lines, [{ 'Audio offset': '2.35' }, { 'Audio offset': undefined }, { Audio: undefined, 'Audio offset': undefined }])
    // The whole music's volume is over its own (D154).
    find('part audio').children[0].fire('click')
    player.volume = 0.5
    assert.equal(audio.volume, 0.2)
  })
})

describe('playback ending with the audio track, and the music for Export Video (D155)', () => {
  let audio: FakeAudio

  beforeEach(() => {
    const createElement = (tag: string) => (tag === 'audio' ? (audio = new FakeAudio()) : new FakeElement())
    Object.assign(globalThis, { document: { createElement, body: new FakeElement() }, Option: FakeElement })
  })

  afterEach(() => mock.restoreAll())

  function scored(setup: PlaybackSetup = {}) {
    const transport = new FakeElement()
    const panel = new FakeElement()
    const saved: PlaybackSetup[] = []
    const fake = (element: FakeElement) => element as unknown as HTMLElement
    const player = new ScorePlayer({
      transport: fake(transport),
      panel: fake(panel),
      body: fake(new FakeElement()),
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: new Map() },
      onError: (message) => assert.fail(message),
      onAddMidi() {},
      loadSetup: async () => setup,
      saveSetup: async (_, kept) => void saved.push(kept),
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
      setScoreLines() {},
    })
    player.compiled({ kind: 'finished', outcome: outcome({ midiData: ONE_PART }) })
    return { player, panel, transport, saved }
  }
  const settled = () => new Promise((resolve) => setImmediate(resolve))

  test('it ends with the MIDI, or with the recording, later or earlier, once its length is known', async () => {
    const { player, panel, transport, saved } = scored()
    await settled()
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 1 }
    audio.duration = 3
    audio.fire('durationchange')
    assert.equal(player.duration, 0.5, 'with the MIDI by default')
    transport.find('transport-parts')!.fire('click')
    const end = panel.find('part-end')!
    end.value = 'audio'
    end.fire('change')
    assert.deepEqual(saved, [{ audio: { end: 'audio' } }])
    assert.equal(player.duration, 4)
    // A recording that starts before the music ends before the MIDI does.
    player.audio = { path: '/s/song.mp3', url: 'song', offset: -2.75 }
    assert.equal(player.duration, 0.25)
    panel.find('part-end')!.value = 'midi'
    panel.find('part-end')!.fire('change')
    assert.equal(player.duration, 0.5)
  })

  test('a recording whose length is not known yet leaves the MIDI\'s', async () => {
    const { player } = scored({ audio: { end: 'audio' } })
    await settled()
    audio.duration = NaN
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    assert.equal(player.duration, 0.5)
    audio.duration = 10
    audio.fire('durationchange')
    assert.equal(player.duration, 10)
  })

  test('Export Video\'s music has the parts chosen, muted or not, at their volumes, to where playback ends', async () => {
    const { player } = scored({ parts: { 0: { muted: true, volume: 50, program: 40 } }, audio: { end: 'audio' } })
    await settled()
    const track = player.parts[0].track
    assert.equal(player.midi?.notes.length, 0, 'muted as heard')
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    audio.duration = 6
    audio.fire('durationchange')
    const chosen = player.videoMelody(new Set([track]))!
    assert.equal(chosen.midi.notes.length, 1)
    assert.equal(chosen.midi.notes[0].program, 40)
    assert.equal(chosen.volumes.get(track), 0.5)
    assert.equal(chosen.midi.duration, 6)
    const none = player.videoMelody(new Set())!
    assert.equal(none.midi.notes.length, 0)
    assert.equal(none.volumes.get(track), 0)
    assert.deepEqual(player.audioTrack, { path: '/s/song.mp3', duration: 6, offset: 0, volume: 1, muted: false })
  })
})

describe('From the recording, in the Parts fold (D159)', () => {
  beforeEach(() => {
    const createElement = (tag: string) => (tag === 'audio' ? new FakeAudio() : new FakeElement())
    Object.assign(globalThis, { document: { createElement, body: new FakeElement() }, Option: FakeElement })
  })

  afterEach(() => mock.restoreAll())

  const settled = () => new Promise((resolve) => setImmediate(resolve))

  /** A score at ♩ = 114 in 4/4, its bar 1 `pickup` whole notes in, with the fold open; what it asked for and wrote. */
  function fold(pickup = 0, options: Partial<ScorePlayerOptions> = {}, found: () => Promise<TempoFound> = async () => FOUND) {
    const transport = new FakeElement()
    const panel = new FakeElement()
    const lines: [Record<string, string | undefined>, string | undefined][] = []
    const asked: ScoreMeter[] = []
    const said: string[] = []
    const fake = (element: FakeElement) => element as unknown as HTMLElement
    const player = new ScorePlayer({
      transport: fake(transport),
      panel: fake(panel),
      body: fake(new FakeElement()),
      preview: { pageElements: [] as unknown as HTMLCollection, sourceLinks: new Map() },
      onError: (message) => assert.fail(message),
      onAddMidi() {},
      loadSetup: async () => undefined,
      saveSetup: async () => {},
      exportMidi: async () => undefined,
      onExported() {},
      onPiano() {},
      onPlayback() {},
      setScoreLines: (written, status) => void lines.push([written, status]),
      chooseAudio() {},
      detectTempo: (meter) => {
        asked.push(meter)
        return found()
      },
      onStatus: (message) => void said.push(message),
      ...options,
    })
    const timing: PlaybackTiming = { events: [], bars: [{ at: pickup, number: 1 }, { at: pickup + 1, number: 2 }] }
    player.compiled({ kind: 'finished', outcome: outcome({ midiData: scoreMidi(114), timing }) })
    transport.find('transport-parts')!.fire('click')
    return { player, panel, lines, asked, said }
  }

  test('the button is shown beside the tempo while the score has a recording, and not where none can be listened to', () => {
    const { player, panel } = fold()
    assert.equal(panel.find('part-from-recording'), undefined, 'no % Audio:')
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    assert.equal(panel.find('part tempo')!.find('part-from-recording')!.textContent, 'From the recording')
    player.audio = undefined
    assert.equal(panel.find('part-from-recording'), undefined)
    // The web: no detectTempo.
    const web = fold(0, { detectTempo: undefined })
    web.player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    assert.equal(web.panel.find('part-from-recording'), undefined)
  })

  test('it asks at the score\'s tempo and meter, says Listening…, and writes both lines as one edit', async () => {
    let answer: (found: TempoFound) => void = () => {}
    const { player, panel, lines, asked } = fold(0, {}, () => new Promise((resolve) => (answer = resolve)))
    player.audio = { path: '/s/song.mp3', url: 'song', offset: -0.25 }
    panel.find('part-from-recording')!.fire('click')
    assert.deepEqual(asked, [{ bpm: 114, beatsPerBar: 4, beat: 1 }])
    const listening = panel.find('part-from-recording')!
    assert.equal(listening.textContent, 'Listening…')
    assert.equal(listening.disabled, true)
    answer(FOUND)
    await settled()
    assert.deepEqual(lines, [[{ BPM: '113.76', 'Audio offset': '-0.32' }, '♩ = 113.76, 4/4, bar 1 at 0.32 s; 99 % of the beats on one tempo']])
    assert.equal(panel.find('part-from-recording')!.textContent, 'From the recording')
  })

  test('with a pickup, the recording waits for bar 1 at the new tempo', async () => {
    const { player, panel, lines } = fold(0.25)
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    panel.find('part-from-recording')!.fire('click')
    await settled()
    assert.deepEqual(lines[0][0], { BPM: '113.76', 'Audio offset': '0.21' })
  })

  test('the score\'s own tempo and no offset take the lines out', async () => {
    const { player, panel, lines } = fold(0, {}, async () => ({ ...FOUND, bpm: 114, heardBpm: 114, barOne: 0 }))
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    panel.find('part-from-recording')!.fire('click')
    await settled()
    assert.deepEqual(lines[0][0], { BPM: undefined, 'Audio offset': undefined })
  })

  test('nothing is written when no tempo is found, and the status line says why', async () => {
    const { player, panel, lines, said } = fold(0, {}, async () => {
      throw new Error('Too few beats were found to tell the tempo: 3')
    })
    player.audio = { path: '/s/song.mp3', url: 'song', offset: 0 }
    panel.find('part-from-recording')!.fire('click')
    await settled()
    assert.deepEqual(lines, [])
    assert.deepEqual(said, ['The tempo was not found, and nothing was written: Too few beats were found to tell the tempo: 3.'])
    assert.equal(panel.find('part-from-recording')!.disabled, false)
  })
})
