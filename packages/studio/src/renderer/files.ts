// The file list in the left pane (DECISIONS D29): the LilyPond files of the
// open folder as a tree, the one in the editor highlighted, unsaved ones
// marked. `fileRows` is pure so the tests can run it without a DOM.
import type { FolderListing, ScoreFile, Transcription } from '../ipc'
import type { TextEdit } from './midiBlock'
import { RelativeWriter, drums, keyCommand, keyWords, partial, pickupTempo, voice, type VoiceText } from './notation'

export type Row =
  | { kind: 'directory'; name: string; depth: number }
  | { kind: 'file'; name: string; depth: number; file: ScoreFile }

/**
 * Turns the listing, already sorted with each directory's files before its
 * subdirectories, into rows: a heading row for each directory the first time
 * one of its files appears, then the file, indented by depth.
 */
export function fileRows(files: readonly ScoreFile[]): Row[] {
  const rows: Row[] = []
  let open: string[] = []
  for (const file of files) {
    const parts = file.relative.split('/')
    const directories = parts.slice(0, -1)
    let shared = 0
    while (shared < open.length && shared < directories.length && open[shared] === directories[shared]) shared++
    for (let depth = shared; depth < directories.length; depth++) {
      rows.push({ kind: 'directory', name: directories[depth] ?? '', depth })
    }
    open = directories
    rows.push({ kind: 'file', name: parts[parts.length - 1] ?? file.relative, depth: directories.length, file })
  }
  return rows
}

export interface FileListOptions {
  /** The pane body the list is drawn into. */
  body: HTMLElement
  /** The pane header's title element, which shows the folder name. */
  title: HTMLElement
  onOpen(file: ScoreFile): void
  onOpenFolder(): void
  onNewScore(): void
}

export class FileList {
  private listing: FolderListing | undefined
  private active: string | undefined
  private dirty = new Set<string>()

  constructor(private readonly options: FileListOptions) {
    this.render()
  }

  get folder(): FolderListing | undefined {
    return this.listing
  }

  show(listing: FolderListing): void {
    this.listing = listing
    this.render()
  }

  setActive(file: string | undefined): void {
    this.active = file
    for (const element of this.items()) element.classList.toggle('active', element.dataset.file === file)
  }

  setDirty(files: Iterable<string>): void {
    this.dirty = new Set(files)
    for (const element of this.items()) {
      if (this.dirty.has(element.dataset.file ?? '')) element.dataset.dirty = ''
      else delete element.dataset.dirty
    }
  }

  private items(): HTMLElement[] {
    return [...this.options.body.querySelectorAll<HTMLElement>('[data-file]')]
  }

  private render(): void {
    const { body, title } = this.options
    body.replaceChildren()
    body.classList.remove('placeholder')
    title.textContent = this.listing?.name ?? 'Files'
    title.title = this.listing?.folder ?? ''

    if (!this.listing || this.listing.files.length === 0) {
      body.classList.add('placeholder')
      const empty = document.createElement('div')
      empty.className = 'empty'
      const message = document.createElement('p')
      message.textContent = this.listing ? 'This folder has no LilyPond scores yet.' : 'No folder open'
      empty.append(message, button('New Score…', this.options.onNewScore), button('Open Folder…', this.options.onOpenFolder))
      body.append(empty)
      return
    }

    const list = document.createElement('ul')
    list.className = 'file-list'
    list.setAttribute('role', 'tree')
    for (const row of fileRows(this.listing.files)) {
      const item = document.createElement('li')
      item.style.setProperty('--depth', String(row.depth))
      item.textContent = row.name
      if (row.kind === 'directory') {
        item.className = 'directory'
        item.setAttribute('role', 'treeitem')
      } else {
        const { file } = row
        item.className = 'file'
        item.setAttribute('role', 'treeitem')
        item.tabIndex = 0
        item.title = file.path
        item.dataset.file = file.path
        item.dataset.relative = file.relative
        item.addEventListener('click', () => this.options.onOpen(file))
        item.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            this.options.onOpen(file)
          }
        })
      }
      list.append(item)
    }
    body.append(list)
    if (this.listing.truncated) {
      const note = document.createElement('p')
      note.className = 'note'
      note.textContent = 'Only the first 500 scores are listed.'
      body.append(note)
    }
    this.setActive(this.active)
    this.setDirty(this.dirty)
  }
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.addEventListener('click', onClick)
  return element
}

