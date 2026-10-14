// The file list in the left pane (DECISIONS D29): the LilyPond files of the
// open folder as a tree, the one in the editor highlighted, unsaved ones
// marked. `fileRows` is pure so the tests can run it without a DOM.
import type { FolderListing, ScoreFile, Transcription } from '../ipc'
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
function transcribedMusic(t: Transcription, text: VoiceText, options: { clef: string; timing: boolean; drums: boolean }): string[] {
  const lines: string[] = []
  if (options.clef) lines.push(`  \\clef "${options.clef}"`)
  if (!options.drums) lines.push(`  ${keyCommand(t.key)}`)
  lines.push(`  \\time ${t.beatsPerBar}/4`, '  \\compressEmptyMeasures')
  const bpm = Math.round(t.bpm)
  if (options.timing) {
    if (!t.steady) {
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
  if (options.timing) lines.push(`  \\tempo 4 = ${bpm}`)
  lines.push(...text.bars.map((bar) => `  ${bar}`), '  \\bar "|."')
  return lines
}

/**
 * The score for `request`'s stem: the instrument's staff, `\layout` and
 * `\midi`, titled after the song, its `% Stem:` line naming the stem's file.
 * With a transcription it holds the stem's notes from its start to its end;
 * without one, four empty bars. It engraves without warnings.
 */
export function stemScore({ stem, title, file, song, transcription }: StemScoreRequest): StemScore {
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
    return [`${variable} = ${drumming ? '\\drummode' : '\\relative'} {`, ...transcribedMusic(t, text, { clef, timing, drums: drumming }), '}', '']
  }
  const { staff, variable, relative, midi } = instrument
  const clef = t ? transcribedClef(stem, instrument, t.notes) : instrument.clef
  let body: string[]
  if (staff === 'voice') {
    body = [
      ...music(variable, `\\relative ${relative}`, clef),
      'words = \\lyricmode {',
      '}',
      '',
      '\\score {',
      '  <<',
      `    \\new Staff \\with {`,
      `      instrumentName = ${label}`,
      `      midiInstrument = "${midi}"`,
      `    } \\new Voice = "${variable}" { \\${variable} }`,
      // Lyrics over a tune of rests alone warn once the preview maps playback.
      t ? '    % The words: write them in \\words, then take the % off the next line.' : '    % The words: take the % off the next line once the tune has notes.',
      `    % \\new Lyrics \\lyricsto "${variable}" { \\words }`,
      '  >>',
    ]
  } else if (staff === 'drums') {
    body = [...music(variable, '\\drummode', ''), '\\score {', `  \\new DrumStaff \\with { instrumentName = ${label} } \\${variable}`]
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
      '    \\new Staff = "upper" \\upper',
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
      `  } \\${variable}`,
    ]
  }
  const text = [...lines, ...body, '  \\layout { }', '  \\midi { }', '}', ''].join('\n')
  const what = instrument.family === 'drums' ? 'Kick, snare and hi-hat of the drums' : instrument.hard ? `A rough draft of the ${title.toLowerCase()}’s chords` : `The ${title.toLowerCase()}’s notes`
  const hint = `${what}, transcribed from the stem with the song’s tempo, key and bars: ${instrument.clefWords.charAt(0).toLowerCase()}${instrument.clefWords.slice(1)}, ${instrument.soundWords} sound. Saved as ${name}.ly beside the stems; the stem plays under the preview.`
  return { name, text, hint, hard: instrument.hard }
}

/** The file a score's `% Stem:` line names, beside the score; undefined without one. */
export function stemOfScore(text: string): string | undefined {
  const line = /^%[ \t]*Stem:[ \t]*(.+?)[ \t]*$/m.exec(text)
  const name = line?.[1]
  return name && !/[\\/]/.test(name) && name !== '.' && name !== '..' ? name : undefined
}
