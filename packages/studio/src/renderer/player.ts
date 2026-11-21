// Playback in the preview pane (DECISIONS D35): the MIDI of the last compile,
// played by @lily/common's midi.js parser, synthesizer and player (D24) behind
// the transport of the extension's media/player.js, and the notes marked as they
// sound, with a playhead through the system (D26), from preview.js's pure half. The
// main process reads the MIDI and its map together with the pages. The Parts
// fold plays each part on an instrument of its own, louder or softer, or mutes
// it, and ▶ starts from a marked bar (D45, D121). Export MIDI saves the music, without the muted
// parts if the user likes (D54). A score written for a stem has the Stem strip
// above the transport, which plays the stem alone or with the score (D112).
// Piano shows the music falling onto a keyboard, over the editor (D116), or
// as karaoke, with the words (D133). A score's audio track plays along with
// the MIDI, from its offset, at a volume of its own, and the MIDI at the
// score's `% BPM:` to keep with it (D155), which From the recording finds
// with its offset (D159). From the singer marks where a voice's singer in the
// recording parts from the score (D276).
import { formatTime, instrumentName, momentTime, parseMidi, Player, type Midi } from '@lily/common/web/midi.js'
import { barAt, cursorAt, scrollToShow, soundingAt, timelineOf, type Box, type Timeline } from '@lily/common/web/preview.js'
import type { CompileEvent, CompileOutcome, ExportedGarageBand, ExportedMidi, GarageBandPlan, MutedPart, PlaybackSetup, PlaybackTiming } from '../ipc'
import { AudioTrack, DRIFT, SETTLE_MS, type TrackAudio } from './audioTrack'
import { garageBandExported, garageBandPlan, withoutMuted } from './garageBandPlan'
import { hundredths, lineNumber, MAX_AUDIO_OFFSET, MAX_BPM, MIN_BPM, sungTimesFor, type SungLines, type SungUnreadable } from './files'
import type { ScoreMeter, SungFound, SungVoice, TempoFound } from '../ipc'
import { keyOf } from './staff'
import { singerVoices, sungElements, sungMarks, sungStatus, voiceGuard, voiceJson, voiceLinks, voiceNotes, voiceSignature, type SingerVoice, type SungMark } from './sungMismatch'
import { voiceTracks } from './karaoke'
import { barOneAt, barOneTime, bpmAt, scoreMeter, tempoLines, tempoStatus, timeSignatureOf } from './tempo'
import { atTempo, audioVolume, barTime, INSTRUMENT_GROUPS, mixMidi, momentAt, mutedParts, partsOf, partVolume, scoreBpm, withAudio, withEnd, withPart, withPrograms, withStartBar, withSung, type Part, type TimeMap } from './playbackSetup'

/** The music the player has: the score, the MIDI bytes and their map. */
export interface Loaded {
  rootFile: string
  midi: Uint8Array | undefined
  timing: PlaybackTiming | undefined
}

export type PlaybackChange =
  | { kind: 'keep' }
  /** Other music, or none: load it and start from the beginning. */
  | { kind: 'load'; midi: Uint8Array | undefined; timing: PlaybackTiming | undefined }
  /** The same music with its notes elsewhere on the pages: it plays on. */
  | { kind: 'remap'; timing: PlaybackTiming | undefined }

/**
 * What a finished compile does to the music, as in the extension (D24): a run
 * that did not happen keeps it; another score replaces it; a failed run
 * without MIDI keeps it, as it keeps the pages; a good run without `\midi`
 * clears it; the same bytes again play on. The web's engine posts a score's
 * pages before its music (D264): until the music comes the player keeps what
 * it has of that score.
 */