// ---- A score for a stem (DECISIONS D112, D113) ----
// The Separate view's *New score for bass* writes one beside the stems, set
// up for the instrument. With lily-transcribe's transcription it holds the
// stem's notes on the song's tempo, meter and key, from its start to its end;
// without one it has four empty bars, to be written by ear. Either way the
// stem plays under the preview, and its `% Stem:` line names the stem, so the
// preview finds it again whenever the score is shown.

/** How a stem's score is set up: its staff, clef and MIDI sound, and the words for them. */
interface StemInstrument {
  staff: 'voice' | 'drums' | 'piano' | 'single'
  /** The music's variable in the score. */
  variable: string
  /** The clef; for vocals and the rest, the one an empty score starts with. */
  clef: string
  /** Where an empty score's `\relative` starts. */
  relative: string
  /** LilyPond's General MIDI name. */
  midi: string
  /** The staff and clef, and the sound, in the menu's words. */
  clefWords: string
  soundWords: string
  /** What lily-transcribe makes of it (its packages/transcribe instruments.py). */
  family: Transcription['family']
  /** Chords, not a tune: their transcription is a rough draft. */
  hard: boolean
}

const single = (variable: string, clef: string, relative: string, midi: string, clefWords: string, soundWords: string, hard: boolean): StemInstrument => ({
  staff: 'single',
  variable,
  clef,
  relative,
  midi,
  clefWords,
  soundWords,
  family: hard ? 'chords' : 'melody',
  hard,
})

/** karaoke-mlx's stems; any other is written as piano chords. */
const STEM_INSTRUMENTS: Record<string, StemInstrument> = {
  vocals: { ...single('melody', 'treble', "c'", 'voice oohs', 'Treble clef with words', 'voice', false), staff: 'voice' },
  drums: { ...single('kit', '', '', '', 'Drum staff', 'drum kit', false), staff: 'drums', family: 'drums' },
  bass: single('bass', 'bass_8', 'c,', 'electric bass (finger)', 'Bass clef', 'electric bass', false),
  guitar: single('guitar', 'treble_8', 'c', 'electric guitar (clean)', 'Guitar clef', 'clean electric guitar', true),
  piano: { ...single('upper', 'treble', "c'", 'acoustic grand', 'Two piano staves', 'grand piano', true), staff: 'piano' },
  other: single('music', 'treble', "c'", 'string ensemble 1', 'Treble clef', 'strings', true),
  instrumental: { ...single('upper', 'treble', "c'", 'acoustic grand', 'Two piano staves', 'piano', true), staff: 'piano' },
}

function stemInstrument(stem: string): StemInstrument {
  return STEM_INSTRUMENTS[stem] ?? { ...single('upper', 'treble', "c'", 'acoustic grand', 'Two piano staves', 'piano', true), staff: 'piano' }
}

/** The bars of rest an empty score starts with, to be written over. */
const EMPTY_BARS = 'R1*4 |'

/** A piano score's hands part at middle C. */
const MIDDLE_C = 60

export interface StemScoreRequest {
  /** The stem as karaoke-mlx names it: `bass`, `vocals`… */
  stem: string
  /** What the Separate view calls it: "Bass", "Lead vocals"… */
  title: string
  /** The stem's file, beside which the score is written. */
  file: string
  /** The song's name, for the title. */
  song: string
  /** What lily-transcribe heard in the stem; without it the score is empty, to be written by ear. */
  transcription?: Transcription
  /** A backing track beside the stem to sing over, named in a `% Backing:` line (D133). */
  backing?: string
}

export interface StemScore {
  /** The score's name before `.ly`; the Rust side adds a number when it is taken. */
  name: string
  text: string
  /** What the menu says it writes. */
  hint: string
  hard: boolean
}

/** `text` as a LilyPond string's contents. */
function lilyString(text: string): string {
  return text.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')
}

/** The last name of a path. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * A song's file name as a title, and the artist when the name has one
 * (`artist - title`, or `artist_-_title` as downloads write it, where the
 * artist's words are joined with hyphens): underscores become spaces, and a
 * name all in lower case gets its capitals.
 */
