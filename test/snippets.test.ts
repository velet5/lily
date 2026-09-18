import * as assert from 'node:assert'
import * as vscode from 'vscode'
import snippets from '../snippets/lilypond.json'

async function openLilyPond(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: 'lilypond', content })
  return vscode.window.showTextDocument(document)
}

suite('snippets', () => {
  test('a \\command snippet replaces the typed backslash instead of doubling it', async () => {
    const editor = await openLilyPond('\\sco')
    const end = new vscode.Position(0, 4)
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      editor.document.uri,
      end,
    )
    const item = list.items.find(
      (candidate) =>
        candidate.kind === vscode.CompletionItemKind.Snippet &&
        (typeof candidate.label === 'string' ? candidate.label : candidate.label.label) === '\\score',
    )
    assert.ok(item, 'the \\score snippet is not offered after typing \\sco')
    // Both ranges must start at the backslash. VS Code reports a `replacing` end
    // past the end of the line here, so only the `inserting` end is checked.
    assert.ok(item.range, 'the snippet completion carries no range')
    const { inserting, replacing } =
      item.range instanceof vscode.Range ? { inserting: item.range, replacing: item.range } : item.range
    assert.strictEqual(replacing.start.character, 0)
    assert.deepStrictEqual([inserting.start.character, inserting.end.character], [0, 4])
  })

  test('every snippet body expands to plain LilyPond', async () => {
    for (const [name, snippet] of Object.entries(snippets)) {
      const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body
      const editor = await openLilyPond('')
      await editor.insertSnippet(new vscode.SnippetString(body))
      const text = editor.document.getText()
      assert.doesNotMatch(text, /\$\{|\\\\|\\\$/, `${name}: unexpanded placeholder or stray escape in\n${text}`)
    }
  })

  test('escaped backslashes and dollars survive expansion', async () => {
    const expected: Record<string, string> = {
      'Grace notes': '\\grace {  }',
      'Music function':
        'name =\n#(define-music-function (music) (ly:music?)\n   #{\n      $music\n   #})',
    }
    for (const [name, text] of Object.entries(expected)) {
      const snippet = snippets[name as keyof typeof snippets]
      const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body
      const editor = await openLilyPond('')
      await editor.insertSnippet(new vscode.SnippetString(body))
      assert.strictEqual(editor.document.getText(), text, name)
    }
  })
})