export function playbackChange(outcome: CompileOutcome, loaded: Loaded | undefined): PlaybackChange {
  if (outcome.state !== 'ok' && outcome.state !== 'failed') return { kind: 'keep' }
  if (outcome.performing && loaded?.rootFile === outcome.rootFile) return { kind: 'keep' }
  const { midiData: midi, timing } = outcome
  if (loaded?.rootFile !== outcome.rootFile) return { kind: 'load', midi, timing }
  if (!midi) {
    return outcome.state === 'failed' || !loaded.midi ? { kind: 'keep' } : { kind: 'load', midi: undefined, timing: undefined }
  }
  if (!loaded.midi || !sameBytes(midi, loaded.midi)) return { kind: 'load', midi, timing }
  return JSON.stringify(timing ?? null) === JSON.stringify(loaded.timing ?? null) ? { kind: 'keep' } : { kind: 'remap', timing }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

const NO_MIDI = 'The score has no MIDI: press Add MIDI to hear it'
const SEEK_STEPS = 1000

export interface ScorePlayerOptions {
  /** The transport bar; the player fills it. */
  transport: HTMLElement
  /** The SVG preview: its pages and their elements by `textedit:` link (D32). */
  preview: { pageElements: HTMLCollection; sourceLinks: Map<string, Element[]> }
  /** The preview's scrolling body, scrolled to the system being played. */
  body: HTMLElement
  onError(message: string): void
  /** Add MIDI (D44): puts a `\midi` block in the score, shown while it has none. */
  onAddMidi(): void
  /** Where the Parts fold opens, above the transport (D45). */
  panel: HTMLElement
  /** The setup kept for a score, and keeping it (D45). */
  loadSetup(rootFile: string): Promise<PlaybackSetup | undefined>
  saveSetup(rootFile: string, setup: PlaybackSetup): Promise<void>
  /** Asks where to save the MIDI and writes it (D54); undefined when cancelled. */
  exportMidi(rootFile: string, midi: Uint8Array, muted: MutedPart[]): Promise<ExportedMidi | undefined>
  /**
   * Export for GarageBand (D162): asks where to write `midi` rewritten by
   * `plan`, which keeps the muted parts the panel offers to leave out, with
   * the score's recordings beside it, and writes it; undefined when
   * cancelled. `audioMuted` is the fold's mute of the audio track, which
   * leaves the recording out. Absent where it cannot be exported.
   */
  exportGarageBand?(rootFile: string, midi: Uint8Array, plan: GarageBandPlan, muted: MutedPart[], audioMuted: boolean): Promise<ExportedGarageBand | undefined>
  /** Resolves once the newest compile's music of the score is here (on the web, performed after its page, D264). */
  music?(rootFile: string): Promise<void>
  /** Tells the status line what Export MIDI or Export for GarageBand wrote. */
  onExported(message: string): void
  /** Piano (D116): shows or hides the piano view. */
  onPiano(): void
  /** The music, its state or where it is changed; not called per frame. */
  onPlayback(): void
  /** Where Karaoke starts while shown: the score's `% Start:`, below 0 a silence before the music (D149). */
  karaokeStart?(): number | undefined
  /**
   * Writes the score's own lines (`% Audio:`, `% Audio offset:`, `% BPM:`),
   * or takes out those given undefined (D155).
   */
  setScoreLines?(lines: Record<string, string | undefined>, said?: string): void
  /** Add audio… (D155): asks for a recording to name in the score's `% Audio:` line; absent where none can be chosen. */
  chooseAudio?(): void
  /**
   * From the recording (D159): the tempo and bar 1 of the score's audio
   * track, at the score's tempo and meter; absent where none can be found.
   */
  detectTempo?(meter: ScoreMeter): Promise<TempoFound>
  /** Tells the status line how From the recording went. */
  onStatus?(message: string): void
  /** Whether the music plays, each time that changes (on the web the engine performs at once while it does, D264). */
  onPlaying?(on: boolean): void
  /**
   * From the singer (D276): where the singer of the score's audio track sings
   * `voice`'s notes, from the recording's lead vocals stem; absent where it
   * cannot be heard.
   */
  detectSung?(voice: string, notes: SungVoice): Promise<SungFound>
  /** The score's text as the editor has it, where From the singer finds a voice's music to mark it (D276). */
  scoreText?(rootFile: string): string | undefined
}

/** A comparison of a voice with its singer (D276), kept while the voice's notes are the same. */
interface SingerRun {
  rootFile: string
  voice: string
  track: number
  /** voiceSignature's: the voice's rhythm and pitches when it was compared. */
  signature: string
  marks: SungMark[]
  found: SungFound
}

const SVG = 'http://www.w3.org/2000/svg'

/** The score's audio track as its lines name it (D155). */
export interface ScoreAudio extends TrackAudio {
  /** Its line's offset, in seconds of the music. */
  offset: number
}

/** The score's audio track as it plays (D155): Export Video sums it in at its offset and volume. */
export interface PlayingAudio {
  path: string
  /** Its length, 0 until known. */
  duration: number
  offset: number
  /** Its own, 0–1, without the whole music's. */
  volume: number
  muted: boolean
}

/** What the status line says Export MIDI wrote (D54). */
function exportedMidi(exported: ExportedMidi): string {
  const name = exported.file.split(/[\\/]/).pop()
  return `Exported ${name}${withoutMuted(exported.leftOut)}`
}

export class ScorePlayer {
  private readonly player = new Player({ onChange: () => this.showPlayback() })
  private readonly playButton = document.createElement('button')
  private readonly stopButton = document.createElement('button')
  private readonly seek = document.createElement('input')
  private readonly time = document.createElement('span')
  private readonly bar = document.createElement('span')
  private readonly addButton = document.createElement('button')
  private readonly markChip = document.createElement('button')
  private readonly partsButton = document.createElement('button')
  private readonly pianoButton = document.createElement('button')
  private readonly menu = document.createElement('div')
  private loaded: Loaded | undefined
  private unplayable = ''
  /** Every part silent, while Karaoke sings over a backing track without the melody (D135). */
  private silent = false
  /** The MIDI as parsed, at the score's own tempo. */
  private raw: Midi | undefined
  /** The MIDI at the score's `% BPM:`, on the grid: what From the singer compares (D155, D276). */
  private timed: Midi | undefined
  /**
   * The MIDI at the score's `% BPM:` with each voice at its sung times,
   * before the setup mutes or changes its parts (D155, D276).
   */
  private parsed: Midi | undefined
  /** The time map of each voice at its sung times, by track (D276); the other parts keep the grid. */
  private voiceMaps = new Map<number, TimeMap>()
  /** The sung times `parsed` has, as `sungKey` puts them. */
  private sungPlayed = ''
  /** The score's `% BPM:`, undefined to play the MIDI as written (D155). */
  private tempo: number | undefined
  /** From the recording is listening (D159). */
  private detecting = false
  /** The voice From the singer is listening to (D276). */
  private singing: string | undefined
  /** The last comparison with a singer, while its voice is unchanged (D276). */
  private singer: SingerRun | undefined
  /** The elements of the preview it marked, with the title each was given. */
  private readonly sungMarked = new Map<Element, Element | undefined>()
  /** The score's `% Audio sung` lines (D276), and what the status line last said of them. */
  private sungRead = new Map<string, SungLines | SungUnreadable>()
  private sungSaid = ''
  /** The score's audio track (D155). */
  private readonly track = new AudioTrack({
    onError: (message) => this.options.onError(message),
    // Playback that ends with the recording learns where (D155).
    onDuration: () => {
      if (this.setup.audio?.end === 'audio') this.remix()
    },
  })
  /** How the loaded score is played (D45); the score's setup arrives after its music. */
  private setup: PlaybackSetup = {}
  private setupFor: string | undefined
  private readonly startMark = document.createElement('div')
  /** While the slider is dragged it shows where the drag is, not where the music is. */
  private seeking = false
  /** While Export MIDI's panel is open, another export does not start. */
  private exporting = false
  /** Counts what `seeks` says it counts. */
  private jumps = 0
  /** Whether `onPlaying` last said the music plays. */
  private saidPlaying = false

  // The playhead (D26).
  /** The map resolved against the pages on screen: built when first drawn, dropped by a render. */
  private timeline: Timeline<Element> | null = null
  /** Element → its box in fractions of its page, per page node. */
  private readonly boxes = new WeakMap<Element, Map<Element, Box>>()
  private readonly playhead = document.createElement('div')
  private sounding = new Set<Element>()
  /** The system scrolled into view last; another is scrolled to when the music reaches it. */
  private shownSystem = -1
  private wasPlaying = false
  private frame = 0

  constructor(private readonly options: ScorePlayerOptions) {
    const { transport } = options
    this.playhead.className = 'playhead'
    this.playButton.type = this.stopButton.type = this.addButton.type = 'button'
    this.addButton.className = 'transport-add'
    this.addButton.textContent = 'Add MIDI'
    this.addButton.title = 'Add a \\midi { } block to the score, so it can be played'
    this.addButton.hidden = true
    this.playButton.className = 'transport-play'
    this.stopButton.textContent = '■︎'
    this.stopButton.title = 'Stop'
    this.stopButton.setAttribute('aria-label', 'Stop')
    this.seek.type = 'range'
    this.seek.min = '0'
    this.seek.max = String(SEEK_STEPS)
    this.seek.value = '0'
    this.seek.setAttribute('aria-label', 'Playback position')
    this.time.className = 'transport-time'
    this.bar.className = 'transport-bar'
    transport.setAttribute('role', 'toolbar')
    transport.setAttribute('aria-label', 'Playback')
    this.markChip.type = this.partsButton.type = this.pianoButton.type = 'button'
    this.markChip.className = 'transport-mark'
    this.markChip.hidden = true
    this.partsButton.className = 'transport-parts'
    this.partsButton.textContent = 'Parts'
    this.partsButton.title = 'Instruments, mutes and where playback starts'
    this.partsButton.setAttribute('aria-expanded', 'false')
    this.partsButton.setAttribute('aria-controls', 'playback-setup')
    this.pianoButton.className = 'transport-piano'
    this.pianoButton.textContent = 'Visual'
    this.pianoButton.title = 'Show the music as it plays, on a keyboard or as karaoke, where the source is'
    this.pianoButton.setAttribute('aria-pressed', 'false')
    options.panel.id = 'playback-setup'
    options.panel.hidden = true
    this.startMark.className = 'start-mark'
    this.menu.className = 'preview-menu'
    this.menu.setAttribute('role', 'menu')
    this.menu.hidden = true
    document.body.append(this.menu)
    transport.replaceChildren(this.playButton, this.stopButton, this.addButton, this.seek, this.bar, this.time, this.markChip, this.pianoButton, this.partsButton)

    this.playButton.addEventListener('click', () => this.toggle())
    this.stopButton.addEventListener('click', () => this.stop())
    this.addButton.addEventListener('click', () => options.onAddMidi())
    this.markChip.addEventListener('click', () => this.setStartBar(undefined))
    this.partsButton.addEventListener('click', () => this.showPanel(options.panel.hidden === true))
    this.pianoButton.addEventListener('click', () => options.onPiano())
    options.body.addEventListener('contextmenu', (event) => this.openMenu(event))
    // WebKit gives a clicked button no focus; see the Separate view's menu.
    this.menu.addEventListener('mousedown', (event) => event.preventDefault())
    this.menu.addEventListener('focusout', (event) => {
      if (!this.menu.contains(event.relatedTarget as Node | null)) this.menu.hidden = true
    })
    this.menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.menu.hidden = true
    })
    this.seek.addEventListener('input', () => {
      this.seeking = true
      this.time.textContent = this.times((Number(this.seek.value) / SEEK_STEPS) * this.player.duration)
    })
    this.seek.addEventListener('change', () => {
      this.seeking = false
      this.shownSystem = -1
      void this.seekTo((Number(this.seek.value) / SEEK_STEPS) * this.player.duration)
    })
    this.showPlayback()
  }

  compiled(event: CompileEvent): void {
    if (event.kind !== 'finished') return
    const { outcome } = event
    const change = playbackChange(outcome, this.loaded)
    if (change.kind === 'keep') return
    const { rootFile } = outcome
    if (change.kind === 'remap') {
      this.loaded = { ...this.loaded!, timing: change.timing }
      this.timeline = null
      // Another map can pair the voices with other tracks.
      if (this.sungChanged()) this.resung()
      this.showPlayback()
      this.checkSung()
      return
    }
    this.loaded = { rootFile, midi: change.midi, timing: change.timing }
    this.timeline = null
    this.unplayable = ''
    let midi
    try {
      if (change.midi) midi = parseMidi(change.midi)
    } catch (error) {
      this.unplayable = error instanceof Error ? error.message : String(error)
    }
    this.raw = midi
    this.retime()
    if (this.setupFor !== rootFile) {
      // Another score: its own setup, once the Rust side has it.
      this.setup = {}
      this.setupFor = rootFile
      this.options.loadSetup(rootFile).then(
        (setup) => {
          if (this.setupFor !== rootFile || !setup) return
          this.setup = setup
          this.remix()
        },
        (error: unknown) => console.error('playback setup:', error),
      )
    }
    this.player.load(this.played())
    this.applyVolumes()
    this.checkSung()
    this.fillPanel()
  }

  /** The music as the player plays it: the setup's mix, until the audio track's end when playback ends with it (D155). */
  private played(): Midi | undefined {
    return this.parsed && withEnd(mixMidi(this.parsed, this.setup), this.audioEnd())
  }

  /**
   * Where playback ends, in seconds of the music, when the setup has it end
   * with the audio track: the recording's end, later or earlier than the
   * MIDI's (D155). Undefined to end with the MIDI, or while its length is not known.
   */
  private audioEnd(): number | undefined {
    if (this.setup.audio?.end !== 'audio' || !this.track.file) return undefined
    const { duration, offset } = this.track
    return duration > 0 && offset + duration > 0 ? offset + duration : undefined
  }

  /**
   * The MIDI plays at `bpm` quarter notes a minute from its start, or as
   * written when undefined (D155). The music keeps its place in the score:
   * playing on, it goes on from the same note.
   */
  set bpm(bpm: number | undefined) {
    if (bpm === this.tempo) return
    const before = this.parsed?.duration ?? 0
    this.tempo = bpm
    this.retime()
    const after = this.parsed?.duration ?? 0
    this.remix(before > 0 ? after / before : 1)
  }

  /** The score's `% BPM:`, as it was last set. */
  get bpm(): number | undefined {
    return this.tempo
  }

  /** The score's audio track, from its lines, or none (D155). */
  set audio(audio: ScoreAudio | undefined) {
    // Set again on each edit of the score's text: only a change is shown.
    if (audio?.path === this.track.file && (audio?.offset ?? 0) === this.track.offset) return
    this.track.load(audio)
    this.track.offset = audio?.offset ?? 0
    this.showTrack()
    // Playback that ends with the recording ends elsewhere now.
    if (this.setup.audio?.end === 'audio') this.remix()
    else this.fillPanel()
  }

  /**
   * The score's `% Audio sung` lines (D276), from its text. A voice whose
   * lines are for other notes plays as written, and the status line says so,
   * once for each thing it has to say.
   */
  set sung(read: Map<string, SungLines | SungUnreadable>) {
    this.sungRead = read
    // Set again on each edit of the score's text: only a change is played.
    if (this.sungChanged()) this.resung()
    this.checkSung()
  }

  /**
   * Each voice's sung times for its notes now, by name, or what is wrong with
   * them; the voices with times play at them (D276).
   */
  sungTimes(): Map<string, { track: number; shifts: number[] } | { stale: string }> {
    const result = new Map<string, { track: number; shifts: number[] } | { stale: string }>()
    const raw = this.raw
    if (!raw || this.sungRead.size === 0) return result
    const tracks = voiceTracks(this.loaded?.timing?.staves, raw.tracks)
    for (const [voice, read] of this.sungRead) {
      const track = tracks.get(voice)
      if (track === undefined) {
        result.set(voice, { stale: `the score has no voice ${voice} for its % Audio sung lines` })
        continue
      }
      const times = sungTimesFor(read, voice, voiceGuard(raw, track))
      if (times) result.set(voice, 'stale' in times ? times : { track, shifts: times.shifts })
    }
    return result
  }

  /** The sung times the voices have now, as one string to tell a change by. */
  private sungKey(): string {
    return JSON.stringify([...this.sungTimes().values()].flatMap((times) => ('shifts' in times ? [[times.track, times.shifts]] : [])))
  }

  private sungChanged(): boolean {
    return this.raw !== undefined && this.sungKey() !== this.sungPlayed
  }

  /**
   * The music at the score's `% BPM:` (D155), and then each voice whose sung
   * times fit its notes moved to them, with its own time map (D276).
   */
  private retime(): void {
    this.timed = this.raw && atTempo(this.raw, this.tempo)
    const voices = [...this.sungTimes().values()].flatMap((times) => ('shifts' in times ? [times] : []))
    const sung = this.timed && withSung(this.timed, voices)
    this.parsed = sung?.midi
    this.voiceMaps = sung?.maps ?? new Map()
    this.sungPlayed = this.sungKey()
    this.timeline = null
  }

  /** Plays the voices at their sung times as they are now, from where the music is. */
  private resung(): void {
    this.retime()
    this.remix()
  }

  /** Says what is wrong with the sung lines, when that changed; and drops a comparison whose voice's notes changed. */
  private checkSung(): void {
    const stale = [...this.sungTimes().values()].flatMap((times) => ('stale' in times ? [times.stale] : []))
    const said = stale.join('; ')
    if (said !== this.sungSaid) {
      this.sungSaid = said
      if (said) this.options.onStatus?.(`${said.charAt(0).toUpperCase()}${said.slice(1)}.`)
    }
    const singer = this.singer
    if (singer && (singer.rootFile !== this.setupFor || !this.raw || voiceSignature(this.raw, singer.track) !== singer.signature)) {
      this.singer = undefined
    }
    this.markSinger()
  }

  /** From the singer's button on a voice's part row, and the one that takes its marks off (D276). */
  private singerButtons(track: number, singers: readonly SingerVoice[]): HTMLElement[] {
    const singer = singers.find((candidate) => candidate.track === track)
    if (!singer) return []
    const { voice } = singer
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'part-from-singer'
    button.textContent = this.singing === voice ? 'Listening…' : 'From the singer'
    button.title = singer.shares
      ? `${voice} shares its MIDI track with ${singer.shares}, which has words too: their notes cannot be told apart yet`
      : `Compare ${voice} with its singer in the recording’s vocals stem and mark the notes where they differ. Nothing is written to the score.`
    button.disabled = this.singing !== undefined
    button.addEventListener('click', () => void this.fromSinger(singer))
    if (this.singer?.voice !== voice || this.singer.marks.length === 0) return [button]
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'part-singer-clear'
    clear.textContent = '✕'
    clear.title = `Take the marks of ${voice}’s singer off the preview`
    clear.setAttribute('aria-label', clear.title)
    clear.addEventListener('click', () => {
      this.singer = undefined
      this.markSinger()
      this.fillPanel()
    })
    return [button, clear]
  }

  /**
   * From the singer (D276): compares `voice` with its singer in the audio
   * track's vocals stem and marks the notes where they part; the status line
   * counts them. Nothing is written to the score.
   */
  private async fromSinger({ voice, track, shares }: SingerVoice): Promise<void> {
    const { detectSung, onStatus } = this.options
    // The grid, not the sung times kept: `sung` measures from it.
    const { raw, timed } = this
    const rootFile = this.setupFor
    if (!detectSung || !raw || !timed || !rootFile || this.singing !== undefined) return
    if (shares) {
      onStatus?.(`${voice} was not compared with its singer: it shares its MIDI track with ${shares}, which has words too, and their notes cannot be told apart yet.`)
      return
    }
    const notes = voiceJson(timed, this.loaded?.timing, voice, track, this.tempo ?? scoreBpm(raw), this.track.offset)
    const signature = voiceSignature(raw, track)
    this.singing = voice
    this.fillPanel()
    try {
      const found = await detectSung(voice, notes)
      if (this.setupFor !== rootFile || !this.raw || voiceSignature(this.raw, track) !== signature) {
        onStatus?.(`${voice}'s singer was heard, but nothing is marked: ${this.setupFor === rootFile ? `${voice}'s notes changed meanwhile` : 'another score is shown now'}.`)
        return
      }
      const marks = sungMarks(notes, found, keyOf(voiceNotes(raw, track)))
      this.singer = { rootFile, voice, track, signature, marks, found }
      onStatus?.(sungStatus(voice, marks, found, this.markSinger()))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onStatus?.(`${voice} was not compared with its singer: ${message.replace(/\.?$/, '.')}`)
    } finally {
      this.singing = undefined
      this.fillPanel()
    }
  }

  /**
   * Puts the comparison's marks on the preview's notes of its voice, each
   * with a title that says what differs, and takes the last ones off.
   * Answers how many elements it marked.
   */
  private markSinger(): number {
    for (const [element, title] of this.sungMarked) {
      element.classList.remove('sung-differs')
      element.removeAttribute('data-sung')
      title?.remove()
    }
    this.sungMarked.clear()
    const singer = this.singer
    const timing = this.loaded?.timing
    const text = singer && this.options.scoreText?.(singer.rootFile)
    if (!singer || !timing || !this.timed || text === undefined) return 0
    const { preview } = this.options
    const elements = sungElements(timing, this.timed, singer.track, singer.voice, singer.marks, singer.rootFile, text, preview.sourceLinks)
    for (const [element, mark] of elements) {
      element.classList.add('sung-differs')
      element.setAttribute('data-sung', mark.kinds.join(' '))
      // An SVG element's tooltip is its <title>.
      const title = typeof document.createElementNS === 'function' ? document.createElementNS(SVG, 'title') : undefined
      if (title) {
        title.textContent = mark.title
        element.prepend(title)
      }
      this.sungMarked.set(element, title)
    }
    return elements.size
  }

  /** The score's audio track as it plays, while it has one (D155). */
  get audioTrack(): PlayingAudio | undefined {
    const path = this.track.file
    if (!path) return undefined
    return { path, duration: this.track.duration, offset: this.track.offset, volume: audioVolume(this.setup) / 100, muted: !!this.setup.audio?.muted }
  }

  /** How long playback lasts: the MIDI, or until the audio track's end (D155). */
  get duration(): number {
    return this.player.duration
  }

  /** Every part silent, while Karaoke sings over a backing track without the melody (D135). */
  get silenced(): boolean {
    return this.silent
  }

  /**
   * The music Export Video renders (D155): the parts of `tracks` on their
   * instruments at their volumes, muted or silenced or not, until where
   * playback ends; undefined without music.
   */
  videoMelody(tracks: ReadonlySet<number>): { midi: Midi; volumes: Map<number, number> } | undefined {
    if (!this.parsed) return undefined
    const parts: NonNullable<PlaybackSetup['parts']> = {}
    for (const [track, part] of Object.entries(this.setup.parts ?? {})) {
      const { muted: _, ...rest } = part
      parts[track] = rest
    }
    const mixed = mixMidi(this.parsed, { parts })
    const midi = withEnd({ ...mixed, notes: mixed.notes.filter((note) => tracks.has(note.track)) }, this.audioEnd())
    const volumes = new Map(this.parsed.tracks.map((_, track) => [track, tracks.has(track) ? partVolume(this.setup, track) / 100 : 0]))
    return { midi, volumes }
  }

  /** Stops the music; the score it belongs to left the preview (D39). */
  stop(): void {
    this.jumps++
    this.player.stop()
  }

  /** Moves the music where the user sent it. */
  private seekTo(seconds: number): Promise<void> {
    this.jumps++
    return this.player.seek(seconds)
  }

  toggle(): void {
    if (this.player.state === 'playing') this.player.pause()
    else void this.play()
  }

  /** Whether there is music to play. */
  get ready(): boolean {
    return this.player.midi !== undefined
  }

  get playing(): boolean {
    return this.player.state === 'playing'
  }

  /** The music as it plays, without the muted parts. */
  get midi(): Midi | undefined {
    return this.player.midi
  }

  /** The music with its muted parts, as the score has it, and its voices at their sung times (D276). */
  get score(): Midi | undefined {
    return this.parsed
  }

  /** The time map of each voice that plays at its sung times, by track (D276). */
  get voiceTimes(): ReadonlyMap<number, TimeMap> {
    return this.voiceMaps
  }

  /** The tracks the Parts fold mutes, which the piano view still shows (D153). */
  get muted(): ReadonlySet<number> {
    const parts = this.setup.parts ?? {}
    return new Set(Object.keys(parts).map(Number).filter((track) => parts[track]?.muted))
  }

  /** Where the music's notes and words are (D26, D133). */
  get timing(): PlaybackTiming | undefined {
    return this.loaded?.timing
  }

  /** The score the music is of. */
  get rootFile(): string | undefined {
    return this.loaded?.rootFile
  }

  /** The parts of the music, muted or not, named as the Parts fold names them. */
  get parts(): Part[] {
    return this.parsed ? partsOf(this.parsed, this.loaded?.timing?.staves) : []
  }

  /** Where the music is as it is heard (D51). */
  get position(): number {
    return this.player.position
  }

  /**
   * Where the music is on the audio clock, ahead of what is heard by the
   * output's latency: what a recording's `currentTime` is to be, as it goes
   * out through the same device (D135).
   */
  get scheduled(): number {
    return this.player.scheduled
  }

  /**
   * How many times the user has sent the music somewhere: a seek, a start mark,
   * a bar's Play from, ■. A seek during playback tells `onPlayback` nothing but
   * the new place, so a recording that follows the score learns of it here.
   */
  get seeks(): number {
    return this.jumps
  }

  /** Each track's volume as heard: its part's (D121), or none while silenced (D135). */
  get volumes(): Map<number, number> {
    return new Map(this.parsed?.tracks.map((_, track) => [track, this.silent ? 0 : partVolume(this.setup, track) / 100]))
  }

  /** Moves the music by `seconds`, within it, playing on if it played (D154); back as far as Karaoke's silence (D149). */
  seekBy(seconds: number): void {
    if (!this.player.midi) return
    const earliest = Math.min(this.options.karaokeStart?.() ?? 0, 0)
    void this.seekTo(Math.min(Math.max(this.player.position + seconds, earliest), this.player.duration))
  }

  /** The whole music's volume, 0–1 (D154): the audio track's too. */
  set volume(volume: number) {
    this.player.setVolume(volume)
    this.track.masterVolume = volume
  }

  /** Marks Piano pressed while the piano view is shown. */
  pianoShown(shown: boolean): void {
    this.pianoButton.setAttribute('aria-pressed', String(shown))
  }

  pause(): void {
    this.player.pause()
  }

  /** Other pages are on screen: the playhead is found on them again. */
  rendered(): void {
    this.timeline = null
    this.refresh()
    this.markSinger()
  }

  /** Draws the playhead and the start mark again after the pages moved or were shown, unless a frame will. */
  refresh(): void {
    if (this.player.state !== 'playing') this.drawPlayhead()
    this.drawStartMark()
  }

  /**
   * Export MIDI (D54): the bytes of the newest compile, once its music is here
   * (D264), each part on the instrument the Parts fold chose, offering to
   * leave out the parts the setup mutes.
   */
  async exportMidi(): Promise<void> {
    // The fold's instruments go into the file.
    await this.export(exportedMidi, (loaded, midi, muted) => this.options.exportMidi(loaded.rootFile, withPrograms(midi, this.setup), muted))
  }

  /**
   * Export for GarageBand (D162): the bytes of the last compile, rewritten by
   * garageBandPlan for the parts, the fold's instruments, `% BPM:` and the
   * lead-in after a pickup, offering to leave out the parts the setup mutes
   * as Export MIDI does, and the recording too when the fold mutes it.
   */
  async exportGarageBand(): Promise<void> {
    const { exportGarageBand } = this.options
    if (!exportGarageBand) return
    await this.export(garageBandExported, (loaded, midi, muted, raw) => {
      const plan = garageBandPlan({
        midi: raw,
        staves: loaded.timing?.staves,
        bars: loaded.timing?.bars ?? [],
        meter: timeSignatureOf(midi),
        bpm: this.tempo,
        setup: this.setup,
        // The panel's checkbox chooses; the Rust side leaves them out of the plan.
        leaveOutMuted: false,
      })
      return exportGarageBand(loaded.rootFile, midi, plan, muted, !!this.setup.audio?.muted)
    })
  }

  /** Runs an export of the last compile's MIDI and says what it wrote, as `said` puts it. */
  private async export<T extends ExportedMidi>(
    said: (exported: T) => string,
    run: (loaded: Loaded, midi: Uint8Array, muted: MutedPart[], raw: Midi) => Promise<T | undefined>,
  ): Promise<void> {
    if (this.exporting) return
    this.exporting = true
    this.fillPanel()
    try {
      // On the web the music comes after the page (D264): wait for the newest compile's.
      if (this.loaded) await this.options.music?.(this.loaded.rootFile)
      const { loaded, raw, parsed } = this
      if (!loaded?.midi || !parsed || !raw) {
        this.options.onError(this.unplayable ? `The MIDI cannot be exported: ${this.unplayable}` : 'The score has no MIDI to export: press Add MIDI first')
        return
      }
      const muted = mutedParts(partsOf(parsed, loaded.timing?.staves), this.setup)
      const exported = await run(loaded, loaded.midi, muted, raw)
      if (!exported) return
      this.options.onExported(said(exported))
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : String(error))
    } finally {
      this.exporting = false
      this.fillPanel()
    }
  }

  /** Plays from where it is, or when stopped from the start mark, else Karaoke's start. */
  async play(): Promise<void> {
    if (!this.player.midi) return
    // From the start means from the start mark.
    const start = this.player.state === 'stopped' ? (this.startTime() ?? this.options.karaokeStart?.()) : undefined
    if (start !== undefined) await this.seekTo(start)
    // Play is a click, which lets the page make sound; this is a device that failed.
    if (!(await this.player.play()) && this.player.suspended) this.options.onError('The sound could not be started.')
  }

  private times(position: number): string {
    return `${formatTime(position)} / ${formatTime(this.player.duration)}`
  }

  private showPlayback(): void {
    const { state, position, duration } = this.player
    const playing = state === 'playing'
    const ready = this.player.midi !== undefined
    this.playButton.disabled = this.stopButton.disabled = this.seek.disabled = !ready
    setText(this.playButton, playing ? '❚❚' : '▶︎')
    this.playButton.title = ready ? (playing ? 'Pause (Space)' : 'Play (Space)') : this.unplayable || NO_MIDI
    this.playButton.setAttribute('aria-label', ready && playing ? 'Pause' : 'Play')
    setText(this.time, ready ? this.times(position) : '')
    if (!this.seeking) this.seek.value = String(duration > 0 ? Math.round((position / duration) * SEEK_STEPS) : 0)
    this.options.transport.dataset.state = ready ? state : 'empty'
    if (playing !== this.saidPlaying) {
      this.saidPlaying = playing
      this.options.onPlaying?.(playing)
    }
    this.partsButton.disabled = !ready
    if (!ready && !this.options.panel.hidden) this.showPanel(false)
    // Only once a compile has shown that the score has no MIDI, not before the first.
    this.addButton.hidden = ready || !this.loaded || !!this.unplayable

    // The playhead follows the audio clock frame by frame while playing.
    if (playing) {
      if (!this.wasPlaying) this.shownSystem = -1 // wherever the user scrolled to, show where it starts
      if (!this.frame) this.frame = requestAnimationFrame(() => this.animate())
    } else this.drawPlayhead()
    this.wasPlaying = playing
    this.track.follow(this.player.clock, this.player.latency, playing, this.jumps)
    this.options.onPlayback()
  }

  private animate(): void {
    this.frame = 0
    this.drawPlayhead()
    if (this.player.state === 'playing') this.frame = requestAnimationFrame(() => this.animate())
  }

  /** The map's events found on the pages; null while there is nothing to find them on. */
  private buildTimeline(): Timeline<Element> | null {
    const { midi } = this.player
    const timing = this.loaded?.timing
    const pages = [...this.options.preview.pageElements]
    if (!timing || !midi || pages.length === 0) return null
    const rects = pages.map((page) => page.getBoundingClientRect())
    // Behind the PDF tab the pages have no size; measure them once they are shown.
    if (rects[0].width === 0) return null
    const indexes = new Map(pages.map((page, index) => [page, index]))
    const box = (element: Element): Box | undefined => {
      const page = element.closest('.preview-page')
      const index = page ? indexes.get(page) : undefined
      if (!page || index === undefined) return undefined
      let cache = this.boxes.get(page)
      if (!cache) this.boxes.set(page, (cache = new Map()))
      let found = cache.get(element)
      if (!found) {
        const rect = rects[index]
        const r = element.getBoundingClientRect()
        found = {
          page: index,
          left: (r.left - rect.left) / rect.width,
          right: (r.right - rect.left) / rect.width,
          top: (r.top - rect.top) / rect.height,
          bottom: (r.bottom - rect.top) / rect.height,
        }
        cache.set(element, found)
      }
      return found
    }
    const sung = this.sungLinks(timing)
    return timelineOf(timing, midi.duration, this.options.preview.sourceLinks, box, (at, grace, href) => {
      const time = momentTime(midi, at, grace)
      const map = href === undefined ? undefined : sung.find(({ inVoice }) => inVoice(href))?.map
      return map ? map(time) : time
    })
  }

  /**
   * Each voice at its sung times with its time map and whether an event of
   * the map is its (D276): its note heads light, and the playhead passes
   * them, when it sings them. A voice whose music is in another file is not
   * found, and its note heads keep the grid; its sound and words do not.
   */
  private sungLinks(timing: PlaybackTiming): { map: TimeMap; inVoice: (href: string) => boolean }[] {
    const rootFile = this.loaded?.rootFile
    const text = rootFile === undefined || this.voiceMaps.size === 0 ? undefined : this.options.scoreText?.(rootFile)
    if (text === undefined || !rootFile) return []
    const tracks = this.raw ? voiceTracks(timing.staves, this.raw.tracks) : new Map<string, number>()
    return [...this.sungRead.keys()].flatMap((voice) => {
      const map = this.voiceMaps.get(tracks.get(voice) ?? -1)
      const inVoice = map && voiceLinks(timing, voice, rootFile, text)
      return map && inVoice ? [{ map, inVoice }] : []
    })
  }

  /** Marks what sounds now and puts the playhead through it; clears both when stopped. */
  private drawPlayhead(): void {
    // Nothing is measured while nothing plays: a render is not to cost a frame.
    const active = this.player.state !== 'stopped'
    if (active && !this.timeline) this.timeline = this.buildTimeline()
    const line = active ? this.timeline : null
    const time = this.player.position
    const cursor = line ? cursorAt(line.moments, time) : undefined
    const next = new Set<Element>()
    if (line && cursor) {
      for (const i of soundingAt(line.events, line.ends, time)) {
        const element = line.events[i].element
        if (element) next.add(element)
      }
    }
    for (const element of this.sounding) if (!next.has(element)) element.classList.remove('playing')
    for (const element of next) if (!this.sounding.has(element)) element.classList.add('playing')
    this.sounding = next
    const moment = line && cursor ? line.moments[cursor.index] : undefined
    const system = moment && line!.systems[moment.system]
    const page = system && (this.options.preview.pageElements[system.page] as HTMLElement | undefined)
    if (!page || !cursor || !moment || !system) {
      this.playhead.remove()
      this.shownSystem = -1
      this.showBar(undefined)
      return
    }
    if (this.playhead.parentNode !== page) page.append(this.playhead)
    const { clientWidth, clientHeight } = page
    this.playhead.style.left = `${cursor.x * clientWidth}px`
    this.playhead.style.top = `${system.top * clientHeight}px`
    this.playhead.style.height = `${(system.bottom - system.top) * clientHeight}px`
    this.showBar(barAt(line!.bars, time))
    if (moment.system !== this.shownSystem && !this.seeking) {
      this.shownSystem = moment.system
      this.follow(page, cursor.x, system)
    }
  }

  // ---- the playback setup (D45) ----

  /**
   * Plays the music as the setup now has it, from where it is; `stretch`
   * times as far in when the music was made longer (D155).
   */
  private remix(stretch = 1): void {
    // From what the audio clock reached: what was rendered before still sounds.
    const { state, starting } = this.player
    const position = this.player.scheduled * stretch
    const playing = state === 'playing' || starting
    this.player.load(this.played())
    this.applyVolumes()
    this.fillPanel()
    this.drawStartMark()
    if ((state === 'stopped' && !playing) || !this.player.midi) return
    // Not a seek of the user's. load() reported a stop, which paused a linked
    // recording, and starting again puts it back at once.
    void this.player.seek(position).then(() => (playing ? this.play() : undefined))
  }

  /** Every track at the volume the setup gives its part (D121); the player keeps them across loads. */
  private applyVolumes(): void {
    this.parsed?.tracks.forEach((_, track) => this.setVolume(track, partVolume(this.setup, track)))
    this.showTrack()
  }

  /** The audio track at its volume and mute (D155); Karaoke's silence is the parts', not its. */
  private showTrack(): void {
    this.track.volume = audioVolume(this.setup) / 100
    this.track.muted = !!this.setup.audio?.muted
  }

  /** A track at this percentage, or at none while the parts are silenced (D135). */
  private setVolume(track: number, percent: number): void {
    this.player.setTrackVolume(track, this.silent ? 0 : percent / 100)
  }

  /** Silences every part, or gives them their volumes back, at once (D135). */
  silence(silent: boolean): void {
    if (silent === this.silent) return
    this.silent = silent
    this.applyVolumes()
  }

  private changeSetup(setup: PlaybackSetup): void {
    this.setup = setup
    const rootFile = this.setupFor
    if (rootFile) this.options.saveSetup(rootFile, setup).catch((error: unknown) => this.options.onError(error instanceof Error ? error.message : String(error)))
  }

  private setStartBar(bar: number | undefined): void {
    this.changeSetup(withStartBar(this.setup, bar))
    this.fillPanel()
    this.drawStartMark()
  }

  /** The bars of the music with their times; empty without a map. */
  private bars(): { time: number; number: number }[] {
    const timing = this.loaded?.timing
    const midi = this.player.midi
    if (!timing || !midi) return []
    return timing.bars.map(({ at, number }) => ({ time: momentTime(midi, at), number })).sort((a, b) => a.time - b.time)
  }

  /** When the start bar begins; undefined without one, or when the music has no such bar. */
  private startTime(): number | undefined {
    const bar = this.setup.startBar
    return bar === undefined ? undefined : barTime(this.bars(), bar)
  }

  private showPanel(open: boolean): void {
    this.options.panel.hidden = !open
    this.partsButton.setAttribute('aria-expanded', String(open))
    if (open) this.fillPanel()
  }

  /** The start mark's chip in the transport, and the fold's rows when it is open. */
  private fillPanel(): void {
    const bar = this.setup.startBar
    const valid = bar !== undefined && this.startTime() !== undefined
    this.markChip.hidden = bar === undefined || !this.player.midi
    this.markChip.textContent = `from bar ${bar} ✕`
    this.markChip.classList.toggle('invalid', !valid)
    this.markChip.title = valid ? 'Playback starts at this bar. Click to start from the beginning again.' : `The score has no bar ${bar}: playback starts from the beginning. Click to clear.`
    const { panel } = this.options
    if (panel.hidden) return
    const midi = this.parsed
    if (!midi) {
      panel.replaceChildren(paragraph('The score has no MIDI to play.'))
      return
    }
    const singers = this.track.file && this.options.detectSung ? singerVoices(this.loaded?.timing, midi) : []
    const rows = partsOf(midi, this.loaded?.timing?.staves).map((part) => {
      const setting = this.setup.parts?.[part.track] ?? {}
      const row = document.createElement('div')
      row.className = 'part'
      row.classList.toggle('muted', !!setting.muted)
      const mute = document.createElement('button')
      mute.type = 'button'
      mute.className = 'part-mute'
      mute.textContent = setting.muted ? 'Muted' : 'On'
      mute.setAttribute('aria-pressed', String(!!setting.muted))
      mute.title = setting.muted ? `Play ${part.name} again` : `Mute ${part.name}`
      mute.addEventListener('click', () => {
        this.changeSetup(withPart(this.setup, part.track, { muted: !setting.muted }))
        this.remix()
      })
      const label = document.createElement('span')
      label.className = 'part-name'
      label.textContent = part.name
      label.title = `Part ${part.number}, written for ${part.written}`
      const select = document.createElement('select')
      select.setAttribute('aria-label', `Instrument of ${part.name}`)
      select.append(new Option(part.drums ? 'Drums' : `As written (${part.written})`, ''))
      for (const group of INSTRUMENT_GROUPS) {
        const optgroup = document.createElement('optgroup')
        optgroup.label = group.label
        for (const instrument of group.instruments) optgroup.append(new Option(instrument.label, String(instrument.program)))
        select.append(optgroup)
      }
      if (setting.program !== undefined && !select.querySelector(`option[value="${setting.program}"]`)) {
        select.append(new Option(instrumentName(setting.program), String(setting.program)))
      }
      select.value = setting.program === undefined ? '' : String(setting.program)
      // A drum kit has no pitches to play on another instrument.
      select.disabled = part.drums
      select.addEventListener('change', () => {
        this.changeSetup(withPart(this.setup, part.track, { program: select.value === '' ? null : Number(select.value) }))
        this.remix()
      })
      // Heard as it is dragged, saved when let go; a double-click is 100 % again.
      const volume = document.createElement('input')
      volume.type = 'range'
      volume.className = 'part-volume'
      volume.min = '0'
      volume.max = '200'
      volume.step = '5'
      volume.value = String(partVolume(this.setup, part.track))
      volume.setAttribute('aria-label', `Volume of ${part.name}`)
      const percent = document.createElement('span')
      percent.className = 'part-volume-value'
      const showVolume = () => {
        percent.textContent = `${volume.value} %`
        volume.title = `${part.name} at ${volume.value} %. Double-click for 100 %.`
      }
      showVolume()
      volume.addEventListener('input', () => {
        this.setVolume(part.track, Number(volume.value))
        showVolume()
      })
      // Not by filling the fold again: the slider keeps the focus for the arrow keys.
      const saveVolume = () => {
        this.changeSetup(withPart(this.setup, part.track, { volume: Number(volume.value) }))
        const reset = this.options.panel.querySelector<HTMLButtonElement>('.part-reset')
        if (reset) reset.disabled = Object.keys(this.setup).length === 0
      }
      volume.addEventListener('change', saveVolume)
      volume.addEventListener('dblclick', () => {
        volume.value = '100'
        this.setVolume(part.track, 100)
        saveVolume()
      })
      row.append(mute, label, select, volume, percent)
      row.append(...this.singerButtons(part.track, singers))
      return row
    })

    const start = document.createElement('div')
    start.className = 'part start'
    const startLabel = document.createElement('label')
    startLabel.className = 'part-name'
    startLabel.textContent = 'Start at bar'
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '1'
    input.step = '1'
    input.placeholder = '1'
    input.value = bar === undefined ? '' : String(bar)
    input.id = 'playback-start-bar'
    startLabel.htmlFor = input.id
    input.addEventListener('change', () => {
      const value = Math.floor(Number(input.value))
      this.setStartBar(input.value.trim() !== '' && value > 1 ? value : undefined)
    })
    const hasBars = this.bars().length > 0
    input.disabled = !hasBars
    const hint = document.createElement('span')
    hint.className = 'part-hint'
    hint.textContent = hasBars ? 'or right-click a bar in the SVG preview' : 'the score has no bar map'
    start.append(startLabel, input, hint)

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'part-reset'
    reset.textContent = 'Play as written'
    reset.title = 'Every part on its own instrument at its own volume, none muted, from the beginning'
    reset.disabled = Object.keys(this.setup).length === 0
    reset.addEventListener('click', () => {
      this.changeSetup({})
      this.remix()
    })
    const exportButton = document.createElement('button')
    exportButton.type = 'button'
    exportButton.className = 'part-export'
    exportButton.textContent = 'Export MIDI…'
    exportButton.title = 'Save the music as a MIDI file, with or without the muted parts'
    exportButton.disabled = this.exporting
    exportButton.addEventListener('click', () => void this.exportMidi())
    const actions = document.createElement('div')
    actions.className = 'part-actions'
    actions.append(reset, exportButton)
    panel.replaceChildren(...rows, ...this.audioRows(), start, this.tempoRow(midi), actions)
  }

  /** The audio track's row in the Parts fold, or Add audio… without one (D155). */
  private audioRows(): HTMLElement[] {
    const file = this.track.file
    const { chooseAudio, setScoreLines } = this.options
    const row = document.createElement('div')
    row.className = 'part audio'
    if (!file) {
      if (!chooseAudio) return []
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'part-add-audio'
      add.textContent = 'Add audio…'
      add.title = 'A recording to play along with the score, as a track of its own'
      add.addEventListener('click', () => chooseAudio())
      const hint = document.createElement('span')
      hint.className = 'part-hint'
      hint.textContent = 'a recording played along with the music'
      row.append(add, hint)
      return [row]
    }
    const muted = !!this.setup.audio?.muted
    const name = file.split(/[\\/]/).pop() ?? file
    row.classList.toggle('muted', muted)
    const mute = document.createElement('button')
    mute.type = 'button'
    mute.className = 'part-mute'
    mute.textContent = muted ? 'Muted' : 'On'
    mute.setAttribute('aria-pressed', String(muted))
    mute.title = muted ? `Play ${name} again` : `Mute ${name}`
    mute.addEventListener('click', () => {
      this.changeSetup(withAudio(this.setup, { muted: !muted }))
      this.showTrack()
      this.fillPanel()
    })
    const label = document.createElement('span')
    label.className = 'part-name'
    label.textContent = `Audio · ${name}`
    label.title = `${file}, played along with the music`
    // When it starts, in seconds of the music, to the hundredth; written to the score.
    const offsetLabel = document.createElement('label')
    offsetLabel.className = 'part-offset'
    offsetLabel.title = 'When the recording starts in the music, in seconds: later for more, already playing at the start for less than 0'
    const offset = document.createElement('input')
    offset.className = 'part-offset-value'
    offset.type = 'number'
    offset.step = '0.01'
    offset.min = String(-MAX_AUDIO_OFFSET)
    offset.max = String(MAX_AUDIO_OFFSET)
    offset.placeholder = '0'
    offset.value = this.track.offset === 0 ? '' : lineNumber(this.track.offset)
    offset.setAttribute('aria-label', `When ${name} starts, in seconds`)
    offset.disabled = !setScoreLines
    offset.addEventListener('change', () => {
      const value = Number(offset.value)
      const seconds = offset.value.trim() === '' || !Number.isFinite(value) ? 0 : hundredths(Math.min(Math.max(value, -MAX_AUDIO_OFFSET), MAX_AUDIO_OFFSET))
      setScoreLines?.({ 'Audio offset': seconds === 0 ? undefined : lineNumber(seconds) })
    })
    offsetLabel.append('Starts at ', offset, ' s')
    // Heard as it is dragged, saved when let go; a double-click is 100 % again.
    const volume = document.createElement('input')
    volume.type = 'range'
    volume.className = 'part-volume'
    volume.min = '0'
    volume.max = '100'
    volume.step = '5'
    volume.value = String(audioVolume(this.setup))
    volume.setAttribute('aria-label', `Volume of ${name}`)
    const percent = document.createElement('span')
    percent.className = 'part-volume-value'
    const showVolume = () => {
      percent.textContent = `${volume.value} %`
      volume.title = `${name} at ${volume.value} %. Double-click for 100 %.`
    }
    showVolume()
    volume.addEventListener('input', () => {
      this.track.volume = Number(volume.value) / 100
      showVolume()
    })
    const saveVolume = () => {
      this.changeSetup(withAudio(this.setup, { volume: Number(volume.value) }))
      this.showTrack()
      const reset = this.options.panel.querySelector<HTMLButtonElement>('.part-reset')
      if (reset) reset.disabled = Object.keys(this.setup).length === 0
    }
    volume.addEventListener('change', saveVolume)
    volume.addEventListener('dblclick', () => {
      volume.value = '100'
      showVolume()
      saveVolume()
    })
    // Playback ends with the MIDI, or with the recording, before or after it.
    const end = document.createElement('select')
    end.className = 'part-end'
    end.setAttribute('aria-label', 'Where playback ends')
    end.title = 'Playback stops where the score’s MIDI ends, or where the recording ends'
    end.append(new Option('Ends with the MIDI', 'midi'), new Option('Ends with the audio', 'audio'))
    end.value = this.setup.audio?.end === 'audio' ? 'audio' : 'midi'
    end.addEventListener('change', () => {
      this.changeSetup(withAudio(this.setup, { end: end.value === 'audio' ? 'audio' : 'midi' }))
      this.remix()
    })
    row.append(mute, label, offsetLabel, end, volume, percent)
    if (setScoreLines) {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'part-remove'
      remove.textContent = '✕'
      remove.title = `Take ${name} out of the score; the file stays where it is`
      remove.setAttribute('aria-label', `Remove the audio track ${name}`)
      remove.addEventListener('click', () => setScoreLines({ Audio: undefined, 'Audio offset': undefined }))
      row.append(remove)
    }
    return [row]
  }

  /** The tempo the MIDI plays at, written to the score's `% BPM:` (D155). */
  private tempoRow(midi: Midi): HTMLElement {
    const { setScoreLines } = this.options
    const written = this.raw ? scoreBpm(this.raw) : scoreBpm(midi)
    const row = document.createElement('div')
    row.className = 'part tempo'
    const label = document.createElement('label')
    label.className = 'part-name'
    label.textContent = 'Tempo, ♩ a minute'
    const input = document.createElement('input')
    input.className = 'part-bpm'
    input.type = 'number'
    input.step = '0.01'
    input.min = String(MIN_BPM)
    input.max = String(MAX_BPM)
    input.placeholder = lineNumber(written)
    input.value = this.tempo === undefined ? '' : lineNumber(this.tempo)
    input.id = 'playback-bpm'
    label.htmlFor = input.id
    input.disabled = !setScoreLines
    input.addEventListener('change', () => {
      const value = hundredths(Number(input.value))
      const bpm = input.value.trim() === '' || !(value >= MIN_BPM && value <= MAX_BPM) || value === written ? undefined : value
      if (bpm === undefined) input.value = ''
      setScoreLines?.({ BPM: bpm === undefined ? undefined : lineNumber(bpm) })
    })
    const hint = document.createElement('span')
    hint.className = 'part-hint'
    hint.textContent = this.tempo === undefined ? `as written, ♩ = ${lineNumber(written)}` : `written at ♩ = ${lineNumber(written)}: the MIDI plays ${lineNumber(this.tempo / written)}× as fast`
    row.append(label, input, hint)
    // From the recording (D159): only a recording attached can be listened to.
    if (this.track.file && this.options.detectTempo && setScoreLines) {
      const detect = document.createElement('button')
      detect.type = 'button'
      detect.className = 'part-from-recording'
      detect.textContent = this.detecting ? 'Listening…' : 'From the recording'
      detect.title = 'Find the recording’s tempo and its bar 1, and write them to the score’s % BPM: and % Audio offset:'
      detect.disabled = this.detecting
      detect.addEventListener('click', () => void this.fromRecording())
      row.append(detect)
    }
    return row
  }

  /**
   * From the recording (D159): writes the tempo found in the audio track and
   * the offset that puts the score's bar 1 on the recording's, as one
   * undoable edit; nothing when none was found, and the status line says why.
   */
  private async fromRecording(): Promise<void> {
    const { detectTempo, setScoreLines, onStatus } = this.options
    const raw = this.raw
    const rootFile = this.setupFor
    if (!detectTempo || !setScoreLines || !raw || this.detecting) return
    const bars = this.loaded?.timing?.bars ?? []
    // The tempo bar 1 is played at chooses the level; `% BPM:` is the first's.
    const tempos = { first: scoreBpm(raw), main: bpmAt(raw, barOneTime(bars, raw)) }
    const signature = timeSignatureOf(this.loaded?.midi)
    const meter = scoreMeter(tempos.main, signature)
    this.detecting = true
    this.fillPanel()
    try {
      const found = await detectTempo(meter)
      // Another score was opened meanwhile: this one's lines are not its.
      if (this.setupFor !== rootFile) {
        onStatus?.('The tempo found was not written: another score is shown now.')
        return
      }
      setScoreLines(tempoLines(found, tempos, barOneAt(bars, raw)), tempoStatus(found, meter, signature))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      onStatus?.(`The tempo was not found, and nothing was written: ${message.replace(/\.?$/, '.')}`)
    } finally {
      this.detecting = false
      this.fillPanel()
    }
  }

  /** Right-click on the pages: start playback at the bar under the pointer. */
  private openMenu(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest('.preview-page') : null
    if (!target || !this.player.midi) return
    const pages = [...this.options.preview.pageElements]
    const page = pages.indexOf(target)
    this.timeline ??= this.buildTimeline()
    const line = this.timeline
    if (page < 0 || !line) return
    const rect = target.getBoundingClientRect()
    const moment = momentAt(line, page, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
    const bar = moment && barAt(line.bars, moment.time)
    if (bar === undefined) return
    event.preventDefault()
    const item = (label: string, action: () => void) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = label
      button.addEventListener('click', () => {
        this.menu.hidden = true
        action()
      })
      return button
    }
    const items = [
      item(`Play from bar ${bar}`, () => {
        this.setStartBar(bar)
        const time = this.startTime()
        if (time !== undefined) void this.seekTo(time).then(() => this.play())
      }),
      item(`Start playback at bar ${bar}`, () => this.setStartBar(bar)),
    ]
    if (this.setup.startBar !== undefined) items.push(item('Start from the beginning', () => this.setStartBar(undefined)))
    this.menu.replaceChildren(...items)
    this.menu.hidden = false
    const { innerWidth, innerHeight } = window
    this.menu.style.left = `${Math.min(event.clientX, innerWidth - this.menu.offsetWidth - 4)}px`
    this.menu.style.top = `${Math.min(event.clientY, innerHeight - this.menu.offsetHeight - 4)}px`
    items[0].focus()
  }

  /** A flag on the pages where playback starts; only measured while there is a mark. */
  private drawStartMark(): void {
    const time = this.startTime()
    if (time === undefined || !this.options.preview.pageElements.length) {
      this.startMark.remove()
      return
    }
    this.timeline ??= this.buildTimeline()
    const line = this.timeline
    const cursor = line ? cursorAt(line.moments, time) : undefined
    const moment = cursor && line!.moments[cursor.index]
    const system = moment && line!.systems[moment.system]
    const page = system && (this.options.preview.pageElements[system.page] as HTMLElement | undefined)
    if (!page || !cursor || !system) {
      this.startMark.remove()
      return
    }
    if (this.startMark.parentNode !== page) page.append(this.startMark)
    const { clientWidth, clientHeight } = page
    this.startMark.dataset.bar = String(this.setup.startBar)
    this.startMark.title = `Playback starts at bar ${this.setup.startBar}`
    this.startMark.style.left = `${cursor.x * clientWidth}px`
    this.startMark.style.top = `${system.top * clientHeight}px`
    this.startMark.style.height = `${(system.bottom - system.top) * clientHeight}px`
  }

  private showBar(number: number | undefined): void {
    const text = number === undefined ? '' : `bar ${number}`
    if (this.bar.textContent !== text) this.bar.textContent = text
  }

  /** Scrolls the playhead into view when it is not, as a click-to-source reveal would. */
  private follow(page: HTMLElement, x: number, system: { top: number; bottom: number }): void {
    const { body } = this.options
    const view = body.getBoundingClientRect()
    const rect = page.getBoundingClientRect()
    const dx = scrollToShow(rect.left - view.left + x * rect.width - 8, 16, body.clientWidth)
    const dy = scrollToShow(rect.top - view.top + system.top * rect.height, (system.bottom - system.top) * rect.height, body.clientHeight)
    if (dx !== 0 || dy !== 0) body.scrollBy(dx, dy)
  }
}