export function songTitle(song: string): { title: string; artist?: string } {
  const words = (text: string) => text.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  const lower = song === song.toLowerCase()
  const capital = (text: string) => (lower ? text.charAt(0).toUpperCase() + text.slice(1) : text)
  const parts = /^(.+?)\s*(_-_| - | – | — )\s*(.+)$/.exec(song)
  if (!parts) return { title: capital(words(song)) || song }
  const slug = parts[2] === '_-_'
  const artist = words(slug ? parts[1]!.replace(/-/g, ' ') : parts[1]!)
  return {
    title: capital(words(parts[3]!)),
    artist: lower ? artist.replace(/(^|\s)(\S)/g, (_, space: string, letter: string) => space + letter.toUpperCase()) : artist,
  }
}

/**
 * A drifting song's tempo bar by bar (D135), as `songTempo`, which runs
 * beside the staff's music: a `\\tempo` at each bar, so its MIDI lasts as long
 * as the stem's bar does. Undefined for a steady song, or without the bars' times.
 */
function songTempo(t: Transcription): string[] | undefined {
  const times = t.barTimes
  if (t.steady || !times || times.length !== t.bars + 1) return undefined
  const bar = t.beatsPerBar === 4 ? 's1' : `s4*${t.beatsPerBar}`
  const bars = times.slice(1).map((end, i) => `\\tempo 64 = ${Math.max(1, Math.round((960 * t.beatsPerBar) / (end - times[i]!)))} ${bar} |`)
  const lines: string[] = []
  for (let i = 0; i < bars.length; i += 4) lines.push(`  ${bars.slice(i, i + 4).join(' ')}`)
  return [
    '% The stem’s tempo bar by bar, so the MIDI keeps time with it.',
    'songTempo = {',
    '  \\omit Score.MetronomeMark',
    ...(t.pickup > 0 ? [`  s16*${t.pickup}`] : []),
    ...lines,
    '}',
    '',
  ]
}

/** The middle of the pitches the notes sound, for a clef; undefined with none. */
function medianPitch(notes: Transcription['notes']): number | undefined {
  const pitches = notes.flatMap(([, , sounding]) => sounding).sort((a, b) => a - b)
  return pitches.length ? pitches[Math.floor(pitches.length / 2)] : undefined
}

/** The clef for what was heard: a man's voice an octave down, low strings in the bass clef. */
function transcribedClef(stem: string, instrument: StemInstrument, notes: Transcription['notes']): string {
  const middle = medianPitch(notes)
  if (middle === undefined) return instrument.clef
  if (instrument.staff === 'voice') return middle < 57 ? 'treble_8' : 'treble'
  if (stem === 'other' || !STEM_INSTRUMENTS[stem]) return middle < 55 ? 'bass' : 'treble'
  return instrument.clef
}

/** The opening lines of a transcribed staff's music: clef, key, meter, tempo, the pickup, then its bars. */
function transcribedMusic(t: Transcription, text: VoiceText, options: { clef: string; timing: boolean; drums: boolean; followed: boolean }): string[] {
  const lines: string[] = []
  if (options.clef) lines.push(`  \\clef "${options.clef}"`)
  if (!options.drums) lines.push(`  ${keyCommand(t.key)}`)
  lines.push(`  \\time ${t.beatsPerBar}/4`, '  \\compressEmptyMeasures')
  const bpm = Math.round(t.bpm)
  if (options.timing) {
    if (options.followed) {
      lines.push(`  % The song's tempo drifts around ♩ = ${bpm}: songTempo has the MIDI follow the stem bar by bar.`)
    } else if (!t.steady) {
      lines.push(`  % The song's tempo drifts: the MIDI keeps ♩ = ${bpm} and drifts from the stem.`)
    } else if (bpm !== t.bpm) {
      const beats = t.seconds / (60 / t.bpm)
      const drift = Math.abs(beats * (60 / bpm - 60 / t.bpm))
      lines.push(`  % The stem's tempo is ♩ = ${t.bpm}: the MIDI's ${bpm} is ${drift.toFixed(1)} s off it by the end.`)
    }
  }
  if (text.pickup !== undefined) {
    lines.push(`  ${partial(t.pickup)}`)
    if (options.timing) lines.push('  % The MIDI keeps time with the stem: this bar lasts as long as the stem', '  % plays before bar 1.', `  ${pickupTempo(t.pickup, t.barOne)}`)
    lines.push(`  ${text.pickup} |`)
  }
  if (options.timing && !options.followed) lines.push(`  \\tempo 4 = ${bpm}`)
  lines.push(...text.bars.map((bar) => `  ${bar}`), '  \\bar "|."')
  return lines
}

