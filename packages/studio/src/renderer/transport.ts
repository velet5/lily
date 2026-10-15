// How bridge.ts reaches Lily Studio's Rust side in the app (DECISIONS D42):
// one Tauri command per call (src-tauri/src/commands.rs), and one channel for
// what the Rust side sends by itself. `node esbuild.mjs --site` bundles
// src/web/transport.ts in its place (D55).
import { Channel, convertFileSrc, invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import type { Transport } from '../ipc'

export const transport: Transport = {
  hosted: false,
  // Lily Studio's app is the Mac's (D112).
  separation: { available: true },
  call: (command, args) => invoke(command, args),
  send: (command, args) => {
    invoke(command, args).catch((error: unknown) => console.error(`${command}:`, error))
  },
  subscribe: (onEvent) => {
    const channel = new Channel<unknown>()
    channel.onmessage = onEvent
    return invoke<void>('subscribe', { channel })
  },
  fileUrl: (path) => convertFileSrc(path),
  // Tauri takes files dropped on the window (D112): the page gets their paths, not an HTML drop.
  onFileDrop: (onDrop) => {
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter' || payload.type === 'drop') onDrop({ kind: payload.type, paths: payload.paths })
        else if (payload.type === 'leave') onDrop({ kind: 'leave' })
      })
      .catch((error: unknown) => console.error('drag and drop:', error))
  },
}