function paragraph(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'part-hint'
  p.textContent = text
  return p
}

/** What the Stem strip plays the stem with: the score's player. */
export interface StripScore {
  readonly ready: boolean
  readonly playing: boolean
  /** Where the music is on the audio clock (D135); below 0 in Karaoke's silence before the music (D149). */
  readonly scheduled: number
  /** Goes up each time the user sends the music somewhere. */
  readonly seeks: number
  play(): Promise<void>
  pause(): void
}

/** A recording the strip plays: the stem, or the backing track to sing over (D133). */
export interface StripAudio {
  path: string
  url: string
  /** What the strip's choice calls it: "Stem", "Backing", "Music". */
  label: string
}

export interface StemStripOptions {
  /** The strip above the transport; shown while the score has a stem. */
  host: HTMLElement
  score: StripScore
  onError(message: string): void
  /** What it plays, or whether it follows the score, changed. */
  onChange?(): void
}

/**
 * The Stem strip (D112): the stem a score was written from, played under the
 * preview so the part can be written by ear. With score plays the score's MIDI
 * with it, each from where it is: the stem from the slider, the score from
 * where it was paused or its start mark. Pause pauses both, so they stay
 * together; moving the slider moves the stem alone; a seek of the transport
 * during playback takes it along, as far from the score as it was, and one
 * while paused moves the score alone. A score with a backing track too has a
 * choice between the two, which keeps the place (D133).
 * A backing track, or the music alone, starts linked for as long as its score
 * is shown, and keeps to the score's place, put back when it strays (D135),
 * until the slider moves it; the next seek or ■ of the transport brings it back.
 */
