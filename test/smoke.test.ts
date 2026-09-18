import * as assert from 'node:assert'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pkg from '../package.json'

const extensionId = `${pkg.publisher}.${pkg.name}`

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the test run must open test/fixtures as its workspace')
  return vscode.Uri.file(path.join(folder.uri.fsPath, name))
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

suite('activation smoke test', () => {
  test('the extension is installed but idle before a LilyPond file is opened', () => {
    const extension = vscode.extensions.getExtension(extensionId)
    assert.ok(extension, `${extensionId} is not installed in the test host`)
    assert.strictEqual(extension.isActive, false)
  })

  test('.ly and .ily files get the lilypond language id', async () => {
    for (const name of ['hello.ly', 'melody.ily']) {
      const document = await vscode.workspace.openTextDocument(fixture(name))
      assert.strictEqual(document.languageId, 'lilypond', name)
    }
  })

  test('opening a LilyPond file activates the extension', async () => {
    const extension = vscode.extensions.getExtension(extensionId)
    assert.ok(extension)
    await vscode.window.showTextDocument(fixture('hello.ly'))
    await waitFor(() => extension.isActive)
    assert.strictEqual(extension.isActive, true)
  })

  test('toggle line comment uses %', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'lilypond',
      content: 'c4 d e f',
    })
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('editor.action.commentLine')
    assert.strictEqual(document.getText(), '% c4 d e f')
  })

  test('toggle block comment uses %{ %}', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'lilypond',
      content: 'c4 d e f',
    })
    const editor = await vscode.window.showTextDocument(document)
    editor.selection = new vscode.Selection(0, 0, 0, 8)
    await vscode.commands.executeCommand('editor.action.blockComment')
    assert.strictEqual(document.getText(), '%{ c4 d e f %}')
  })

  test('typing { auto-closes but ( does not', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'lilypond',
      content: '',
    })
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand('type', { text: '{' })
    assert.strictEqual(document.getText(), '{}')
    await vscode.commands.executeCommand('type', { text: 'c4(' })
    assert.strictEqual(document.getText(), '{c4(}')
  })
})
