import * as path from 'node:path'
import * as vscode from 'vscode'
import { findDefinition, positionAt, referenceAt, type Found, type Sources } from '@lily/common/definition'
import { completionsAt, TRIGGER_CHARACTERS, type LyCompletionKind } from './completion'
import { loadIndex, type LilyIndex } from './data'
import { hoverAt } from './hover'

// The VS Code side of IntelliSense (DECISIONS D21): completion.ts and hover.ts
// decide, this file translates; @lily/common/definition finds a `\name`'s
// definition, for go to definition and the hover (D119). It needs no lilypond binary (D9); the data was
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

/** Included files are read from their editor when open, else from disk. */
const sources: Sources = {
  async read(file) {
    const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === file)
    if (open) return open.getText()
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)))
    } catch {
      return undefined
    }
  },
  resolve: (from, target) => path.resolve(path.dirname(from), target),
}

/** The definition of the `\name` at `position`, with the range of the `\name`. */
async function definitionAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): Promise<{ found: Found; range: vscode.Range } | undefined> {
  const reference = referenceAt(document.lineAt(position.line).text, position.character)
  if (!reference) return undefined
  const offset = document.offsetAt(new vscode.Position(position.line, reference.start))
  const found = await findDefinition(sources, document.uri.fsPath, document.getText(), reference.name, offset)
  return found && { found, range: new vscode.Range(position.line, reference.start, position.line, reference.end) }
}

function definitionRange(found: Found): vscode.Range {
  const start = positionAt(found.text, found.offset)
  return new vscode.Range(start.line, start.character, start.line, start.character + found.length)
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
    vscode.languages.registerDefinitionProvider('lilypond', {
      async provideDefinition(document, position) {
        const definition = await definitionAt(document, position)
        if (!definition) return undefined
        const { found, range } = definition
        // The `\name` itself is the origin, so that all of it is underlined while ⌘ is held.
        return [
          {
            originSelectionRange: range,
            targetUri: vscode.Uri.file(found.file),
            targetRange: definitionRange(found),
          },
        ]
      },
    }),
    vscode.languages.registerHoverProvider('lilypond', {
      async provideHover(document, position) {
        // A score's own definition comes first: it is what lilypond uses, even of a built-in name.
        const definition = await definitionAt(document, position)
        if (definition) {
          return new vscode.Hover(new vscode.MarkdownString(definitionMarkdown(definition.found, document)), definition.range)
        }
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

/** The assignment as code, and the file it is in when it is not `document`. */
function definitionMarkdown(found: Found, document: vscode.TextDocument): string {
  const code = '```lilypond\n' + found.preview + '\n```'
  if (found.file === document.uri.fsPath) return code
  const line = positionAt(found.text, found.offset).line + 1
  return `${code}\n\n*${path.basename(found.file)}:${line}*`
}
