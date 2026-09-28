// Types of preview.js's pure half, which Lily Studio's renderer bundles
// (DECISIONS D32, D35); the extension loads the script into its webview as it
// is. Only what the studio uses.
export {}

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
