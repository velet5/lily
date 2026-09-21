import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pkg from '../package.json'
import type { CompileResult } from '../src/compile/compiler'
import { locateLilyPond } from '../src/compile/locate'
import type { LilyApi } from '../src/extension'
import type { PreviewPanel } from '../src/preview/panel'

const HEADER = '\\version "2.24.0"\n'
const pages = (count: number) =>
  `{ ${Array.from({ length: count }, () => 'c1').join(' \\pageBreak ')} }\n`

/** Replaces the whole text through the editor, as typing would, and saves it. */
async function rewrite(document: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit()
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text)
  assert.ok(await vscode.workspace.applyEdit(edit))
  assert.ok(await document.save())
}

/** `whenRendered()` answers for the current render, so poll until the refresh arrives. */
async function rendersPages(preview: PreviewPanel, count: number): Promise<void> {
  const deadline = Date.now() + 15000
  const pause = () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50))
  // Raced, because whenRendered() stays pending while nothing new is drawn.
  while ((await Promise.race([preview.whenRendered(), pause()])) !== count) {
    assert.ok(Date.now() < deadline, `the preview never showed ${count} page(s)`)
    await pause()
  }
}

suite('refresh on save', () => {
  const config = () => vscode.workspace.getConfiguration('lily')
  const target = vscode.ConfigurationTarget.Global
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
  })

  setup(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'))

  teardown(async () => {
    await config().update('preview.refreshOnSave', undefined, target)
    await config().update('preview.refreshDelay', undefined, target)
  })

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  })

  /** Writes the files, shows the first in column one and opens its preview. */
  async function previewed(files: Record<string, string>) {
    for (const [name, text] of Object.entries(files)) {
      await fs.writeFile(path.join(scratch, name), text)
    }
    const uri = vscode.Uri.file(path.join(scratch, Object.keys(files)[0]))
    const editor = await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.One })
    await vscode.commands.executeCommand('lily.preview.openToSide')
    const preview = api.previews.get(uri.fsPath)
    assert.ok(preview)
    return { document: editor.document, preview }
  }

  test('saving the previewed file redraws it', async () => {
    const { document, preview } = await previewed({ 'saved.ly': HEADER + pages(1) })
    assert.strictEqual(await preview.whenRendered(), 1)

    await rewrite(document, HEADER + pages(2))
    await rendersPages(preview, 2)
  })

  test('saving an included file redraws the root that includes it', async () => {
    const { preview } = await previewed({
      // Braces: a bare \music right after \include is lexed before the file is read.
      'root.ly': `${HEADER}\\include "parts.ily"\n{ \\music }\n`,
      'parts.ily': `music = ${pages(1)}`,
    })
    assert.strictEqual(await preview.whenRendered(), 1)

    const include = await vscode.workspace.openTextDocument(path.join(scratch, 'parts.ily'))
    await rewrite(include, `music = ${pages(3)}`)
    await rendersPages(preview, 3)
  })

  test('does nothing when lily.preview.refreshOnSave is off', async () => {
    await config().update('preview.refreshOnSave', false, target)
    await config().update('preview.refreshDelay', 0, target)
    const { document, preview } = await previewed({ 'manual.ly': HEADER + pages(1) })
    assert.strictEqual(await preview.whenRendered(), 1)

    await rewrite(document, HEADER + pages(2))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.strictEqual(await preview.whenRendered(), 1)

    // The command still works.
    await vscode.commands.executeCommand('lily.compile')
    assert.strictEqual(await preview.whenRendered(), 2)
  })

  test('unsaved includes update the root, preserve navigation and reuse identical pages', async () => {
    const { preview } = await previewed({
      'live-root.ly': `${HEADER}\\include "live-part.ily"\n{ \\music }\n`,
      'live-part.ily': `music = ${pages(1)}`,
    })
    await preview.whenRendered()
    const include = await vscode.workspace.openTextDocument(path.join(scratch, 'live-part.ily'))
    const original = include.getText()
    const edit = new vscode.WorkspaceEdit()
    edit.replace(include.uri, new vscode.Range(0, 0, include.lineCount, 0), `music = ${pages(2)}`)
    const editedAt = Date.now()
    assert.ok(await vscode.workspace.applyEdit(edit))
    await rendersPages(preview, 2)
    console.log('live-preview unsaved include edit-to-render:', Date.now() - editedAt, 'ms', preview.latency)
    assert.ok(include.isDirty)
    assert.strictEqual(await fs.readFile(include.uri.fsPath, 'utf8'), original)
    assert.strictEqual(preview.latency?.engine, 'warm')
    await vscode.commands.executeCommand('lily.preview.refresh', vscode.Uri.file(preview.rootFile))
    await preview.whenRendered()
    assert.strictEqual(preview.latency?.reusedPages, 2)
    // Forward lookup uses the original include, not its now-deleted snapshot.
    api.previews.followCursor({ file: include.uri.fsPath, line: 0, character: 10, lineText: include.lineAt(0).text })
    const deadline = Date.now() + 5000
    while (!preview.highlighted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(preview.highlighted)
    await vscode.window.showTextDocument(include)
    await vscode.commands.executeCommand('workbench.action.files.revert')
  })

  test('a result from an older source revision cannot publish stale diagnostics', async () => {
    const good = HEADER + '#(usleep 400000)\n' + pages(1)
    const { document, preview } = await previewed({ 'revisions.ly': good })
    await preview.whenRendered()
    const replace = async (text: string) => {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text)
      assert.ok(await vscode.workspace.applyEdit(edit))
    }
    await replace(good.replace('c1', 'c1 \\stacato'))
    const old = vscode.commands.executeCommand<CompileResult>('lily.compile', document.uri)
    await new Promise(resolve => setTimeout(resolve, 150))
    const started = Date.now()
    await replace(HEADER + pages(2))
    await old
    assert.deepStrictEqual(vscode.languages.getDiagnostics(document.uri), [])
    await rendersPages(preview, 2)
    assert.deepStrictEqual(vscode.languages.getDiagnostics(document.uri), [])
    console.log('live-preview edit-to-render (queued after incomplete score):', Date.now() - started, 'ms', preview.latency)
    await vscode.commands.executeCommand('workbench.action.files.revert')
  })

  test('saving a Cyrillic-named score reuses pages from its unsaved preview', async () => {
    const { document, preview } = await previewed({ 'Молодость.ly': HEADER + pages(1) })
    await preview.whenRendered()
    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), HEADER + pages(2))
    assert.ok(await vscode.workspace.applyEdit(edit))
    await rendersPages(preview, 2)
    assert.ok(document.isDirty)
    assert.ok(await document.save())
    await vscode.commands.executeCommand('lily.preview.refresh', document.uri)
    await preview.whenRendered()
    assert.strictEqual(preview.latency?.reusedPages, 2)
    api.previews.followCursor({ file: document.uri.fsPath, line: 1, character: 2, lineText: document.lineAt(1).text })
    const deadline = Date.now() + 5000
    while (!preview.highlighted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.ok(preview.highlighted, 'source navigation survives saving the snapshot')
  })

  test('LilyPond: Compile previews a dirty file without saving', async () => {
    // No delay: a refresh scheduled by the command's save would start at once
    // and supersede the command's run.
    await config().update('preview.refreshDelay', 0, target)
    const { document, preview } = await previewed({ 'dirty.ly': HEADER + pages(1) })
    assert.strictEqual(await preview.whenRendered(), 1)

    const edit = new vscode.WorkspaceEdit()
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), HEADER + pages(2))
    assert.ok(await vscode.workspace.applyEdit(edit))
    const result = await vscode.commands.executeCommand<CompileResult>('lily.compile')

    assert.strictEqual(document.isDirty, true)
    assert.strictEqual(result.cancelled, false)
    assert.strictEqual(api.autoPreview.pending, 0)
    assert.strictEqual(await preview.whenRendered(), 2)
    await vscode.commands.executeCommand('workbench.action.files.revert')
  })
})
