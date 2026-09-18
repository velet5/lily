import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
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

const openPreview = (uri?: vscode.Uri) =>
  vscode.commands.executeCommand('lily.preview.openToSide', uri)

const previewTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('lily.preview'),
    )

suite('side-by-side preview', () => {
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
    api = await vscode.extensions.getExtension<LilyApi>(`${pkg.publisher}.${pkg.name}`)!.activate()
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  })

  test('opens beside the editor, draws every page and leaves the focus in the code', async () => {
    const uri = fixture('pages.ly')
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One })
    await openPreview()

    const preview = api.previews.get(uri.fsPath)
    assert.ok(preview, 'a preview is registered for the root file')
    // Reported by the webview itself: the real script drew two real pages.
    assert.strictEqual(await preview.whenRendered(), 2)

    const tabs = previewTabs()
    assert.deepStrictEqual(
      tabs.map((tab) => [tab.label, tab.group.viewColumn]),
      [['Preview pages.ly', vscode.ViewColumn.Two]],
    )
    assert.strictEqual(vscode.window.activeTextEditor?.document, editor.document)
    assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, vscode.ViewColumn.One)
  })

  test('invoking the command again reveals the same panel', async () => {
    const uri = fixture('pages.ly')
    const before = api.previews.get(uri.fsPath)
    await openPreview(uri)
    assert.strictEqual(api.previews.get(uri.fsPath), before)
    assert.strictEqual(previewTabs().length, 1)
  })

  test('a compile of the previewed file refreshes the preview', async () => {
    const file = path.join(scratch, 'growing.ly')
    const uri = vscode.Uri.file(file)
    await fs.writeFile(file, '\\version "2.24.0"\n{ c4 d e f }\n')
    await openPreview(uri)
    const preview = api.previews.get(file)
    assert.strictEqual(await preview?.whenRendered(), 1)

    await fs.writeFile(file, '\\version "2.24.0"\n{ c4 d e f \\pageBreak g1 \\pageBreak a1 }\n')
    await vscode.commands.executeCommand('lily.compile', uri)
    assert.strictEqual(await preview?.whenRendered(), 3)
    assert.strictEqual(previewTabs().length, 2, 'one panel per root file')
  })

  test('a closed preview is forgotten', async () => {
    const uri = fixture('pages.ly')
    const tab = previewTabs().find((candidate) => candidate.label === 'Preview pages.ly')
    assert.ok(tab)
    await vscode.window.tabGroups.close(tab)
    assert.strictEqual(api.previews.get(uri.fsPath), undefined)
  })
})
