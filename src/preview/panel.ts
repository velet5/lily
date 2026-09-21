import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type * as vscode from 'vscode'
import type { CompileResult } from '../compile/compiler'
import {
  LinkIndex,
  canonicalFile,
  characterToChar,
  parseTextEdit,
  type SourceLocation,
} from './pointAndClick'

// The side-by-side preview (DECISIONS D4, D17). Only *types* come from `vscode`:
// the caller creates the WebviewPanel, so the lifecycle and the message protocol
// run under `node --test` against a fake panel (D13).

export const PREVIEW_VIEW_TYPE = 'lily.preview'

/** `theme` paints the score with the editor colours, `paper` black on white. */
export type PreviewColors = 'theme' | 'paper'

/** Host → webview. */
export type HostMessage =
  | { type: 'render'; revision: number; pages: string[] }
  | { type: 'status'; busy: boolean; note?: string }
  | { type: 'colors'; colors: PreviewColors }
  | { type: 'zoom'; action: ZoomAction }
  | { type: 'page'; action: PageAction }
  /** The links to mark as the cursor's; `reveal` scrolls the first one into view. */
  | { type: 'highlight'; hrefs: string[]; reveal: boolean }
  /** What the score sounds like: a MIDI file as base64, or null when it has none (D24). */
  | { type: 'midi'; data: string | null }
  | { type: 'playback'; action: PlaybackAction }

/** Webview → host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'rendered'; revision: number; pages: number }
  /** A `textedit:` link was clicked. */
  | { type: 'reveal'; href: string }
  /** Answers every `highlight` with the number of elements now marked. */
  | { type: 'highlighted'; elements: number }
  /** What the toolbar shows, whenever it changes: 1-based page, page count, zoom. */
  | ({ type: 'view' } & PreviewView)
  /** A toolbar button that only the host can act on. */
  | { type: 'command'; command: ToolbarCommand }
  /** The player, whenever its state changes; the position is not reported as it runs. */
  | ({ type: 'playback' } & PreviewPlayback)

export type ZoomAction = 'in' | 'out' | 'fit'
export type PageAction = 'next' | 'previous'
/** `toggle` is play or pause, whichever applies. */
export type PlaybackAction = 'play' | 'toggle' | 'stop'

/** The webview names one of these, never a VS Code command (D20). */
export const TOOLBAR_COMMANDS = ['refresh', 'exportPdf', 'exportMidi'] as const
export type ToolbarCommand = (typeof TOOLBAR_COMMANDS)[number]

export interface PreviewView {
  /** 0 while there are no pages. */
  page: number
  pages: number
  /** 1 is fit-width. */
  zoom: number
}

export interface PreviewPlayback {
  state: 'stopped' | 'playing' | 'paused'
  /** Seconds. */
  position: number
  duration: number
  /** Play was asked for, and the webview may not make sound before a click in it. */
  blocked: boolean
}

/** Where the editor's cursor is, in the editor's own terms. */
export interface EditorCursor {
  file: string
  /** 0-based. */
  line: number
  /** 0-based, UTF-16. */
  character: number
  lineText: string
}

export interface PreviewAssets {
  /** The only directory the webview may load from. */
  root: vscode.Uri
  script: vscode.Uri
  /** The parser, synthesizer and player that the MIDI viewer uses too (D24). */
  midiScript: vscode.Uri
  style: vscode.Uri
}

export interface PreviewHtmlOptions {
  cspSource: string
  nonce: string
  scriptUri: string
  /** media/midi.js, which the script expects to be loaded before it (D24). */
  midiScriptUri: string
  styleUri: string
  colors: PreviewColors
}

/**
 * The document never changes after creation; pages arrive as messages. Nothing
 * inline is allowed: a score's SVG is untrusted input (it may come from a
 * downloaded .ly file), so scripts run by nonce only and styles only from our
 * stylesheet. LilyPond's own inline `<style>` and `style=""` are therefore
 * inert, and media/preview.css restates them.
 */
