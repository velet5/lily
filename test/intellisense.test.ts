import * as assert from 'node:assert'
import * as vscode from 'vscode'

// The providers end to end in the extension host; what is offered where is
// covered by the unit tests under test/intellisense/.

async function open(content: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: 'lilypond', content })
  await vscode.window.showTextDocument(document)
  return document
}

async function complete(content: string, trigger?: string): Promise<vscode.CompletionItem[]> {
  const document = await open(content)
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    document.uri,
    document.positionAt(content.length),
    trigger,
  )
  // Snippets and word-based suggestions come from VS Code, not from the data.
  return list.items.filter(
    (item) => item.kind !== vscode.CompletionItemKind.Snippet && item.kind !== vscode.CompletionItemKind.Text,
  )
}

const labelOf = (item: vscode.CompletionItem) => (typeof item.label === 'string' ? item.label : item.label.label)

suite('IntelliSense', () => {
  test('a typed command is completed and replaces its backslash', async () => {
    const items = await complete('{ c4 \\transp')
    const transpose = items.find((item) => labelOf(item) === '\\transpose')
    assert.ok(transpose, '\\transpose is not offered')
    assert.strictEqual(transpose.kind, vscode.CompletionItemKind.Function)
    assert.ok(transpose.range instanceof vscode.Range)
    assert.strictEqual(transpose.range.start.character, 5)
    assert.ok(transpose.documentation instanceof vscode.MarkdownString)
    assert.match(transpose.documentation.value, /Transpose \*music\*/)
  })

  test('the space after \\new brings up the contexts', async () => {
    const items = await complete('\\new ', ' ')
    assert.ok(items.some((item) => labelOf(item) === 'PianoStaff'))
    assert.ok(items.every((item) => item.kind === vscode.CompletionItemKind.Class))
  })

  test("the dot after a grob brings up that grob's properties", async () => {
    const items = await complete('\\override NoteHead.', '.')
    assert.ok(items.some((item) => labelOf(item) === 'color'))
    assert.ok(items.every((item) => item.kind === vscode.CompletionItemKind.Property))
  })

  test('a space between notes brings up nothing', async () => {
    assert.deepStrictEqual(await complete('{ c4 d4 ', ' '), [])
  })

  test('hovering a command shows its documentation', async () => {
    const document = await open("\\relative c' { c4 }")
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      document.uri,
      new vscode.Position(0, 3),
    )
    const text = hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === 'string' ? content : content.value))
      .join('\n')
    assert.match(text, /\\relative \[pitch\] \(music\)/)
    assert.match(text, /Make \*music\* relative to \*pitch\*/)
    assert.deepStrictEqual(hovers[0].range, new vscode.Range(0, 0, 0, 9))
  })
})