/**
 * The score for `request`'s stem: the instrument's staff, `\layout` and
 * `\midi`, titled after the song, its `% Stem:` line naming the stem's file
 * and a `% Backing:` line the backing track, when it has one.
 * With a transcription it holds the stem's notes from its start to its end;
 * without one, four empty bars. It engraves without warnings.
 */
export function stemScore({ stem, title, file, song, transcription, backing }: StemScoreRequest): StemScore {
  const instrument = stemInstrument(stem)
  const name = stem.replace(/[^A-Za-z0-9 _-]+/g, '') || 'stem'
  const stemFile = fileName(file).replace(/[\r\n]+/g, ' ')
  const label = `"${lilyString(title)}"`
  const heading = songTitle(song)
  const t = transcription
  const lines = [
    '\\version "2.24.0"',
    '',
    `% Stem: ${stemFile}`,
    ...(backing ? [`% Backing: ${fileName(backing).replace(/[\r\n]+/g, ' ')}`] : []),
    ...(t
      ? [
          `% Transcribed from the stem by Lily Studio: ♩ = ${Math.round(t.bpm)}, ${t.beatsPerBar}/4, ${keyWords(t.key)}, ${t.bars} bars.`,
          instrument.hard
            ? '% A rough draft of its chords: check them by ear, the stem plays under the preview.'
            : '% Check it by ear: the stem plays under the preview, alone or with the score.',
        ]
      : ['% Write the part by ear: the stem plays under the preview, alone or with the score.']),
    '',
    '\\header {',
    `  title = "${lilyString(heading.title)}"`,
    ...(heading.artist ? [`  subtitle = "${lilyString(heading.artist)}"`] : []),
    `  instrument = ${label}`,
    '}',
    '',
  ]
  const layout = t && { pickup: t.pickup, bars: t.bars, beatsPerBar: t.beatsPerBar }
  const tempo = t ? songTempo(t) : undefined
  /** A staff's music, with the song's tempo bar by bar beside it when it drifts. */
  const timed = (variable: string) => (tempo ? `<< \\${variable} \\songTempo >>` : `\\${variable}`)
  /** A staff's music variable: transcribed when there is a transcription, four empty bars when not. */
  const music = (variable: string, mode: string, clef: string, notes?: Transcription['notes'], timing = true): string[] => {
    if (!t || !layout) {
      return [
        `${variable} = ${mode} {`,
        ...(clef ? [`  \\clef "${clef}"`, '  \\key c \\major'] : []),
        '  \\time 4/4',
        `  ${EMPTY_BARS}`,
        '}',
        '',
      ]
    }
    const drumming = instrument.staff === 'drums'
    const text = voice(notes ?? t.notes, layout, drumming ? drums : ((writer) => (pitches: readonly number[]) => writer.write(pitches))(new RelativeWriter(t.key)))
    return [
      `${variable} = ${drumming ? '\\drummode' : '\\relative'} {`,
      ...transcribedMusic(t, text, { clef, timing, drums: drumming, followed: !!tempo }),
      '}',
      '',
    ]
  }
  const { staff, variable, relative, midi } = instrument
  const clef = t ? transcribedClef(stem, instrument, t.notes) : instrument.clef
  let body: string[]
  if (staff === 'voice') {
    const heard = t?.words?.length && layout ? lyricLines(t.words, voice(t.notes, layout, () => '').sung, t.beatsPerBar * 4) : undefined
    body = [
      ...music(variable, `\\relative ${relative}`, clef),
      'words = \\lyricmode {',
      ...(heard ?? []),
      '}',
      '',
      '\\score {',
      '  <<',
      `    \\new Staff \\with {`,
      `      instrumentName = ${label}`,
      `      midiInstrument = "${midi}"`,
      `    } \\new Voice = "${variable}" { ${timed(variable)} }`,
      // Lyrics over a tune of rests alone warn once the preview maps playback.
      ...(heard
        ? ['    % The words as Lily Studio heard them, a syllable a note: check them by ear.', `    \\new Lyrics \\lyricsto "${variable}" { \\words }`]
        : [
            t ? '    % The words: write them in \\words, then take the % off the next line.' : '    % The words: take the % off the next line once the tune has notes.',
            `    % \\new Lyrics \\lyricsto "${variable}" { \\words }`,
          ]),
      '  >>',
    ]
  } else if (staff === 'drums') {
    body = [...music(variable, '\\drummode', ''), '\\score {', `  \\new DrumStaff \\with { instrumentName = ${label} } ${timed(variable)}`]
  } else if (staff === 'piano') {
    const hand = (upper: boolean): Transcription['notes'] | undefined =>
      t?.notes.map(([at, length, pitches]) => [at, length, pitches.filter((pitch) => pitch >= MIDDLE_C === upper)])
    body = [
      ...music('upper', "\\relative c'", 'treble', hand(true)),
      ...music('lower', '\\relative c', 'bass', hand(false), false),
      '\\score {',
      `  \\new PianoStaff \\with {`,
      `    instrumentName = ${label}`,
      `    midiInstrument = "${midi}"`,
      '  } <<',
      `    \\new Staff = "upper" ${timed('upper')}`,
      '    \\new Staff = "lower" \\lower',
      '  >>',
    ]
  } else {
    body = [
      ...music(variable, `\\relative ${relative}`, clef),
      '\\score {',
      `  \\new Staff \\with {`,
      `    instrumentName = ${label}`,
      `    midiInstrument = "${midi}"`,
      `  } ${timed(variable)}`,
    ]
  }
  const scoreAt = body.indexOf('\\score {')
  if (tempo) body.splice(scoreAt, 0, ...tempo)
  const text = [...lines, ...body, '  \\layout { }', '  \\midi { }', '}', ''].join('\n')
  const what =
    instrument.family === 'drums'
      ? 'Kick, snare and hi-hat of the drums'
      : instrument.hard
        ? `A rough draft of the ${title.toLowerCase()}’s chords`
        : instrument.staff === 'voice'
          ? `The ${title.toLowerCase()}’ tune and words`
          : `The ${title.toLowerCase()}’s notes`
  const hint = `${what}, transcribed from the stem with the song’s tempo, key and bars: ${instrument.clefWords.charAt(0).toLowerCase()}${instrument.clefWords.slice(1)}, ${instrument.soundWords} sound. Saved as ${name}.ly beside the stems; the stem plays under the preview.`
  return { name, text, hint, hard: instrument.hard }
}