export function previewHtml(options: PreviewHtmlOptions): string {
  const { cspSource, nonce } = options
  const csp = [
    "default-src 'none'",
    // \image embeds bitmaps as data: URIs.
    'img-src data:',
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attribute(options.styleUri)}">
<title>LilyPond Preview</title>
</head>
<body data-colors="${attribute(options.colors)}">
<div id="progress" hidden></div>
<main id="pages"></main>
<p id="empty"></p>
<p id="note" role="status" hidden></p>
<div id="toolbar" role="toolbar" aria-label="Preview">
<button id="refresh" type="button" title="Refresh Preview" aria-label="Refresh Preview">&#x21bb;</button>
<span id="pager" class="group" hidden>
<button id="page-previous" type="button" title="Previous Page" aria-label="Previous Page">&lsaquo;</button>
<span id="page-label"></span>
<button id="page-next" type="button" title="Next Page" aria-label="Next Page">&rsaquo;</button>
</span>
<span class="spacer"></span>
<span class="group">
<button id="zoom-out" type="button" title="Zoom Out (-)" aria-label="Zoom Out">&minus;</button>
<button id="zoom-fit" type="button" title="Fit Width (0)">Fit</button>
<button id="zoom-in" type="button" title="Zoom In (+)" aria-label="Zoom In">+</button>
</span>
<span class="spacer"></span>
<span id="player" class="group">
<button id="midi-play" type="button" disabled>&#x25B6;&#xFE0E;</button>
<button id="midi-stop" type="button" title="Stop" aria-label="Stop" disabled>&#x25A0;&#xFE0E;</button>
<input id="midi-seek" type="range" min="0" max="1000" value="0" aria-label="Playback position" disabled>
<span id="midi-time"></span>
</span>
<span class="spacer"></span>
<span class="group">
<button id="export-pdf" type="button" title="Export PDF next to the source">PDF</button>
<button id="export-midi" type="button" title="Export MIDI next to the source">MIDI</button>
</span>
</div>
<script nonce="${attribute(nonce)}" src="${attribute(options.midiScriptUri)}"></script>
<script nonce="${attribute(nonce)}" src="${attribute(options.scriptUri)}"></script>
</body>
</html>
`
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export interface PreviewPanelOptions {
  assets: PreviewAssets
  colors: PreviewColors
  onDidDispose?: () => void
  /** A `textedit:` link of the score was clicked (D19). */
  onDidClickSource?: (location: SourceLocation) => void
  /** A toolbar button asked for something only the host can do (D20). */
  onDidRequestCommand?: (command: ToolbarCommand) => void
}

/** One preview of one root file. Holds the SVG text, not the paths (D15). */
export class PreviewPanel {
  /** The pages on screen; kept when a later run produces none. */
  private pages: string[] | undefined
  private revision = 0
  /** What the webview last reported as drawn. */
  private rendered: { revision: number; pages: number } | undefined
  private waiters: Array<(pages: number) => void> = []
  /** Compiles in flight that this panel follows. */
  private pending = 0
  private note: string | undefined
  private latestUpdate = 0
  private disposed = false
  private colors: PreviewColors
  /** Where the pages on screen came from, and the cursor shown in them (D19). */
  private links = LinkIndex.empty
  private cursor: SourceLocation | undefined
  /** The link just clicked here; the cursor it moves must not scroll the score. */
  private clicked: SourceLocation | undefined
  /** Whether the webview was last told to mark something, and what it then marked. */
  private marking = false
  private marked = 0
  private shown: PreviewView | undefined
  /** The MIDI file of the run on screen, as base64 (D24). */
  private midi: string | undefined
  private player: PreviewPlayback | undefined
  /** play() found the webview hidden; it starts once it is back. */
  private playWhenReady = false
  private readonly subscriptions: vscode.Disposable[]

  constructor(
    readonly rootFile: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly options: PreviewPanelOptions,
  ) {
    const { webview } = panel
    this.colors = options.colors
    webview.options = { enableScripts: true, localResourceRoots: [options.assets.root] }
    this.subscriptions = [
      webview.onDidReceiveMessage((message: WebviewMessage) => this.receive(message)),
      panel.onDidDispose(() => this.dispose()),
    ]
    webview.html = previewHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(options.assets.script).toString(),
      midiScriptUri: webview.asWebviewUri(options.assets.midiScript).toString(),
      styleUri: webview.asWebviewUri(options.assets.style).toString(),
      colors: options.colors,
    })
  }

  get hasPages(): boolean {
    return this.pages !== undefined
  }

  /** How many elements the webview has marked as the cursor's. */
  get highlighted(): number {
    return this.marked
  }

  /** What the webview's toolbar last reported; undefined until it has. */
  get view(): PreviewView | undefined {
    return this.shown
  }

  /** Whether the last compile wrote a MIDI file, which takes a `\midi` block. */
  get hasMidi(): boolean {
    return this.midi !== undefined
  }

  /** What the webview's player last reported; undefined until it has. */
  get playback(): PreviewPlayback | undefined {
    return this.player
  }

  /** Whether this is the tab the user is in. */
  get active(): boolean {
    return this.panel.active
  }

  /** Undefined while the panel is hidden behind another tab of its group. */
  get viewColumn(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn
  }

  /** Brings the panel forward in its own column; the editor keeps the focus. */
  reveal(): void {
    this.panel.reveal(undefined, true)
  }

  /**
   * Shows the panel as busy until `run` settles, then renders its result. `run`
   * must not reject (`CompileReporter.run` never does); undefined means the
   * compile could not run at all.
   */
  async follow(run: Promise<CompileResult | undefined>): Promise<void> {
    this.pending++
    this.postStatus()
    let result: CompileResult | undefined
    try {
      result = await run
    } finally {
      this.pending--
    }
    await this.update(result)
    this.postStatus()
  }

  /** Resolves with the page count once the webview has drawn the latest render. */
  whenRendered(): Promise<number> {
    if (this.rendered && this.rendered.revision === this.revision) {
      return Promise.resolve(this.rendered.pages)
    }
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  setColors(colors: PreviewColors): void {
    this.colors = colors
    this.post({ type: 'colors', colors })
  }

  zoom(action: ZoomAction): void {
    this.post({ type: 'zoom', action })
  }

  /** Scrolls to the top of the next or the previous page. */
  page(action: PageAction): void {
    this.post({ type: 'page', action })
  }

  /** Plays, pauses or stops the score's MIDI in the webview, which is where the sound is made. */
  play(action: PlaybackAction = 'toggle'): void {
    if (action !== 'stop' && !this.panel.visible) {
      // A hidden webview is destroyed; the new one says `ready` and is told then.
      this.playWhenReady = true
      this.reveal()
      return
    }
    this.post({ type: 'playback', action })
  }

  /**
   * Marks what the cursor points at, or nothing. `cursor.file` is canonical
   * (canonicalFile). `reveal` also scrolls the element into view; a refresh
   * re-marks without it, so it never fights the restored scroll position.
   */
  showCursor(cursor: SourceLocation | undefined, reveal = true): void {
    // The clicked note is under the mouse already, even when cut off by the edge.
    const { clicked } = this
    this.clicked = undefined
    if (clicked && cursor?.line === clicked.line && cursor.char === clicked.char) reveal = false
    this.cursor = cursor
    const hrefs = cursor ? this.links.lookup(cursor.file, cursor.line, cursor.char) : []
    // Moving through a file this score does not use is not worth a message each.
    if (hrefs.length === 0 && !this.marking) return
    this.marking = hrefs.length > 0
    this.post({ type: 'highlight', hrefs, reveal })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const subscription of this.subscriptions) subscription.dispose()
    this.panel.dispose()
    this.options.onDidDispose?.()
  }

  private async update(result: CompileResult | undefined): Promise<void> {
    // A superseded run shows nothing; its successor is followed too.
    if (result?.cancelled) return
    if (!result) {
      this.note = 'LilyPond could not be run. See the LilyPond output.'
      return
    }

    const update = ++this.latestUpdate
    let pages: string[]
    let midi: string | undefined
    try {
      // Now: the run's directory is deleted when the next one completes (D15).
      pages = await Promise.all(result.pages.map((page) => fs.readFile(page, 'utf8')))
      // Several \score blocks with \midi write several files; the first is the one heard.
      const [first] = result.midi
      if (first !== undefined) midi = await fs.readFile(first, 'base64')
    } catch {
      return
    }
    const links = await LinkIndex.build(pages)
    if (update !== this.latestUpdate || this.disposed) return

    // A failed run that wrote no MIDI keeps the previous one, as it keeps the pages.
    if ((midi !== undefined || result.ok) && midi !== this.midi) {
      this.midi = midi
      this.post({ type: 'midi', data: midi ?? null })
    }
    if (pages.length > 0) {
      this.pages = pages
      this.links = links
      this.revision++
      this.post({ type: 'render', revision: this.revision, pages })
      // The new page nodes carry no mark, and the links may have moved.
      this.marking = false
      this.marked = 0
      this.showCursor(this.cursor, false)
      this.note = result.ok ? undefined : 'Compiled with errors. See the Problems panel.'
    } else if (!result.ok) {
      // Keep the previous render (ARCHITECTURE §3.3).
      this.note = this.pages
        ? 'Compile failed. Showing the last successful render.'
        : 'Compile failed. See the Problems panel.'
    } else {
      this.note = 'LilyPond produced no pages.'
    }
  }

  private receive(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        // Sent on every (re)load: a hidden webview is destroyed, not retained.
        this.post({ type: 'colors', colors: this.colors })
        if (this.pages) this.post({ type: 'render', revision: this.revision, pages: this.pages })
        this.post({ type: 'midi', data: this.midi ?? null })
        this.postStatus()
        if (this.playWhenReady) this.post({ type: 'playback', action: 'play' })
        this.playWhenReady = false
        this.marking = false
        this.marked = 0
        this.showCursor(this.cursor, false)
        break
      case 'rendered':
        this.rendered = { revision: message.revision, pages: message.pages }
        if (message.revision === this.revision) {
          for (const resolve of this.waiters.splice(0)) resolve(message.pages)
        }
        break
      case 'reveal': {
        // The href comes from the score, so it is parsed here, not trusted.
        const location = typeof message.href === 'string' && parseTextEdit(message.href)
        if (!location) break
        this.clicked = location
        this.options.onDidClickSource?.(location)
        break
      }
      case 'highlighted':
        this.marked = Number(message.elements) || 0
        break
      case 'view':
        this.shown = {
          page: Number(message.page) || 0,
          pages: Number(message.pages) || 0,
          zoom: Number(message.zoom) || 1,
        }
        break
      case 'playback':
        this.player = {
          state: message.state === 'playing' || message.state === 'paused' ? message.state : 'stopped',
          position: Number(message.position) || 0,
          duration: Number(message.duration) || 0,
          blocked: message.blocked === true,
        }
        break
      case 'command':
        if (TOOLBAR_COMMANDS.includes(message.command)) {
          this.options.onDidRequestCommand?.(message.command)
        }
        break
    }
  }

  private postStatus(): void {
    this.post({ type: 'status', busy: this.pending > 0, note: this.note })
  }

  private post(message: HostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(message)
  }
}

export interface PreviewHost {
  assets: PreviewAssets
  /** Read on every open, never cached (D9). */
  colors(): PreviewColors
  /** Creates the panel beside the editor without taking the focus. */
  createPanel(title: string): vscode.WebviewPanel
  onDidClose?(rootFile: string): void
  /** Shows `location` in an editor; `preview` is where the click happened. */
  revealSource?(location: SourceLocation, preview: PreviewPanel): void
  /** Carries out what a button of `preview`'s toolbar asked for. */
  runToolbarCommand?(command: ToolbarCommand, preview: PreviewPanel): void
}

/** How long the cursor has to rest before the previews follow it. */
export const CURSOR_DELAY_MS = 100

/** One panel per root file (D4). */
export class PreviewManager {
  private readonly panels = new Map<string, PreviewPanel>()
  private cursorTimer: NodeJS.Timeout | undefined
  private cursorRequests = 0

  constructor(private readonly host: PreviewHost) {}

  /** Creates the preview of `rootFile`, or reveals the one that exists. */
  open(rootFile: string): { preview: PreviewPanel; created: boolean } {
    const key = panelKey(rootFile)
    const existing = this.panels.get(key)
    if (existing) {
      existing.reveal()
      return { preview: existing, created: false }
    }
    const preview = new PreviewPanel(
      path.resolve(rootFile),
      this.host.createPanel(`Preview ${path.basename(rootFile)}`),
      {
        assets: this.host.assets,
        colors: this.host.colors(),
        onDidDispose: () => {
          this.panels.delete(key)
          this.host.onDidClose?.(preview.rootFile)
        },
        onDidClickSource: (location) => this.host.revealSource?.(location, preview),
        onDidRequestCommand: (command) => this.host.runToolbarCommand?.(command, preview),
      },
    )
    this.panels.set(key, preview)
    return { preview, created: true }
  }

  get(rootFile: string): PreviewPanel | undefined {
    return this.panels.get(panelKey(rootFile))
  }

  /** The preview whose tab the user is in. */
  get active(): PreviewPanel | undefined {
    return [...this.panels.values()].find((preview) => preview.active)
  }

  /**
   * The preview a command without an argument is about: the active one, else
   * that of `file` (the active editor's), else the only one there is.
   */
  target(file?: string): PreviewPanel | undefined {
    return (
      this.active ??
      (file === undefined ? undefined : this.get(file)) ??
      (this.panels.size === 1 ? [...this.panels.values()][0] : undefined)
    )
  }

  /** Root files of the open previews. */
  roots(): string[] {
    return [...this.panels.values()].map((preview) => preview.rootFile)
  }

  setColors(colors: PreviewColors): void {
    for (const preview of this.panels.values()) preview.setColors(colors)
  }

  /** showCursor() once the cursor rests: holding an arrow key is one lookup. */
  followCursor(cursor: EditorCursor | undefined): void {
    clearTimeout(this.cursorTimer)
    this.cursorTimer = setTimeout(() => void this.showCursor(cursor), CURSOR_DELAY_MS)
  }

  /** Marks the element under `cursor` in every preview that has one; undefined clears. */
  async showCursor(cursor: EditorCursor | undefined): Promise<void> {
    clearTimeout(this.cursorTimer)
    const request = ++this.cursorRequests
    const location = cursor && {
      file: await canonicalFile(cursor.file),
      line: cursor.line + 1,
      char: characterToChar(cursor.lineText, cursor.character),
    }
    // A later cursor must not be overtaken by this one's realpath.
    if (request !== this.cursorRequests) return
    for (const preview of this.panels.values()) preview.showCursor(location)
  }

  dispose(): void {
    clearTimeout(this.cursorTimer)
    for (const preview of [...this.panels.values()]) preview.dispose()
  }
}

function panelKey(rootFile: string): string {
  const resolved = path.resolve(rootFile)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
