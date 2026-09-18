import * as assert from 'node:assert'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pkg from '../package.json'
import { locateLilyPond } from '../src/compile/locate'
import type { LilyApi } from '../src/extension'

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the test run must open test/fixtures as its workspace')
  return vscode.Uri.file(path.join(folder.uri.fsPath, name))
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(condition(), what)
}

// hello.ly draws the six notes of melody.ily, so every link leads into the include.
suite('point-and-click', () => {
  let api: LilyApi
  const root = fixture('hello.ly')
  const melody = fixture('melody.ily')
  const config = () => vscode.workspace.getConfiguration('lily')
  const target = vscode.ConfigurationTarget.Global

  const placeCursor = (editor: vscode.TextEditor, line: number, character: number) => {
    const position = new vscode.Position(line, character)
    editor.selection = new vscode.Selection(position, position)
  }

  suiteSetup(async function () {
    // Needs the real binary; skip, rather than fail, without it (DECISIONS D15).
    const installed = await locateLilyPond().then(
      () => true,
      () => false,
    )
    if (!installed) this.skip()
    api = await vscode.extensions.getExtension<LilyApi>(`${pkg.publisher}.${pkg.name}`)!.activate()
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await vscode.window.showTextDocument(root, { viewColumn: vscode.ViewColumn.One })
    await vscode.commands.executeCommand('lily.preview.openToSide')
    assert.strictEqual(await api.previews.get(root.fsPath)?.whenRendered(), 1)
  })

  suiteTeardown(async () => {
    await config().update('preview.followCursor', undefined, target)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('a clicked note opens its file in the code pane, cursor on the note', async () => {
    const preview = api.previews.get(root.fsPath)
    assert.ok(preview)
    // `  g2 g`: what the webview posts for the second g, already parsed.
    await api.revealSource({ file: melody.fsPath, line: 3, char: 5 }, preview)

    const editor = vscode.window.activeTextEditor
    assert.strictEqual(editor?.document.uri.fsPath, melody.fsPath)
    assert.strictEqual(editor.viewColumn, vscode.ViewColumn.One, 'beside the score, not on top of it')
    assert.deepStrictEqual(
      [editor.selection.active.line, editor.selection.active.character, editor.selection.isEmpty],
      [2, 5, true],
    )
    assert.strictEqual(preview.viewColumn, vscode.ViewColumn.Two)
    // The cursor it placed is followed like any other: the clicked note is marked.
    await until(() => preview.highlighted === 1, 'the webview marks the note under the cursor')
  })

  test('moving the cursor marks the note in the real webview, and a line without notes clears it', async () => {
    const preview = api.previews.get(root.fsPath)
    assert.ok(preview)
    const editor = await vscode.window.showTextDocument(melody, { viewColumn: vscode.ViewColumn.One })

    placeCursor(editor, 0, 3)
    await until(() => preview.highlighted === 0, 'nothing on the line of `melody =` is drawn')
    placeCursor(editor, 1, 6)
    await until(() => preview.highlighted === 1, 'the d is marked')
  })

  test('switched off, the mark goes and the cursor is no longer followed', async () => {
    const preview = api.previews.get(root.fsPath)
    assert.ok(preview)
    await config().update('preview.followCursor', false, target)
    await until(() => preview.highlighted === 0, 'the mark is cleared')

    const editor = await vscode.window.showTextDocument(melody, { viewColumn: vscode.ViewColumn.One })
    placeCursor(editor, 2, 2)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.strictEqual(preview.highlighted, 0)

    await config().update('preview.followCursor', true, target)
    await until(() => preview.highlighted === 1, 'switched on again, the g is marked without a keypress')
  })
})
