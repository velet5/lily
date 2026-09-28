import * as assert from 'node:assert'
import { describe, test } from 'node:test'
import type * as vscode from 'vscode'
import {
  MidiPlayerProvider,
  midiPlayerHtml,
  type PlayerHostMessage,
  type PlayerWebviewMessage,
} from '../../src/midi/player'

// Runs without an extension host (DECISIONS D13): like the preview panel, the
// MIDI viewer only uses `vscode` types, so a fake WebviewPanel is enough.

const uri = (value: string) => ({ path: new URL(value).pathname, toString: () => value }) as vscode.Uri

class FakePanel {
  readonly posted: PlayerHostMessage[] = []
  private receive: (message: PlayerWebviewMessage) => void = () => {}
  private readonly disposeListeners: Array<() => void> = []

  readonly webview = {
    cspSource: 'https://webview.test',
    html: '',
    options: {} as vscode.WebviewOptions,
    asWebviewUri: (resource: vscode.Uri) => uri(resource.toString().replace('file://', 'https://webview.test')),
    postMessage: async (message: PlayerHostMessage) => {
      this.posted.push(message)
      return true
    },
    onDidReceiveMessage: (listener: (message: PlayerWebviewMessage) => void) => {
      this.receive = listener
      return { dispose: () => {} }
    },
  }

  onDidDispose(listener: () => void) {
    this.disposeListeners.push(listener)
    return { dispose: () => {} }
  }

  close() {
    for (const listener of this.disposeListeners.splice(0)) listener()
  }

  fromWebview(message: PlayerWebviewMessage) {
    this.receive(message)
  }

  get asPanel() {
    return this as unknown as vscode.WebviewPanel
  }
}

const settled = () => new Promise((resolve) => setImmediate(resolve))

function setup() {
  const files = new Map<string, Uint8Array>()
  const watchers = new Map<string, () => void>()
  let unwatched = 0
  const provider = new MidiPlayerProvider({
    assets: {
      root: uri('file:///ext/media'),
      script: uri('file:///ext/media/player.js'),
      midiScript: uri('file:///ext/media/midi.js'),
      style: uri('file:///ext/media/player.css'),
    },
    readFile: async (file) => {
      const bytes = files.get(file.toString())
      if (!bytes) throw new Error('ENOENT')
      return bytes
    },
    watch: (file, listener) => {
      watchers.set(file.toString(), listener)
      return { dispose: () => void unwatched++ }
    },
  })
  const open = (file: vscode.Uri) => {
    const fake = new FakePanel()
    void provider.resolveCustomEditor(provider.openCustomDocument(file), fake.asPanel)
    return fake
  }
  return { provider, files, watchers, open, unwatched: () => unwatched }
}

describe('midiPlayerHtml', () => {
  const html = midiPlayerHtml({
    cspSource: 'https://webview.test',
    nonce: 'N0nce+/=',
    scriptUri: 'https://webview.test/media/player.js',
    midiScriptUri: 'https://webview.test/media/midi.js',
    styleUri: 'https://webview.test/media/player.css',
  })

  test('the policy denies by default and allows nothing inline', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
    assert.deepStrictEqual(csp.split('; '), [
      "default-src 'none'",
      'style-src https://webview.test',
      "script-src 'nonce-N0nce+/='",
    ])
    assert.deepStrictEqual(html.match(/<script\b[^>]*>/g), [
      '<script nonce="N0nce+/=" src="https://webview.test/media/midi.js">',
      '<script nonce="N0nce+/=" src="https://webview.test/media/player.js">',
    ])
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i)
  })

  test('has every element that player.js looks up', () => {
    for (const id of ['title', 'summary', 'note', 'tracks', 'midi-play', 'midi-stop', 'midi-seek', 'midi-time']) {
      assert.match(html, new RegExp(` id="${id}"`), id)
    }
  })
})

describe('MidiPlayerProvider', () => {
  const song = uri('file:///scores/my%20song.midi')

  test('scripts are enabled and only media/ can be loaded', () => {
    const { open } = setup()
    const fake = open(song)
    assert.deepStrictEqual(Object.keys(fake.webview.options), ['enableScripts', 'localResourceRoots'])
    assert.match(fake.webview.html, /src="https:\/\/webview\.test\/ext\/media\/midi\.js"/)
  })

  test('a ready webview gets the file as base64, and again when the file is rewritten', async () => {
    const { files, watchers, open } = setup()
    files.set(song.toString(), Buffer.from('MThd-one'))
    const fake = open(song)
    assert.deepStrictEqual(fake.posted, [], 'nothing before the webview can hear it')

    fake.fromWebview({ type: 'ready' })
    await settled()
    const name = 'my%20song.midi'
    assert.deepStrictEqual(fake.posted.splice(0), [
      { type: 'midi', name, data: Buffer.from('MThd-one').toString('base64') },
    ])

    files.set(song.toString(), Buffer.from('MThd-two'))
    watchers.get(song.toString())?.()
    await settled()
    assert.deepStrictEqual(fake.posted.splice(0), [
      { type: 'midi', name, data: Buffer.from('MThd-two').toString('base64') },
    ])
  })

  test('a file that cannot be read is an error message, not an exception', async () => {
    const { open } = setup()
    const fake = open(song)
    fake.fromWebview({ type: 'ready' })
    await settled()
    assert.deepStrictEqual(fake.posted, [{ type: 'error', name: 'my%20song.midi', message: 'ENOENT' }])
  })

  test('open players are found by file, take commands and report their state', () => {
    const { provider, open } = setup()
    assert.strictEqual(provider.get(song), undefined)
    const fake = open(song)
    const player = provider.get(song)
    assert.ok(player)
    assert.strictEqual(provider.get(uri('file:///scores/other.midi')), undefined)

    player.play()
    player.play('stop')
    assert.deepStrictEqual(fake.posted, [
      { type: 'playback', action: 'toggle' },
      { type: 'playback', action: 'stop' },
    ])
    fake.fromWebview({ type: 'playback', state: 'paused', position: 2, duration: 15, blocked: false, timed: false })
    assert.deepStrictEqual(player.playback, { state: 'paused', position: 2, duration: 15, blocked: false, timed: false })
  })

  test('a closed player is forgotten, stops watching and posts nothing more', async () => {
    const { provider, files, watchers, open, unwatched } = setup()
    files.set(song.toString(), Buffer.from('MThd'))
    const fake = open(song)
    fake.close()
    assert.strictEqual(provider.get(song), undefined)
    assert.strictEqual(unwatched(), 1)
    watchers.get(song.toString())?.()
    await settled()
    assert.deepStrictEqual(fake.posted, [])
  })
})