/**
 * The words lily-transcribe laid on the notes (D134) as `\lyricmode` lines, one
 * per bar: a syllable for each note written, `_` for one sung to none, up to
 * the last syllable. `sung` is where each note written starts.
 */
function lyricLines(words: readonly [number, string, boolean][], sung: readonly number[], bar: number): string[] {
  const byNote = new Map(words.map(([at, text, hyphen]) => [at, { text, hyphen }]))
  let last = sung.length - 1
  while (last >= 0 && !byNote.has(sung[last]!)) last -= 1
  const bars = new Map<number, string[]>()
  for (const at of sung.slice(0, last + 1)) {
    const word = byNote.get(at)
    const number = Math.floor(at / bar)
    bars.set(number, [...(bars.get(number) ?? []), word ? `${lyricWord(word.text)}${word.hyphen ? ' --' : ''}` : '_'])
  }
  return [...bars.values()].map((tokens) => `  ${tokens.join(' ')}`)
}

/** A syllable as `\lyricmode` reads it: spaces as `_`, quoted when it has what lilypond reads otherwise. */
function lyricWord(text: string): string {
  const plain = text.replace(/ /g, '_')
  return /^[\p{L}'’][\p{L}'’.,!?;:_-]*$/u.test(plain) && !plain.endsWith('-') ? plain : `"${lilyString(text)}"`
}

/** The file a score's `% Stem:` line names, beside the score; undefined without one. */
export function stemOfScore(text: string): string | undefined {
  return fileLine(text, 'Stem')
}

/** The backing track a score's `% Backing:` line names, beside the score, to sing over (D133). */
export function backingOfScore(text: string): string | undefined {
  return fileLine(text, 'Backing')
}

/** The music alone, without any voice, a score's `% Music:` line names, beside the score (D137). */
export function musicOfScore(text: string): string | undefined {
  return fileLine(text, 'Music')
}

/** The earliest `% Start:`: a minute of silence before the music. */
export const EARLIEST_START = -60

/**
 * Where Karaoke starts, in seconds, from a score's `% Start:` line: past a long
 * intro, or below 0 for silence before the music (D149); undefined without one.
 */
