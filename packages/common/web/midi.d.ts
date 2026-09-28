// Types of midi.js, the parser and player that the extension's webviews and
// Lily Studio play with (D24).

export interface Note {
  time: number
  duration: number
  /** The index of its track in `tracks`. */
  track: number
  channel: number
  key: number
  program: number
}
export interface Track {
  name: string
  channels: number[]
  programs: number[]
  notes: number
}
export interface Midi {
  title: string
  duration: number
  notes: Note[]
  tracks: Track[]
  division: number
}
export type PlayerState = 'stopped' | 'playing' | 'paused'
export function parseMidi(bytes: Uint8Array): Midi
export function formatTime(seconds: number): string
export function instrumentName(program: number): string
/** What a track plays: its programs' names, and `drums`. */
export function trackInstruments(track: Track): string
export function momentTime(midi: Midi, at: number, grace?: number): number
export class Player {
  constructor(options?: { onChange?: () => void; createContext?: () => BaseAudioContext })
  readonly midi: Midi | undefined
  readonly state: PlayerState
  /** Where the music is as it is heard: the audio clock less the output latency (D51). */
  readonly position: number
  /** Where the music is on the audio clock, `latency` ahead of `position`; a pause goes on from here. */
  readonly scheduled: number
  readonly latency: number
  readonly duration: number
  readonly suspended: boolean
  load(midi: Midi | undefined): void
  play(): Promise<boolean>
  pause(): void
  stop(): void
  seek(seconds: number): Promise<void>
  dispose(): void
}
