// How bridge.ts reaches Lily Studio's Rust side in the app (DECISIONS D42):
// one Tauri command per call (src-tauri/src/commands.rs), and one channel for
// what the Rust side sends by itself. `node esbuild.mjs --site` bundles
// src/web/transport.ts in its place (D55).
import { Channel, invoke } from '@tauri-apps/api/core'
import type { Transport } from '../ipc'

export const transport: Transport = {
  hosted: false,
  call: (command, args) => invoke(command, args),
  send: (command, args) => {
    invoke(command, args).catch((error: unknown) => console.error(`${command}:`, error))
  },
  subscribe: (onEvent) => {
    const channel = new Channel<unknown>()
    channel.onmessage = onEvent
    return invoke<void>('subscribe', { channel })
  },
}
