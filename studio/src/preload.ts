// The only bridge between the sandboxed renderer and the main process
// (DECISIONS D28). It exposes `window.studio`, one named IPC channel per call
// (src/ipc.ts); later steps add the playback calls here.
import { contextBridge, ipcRenderer } from 'electron'
import type { FolderListing } from './files'
import { Channel, type Command, type CompileEvent, type Opened } from './ipc'
import { TEMPLATES, type TemplateId } from './templates'

const studio = {
  platform: process.platform,
  templates: TEMPLATES.map(({ id, label }) => ({ id, label })),

  /** Asks for a folder; undefined when the dialog was cancelled. */
  openFolder: (): Promise<Opened | undefined> => ipcRenderer.invoke(Channel.openFolder),
  /** Asks for a LilyPond file; its folder becomes the open folder. */
  openFile: (): Promise<Opened | undefined> => ipcRenderer.invoke(Channel.openFile),
  /** Lists the open folder again, or undefined when none is open. */
  listFolder: (): Promise<FolderListing | undefined> => ipcRenderer.invoke(Channel.listFolder),
  readFile: (file: string): Promise<string> => ipcRenderer.invoke(Channel.readFile, file),
  saveFile: (file: string, text: string): Promise<void> => ipcRenderer.invoke(Channel.saveFile, file, text),
  /** Asks where to save a new score from `template`, writes it and opens its folder. */
  newScore: (template: TemplateId): Promise<Opened | undefined> => ipcRenderer.invoke(Channel.newScore, template),
  /** Tells the main process whether any open file has unsaved changes. */
  setDirty: (dirty: boolean): void => ipcRenderer.send(Channel.setDirty, dirty),
  /** Runs `listener` for each menu command; returns a function that removes it. */
  onCommand(listener: (command: Command) => void): () => void {
    const handler = (_event: unknown, command: Command) => listener(command)
    ipcRenderer.on(Channel.command, handler)
    return () => ipcRenderer.removeListener(Channel.command, handler)
  },
  /** Runs `listener` when a compile starts or ends; saving a file starts one (D31). */
  onCompile(listener: (event: CompileEvent) => void): () => void {
    const handler = (_event: unknown, compile: CompileEvent) => listener(compile)
    ipcRenderer.on(Channel.compile, handler)
    return () => ipcRenderer.removeListener(Channel.compile, handler)
  },
}

export type StudioApi = typeof studio

contextBridge.exposeInMainWorld('studio', studio)
