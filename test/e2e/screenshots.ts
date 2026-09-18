import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import pkg from '../../package.json'
import type { LilyApi } from '../../src/extension'

// Takes the README screenshots (`npm run screenshots`, DECISIONS D23): drives the
// packaged extension like the release pass does, and captures the window over
// the DevTools protocol, which the `screenshots` configuration of
// .vscode-test.mjs opens on SCREENSHOT_PORT. Not a test: nothing globs this file.

const PORT = Number(process.env.SCREENSHOT_PORT ?? 9339)
const SIZE = { width: 1440, height: 860 }
const OUT = path.resolve(__dirname, '..', '..', 'docs', 'images')

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args)

/** A DevTools session with the workbench window. */
async function devtools() {
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as {
    type: string
    url: string
    webSocketDebuggerUrl: string
  }[]
  const workbench = targets.find((target) => target.type === 'page' && target.url.includes('workbench'))
  assert.ok(workbench, 'no workbench window on the DevTools port')
  const socket = new WebSocket(workbench.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  const pending = new Map<number, (result: Record<string, string>) => void>()
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
  }
  let id = 0
  const send = (method: string, params: object = {}) =>
    new Promise<Record<string, string>>((resolve) => {
      pending.set(++id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { send, close: () => socket.close() }
}

suite('README screenshots', () => {
  let score: string | undefined

  suiteTeardown(async () => {
    await run('workbench.action.closeAllEditors')
    if (score) await fs.rm(score, { force: true })
  })

  test('preview, diagnostics and completion', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]
    assert.ok(folder)
    // A copy inside the workspace (git-ignored), so that breadcrumbs and the
    // Problems panel show `sample.ly` and not this machine's temp directory.
    score = path.join(folder.uri.fsPath, 'sample.ly')
    await fs.copyFile(path.join(folder.uri.fsPath, 'score.ly'), score)

    const session = await devtools()
    await session.send('Emulation.setDeviceMetricsOverride', { ...SIZE, deviceScaleFactor: 2, mobile: false })
    const capture = async (name: string) => {
      await pause(1200) // widgets fade in, the preview scrolls
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' })
      await fs.writeFile(path.join(OUT, name), Buffer.from(data, 'base64'))
    }

    await run('workbench.action.closeAllEditors')
    await run('workbench.action.closeSidebar')
    await run('workbench.action.closeAuxiliaryBar')
    await run('workbench.action.closePanel')
    await run('notifications.clearAll')

    // 1. Code on the left, the score on the right, the cursor's note marked.
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(score), {
      viewColumn: vscode.ViewColumn.One,
    })
    const api = await vscode.extensions.getExtension<LilyApi>(`${pkg.publisher}.${pkg.name}`)!.activate()
    await run('lily.preview.openToSide')
    const preview = api.previews.get(score)
    assert.strictEqual(await preview?.whenRendered(), 2)
    const at = (needle: string, offset = 0) =>
      editor.document.positionAt(editor.document.getText().indexOf(needle) + offset)
    editor.selection = new vscode.Selection(at('d2 b4'), at('d2 b4'))
    await capture('preview.png')

    // 2. A saved mistake: squiggle, Problems panel, status bar.
    const good = editor.document.getText()
    await editor.edit((edit) => edit.insert(at('b |'), '\\stacato '))
    await editor.document.save()
    while (vscode.languages.getDiagnostics(editor.document.uri).length === 0) await pause(50)
    await run('workbench.actions.view.problems')
    await vscode.window.showTextDocument(editor.document, vscode.ViewColumn.One)
    await capture('diagnostics.png')
    await run('workbench.action.closePanel')

    // 3. Completion of contexts after \new, with documentation.
    await editor.edit((edit) =>
      edit.replace(new vscode.Range(0, 0, editor.document.lineCount, 0), good),
    )
    await editor.document.save()
    const staff = at('\\new Staff { \\bass }', '\\new '.length)
    await editor.edit((edit) => edit.delete(new vscode.Range(staff, staff.translate(0, 'Staff'.length))))
    editor.selection = new vscode.Selection(staff, staff)
    await run('editor.action.triggerSuggest')
    await pause(500)
    await run('toggleSuggestionDetails')
    await capture('completion.png')
    await run('hideSuggestWidget')
    await run('workbench.action.revertAndCloseActiveEditor')

    await session.send('Emulation.clearDeviceMetricsOverride')
    session.close()
  })
})
