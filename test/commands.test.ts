import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pkg from '../package.json'
import type { ExportResult } from '../src/compile/compiler'
import { locateLilyPond } from '../src/compile/locate'
import type { LilyApi } from '../src/extension'
import type { PreviewPanel, PreviewPlayback, PreviewView } from '../src/preview/panel'

const extension = () => vscode.extensions.getExtension<LilyApi>(`${pkg.publisher}.${pkg.name}`)!

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the test run must open test/fixtures as its workspace')
  return vscode.Uri.file(path.join(folder.uri.fsPath, name))
}

suite('command surface: the manifest', () => {
  const { commands, menus, keybindings } = pkg.contributes
  const contributed = commands.map((entry) => entry.command)

  test('every contributed command is registered, and nothing else is', async () => {
    await extension().activate()
    const registered = (await vscode.commands.getCommands(true)).filter((id) => id.startsWith('lily.'))
    assert.deepStrictEqual(registered.sort(), [...contributed].sort())
  })

  test('menus and keybindings only name contributed commands, each behind a when clause', () => {
    const entries = [...Object.values(menus).flat(), ...keybindings]
    assert.ok(entries.length > 0)
    for (const entry of entries) {
      assert.ok(contributed.includes(entry.command), entry.command)
      assert.ok(entry.when, `${entry.command} would show up everywhere`)
    }
  })

  test('every command is reachable from the palette only where it can work', () => {
    const limited = menus.commandPalette.map((entry) => entry.command)
    // Show Output works anywhere.
    assert.deepStrictEqual(
      contributed.filter((command) => !limited.includes(command)),
      ['lily.showOutput'],
    )
  })

  test('every command has an icon, and icon files exist', async () => {
    for (const { command, icon } of commands) {
      assert.ok(icon, command)
      if (typeof icon === 'string') {
        assert.match(icon, /^\$\([a-z-]+\)$/, command)
        continue
      }
      for (const file of [icon.light, icon.dark]) {
        const svg = await fs.readFile(path.join(extension().extensionPath, file), 'utf8')
        assert.match(svg, /^<svg /, file)
      }
    }
  })
})

