import * as vscode from 'vscode'
import { completionsAt, TRIGGER_CHARACTERS, type LyCompletionKind } from './completion'
import { loadIndex, type LilyIndex } from './data'
import { hoverAt } from './hover'

// The VS Code side of IntelliSense (DECISIONS D21): completion.ts and hover.ts
// decide, this file translates. It needs no lilypond binary (D9); the data was
// generated ahead of time and ships with the extension.

/** How far back the providers read. A `\markup` block or an `\override` split over more is rare. */
const LOOKBACK_LINES = 60

const KINDS: Record<LyCompletionKind, vscode.CompletionItemKind> = {
  function: vscode.CompletionItemKind.Function,
  music: vscode.CompletionItemKind.Constant,
  keyword: vscode.CompletionItemKind.Keyword,
  markup: vscode.CompletionItemKind.Method,
  context: vscode.CompletionItemKind.Class,
  grob: vscode.CompletionItemKind.Struct,
  property: vscode.CompletionItemKind.Property,
}

export function registerIntelliSense(extensionPath: string): vscode.Disposable {
  // Read on first use, so that opening a LilyPond file does not wait for 400 kB of JSON.
  let index: Promise<LilyIndex> | undefined
  const getIndex = () => (index ??= loadIndex(extensionPath))

  const textBefore = (document: vscode.TextDocument, end: vscode.Position) =>
    document.getText(new vscode.Range(Math.max(0, end.line - LOOKBACK_LINES), 0, end.line, end.character))

  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(
      'lilypond',
      {
        async provideCompletionItems(document, position) {
          const list = completionsAt(await getIndex(), textBefore(document, position))
          if (!list) return undefined
          // The whole `\command` is replaced, backslash included (D13).
          const range = new vscode.Range(position.translate(0, -list.replace), position)
          return list.items.map((entry) => {
            const item = new vscode.CompletionItem(entry.label, KINDS[entry.kind])
            item.range = range
            item.detail = entry.detail
            item.sortText = entry.sortText
            if (entry.doc) item.documentation = new vscode.MarkdownString(entry.doc)
            return item
          })
        },
      },
      ...TRIGGER_CHARACTERS,
    ),
    vscode.languages.registerHoverProvider('lilypond', {
      async provideHover(document, position) {
        const line = document.lineAt(position.line).text
        const before = textBefore(document, new vscode.Position(position.line, 0))
        const hover = hoverAt(await getIndex(), line, position.character, before)
        if (!hover) return undefined
        return new vscode.Hover(
          new vscode.MarkdownString(hover.markdown),
          new vscode.Range(position.line, hover.start, position.line, hover.end),
        )
      },
    }),
  )
}
