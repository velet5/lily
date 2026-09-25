// The IPC contract between main.ts and preload.ts (DECISIONS D28, D29): one
// named channel per call. Types only, apart from the channel names.
import type { LyDiagnostic } from '../../src/diagnostics/parse'
import type { FolderListing } from './files'

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
  midi: string[]
  durationMs: number
  /** Why lilypond did not run, or the end of its output when it failed without a parsable error. */
  message?: string
}

export type CompileEvent =
  | { kind: 'started'; rootFile: string }
  | { kind: 'finished'; outcome: CompileOutcome }
