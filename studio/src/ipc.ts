// The IPC contract between main.ts and preload.ts (DECISIONS D28, D29): one
// named channel per call. Types only, apart from the channel names.
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
} as const

/** A folder was opened, or a file whose folder becomes the open folder. */
export interface Opened {
  listing: FolderListing
  /** The file to show in the editor, if one was chosen. */
  file?: string
}

/** Commands sent from the application menu to the renderer. */
export type Command = 'new-score' | 'open-file' | 'open-folder' | 'save' | 'save-all'