export function startOfScore(text: string): number | undefined {
  const start = Number(/^%[ \t]*Start:[ \t]*(-?\d+(?:\.\d+)?)[ \t]*$/m.exec(text)?.[1] ?? NaN)
  return Number.isFinite(start) ? Math.max(start, EARLIEST_START) : undefined
}

/** The recording a score's `% Audio:` line names, beside the score, played along with the MIDI as a track of its own (D155). */
export function audioOfScore(text: string): string | undefined {
  return fileLine(text, 'Audio')
}

/** The furthest an audio track may start from the music, either way, in seconds (D155). */
export const MAX_AUDIO_OFFSET = 3600

/**
 * When the audio track starts, in seconds of the music, from a score's
 * `% Audio offset:` line, to the hundredth: below 0 it is that far into the
 * recording when the music starts (D155); 0 without one.
 */
export function audioOffsetOfScore(text: string): number {
  const offset = numberLine(text, 'Audio offset')
  return offset === undefined ? 0 : Math.min(Math.max(hundredths(offset), -MAX_AUDIO_OFFSET), MAX_AUDIO_OFFSET)
}

/** The slowest and fastest the MIDI may be played at, in quarter notes a minute (D155). */
export const MIN_BPM = 1
export const MAX_BPM = 999.99

/**
 * The tempo the score's MIDI plays at, in quarter notes a minute to the
 * hundredth, from its `% BPM:` line, to keep it with its audio track (D155);
 * undefined without one, or outside 1–999.99.
 */
export function bpmOfScore(text: string): number | undefined {
  const bpm = numberLine(text, 'BPM')
  return bpm === undefined || bpm < MIN_BPM || bpm > MAX_BPM ? undefined : hundredths(bpm)
}

/** `value` to the hundredth, as the audio track's lines keep it. */
export function hundredths(value: number): number {
  return Math.round(value * 100) / 100 || 0
}

/** `value` as a line of the score writes it: to the hundredth, without trailing zeros. */
export function lineNumber(value: number): string {
  return String(hundredths(value))
}

/** The lines of a score's own (D112, D133, D137, D149, D155), after which another of them goes. */
const SCORE_LINES = ['Stem', 'Backing', 'Music', 'Start', 'Audio', 'Audio offset', 'BPM']

/**
 * The edits that give `text` these `% Label: value` lines, or take them out
 * where the value is undefined (D155). A line there already is rewritten in
 * place; a new one goes after the score's own lines, else after `\version`,
 * else first.
 */
export function withScoreLines(text: string, lines: Record<string, string | undefined>): TextEdit[] {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const edits: TextEdit[] = []
  const added: string[] = []
  const removed = new Set<string>()
  for (const [label, value] of Object.entries(lines)) {
    const found = lineOf(text, label)
    const line = value === undefined ? undefined : `% ${label}: ${value.replace(/[\r\n]+/g, ' ')}`
    if (found && line !== undefined) edits.push({ offset: found.start, length: found.end - found.start, text: line })
    else if (found) {
      edits.push({ offset: found.start, length: found.next - found.start, text: '' })
      removed.add(label)
    } else if (line !== undefined) added.push(line)
  }
  if (added.length > 0) {
    const after = Math.max(...SCORE_LINES.map((label) => (removed.has(label) ? -1 : (lineOf(text, label)?.next ?? -1))))
    const version = /^[ \t]*\\version\b.*$/m.exec(text)
    const offset = after >= 0 ? after : version ? lineEnd(text, version.index + version[0].length) : 0
    const atEnd = offset === text.length && offset > 0 && !text.endsWith('\n')
    edits.push({ offset, length: 0, text: (atEnd ? eol : '') + added.join(eol) + (atEnd ? '' : eol) })
  }
  return edits.sort((a, b) => a.offset - b.offset)
}

/** Where a `% Label:` line starts, ends before its line break, and the next line starts. */
function lineOf(text: string, label: string): { start: number; end: number; next: number } | undefined {
  const match = new RegExp(`^%[ \\t]*${label}:.*?(?=\\r?$)`, 'm').exec(text)
  if (!match) return undefined
  const end = match.index + match[0].length
  return { start: match.index, end, next: lineEnd(text, end) }
}

/** The start of the line after the one that ends at `end`, or the text's end. */
function lineEnd(text: string, end: number): number {
  const newline = text.indexOf('\n', end)
  return newline < 0 ? text.length : newline + 1
}

