import { randomBytes } from 'node:crypto'
import type * as vscode from 'vscode'
import type { PlaybackAction, PreviewPlayback } from '../preview/panel'

// The viewer of `.mid` / `.midi` files (DECISIONS D24): a custom editor whose
// webview plays the file with media/midi.js, as the preview plays its score.
// Only *types* come from `vscode`, as in preview/panel.ts: extension.ts registers
// the provider and lends it the file system, so it runs under `node --test`.

export const MIDI_PLAYER_VIEW_TYPE = 'lily.midiPlayer'

/** Host → webview. */
export type PlayerHostMessage =
  /** The file as base64; sent again whenever it is rewritten. */
  | { type: 'midi'; name: string; data: string }
  | { type: 'error'; name: string; message: string }
  | { type: 'playback'; action: PlaybackAction }

/** Webview → host. */
export type PlayerWebviewMessage =
  | { type: 'ready' }
  /** Whenever the state changes, as the preview reports it. */
  | ({ type: 'playback' } & PreviewPlayback)

export interface MidiPlayerAssets {
  /** The only directory the webview may load from. */
  root: vscode.Uri
  script: vscode.Uri
  midiScript: vscode.Uri
  style: vscode.Uri
}

export interface MidiPlayerHost {
  assets: MidiPlayerAssets
  readFile(uri: vscode.Uri): PromiseLike<Uint8Array>
  /** Calls `listener` when the file at `uri` was written, e.g. by the next export. */
  watch(uri: vscode.Uri, listener: () => void): vscode.Disposable
}

export interface MidiPlayerHtmlOptions {
  cspSource: string
  nonce: string
  scriptUri: string
  midiScriptUri: string
  styleUri: string
}

/** The policy of the preview (D17), less the images: a MIDI file's texts are shown as text. */
export function midiPlayerHtml(options: MidiPlayerHtmlOptions): string {
  const { cspSource, nonce } = options
  const csp = ["default-src 'none'", `style-src ${cspSource}`, `script-src 'nonce-${nonce}'`].join('; ')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${attribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attribute(options.styleUri)}">
<title>MIDI Player</title>
</head>
<body>
<main>
<h1 id="title"></h1>
<p id="summary"></p>
<div id="transport" role="toolbar" aria-label="Playback">
<button id="midi-play" type="button" disabled>&#x25B6;&#xFE0E;</button>
<button id="midi-stop" type="button" title="Stop" aria-label="Stop" disabled>&#x25A0;&#xFE0E;</button>
<input id="midi-seek" type="range" min="0" max="1000" value="0" aria-label="Playback position" disabled>
<span id="midi-time"></span>
</div>
<p id="note" role="status" hidden></p>
<table id="tracks" hidden>
<thead><tr><th>Track</th><th>Instrument</th><th>Notes</th></tr></thead>
<tbody></tbody>
</table>
</main>
<script nonce="${attribute(nonce)}" src="${attribute(options.midiScriptUri)}"></script>
<script nonce="${attribute(nonce)}" src="${attribute(options.scriptUri)}"></script>
</body>
</html>
`
}

function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function baseName(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1)
}

/** One open tab of one MIDI file. */
export class MidiPlayerPanel {
  private player: PreviewPlayback | undefined
  private reads = 0
  private disposed = false
  private readonly subscriptions: vscode.Disposable[]

  constructor(
    readonly uri: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
    private readonly host: MidiPlayerHost,
    onDidDispose: () => void,
  ) {
    const { webview } = panel
    const { assets } = host
    webview.options = { enableScripts: true, localResourceRoots: [assets.root] }
    this.subscriptions = [
      // Sent on every (re)load: a hidden webview is destroyed, not retained.
      webview.onDidReceiveMessage((message: PlayerWebviewMessage) => this.receive(message)),
      host.watch(uri, () => void this.send()),
      panel.onDidDispose(() => {
        this.disposed = true
        for (const subscription of this.subscriptions) subscription.dispose()
        onDidDispose()
      }),
    ]
    webview.html = midiPlayerHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(assets.script).toString(),
      midiScriptUri: webview.asWebviewUri(assets.midiScript).toString(),
      styleUri: webview.asWebviewUri(assets.style).toString(),
    })
  }

  /** What the webview's player last reported; undefined until it has. */
  get playback(): PreviewPlayback | undefined {
    return this.player
  }

  play(action: PlaybackAction = 'toggle'): void {
    this.post({ type: 'playback', action })
  }

  private receive(message: PlayerWebviewMessage): void {
    if (message.type === 'ready') {
      void this.send()
    } else if (message.type === 'playback') {
      this.player = {
        state: message.state === 'playing' || message.state === 'paused' ? message.state : 'stopped',
        position: Number(message.position) || 0,
        duration: Number(message.duration) || 0,
        blocked: message.blocked === true,
      }
    }
  }

  private async send(): Promise<void> {
    const read = ++this.reads
    const name = baseName(this.uri)
    let message: PlayerHostMessage
    try {
      const bytes = await this.host.readFile(this.uri)
      message = { type: 'midi', name, data: Buffer.from(bytes).toString('base64') }
    } catch (error) {
      message = { type: 'error', name, message: error instanceof Error ? error.message : String(error) }
    }
    // An export writes the file more than once; only the last read counts.
    if (read === this.reads) this.post(message)
  }

  private post(message: PlayerHostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(message)
  }
}

/** Opens `.mid` and `.midi` files in a player instead of "the file is binary". */
export class MidiPlayerProvider implements vscode.CustomReadonlyEditorProvider {
  private readonly panels = new Set<MidiPlayerPanel>()

  constructor(private readonly host: MidiPlayerHost) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} }
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const player: MidiPlayerPanel = new MidiPlayerPanel(document.uri, panel, this.host, () =>
      this.panels.delete(player),
    )
    this.panels.add(player)
  }

  /** An open player of `uri`. */
  get(uri: vscode.Uri): MidiPlayerPanel | undefined {
    const wanted = uri.toString()
    return [...this.panels].find((player) => player.uri.toString() === wanted)
  }
}
