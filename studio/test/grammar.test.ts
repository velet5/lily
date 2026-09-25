import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type * as monaco from 'monaco-editor/editor'
import rawGrammar from '../../syntaxes/lilypond.tmLanguage.json'
import { languageConfiguration, loadGrammar, theme, tokensProvider, tokenType } from '../src/renderer/grammar'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/), with
// the same Oniguruma WebAssembly the renderer loads.

/** Tokenizes `lines` as Monaco would: `[text, token]` pairs per line. */
async function tokenize(...lines: string[]): Promise<[string, string][][]> {
  const provider = tokensProvider(await loadGrammar())
  let state: monaco.languages.IState = provider.getInitialState()
  return lines.map((line) => {
    const { tokens, endState } = provider.tokenize(line, state)
    state = endState
    return tokens.map((token, i) => [line.slice(token.startIndex, tokens[i + 1]?.startIndex), token.scopes])
  })
}

/** The token of the first piece of `line` that is exactly `text`. */
function tokenOf(line: [string, string][], text: string): string | undefined {
  return line.find(([piece]) => piece === text)?.[1]
}

describe('tokenType', () => {
  test('uses the innermost scope that has a colour', () => {
    assert.equal(tokenType(['source.lilypond', 'variable.other.pitch.lilypond']), 'variable')
    assert.equal(tokenType(['source.lilypond', 'meta.markup.lilypond', 'support.function.markup.lilypond']), 'support.function')
    assert.equal(tokenType(['source.lilypond', 'keyword.control.directive.lilypond']), 'keyword.control')
    assert.equal(tokenType(['source.lilypond', 'keyword.other.mode.lilypond']), 'keyword')
    assert.equal(tokenType(['source.lilypond', 'punctuation.section.braces.begin.lilypond']), '')
  })

  test('says comment or string inside one, for Monaco’s bracket and auto-closing rules', () => {
    assert.equal(tokenType(['source.lilypond', 'comment.block.lilypond', 'punctuation.definition.comment.begin.lilypond']), 'comment')
    assert.equal(tokenType(['source.lilypond', 'string.quoted.double.lilypond']), 'string')
    assert.equal(tokenType(['source.lilypond', 'string.quoted.double.lilypond', 'constant.character.escape.lilypond']), 'constant.character.escape.string')
  })

  test('every scope the grammar names, except punctuation and meta, has a colour', () => {
    const names = new Set<string>()
    JSON.stringify(rawGrammar, (key, value: unknown) => {
      if ((key === 'name' || key === 'contentName') && typeof value === 'string') names.add(value)
      return value
    })
    names.delete('LilyPond')
    const uncoloured = [...names].filter((name) => !/^(punctuation|meta)\./.test(name) && tokenType([name]) === '')
    assert.deepEqual(uncoloured, [])
  })
})

describe('tokensProvider', () => {
  test('colours a small score', async () => {
    const [version, music] = await tokenize('\\version "2.24.0"', '\\relative c\' { c4-. d8 r % tune')
    assert.equal(tokenOf(version, '\\version'), 'keyword.control')
    assert.equal(tokenOf(version, '"'), 'string')
    assert.equal(tokenOf(music, '\\relative'), 'support.function')
    assert.equal(tokenOf(music, 'c'), 'variable')
    assert.equal(tokenOf(music, '4'), 'constant.numeric')
    assert.equal(tokenOf(music, 'r'), 'constant.language')
    assert.equal(tokenOf(music, '-.'), 'keyword.operator')
    assert.deepEqual(music.slice(-2), [['%', 'comment'], [' tune', 'comment']])
  })

  test('carries a block comment and Scheme across lines', async () => {
    const [open, inside, close] = await tokenize('%{ a {', 'still { a comment', '%} c1')
    assert.ok(open.every(([, token]) => token === 'comment'))
    assert.deepEqual(inside, [['still { a comment', 'comment']])
    assert.equal(tokenOf(close, 'c'), 'variable')

    const [scheme, more] = await tokenize('#(define (twice x)', '  (* 2 x))')
    assert.equal(tokenOf(scheme, 'define'), 'keyword.control')
    assert.equal(tokenOf(more, '2'), 'constant.numeric')
  })
})

describe('theme', () => {
  test('has the same keys light and dark, over the matching base theme', () => {
    const light = theme(false)
    const dark = theme(true)
    assert.equal(light.base, 'vs')
    assert.equal(dark.base, 'vs-dark')
    assert.deepEqual(
      light.rules.map((rule) => rule.token),
      dark.rules.map((rule) => rule.token),
    )
    assert.ok(light.rules.every((rule) => /^[0-9A-F]{6}$/.test(rule.foreground ?? '')))
  })
})

describe('languageConfiguration', () => {
  test('is language-configuration.json with RegExps', () => {
    const config = languageConfiguration()
    assert.deepEqual(config.comments, { lineComment: '%', blockComment: ['%{', '%}'] })
    assert.ok(config.brackets?.some(([open, close]) => open === '<<' && close === '>>'))
    assert.ok(!config.autoClosingPairs?.some((pair) => pair.open === '('), 'slurs are not auto-closed')
    assert.deepEqual(config.surroundingPairs?.[0], { open: '{', close: '}' })
    assert.equal('\\override Staff.TimeSignature'.match(new RegExp(config.wordPattern!, 'g'))?.[0], '\\override')
    assert.ok(config.indentationRules?.increaseIndentPattern.test('  \\new Staff << % piano'))
    assert.ok(config.indentationRules?.decreaseIndentPattern.test('  }'))
  })
})
