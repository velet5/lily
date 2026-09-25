// The pure half of the extension's preview webview script, which
// src/renderer/preview.ts bundles (DECISIONS D32). Only what the studio uses.
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
}
