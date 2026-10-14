// The file list in the left pane (DECISIONS D29): the LilyPond files of the
// open folder as a tree, the one in the editor highlighted, unsaved ones
// marked. `fileRows` is pure so the tests can run it without a DOM.
import type { FolderListing, ScoreFile } from '../ipc'

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

// ---- A score for a stem (DECISIONS D112) ----
// The Separate view's *New score for bass…* writes one beside the stems, set
// up for the instrument, with no notes yet: they are written by ear while the
// stem plays under the preview. Its `% Stem:` line names the stem, so the
// preview finds it again whenever the score is shown.

/** How a stem's score is set up: its staff, clef and MIDI sound, and the words for them. */
interface StemInstrument {
  staff: 'voice' | 'drums' | 'piano' | 'single'
  /** The music's variable in the score. */
  variable: string
  clef: string
  /** Where `\relative` starts. */
  relative: string
  /** LilyPond's General MIDI name. */
  midi: string
  /** The staff and clef, and the sound, in the menu's words. */
  clefWords: string
  soundWords: string
  /** Guitar, piano and the rest are the hardest to write down by ear (#1199). */
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
  hard,
})

/** karaoke-mlx's stems; any other is written on a treble staff for piano. */
const STEM_INSTRUMENTS: Record<string, StemInstrument> = {
  vocals: { ...single('melody', 'treble', "c'", 'voice oohs', 'Treble clef with words', 'voice', false), staff: 'voice' },
  drums: { ...single('kit', '', '', '', 'Drum staff', 'drum kit', false), staff: 'drums' },
  bass: single('bass', 'bass_8', 'c,', 'electric bass (finger)', 'Bass clef', 'electric bass', false),
  guitar: single('guitar', 'treble_8', 'c', 'electric guitar (clean)', 'Guitar clef', 'clean electric guitar', true),
  piano: { ...single('upper', 'treble', "c'", 'acoustic grand', 'Two piano staves', 'grand piano', true), staff: 'piano' },
  other: single('music', 'treble', "c'", 'string ensemble 1', 'Treble clef', 'strings', true),
  instrumental: single('music', 'treble', "c'", 'acoustic grand', 'Treble clef', 'piano', true),
}

function stemInstrument(stem: string): StemInstrument {
  return STEM_INSTRUMENTS[stem] ?? single('music', 'treble', "c'", 'acoustic grand', 'Treble clef', 'piano', true)
}

/** The bars of rest a stem's score starts with, to be written over. */
const EMPTY_BARS = 'R1*4 |'

export interface StemScoreRequest {
  /** The stem as karaoke-mlx names it: `bass`, `vocals`… */
  stem: string
  /** What the Separate view calls it: "Bass", "Lead vocals"… */
  title: string
  /** The stem's file, beside which the score is written. */
  file: string
  /** The song's name, for the title. */
  song: string
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
 * The score for `request`'s stem: an instrument's staff with four empty bars,
 * `\layout` and `\midi`, titled after the song, its `% Stem:` line naming the
 * stem's file. It engraves without warnings.
 */
export function stemScore({ stem, title, file, song }: StemScoreRequest): StemScore {
  const instrument = stemInstrument(stem)
  const name = stem.replace(/[^A-Za-z0-9 _-]+/g, '') || 'stem'
  const stemFile = fileName(file).replace(/[\r\n]+/g, ' ')
  const label = `"${lilyString(title)}"`
  const lines = [
    '\\version "2.24.0"',
    '',
    `% Stem: ${stemFile}`,
    '% Write the part by ear: the stem plays under the preview, alone or with the score.',
    '',
    '\\header {',
    `  title = "${lilyString(song)} — ${lilyString(title)}"`,
    '}',
    '',
  ]
  const head = (variable: string, mode: string, clef: string) => [
    `${variable} = ${mode} {`,
    ...(clef ? [`  \\clef "${clef}"`, '  \\key c \\major'] : []),
    '  \\time 4/4',
    `  ${EMPTY_BARS}`,
    '}',
    '',
  ]
  const { staff, variable, clef, relative, midi } = instrument
  let music: string[]
  if (staff === 'voice') {
    music = [
      ...head(variable, `\\relative ${relative}`, clef),
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
      '    % The words: take the % off the next line once the tune has notes.',
      `    % \\new Lyrics \\lyricsto "${variable}" { \\words }`,
      '  >>',
    ]
  } else if (staff === 'drums') {
    music = [...head(variable, '\\drummode', ''), '\\score {', `  \\new DrumStaff \\with { instrumentName = ${label} } \\${variable}`]
  } else if (staff === 'piano') {
    music = [
      ...head('upper', "\\relative c'", 'treble'),
      ...head('lower', '\\relative c', 'bass'),
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
    music = [
      ...head(variable, `\\relative ${relative}`, clef),
      '\\score {',
      `  \\new Staff \\with {`,
      `    instrumentName = ${label}`,
      `    midiInstrument = "${midi}"`,
      `  } \\${variable}`,
    ]
  }
  const text = [...lines, ...music, '  \\layout { }', '  \\midi { }', '}', ''].join('\n')
  const hint = `${instrument.clefWords}, “${title}”, ${instrument.soundWords} sound. Saved as ${name}.ly beside the stems; the stem plays under the preview.`
  return { name, text, hint, hard: instrument.hard }
}

/** The file a score's `% Stem:` line names, beside the score; undefined without one. */
export function stemOfScore(text: string): string | undefined {
  const line = /^%[ \t]*Stem:[ \t]*(.+?)[ \t]*$/m.exec(text)
  const name = line?.[1]
  return name && !/[\\/]/.test(name) && name !== '.' && name !== '..' ? name : undefined
}
