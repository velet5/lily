// Stem separation on the web (DECISIONS D55, D112): it runs karaoke-mlx with
// uv on the user's Mac, which the server is not. The transport answers every
// separation command here, without asking the worker, so the page hears why
// and the socket carries none of them.
import type { SeparationAvailability } from '../ipc'

export const SEPARATION_UNAVAILABLE = 'Separating stems needs the Mac app.'

export const separation: SeparationAvailability = { available: false, reason: SEPARATION_UNAVAILABLE }

/** The app's separation commands (src-tauri/src/separate.rs). */
export const SEPARATION_COMMANDS: ReadonlySet<string> = new Set([
  'separation_status',
  'separation_models',
  'choose_song',
  'separate',
  'separation_cancel',
  'mix_stems',
  'reveal_in_finder',
])

/** Rejects a separation command as the app's Rust side rejects a failed one; undefined for any other command. */
export function separationStub(command: string): Promise<never> | undefined {
  return SEPARATION_COMMANDS.has(command) ? Promise.reject(SEPARATION_UNAVAILABLE) : undefined
}