export class StemStrip {
  private readonly audio = document.createElement('audio')
  private readonly name = document.createElement('span')
  private readonly playButton = document.createElement('button')
  private readonly seek = document.createElement('input')
  private readonly time = document.createElement('span')
  private readonly withScore = document.createElement('button')
  private readonly close = document.createElement('button')
  private readonly label = document.createElement('span')
  private readonly choice = document.createElement('select')
  private linked = false
  private seeking = false
  private audios: StripAudio[] = []
  private stem: string | undefined
  /** When the recording was last put back where the score is, by performance.now(). */
  private corrected = -Infinity
  /**
   * The recording's place less the score's, in seconds. A stem's is taken when
   * they start together; a backing track's is 0 until the slider moves it.
   */
  private lead = 0
  /** Whether the last follow() found the two playing linked. */
  private together = false
  /** The score's `seeks` at the last follow(). */
  private seeks = 0

  constructor(private readonly options: StemStripOptions) {
    const { host } = options
    this.label.className = 'stem-strip-label'
    this.label.textContent = 'Stem'
    this.choice.className = 'stem-strip-choice'
    this.choice.setAttribute('aria-label', 'What the strip plays')
    this.choice.title = 'The stem the score was written from, or the backing track to sing over'
    this.choice.addEventListener('change', () => {
      this.choose(Number(this.choice.value))
      options.onChange?.()
    })
    this.name.className = 'stem-strip-name'
    for (const control of [this.playButton, this.withScore, this.close]) control.type = 'button'
    this.playButton.className = 'stem-strip-play'
    this.seek.type = 'range'
    this.seek.min = '0'
    this.seek.max = String(SEEK_STEPS)
    this.seek.value = '0'
    this.seek.setAttribute('aria-label', 'Stem position')
    this.time.className = 'stem-strip-time'
    this.withScore.className = 'stem-strip-with'
    this.withScore.textContent = 'With score'
    this.close.className = 'stem-strip-close'
    this.close.textContent = '✕'
    this.close.title = 'Hide the stem until the score is shown again'
    this.close.setAttribute('aria-label', 'Hide the stem')
    this.audio.preload = 'metadata'
    host.setAttribute('role', 'toolbar')
    host.setAttribute('aria-label', 'Stem')
    host.hidden = true
    host.replaceChildren(this.label, this.choice, this.name, this.playButton, this.seek, this.time, this.withScore, this.close)

    this.playButton.addEventListener('click', () => void this.toggle())
    this.withScore.addEventListener('click', () => this.link(!this.linked))
    this.close.addEventListener('click', () => this.show([]))
    this.seek.addEventListener('input', () => {
      this.seeking = true
      this.time.textContent = this.times((Number(this.seek.value) / SEEK_STEPS) * this.duration())
    })
    this.seek.addEventListener('change', () => {
      this.seeking = false
      const place = (Number(this.seek.value) / SEEK_STEPS) * this.duration()
      this.audio.currentTime = place
      this.lead = place - options.score.scheduled
    })
    for (const event of ['timeupdate', 'durationchange', 'play', 'pause', 'loadedmetadata']) {
      this.audio.addEventListener(event, () => this.showState())
    }
    this.audio.addEventListener('ended', () => {
      if (this.linked) this.options.score.pause()
    })
    this.audio.addEventListener('error', () => {
      if (this.stem) this.options.onError(`The stem ${baseName(this.stem)} cannot be played`)
    })
    this.showState()
  }