suite('command surface: preview and export', () => {
  let api: LilyApi
  let scratch: string

  suiteSetup(async function () {
    // Needs the real binary; skip, rather than fail, without it (DECISIONS D15).
    const installed = await locateLilyPond().then(
      () => true,
      () => false,
    )
    if (!installed) this.skip()
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-test-'))
    api = await extension().activate()
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  })

  /** Waits for the real webview's toolbar to report `expected`. */
  async function view(file: string, expected: Partial<PreviewView>): Promise<void> {
    const matches = () => {
      const shown = api.previews.get(file)?.view
      return Object.entries(expected).every(([key, value]) => shown?.[key as keyof PreviewView] === value)
    }
    const deadline = Date.now() + 5000
    while (!matches() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.deepStrictEqual({ ...api.previews.get(file)?.view }, { ...api.previews.get(file)?.view, ...expected })
  }

  test('zoom and page commands drive the preview while the editor keeps the focus', async () => {
    const uri = fixture('pages.ly')
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One })
    await vscode.commands.executeCommand('lily.preview.openToSide')
    assert.strictEqual(await api.previews.get(uri.fsPath)?.whenRendered(), 2)
    await view(uri.fsPath, { page: 1, pages: 2, zoom: 1 })

    await vscode.commands.executeCommand('lily.preview.zoomIn')
    await view(uri.fsPath, { zoom: 1.1 })
    await vscode.commands.executeCommand('lily.preview.zoomOut')
    await vscode.commands.executeCommand('lily.preview.zoomOut')
    await view(uri.fsPath, { zoom: 0.9 })
    await vscode.commands.executeCommand('lily.preview.zoomFit')
    await view(uri.fsPath, { zoom: 1 })

    await vscode.commands.executeCommand('lily.preview.nextPage')
    await view(uri.fsPath, { page: 2 })
    await vscode.commands.executeCommand('lily.preview.previousPage')
    await view(uri.fsPath, { page: 1 })
    assert.strictEqual(vscode.window.activeTextEditor?.document, editor.document)
  })

  test('Refresh Preview recompiles the only preview from an editor of another file', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const file = path.join(scratch, 'refreshed.ly')
    await fs.writeFile(file, '\\version "2.24.0"\n{ c4 d e f }\n')
    // An editor first, so the preview opens beside it and is not covered by the next one.
    await vscode.window.showTextDocument(fixture('hello.ly'), { viewColumn: vscode.ViewColumn.One })
    await vscode.commands.executeCommand('lily.preview.openToSide', vscode.Uri.file(file))
    const preview = api.previews.get(file)
    assert.strictEqual(await preview?.whenRendered(), 1)

    await vscode.window.showTextDocument(fixture('melody.ily'), { viewColumn: vscode.ViewColumn.One })
    await fs.writeFile(file, '\\version "2.24.0"\n{ c4 d e f \\pageBreak g1 }\n')
    await vscode.commands.executeCommand('lily.preview.refresh')
    assert.strictEqual(await preview?.whenRendered(), 2)
  })

  test('Export PDF writes next to the source and leaves the preview alone', async () => {
    const file = path.join(scratch, 'refreshed.ly')
    const result = await vscode.commands.executeCommand<ExportResult>(
      'lily.export.pdf',
      vscode.Uri.file(file),
    )
    assert.deepStrictEqual(result.exported, [path.join(scratch, 'refreshed.pdf')])
    assert.deepStrictEqual((await fs.readdir(scratch)).sort(), ['refreshed.ly', 'refreshed.pdf'])
    assert.strictEqual(await api.previews.get(file)?.whenRendered(), 2, 'still the two pages')
  })

  test('Export MIDI copies what \\midi wrote, and says so when there is none', async () => {
    const silent = await vscode.commands.executeCommand<ExportResult>(
      'lily.export.midi',
      vscode.Uri.file(path.join(scratch, 'refreshed.ly')),
    )
    assert.deepStrictEqual([silent.ok, silent.exported], [true, []])

    const file = path.join(scratch, 'audible.ly')
    await fs.writeFile(file, '\\version "2.24.0"\n\\score { { c4 d e f } \\layout { } \\midi { } }\n')
    const audible = await vscode.commands.executeCommand<ExportResult>(
      'lily.export.midi',
      vscode.Uri.file(file),
    )
    assert.deepStrictEqual(audible.exported, [path.join(scratch, 'audible.midi')])
    assert.strictEqual((await fs.readFile(audible.exported[0])).subarray(0, 4).toString(), 'MThd')
  })

  /** Waits for a webview's player to report what `accept` wants. */
  async function playback(
    read: () => PreviewPlayback | undefined,
    what: string,
    accept: (state: PreviewPlayback) => boolean,
  ): Promise<PreviewPlayback> {
    const deadline = Date.now() + 5000
    let shown = read()
    while (!(shown && accept(shown)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      shown = read()
    }
    assert.ok(shown && accept(shown), `${what}; the player reports ${JSON.stringify(shown)}`)
    return shown
  }

  /** Sound needs a click in the webview; from a test, having asked for it is as far as it goes. */
  const asked = (state: PreviewPlayback) => state.state === 'playing' || state.blocked

  test('Play MIDI opens the preview of a score and plays it; a score without \\midi is told so', async () => {
    const file = path.join(scratch, 'audible.ly')
    const preview = await vscode.commands.executeCommand<PreviewPanel | undefined>(
      'lily.midi.play',
      vscode.Uri.file(file),
    )
    assert.ok(preview, 'no preview was opened')
    assert.strictEqual(preview.hasMidi, true)
    // Four crotchets at lilypond's default tempo: media/midi.js parsed what the compile wrote.
    await playback(() => preview.playback, 'play', (s) => s.duration === 4 && asked(s))

    await vscode.commands.executeCommand('lily.midi.stop', vscode.Uri.file(file))
    await playback(() => preview.playback, 'stop', (s) => s.state === 'stopped' && s.position === 0)

    const silent = await vscode.commands.executeCommand<PreviewPanel | undefined>(
      'lily.midi.play',
      vscode.Uri.file(path.join(scratch, 'refreshed.ly')),
    )
    assert.strictEqual(silent, undefined)
  })

  test('an exported MIDI file opens in the player, which plays it', async () => {
    const uri = vscode.Uri.file(path.join(scratch, 'audible.midi'))
    await vscode.commands.executeCommand('vscode.openWith', uri, 'lily.midiPlayer')
    const player = api.midiPlayers.get(uri)
    assert.ok(player, 'the custom editor was not resolved')
    await playback(() => player.playback, 'load', (s) => s.state === 'stopped' && s.duration === 4)
    player.play()
    await playback(() => player.playback, 'play', asked)
    player.play('stop')
    await playback(() => player.playback, 'stop', (s) => s.state === 'stopped')
  })
})
