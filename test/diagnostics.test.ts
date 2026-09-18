import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { CompileResult } from '../src/compile/compiler'
import { locateLilyPond } from '../src/compile/locate'

function fixture(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the test run must open test/fixtures as its workspace')
  return vscode.Uri.file(path.join(folder.uri.fsPath, name))
}

const compile = (uri: vscode.Uri) =>
  vscode.commands.executeCommand<CompileResult | undefined>('lily.compile', uri)

const ours = (uri: vscode.Uri) =>
  vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'lilypond')

suite('compile diagnostics', () => {
  let scratch: string

  suiteSetup(async function () {
    // Needs the real binary; skip, rather than fail, without it (DECISIONS D15).
    const installed = await locateLilyPond().then(
      () => true,
      () => false,
    )
    if (!installed) this.skip()
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-test-'))
    await vscode.window.showTextDocument(fixture('hello.ly'))
  })

  suiteTeardown(async () => {
    await vscode.workspace
      .getConfiguration('lily')
      .update('lilypond.path', undefined, vscode.ConfigurationTarget.Global)
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  })

  test('errors and warnings land on the token, in the root and in its include', async () => {
    const root = fixture('broken.ly')
    const include = fixture('parts/broken-part.ily')
    const result = await compile(root)
    assert.strictEqual(result?.ok, false)

    const document = await vscode.workspace.openTextDocument(root)
    const found = ours(root).map((d) => [d.severity, document.getText(d.range), d.message])
    assert.deepStrictEqual(found, [
      [vscode.DiagnosticSeverity.Error, '\\undefinedCommand', "unknown command: `\\undefinedCommand'"],
      [
        vscode.DiagnosticSeverity.Error,
        '\\undefinedCommand',
        'string outside of text script or \\lyricmode',
      ],
      [vscode.DiagnosticSeverity.Warning, '|', 'bar check failed at: 3/4'],
    ])
    // The line is tab-indented: character 16, although lilypond said column 24.
    assert.strictEqual(ours(root)[0].range.start.character, 16)

    const included = await vscode.workspace.openTextDocument(include)
    assert.deepStrictEqual(
      ours(include).map((d) => included.getText(d.range)),
      ['\\alsoUndefined', '\\alsoUndefined'],
    )
  })

  test('the next completed run of a root replaces what it reported', async () => {
    const file = path.join(scratch, 'fixme.ly')
    const uri = vscode.Uri.file(file)
    await fs.writeFile(file, '\\version "2.24.0"\n{ c4 \\oops }\n')
    await compile(uri)
    assert.strictEqual(ours(uri).length, 2)
    const other = ours(fixture('broken.ly')).length

    await fs.writeFile(file, '\\version "2.24.0"\n{ c4 d }\n')
    const result = await compile(uri)
    assert.strictEqual(result?.ok, true)
    assert.deepStrictEqual(ours(uri), [])
    assert.strictEqual(ours(fixture('broken.ly')).length, other, 'another root is left alone')
  })

  test('a binary that cannot be found resolves without a result and keeps diagnostics', async () => {
    const before = ours(fixture('broken.ly')).length
    assert.ok(before > 0, 'the first test published diagnostics for broken.ly')
    await vscode.workspace
      .getConfiguration('lily')
      .update('lilypond.path', path.join(scratch, 'no-such-lilypond'), vscode.ConfigurationTarget.Global)
    assert.strictEqual(await compile(fixture('broken.ly')), undefined)
    assert.strictEqual(ours(fixture('broken.ly')).length, before)
  })
})