  /** Shows the strip for its recordings (a path and where it plays from, the first chosen), or hides it. */
  show(audios: StripAudio[]): void {
    this.audio.pause()
    if (this.linked && this.options.score.playing) this.options.score.pause()
    this.audios = audios
    // The link is the score's: none is carried from one to the next, or past ✕.
    this.linked = audios.some(({ label }) => followsScore(label))
    this.lead = 0
    this.options.host.hidden = audios.length === 0
    this.label.hidden = audios.length > 1
    this.label.textContent = audios[0]?.label ?? 'Stem'
    this.choice.hidden = audios.length < 2
    this.choice.replaceChildren(...audios.map(({ label }, i) => new Option(label, String(i))))
    if (audios.length > 0) this.choose(0)
    else {
      this.stem = undefined
      this.audio.removeAttribute('src')
      this.audio.load()
    }
    this.showState()
    this.options.onChange?.()
  }

  /** A backing track, or the music alone, is chosen and follows the score. */
  get backing(): boolean {
    return this.linked && this.onScoreTimeline
  }

  /** The recording chosen shares the score's timeline. */
  private get onScoreTimeline(): boolean {
    const label = this.audios[Number(this.choice.value)]?.label
    return label !== undefined && followsScore(label)
  }

  /** The recording's volume, 0–1, as the score's music has it (D154). */
  set volume(volume: number) {
    this.audio.volume = volume
  }

