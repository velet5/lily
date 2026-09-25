// The IPC contract between main.ts and preload.ts (DECISIONS D28, D29): one
// named channel per call. Types only, apart from the channel names.
import type { LyDiagnostic } from '../../src/diagnostics/parse'
import type { PlaybackTiming } from '../../src/preview/panel'
import type { SourceLocation } from '../../src/preview/pointAndClick'
import type { FolderListing } from './files'
import type { FileChange } from './main/watcher'

export const Channel = {
  openFolder: 'studio:open-folder',
  openFile: 'studio:open-file',
  listFolder: 'studio:list-folder',
  readFile: 'studio:read-file',
  saveFile: 'studio:save-file',
  newScore: 'studio:new-score',
  setDirty: 'studio:set-dirty',
  /** Main → renderer: a menu item or the close guard asks for a command. */
  command: 'studio:command',
  /** Main → renderer: a compile started or finished (D31). */
  compile: 'studio:compile',
  /** A click in the preview: where a `textedit:` link points (D32). */
  revealSource: 'studio:reveal-source',
  /** The PDF of a score for the PDF tab, compiled into the temp directory (D33). */
  compilePdf: 'studio:compile-pdf',
  /** Export PDF: writes that PDF next to the score (D33). */
  exportPdf: 'studio:export-pdf',
  /** Main → renderer: files changed on disk by another program (D34). */
  filesChanged: 'studio:files-changed',
  /** Asks whether to reload a file with unsaved changes that changed on disk (D34). */
  confirmReload: 'studio:confirm-reload',
} as const

/** A folder was opened, or a file whose folder becomes the open folder. */
export interface Opened {
  listing: FolderListing
  /** The file to show in the editor, if one was chosen. */
  file?: string
}

/** Commands sent from the application menu to the renderer. */
export type Command = 'new-score' | 'open-file' | 'open-folder' | 'save' | 'save-all'

/**
 * How a compile ended (D31). `no-root`: a saved include that no score in the
 * folder includes, so nothing ran. `no-lilypond` and `error`: lilypond did not
 * run, and `message` says why.
 */
export type CompileState = 'ok' | 'failed' | 'no-root' | 'no-lilypond' | 'error'

export interface CompileOutcome {
  state: CompileState
  /** The score that was compiled; for `no-root`, the saved file. */
  rootFile: string
  /** From src/diagnostics/parse.ts: absolute files, 1-based lines and columns. */
  diagnostics: LyDiagnostic[]
  errorCount: number
  warningCount: number
  /** SVG pages of the run, in order; valid until the next compile of `rootFile`. */
  pages: string[]
  /** The text of `pages`, read before the event was sent; the preview shows it (D32). */
  svg: string[]
  midi: string[]
  /** The bytes of the first of `midi`, read with the pages: the music the preview plays (D35). */
  midiData?: Uint8Array
  /** Where the notes of `midiData` are on the pages (D26), when the map was written. */
  timing?: PlaybackTiming
  durationMs: number
  /** Why lilypond did not run, or the end of its output when it failed without a parsable error. */
  message?: string
}

/**
 * A score's PDF for the PDF tab (D33). `failed`: lilypond reported errors, and
 * `files` holds whatever it still wrote. `no-lilypond` and `error`: it did not
 * run, and `message` says why.
 */
export interface PdfOutcome {
  state: 'ok' | 'failed' | 'no-lilypond' | 'error'
  rootFile: string
  /** The PDFs lilypond wrote, one per book, named as it names them. */
  files: { name: string; data: Uint8Array }[]
  errorCount: number
  durationMs: number
  message?: string
}

export type CompileEvent =
  | { kind: 'started'; rootFile: string }
  | { kind: 'finished'; outcome: CompileOutcome }

export type { FileChange, PlaybackTiming, SourceLocation }
