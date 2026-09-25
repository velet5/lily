// LilyPond highlighting in Monaco from the extension's own TextMate grammar and
// language configuration (DECISIONS D30). vscode-textmate tokenizes each line
// with Oniguruma compiled to WebAssembly; every token is handed to Monaco as
// one theme key (`tokenType`), which the two themes below colour like VS
// Code's Light+ and Dark+. Only types come from `monaco-editor`, so the tests
// run this module under node.
import type * as monaco from 'monaco-editor/editor'
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma'
import onigWasm from 'vscode-oniguruma/release/onig.wasm'
import { INITIAL, Registry, type IGrammar, type IRawGrammar, type StateStack } from 'vscode-textmate'
import rawConfiguration from '../../../language-configuration.json'
import rawGrammar from '../../../syntaxes/lilypond.tmLanguage.json'

export const SCOPE_NAME = 'source.lilypond'
export const LIGHT_THEME = 'lilypond-light'
export const DARK_THEME = 'lilypond-dark'

/** A line that takes longer is left partly uncoloured rather than freezing the editor. */
const LINE_TIME_LIMIT_MS = 500

/** Theme keys with their Light+ and Dark+ colours. A scope takes the longest key it starts with. */
const COLORS: readonly (readonly [key: string, light: string, dark: string])[] = [
  ['comment', '008000', '6A9955'],
  ['string', 'A31515', 'CE9178'],
  ['constant.character.escape', 'EE0000', 'D7BA7D'],
  ['constant.numeric', '098658', 'B5CEA8'],
  ['constant.language', '0000FF', '569CD6'],
  ['constant.character', '0000FF', '569CD6'],
  ['constant.other', '0000FF', '569CD6'],
  ['keyword.control', 'AF00DB', 'C586C0'],
  ['keyword.operator', '000000', 'D4D4D4'],
  ['keyword', '0000FF', '569CD6'],
  ['storage', '0000FF', '569CD6'],
  ['support.function', '795E26', 'DCDCAA'],
  ['entity.name.function', '795E26', 'DCDCAA'],
  ['support.class', '267F99', '4EC9B0'],
  ['support.variable', '001080', '9CDCFE'],
  ['variable', '001080', '9CDCFE'],
  ['invalid', 'CD3131', 'F44747'],
]

export function theme(dark: boolean): monaco.editor.IStandaloneThemeData {
  return {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: COLORS.map(([token, light, darkColor]) => ({ token, foreground: dark ? darkColor : light })),
    colors: {},
  }
}

function colorKey(scope: string): string | undefined {
  let best: string | undefined
  for (const [key] of COLORS) {
    if ((scope === key || scope.startsWith(`${key}.`)) && key.length > (best?.length ?? 0)) best = key
  }
  return best
}

/**
 * The Monaco token for a TextMate scope stack (outermost first): the key of
 * the innermost scope that has a colour, so `punctuation.definition.string`
 * is coloured as the string around it. Inside a comment or string the kind is
 * appended when the key does not already say it, because Monaco reads the
 * words `comment` and `string` in a token to skip brackets and auto-closing
 * there; the theme ignores the extra segment.
 */
export function tokenType(scopes: readonly string[]): string {
  let key = ''
  for (let i = scopes.length - 1; i >= 0 && !key; i--) key = colorKey(scopes[i]) ?? ''
  const kind = scopes.some((s) => s.startsWith('comment.') || s === 'comment')
    ? 'comment'
    : scopes.some((s) => s.startsWith('string.') || s === 'string')
      ? 'string'
      : ''
  if (!kind || key.startsWith(kind)) return key
  return key ? `${key}.${kind}` : kind
}

let grammar: Promise<IGrammar> | undefined

/** Loads Oniguruma and the grammar once. */
export function loadGrammar(): Promise<IGrammar> {
  grammar ??= (async () => {
    const registry = new Registry({
      onigLib: loadWASM(onigWasm).then(() => ({ createOnigScanner, createOnigString })),
      // The grammar includes no other grammar.
      loadGrammar: async (scopeName) => (scopeName === SCOPE_NAME ? (rawGrammar as unknown as IRawGrammar) : null),
    })
    const loaded = await registry.loadGrammar(SCOPE_NAME)
    if (!loaded) throw new Error(`The grammar ${SCOPE_NAME} did not load.`)
    return loaded
  })()
  return grammar
}

export function tokensProvider(grammar: IGrammar): monaco.languages.TokensProvider {
  return {
    // StateStack is immutable and has clone() and equals(), as Monaco's IState asks.
    getInitialState: () => INITIAL,
    tokenize(line, state) {
      const result = grammar.tokenizeLine(line, state as StateStack, LINE_TIME_LIMIT_MS)
      return {
        tokens: result.tokens.map((token) => ({ startIndex: token.startIndex, scopes: tokenType(token.scopes) })),
        endState: result.ruleStack,
      }
    },
  }
}

interface RawConfiguration {
  comments: { lineComment: string; blockComment: [string, string] }
  brackets: [string, string][]
  autoClosingPairs: monaco.languages.IAutoClosingPairConditional[]
  surroundingPairs: [string, string][]
  wordPattern: string
  indentationRules: { increaseIndentPattern: string; decreaseIndentPattern: string }
}

/** language-configuration.json with its patterns turned into RegExps, as Monaco takes them. */
export function languageConfiguration(): monaco.languages.LanguageConfiguration {
  const raw = rawConfiguration as RawConfiguration
  return {
    comments: raw.comments,
    brackets: raw.brackets,
    autoClosingPairs: raw.autoClosingPairs,
    surroundingPairs: raw.surroundingPairs.map(([open, close]) => ({ open, close })),
    wordPattern: new RegExp(raw.wordPattern),
    indentationRules: {
      increaseIndentPattern: new RegExp(raw.indentationRules.increaseIndentPattern),
      decreaseIndentPattern: new RegExp(raw.indentationRules.decreaseIndentPattern),
    },
  }
}
