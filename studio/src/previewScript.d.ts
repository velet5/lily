// The pure half of the extension's preview webview script, which
// src/renderer/preview.ts and player.ts bundle (DECISIONS D32, D35). Only what
// the studio uses.
declare module '*/media/preview.js' {
  interface Rect {
    top: number
    height: number
  }
  interface Anchor {
    page: number
    offset: number
  }
  export function clampZoom(zoom: number): number
  export function stepZoom(zoom: number, direction: number): number
  export function zoomLabel(zoom: number): string
  export function captureAnchor(pages: Rect[], y: number): Anchor | null
  export function resolveAnchor(anchor: Anchor | null, pages: Rect[]): number
  export function sanitize(element: Element): void
  export function quiet(text: string): string
  export function isSourceLink(href: string): boolean
  export function scrollToShow(start: number, size: number, viewport: number): number

  /** An element's box in fractions of page `page`. */
  export interface Box {
    page: number
    left: number
    right: number
    top: number
    bottom: number
  }
  export interface TimelineEvent<E> {
    time: number
    end: number
    element: E | undefined
  }
  export interface Moment {
    time: number
    page: number
    x: number
    system: number
  }
  export interface System {
    page: number
    top: number
    bottom: number
  }
  export interface Timeline<E> {
    events: TimelineEvent<E>[]
    ends: number[]
    moments: Moment[]
    systems: System[]
    bars: { time: number; number: number }[]
  }
  export function timelineOf<E>(
    timing: { events: { href: string; at: number; grace: number; length: number }[]; bars: { at: number; number: number }[] },
    duration: number,
    sourceLinks: Map<string, E[]>,
    box: (element: E) => Box | undefined,
    time: (at: number, grace: number) => number,
  ): Timeline<E>
  export function cursorAt(moments: Moment[], time: number): { index: number; x: number } | undefined
  export function barAt(bars: { time: number; number: number }[], time: number): number | undefined
  export function soundingAt(events: { time: number; end: number }[], ends: number[], time: number): number[]
}

// The parser and player the extension's webviews play with (D24).
declare module '*/media/midi.js' {
  export interface Midi {
    title: string
    duration: number
    notes: { time: number; duration: number }[]
    division: number
  }
  export type PlayerState = 'stopped' | 'playing' | 'paused'
  export function parseMidi(bytes: Uint8Array): Midi
  export function formatTime(seconds: number): string
  export function momentTime(midi: Midi, at: number, grace?: number): number
  export class Player {
    constructor(options?: { onChange?: () => void; createContext?: () => BaseAudioContext })
    readonly midi: Midi | undefined
    readonly state: PlayerState
    readonly position: number
    readonly duration: number
    readonly suspended: boolean
    load(midi: Midi | undefined): void
    play(): Promise<boolean>
    pause(): void
    stop(): void
    seek(seconds: number): Promise<void>
    dispose(): void
  }
}
