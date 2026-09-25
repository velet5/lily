// The only bridge between the sandboxed renderer and the main process
// (DECISIONS D28). It exposes `window.studio`; later steps add the file,
// compile and playback calls here, each a named IPC channel.
import { contextBridge } from 'electron'

const studio = {
  platform: process.platform,
}

export type StudioApi = typeof studio

contextBridge.exposeInMainWorld('studio', studio)