function numberLine(text: string, label: string): number | undefined {
  const value = Number(new RegExp(`^%[ \\t]*${label}:[ \\t]*([-+]?\\d+(?:\\.\\d*)?|[-+]?\\.\\d+)[ \\t]*$`, 'm').exec(text)?.[1] ?? NaN)
  return Number.isFinite(value) ? value : undefined
}

function fileLine(text: string, label: string): string | undefined {
  const line = new RegExp(`^%[ \\t]*${label}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text)
  const name = line?.[1]
  return name && !/[\\/]/.test(name) && name !== '.' && name !== '..' ? name : undefined
}

/** The file `\include "target"` in `from` reads: beside `from`, `..` and `.` resolved (D119). */
export function includedFile(from: string, target: string): string {
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '..' && parts.length > 1) parts.pop()
    else if (part !== '.' && part !== '..' && part !== '') parts.push(part)
  }
  return `${target.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

// ---- A singer's own timing (DECISIONS D276) ----
// *Keep the sung times* writes a voice's shifts from the grid into the score,
// with D155's lines: a guard line first, the voice's note count as played and
// a hash of their rhythm, then the shifts, 16 notes a line.
//
//   % Audio sung lead: 239 5e0c41a7
//   % Audio sung lead: . . +62 . -71 . . . . +55 . . . . . .
//
// The times belong to the notes they were measured on: when the count or the
// hash no longer match the voice's notes, the voice plays as written and the
// status line says so, so old times are never put on new notes.

/** A voice's note in the guard's terms: its start and length in MIDI ticks. */
export interface GuardNote {
  start: number
  length: number
}

/** The guard of a voice's sung times: its note count as played, and the hash of their rhythm. */
export interface SungGuard {
  count: number
  /** 8 lower-case hex digits. */
  hash: string
}

/** A voice's `% Audio sung` lines as read: its guard, and each note's shift from the grid in whole ms, 0 for `.`. */
export interface SungLines extends SungGuard {
  shifts: number[]
}

/** A voice's lines that cannot be read, and what is wrong with them. */
export interface SungUnreadable {
  problem: string
}

/** Shifts on a line, as Keep the sung times writes them. */
export const SUNG_PER_LINE = 16

/** The furthest a stored shift may move a note, in ms: a minute, far past any a 16th allows. */
const MAX_SHIFT = 60_000

/**
 * The guard of `notes`, in the order played: their count, and the 32-bit
 * FNV-1a hash of the ASCII text `<start>,<length>;` of each, in ticks. It
 * hashes the rhythm and not the pitches: correcting a pitch the comparison
 * found keeps the times (D276).
 */
export function sungGuard(notes: readonly GuardNote[]): SungGuard {
  let hash = 0x811c9dc5
  for (const { start, length } of notes) {
    for (const char of `${Math.round(start)},${Math.round(length)};`) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return { count: notes.length, hash: hash.toString(16).padStart(8, '0') }
}

/** Whether `voice` can name a voice in a `% Audio sung` line: not blank, without a colon or a line break. */
export function sungVoiceName(voice: string): boolean {
  return voice.trim() === voice && voice !== '' && !/[:\p{Cc}]/u.test(voice)
}

/** `% Audio sung <voice>:` lines, each with its voice and the text after the colon, in order. */
const SUNG_LINE = /^%[ \t]*Audio sung[ \t]+([^:\r\n]+?)[ \t]*:[ \t]*(.*?)[ \t]*\r?$/gm

/**
 * Each voice's `% Audio sung` lines in `text` (D276), read in order wherever
 * they are: the first is the guard, `<count> <hash>`, and the rest the
 * shifts, signed whole ms (`+62`, `-71`) or `.` for the grid, one for each
 * note. Lines that do not read so are a voice's problem, not a shift of 0.
 */
export function sungOfScore(text: string): Map<string, SungLines | SungUnreadable> {
  const lines = new Map<string, string[]>()
  for (const [, voice, rest] of text.matchAll(SUNG_LINE)) lines.set(voice!, [...(lines.get(voice!) ?? []), rest!])
  const result = new Map<string, SungLines | SungUnreadable>()
  for (const [voice, [guard, ...rest]] of lines) {
    const found = /^(\d+)[ \t]+([0-9a-fA-F]{8})$/.exec(guard!)
    if (!found) {
      result.set(voice, { problem: 'its first line is not its note count and hash' })
      continue
    }
    const count = Number(found[1])
    const shifts: number[] = []
    let problem: string | undefined
    for (const token of rest.flatMap((line) => line.split(/[ \t]+/)).filter((token) => token !== '')) {
      const shift = token === '.' ? 0 : /^[+-]\d+$/.test(token) ? Number(token) : NaN
      if (!(Math.abs(shift) <= MAX_SHIFT)) {
        problem = `${token} is not a shift in ms`
        break
      }
      shifts.push(shift || 0)
    }
    if (!problem && shifts.length !== count) problem = `it has ${shifts.length} shifts for ${count} notes`
    result.set(voice, problem ? { problem } : { count, hash: found[2]!.toLowerCase(), shifts })
  }
  return result
}

/**
 * The lines `voice` keeps its sung times in: the guard, then the shifts, 16
 * a line, each in whole ms from the grid, signed, and `.` for the grid. A
 * voice whose singer keeps to the grid has lines of dots.
 */
export function sungLines(voice: string, guard: SungGuard, shifts: readonly number[]): string[] {
  if (!sungVoiceName(voice)) throw new Error(`${JSON.stringify(voice)} cannot name a voice in a % Audio sung line.`)
  if (shifts.length !== guard.count) throw new Error(`${voice} has ${guard.count} notes, not ${shifts.length}.`)
  const tokens = shifts.map((shift) => {
    const ms = Math.round(Math.min(Math.max(shift, -MAX_SHIFT), MAX_SHIFT)) || 0
    return ms === 0 ? '.' : ms > 0 ? `+${ms}` : String(ms)
  })
  const lines = [`% Audio sung ${voice}: ${guard.count} ${guard.hash}`]
  for (let i = 0; i < tokens.length; i += SUNG_PER_LINE) lines.push(`% Audio sung ${voice}: ${tokens.slice(i, i + SUNG_PER_LINE).join(' ')}`)
  return lines
}

/**
 * The edits that replace all of `voice`'s `% Audio sung` lines in `text` with
 * `lines`, or take them out when undefined, as one edit (D276). The new lines
 * go where the voice's first one was; a voice without any gets them after
 * the score's own lines and the other voices' sung ones, else after
 * `\version`, else first.
 */
export function withSungLines(text: string, voice: string, lines: readonly string[] | undefined): TextEdit[] {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const own: { start: number; next: number }[] = []
  let after = -1
  for (const match of text.matchAll(SUNG_LINE)) {
    const next = lineEnd(text, match.index + match[0].length)
    if (match[1] === voice) own.push({ start: match.index, next })
    else after = Math.max(after, next)
  }
  const edits: TextEdit[] = own.map(({ start, next }) => ({ offset: start, length: next - start, text: '' }))
  if (lines && lines.length > 0) {
    const block = lines.join(eol)
    if (own.length > 0) {
      // Where the first was, with the line break it had.
      const first = own[0]!
      edits[0] = { ...edits[0]!, text: block + (text.slice(first.start, first.next).endsWith('\n') ? eol : '') }
    } else {
      for (const label of SCORE_LINES) after = Math.max(after, lineOf(text, label)?.next ?? -1)
      const version = /^[ \t]*\\version\b.*$/m.exec(text)
      const offset = after >= 0 ? after : version ? lineEnd(text, version.index + version[0].length) : 0
      const atEnd = offset === text.length && offset > 0 && !text.endsWith('\n')
      edits.push({ offset, length: 0, text: (atEnd ? eol : '') + block + (atEnd ? '' : eol) })
    }
  }
  return edits.sort((a, b) => a.offset - b.offset)
}

/**
 * The shifts of `voice`'s lines for its notes now, whose guard is `guard`;
 * or, when they belong to other notes or cannot be read, what the status line
 * says, and the voice plays as written. Undefined when it has no lines.
 */
export function sungTimesFor(
  read: SungLines | SungUnreadable | undefined,
  voice: string,
  guard: SungGuard,
): { shifts: number[] } | { stale: string } | undefined {
  if (!read) return undefined
  if ('problem' in read) return { stale: `${voice}'s % Audio sung lines cannot be read (${read.problem}); it plays as written` }
  if (read.count !== guard.count || read.hash !== guard.hash) return { stale: `${voice}'s sung times are for an earlier rhythm; it plays as written` }
  return { shifts: read.shifts }
}
