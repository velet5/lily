// The only bridge between the sandboxed renderer and the main process
// (DECISIONS D28). It exposes `window.studio`, one named IPC channel per call
// (src/ipc.ts).
import { contextBridge, ipcRenderer } from 'electron'
import type { FolderListing } from './files'
import {
  Channel,
  type Command,
  type CompileEvent,
  type FileChange,
  type LilyPondStatus,
  type Opened,
  type PdfOutcome,
  type SetupLink,
  type SourceLocation,
} from './ipc'
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
  /**
   * The editor now shows `file`: resolves with its score, or undefined when no
   * score includes it. The score's compile events follow on onCompile (D39).
   */
  showScore: (file: string): Promise<string | undefined> => ipcRenderer.invoke(Channel.showScore, file),
  /** Tells the main process whether any open file has unsaved changes. */
  setDirty: (dirty: boolean): void => ipcRenderer.send(Channel.setDirty, dirty),
  /**
   * Where a `textedit:` link of the preview points; undefined when it is not
   * one. Rejects when the file is not one the studio may open.
   */
  revealSource: (href: string): Promise<SourceLocation | undefined> => ipcRenderer.invoke(Channel.revealSource, href),
  /**
   * The PDF of the score `rootFile`, compiled into the temp directory (D33);
   * undefined when a newer PDF compile of it took over.
   */
  compilePdf: (rootFile: string): Promise<PdfOutcome | undefined> => ipcRenderer.invoke(Channel.compilePdf, rootFile),
  /** Writes the PDF of `rootFile` next to it; resolves with the files written. */
  exportPdf: (rootFile: string): Promise<string[]> => ipcRenderer.invoke(Channel.exportPdf, rootFile),
  /**
   * Asks, in a dialog, whether to reload `file` from disk and lose its unsaved
   * changes; true for Reload.
   */
  confirmReload: (file: string): Promise<boolean> => ipcRenderer.invoke(Channel.confirmReload, file),
  /**
   * The unsaved text of `file` after an edit, or null after a save or reload.
   * Live preview compiles with these texts (D36).
   */
  edited: (file: string, text: string | null): void => ipcRenderer.send(Channel.edited, file, text),
  /** Turns live preview on or off. */
  setLive: (on: boolean): void => ipcRenderer.send(Channel.setLive, on),
  /** Looks for LilyPond and asks it for its version (D37). */
  lilypondStatus: (): Promise<LilyPondStatus> => ipcRenderer.invoke(Channel.lilypondStatus),
  /** Asks where LilyPond is; undefined when the dialog was cancelled. */
  chooseLilyPond: (): Promise<LilyPondStatus | undefined> => ipcRenderer.invoke(Channel.chooseLilyPond),
  /** Opens a page of the setup in the browser. */
  openLink: (link: SetupLink): Promise<void> => ipcRenderer.invoke(Channel.openLink, link),
  /** Opens the sample score, writing it first when it is not there. */
  openSample: (): Promise<Opened> => ipcRenderer.invoke(Channel.openSample),
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
  /** Runs `listener` when open files or the score's includes change on disk (D34). */
  onFilesChanged(listener: (changes: FileChange[]) => void): () => void {
    const handler = (_event: unknown, changes: FileChange[]) => listener(changes)
    ipcRenderer.on(Channel.filesChanged, handler)
    return () => ipcRenderer.removeListener(Channel.filesChanged, handler)
  },
}

export type StudioApi = typeof studio

contextBridge.exposeInMainWorld('studio', studio)