  /** The backing track, or the music alone, while it follows the score: its file and length (D140). */
  get backingTrack(): { path: string; duration: number } | undefined {
    return this.backing && this.stem ? { path: this.stem, duration: this.duration() } : undefined
  }

  /**
   * The score's music started, stopped or moved: a linked recording keeps
   * with it (D135), at `lead` from it. `scheduled` is the score's place on its
   * audio clock, not as heard: the recording's `currentTime` is the same kind
   * of place, and on Bluetooth the two differ by 0.16 s, which put it back ten
   * times a second. A seek goes through at once, even over one still under
   * way; only a backing track is put back for straying, as a stem's drift from
   * a score written by hand is not worth a jump in what is being written from.
   */
  follow(scheduled: number, playing: boolean): void {
    const { seeks } = this.options.score
    const moved = seeks !== this.seeks
    this.seeks = seeks
    const together = playing && this.linked && !!this.stem
    const joining = together && (!this.together || this.audio.paused)
    this.together = together
    if (!this.linked || !this.stem) return
    const { backing } = this
    if (moved && backing) this.lead = 0
    if (!playing || scheduled < 0) {
      if (!this.audio.paused) this.audio.pause()
      // Karaoke's silence before the music (D149): the recording waits at its start.
      if (playing && this.audio.currentTime !== 0) this.audio.currentTime = 0
      return
    }
    // Still loading it has no place to measure from, and keeps its distance;
    // at its end it starts again from its start.
    if (joining && !backing && this.audio.readyState >= this.audio.HAVE_METADATA) this.lead = (this.audio.ended ? 0 : this.audio.currentTime) - scheduled
    const place = Math.max(scheduled + this.lead, 0)
    if (place >= this.duration() && this.duration() > 0) return
    const now = performance.now()
    const off = Math.abs(this.audio.currentTime - place)
    const strayed = backing && !this.audio.seeking && now - this.corrected > SETTLE_MS && off > DRIFT
    if (strayed || ((moved || joining) && off > 0.03)) {
      this.audio.currentTime = place
      this.corrected = now
    }
    if (this.audio.paused) {
      this.audio.play().catch((error: unknown) => {
        // A pause or another source came first: nothing failed.
        if (error instanceof Error && error.name === 'AbortError') return
        this.options.onError(`The stem could not be played: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  }

  /** Plays the `index`th recording from where the strip is, playing on if it was. */
  private choose(index: number): void {
    const chosen = this.audios[index]
    if (!chosen) return
    const at = this.stem ? this.audio.currentTime : 0
    const playing = !this.audio.paused
    this.choice.value = String(index)
    this.stem = chosen.path
    this.name.textContent = baseName(chosen.path)
    this.name.title = chosen.path
    this.audio.src = chosen.url
    if (at > 0 || playing) {
      this.audio.addEventListener(
        'loadedmetadata',
        () => {
          // The score went on while this loaded; nothing puts a stem back later.
          this.audio.currentTime = this.together ? Math.max(this.options.score.scheduled + this.lead, 0) : at
          if (playing) void this.audio.play()
        },
        { once: true },
      )
    }
  }

  private async toggle(): Promise<void> {
    const { score } = this.options
    if (!this.audio.paused) {
      this.audio.pause()
      if (this.linked) score.pause()
      return
    }
    if (this.linked && score.ready && !score.playing) await score.play()
    // Before the music the recording waits; follow() starts it at 0 (D149).
    if (this.linked && score.playing && score.scheduled < 0) return
    try {
      await this.audio.play()
    } catch (error) {
      this.options.onError(`The stem could not be played: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private link(on: boolean): void {
    const { score } = this.options
    this.linked = on
    this.lead = 0
    this.together = false
    if (!this.audio.paused) {
      if (on && score.ready && !score.playing) void score.play()
      if (!on && score.playing) score.pause()
    }
    this.showState()
    this.options.onChange?.()
  }

  private duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0
  }

  private times(position: number): string {
    return `${formatTime(position)} / ${formatTime(this.duration())}`
  }

  private showState(): void {
    const ready = !!this.stem && this.duration() > 0
    const playing = !this.audio.paused
    this.playButton.disabled = this.seek.disabled = !ready
    setText(this.playButton, playing ? '❚❚' : '▶︎')
    this.playButton.title = playing ? 'Pause the stem' : this.linked ? 'Play the stem with the score' : 'Play the stem'
    this.playButton.setAttribute('aria-label', playing ? 'Pause the stem' : 'Play the stem')
    setText(this.time, ready ? this.times(this.audio.currentTime) : '')
    if (!this.seeking) this.seek.value = String(ready ? Math.round((this.audio.currentTime / this.duration()) * SEEK_STEPS) : 0)
    this.withScore.setAttribute('aria-pressed', String(this.linked))
    if (this.onScoreTimeline) {
      this.withScore.title = this.linked ? 'The recording keeps to the score’s place. Click to play it alone.' : 'Keep the recording to the score’s place'
    } else {
      this.withScore.title = this.linked
        ? 'The score’s MIDI plays with the stem, each from where it is. Click to play the stem alone.'
        : 'Play the score’s MIDI with the stem, each from where it is: put the stem where the score’s first bar begins'
    }
    this.options.host.dataset.state = playing ? 'playing' : 'paused'
  }
}

/**
 * Sets an element's text only when it changes. The transport is shown again on
 * every tick while it plays, and WebKit drops a click on a button whose text
 * node was replaced between the press and the release: ❚❚ rarely paused.
 */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

/** A recording on the score's own timeline, not one the score was written from. */
function followsScore(label: string): boolean {
  return label === 'Backing' || label === 'Music'
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
