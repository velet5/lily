import * as assert from 'node:assert'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pkg from '../../package.json'
import type { LilyApi } from '../../src/extension'
import type { CheckReport } from '../../tools/lily-check/check'

// The release pass (DECISIONS D23): `npm run test:e2e` packages the VSIX, unpacks
// it and starts the host with the unpacked copy as the extension. Everything
// below therefore runs on the files a user would install, so a wrong
// .vscodeignore fails here and nowhere else. Only types come from src/.
//
// Unlike the other suites, this one does not skip without lilypond: a release
// that was never compiled with has not been checked.

const extension = () => vscode.extensions.getExtension<LilyApi>(`${pkg.publisher}.${pkg.name}`)!

const pause = (ms: number) => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))

async function eventually<T>(what: string, probe: () => T | undefined | false, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await pause(50)
  }
}

/** Replaces the whole text through the editor, as typing would, and saves it. */
async function rewrite(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit()
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text)
  assert.ok(await vscode.workspace.applyEdit(edit))
  assert.ok(await document.save())
}

suite('release smoke pass on the packaged extension', () => {
  let api: LilyApi
  let scratch: string
  let score: string

  suiteSetup(async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]
    assert.ok(folder, 'the run must open test/e2e/workspace')
    // A copy, because the pass edits and exports next to the score.
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-e2e-'))
    score = path.join(scratch, 'score.ly')
    await fs.copyFile(path.join(folder.uri.fsPath, 'score.ly'), score)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  })

  test('the host runs the unpacked VSIX, which holds what it needs and no sources', async () => {
    const root = extension().extensionPath
    assert.match(root, /[\\/]\.vscode-test[\\/]vsix[\\/]extension$/)
    const shipped = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    assert.strictEqual(shipped.version, pkg.version, 'a stale VSIX; run npm run test:e2e')

    const entries = (await fs.readdir(root, { recursive: true })).map((entry) => entry.replaceAll('\\', '/'))
    for (const needed of [
      'dist/extension.js',
      'dist/lily-check.js',
      'data/completions.json',
      'syntaxes/lilypond.tmLanguage.json',
      'snippets/lilypond.json',
      'language-configuration.json',
      'media/preview.js',
      'media/preview.css',
      'media/midi.js',
      'media/player.js',
      'media/player.css',
      'media/icons/preview.svg',
      'media/icons/preview-dark.svg',
    ]) {
      assert.ok(entries.includes(needed), `${needed} is missing from the VSIX`)
    }
    // vsce renames these three (readme.md, changelog.md, LICENSE.txt).
    const renamed = (name: string) => entries.find((entry) => entry.toLowerCase() === name)
    for (const needed of ['readme.md', 'changelog.md', 'license.txt']) {
      assert.ok(renamed(needed), `${needed} is missing from the VSIX`)
    }
    const unwanted = entries.filter((entry) =>
      /^(src|test|tools|scripts|out|node_modules|\.github|\.vscode)\/|\.map$|\.ts$/.test(entry),
    )
    assert.deepStrictEqual(unwanted, [])
    // Every image the README shows travels with it (links are not rewritten).
    const readme = await fs.readFile(path.join(root, renamed('readme.md')!), 'utf8')
    // The README spells out where the installed checker is.
    assert.ok(readme.includes(`${pkg.publisher}.${pkg.name}-${pkg.version}/dist/lily-check.js`))
    const images = [...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1])
    for (const image of images.filter((link) => !/^https?:/.test(link))) {
      assert.ok(entries.includes(image), `README shows ${image}, which is not in the VSIX`)
    }
  })

  test('opening the score activates the extension and the preview draws both pages beside it', async () => {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(score), {
      viewColumn: vscode.ViewColumn.One,
    })
    assert.strictEqual(editor.document.languageId, 'lilypond')
    api = await extension().activate()

    await vscode.commands.executeCommand('lily.preview.openToSide')
    const preview = api.previews.get(score)
    assert.ok(preview, 'no preview was registered for the score')
    // Reported by the webview: the shipped media/preview.js drew the pages.
    assert.strictEqual(await preview.whenRendered(), 2)
    assert.strictEqual(preview.viewColumn, vscode.ViewColumn.Two)
    assert.strictEqual(vscode.window.activeTextEditor?.document, editor.document)
    assert.deepStrictEqual(vscode.languages.getDiagnostics(vscode.Uri.file(score)), [])
  })

  test('completion and hover answer from the shipped data', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'lilypond', content: '\\new ' })
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One })
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      document.uri,
      new vscode.Position(0, 5),
      ' ',
    )
    const labels = list.items.map((item) => (typeof item.label === 'string' ? item.label : item.label.label))
    assert.ok(labels.includes('PianoStaff'), 'contexts are not offered after \\new')

    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      new vscode.Position(0, 2),
    )
    assert.ok(hovers.length > 0, '\\new has no hover')
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  })

  test('saving a mistake marks it in the source, and saving the fix clears it and redraws', async () => {
    const uri = vscode.Uri.file(score)
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One })
    const good = editor.document.getText()
    const preview = api.previews.get(score)
    assert.ok(preview)

    await rewrite(editor.document, good.replace('g4 a b |', 'g4 a \\stacato b |'))
    const [problem] = await eventually('the diagnostic', () => {
      const found = vscode.languages.getDiagnostics(uri)
      return found.length > 0 && found
    })
    assert.strictEqual(problem.severity, vscode.DiagnosticSeverity.Error)
    assert.strictEqual(editor.document.getText(problem.range), '\\stacato')

    await rewrite(editor.document, good)
    await eventually('the diagnostics to clear', () => vscode.languages.getDiagnostics(uri).length === 0)
    assert.strictEqual(await preview.whenRendered(), 2)
  })

  test('PDF and MIDI are exported next to the score, and nothing else is written there', async () => {
    for (const format of ['pdf', 'midi']) {
      const result = await vscode.commands.executeCommand<{ ok: boolean; exported: string[] }>(
        `lily.export.${format}`,
        vscode.Uri.file(score),
      )
      assert.deepStrictEqual([result.ok, result.exported], [true, [path.join(scratch, `score.${format}`)]])
    }
    assert.deepStrictEqual((await fs.readdir(scratch)).sort(), ['score.ly', 'score.midi', 'score.pdf'])
  })

  test('the score plays in its preview, and the exported MIDI file in a player of its own', async () => {
    // Sound needs a click in the webview; from a test, asking for it is as far as it goes.
    const asked = (state: { state: string; blocked: boolean } | undefined) =>
      state !== undefined && (state.state === 'playing' || state.blocked)
    const preview = api.previews.get(score)
    assert.ok(preview)
    await vscode.commands.executeCommand('lily.midi.play', vscode.Uri.file(score))
    // Eight bars of 3/4 at 96: the shipped media/midi.js read the file the compile wrote.
    await eventually('the preview to play', () => preview.playback?.duration === 15 && asked(preview.playback))
    await vscode.commands.executeCommand('lily.midi.stop', vscode.Uri.file(score))
    await eventually('the preview to stop', () => preview.playback?.state === 'stopped')

    const exported = vscode.Uri.file(path.join(scratch, 'score.midi'))
    await vscode.commands.executeCommand('vscode.openWith', exported, 'lily.midiPlayer')
    const player = await eventually('the MIDI player', () => api.midiPlayers.get(exported))
    await eventually('the file to load', () => player.playback?.duration === 15)
    player.play()
    await eventually('the player to play', () => asked(player.playback))
    player.play('stop')
    await eventually('the player to stop', () => player.playback?.state === 'stopped')
  })

  test('the shipped lily-check compiles the score and reports its pages', async () => {
    const cli = path.join(extension().extensionPath, 'dist', 'lily-check.js')
    const outDir = path.join(scratch, 'pages')
    // The extension host is Electron; this makes its binary behave as node.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        [cli, 'compile', score, '--json', '--out-dir', outDir],
        { env },
        (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve(out)),
      ),
    )
    const report: CheckReport = JSON.parse(stdout)
    assert.deepStrictEqual([report.ok, report.errorCount, report.pages.length], [true, 0, 2])
    for (const page of report.pages) {
      assert.match(await fs.readFile(page, 'utf8'), /<svg /)
    }
  })
})
