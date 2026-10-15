import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { definitionsIn, findDefinition, includesIn, positionAt, referenceAt, type Sources } from '@lily/common/definition'

// @lily/common/definition (DECISIONS D119), which both apps use for go to
// definition and the hover. Runs under `node --test` (npm run test:unit).

const FIGURES = String.raw`%% piano figures
pE     = { e'8 b' fis'' gis''~ gis''2 }
pCis   = { cis'8 gis' dis'' e''~ e''2 }
pCisV  = <cis' e' gis'>1
ringOn  = \startTextSpan

piano = {
  \clef treble
  \pE | \pCis | gis8\ringOn dis' |
}
`

/** Finds `name` as used at the first `\name` after `marker` in `text`, with `files` to include. */
function find(text: string, name: string, files: Record<string, string> = {}, marker = '') {
  const sources: Sources = {
    read: async (file) => files[file],
    resolve: (_from, target) => target,
  }
  const offset = text.indexOf(`\\${name}`, text.indexOf(marker))
  return findDefinition(sources, 'main.ly', text, name, offset)
}

describe('referenceAt', () => {
  const line = '  \\pE | \\pCis | gis8\\ringOn dis\''

  test('finds the name from the backslash to just after the end', () => {
    const start = line.indexOf('\\pCis')
    for (const character of [start, start + 1, start + 5]) {
      assert.deepEqual(referenceAt(line, character), { name: 'pCis', start, end: start + 5 })
    }
    assert.equal(referenceAt(line, start + 6), undefined)
  })

  test('a name right after a note', () => {
    assert.equal(referenceAt(line, line.indexOf('ringOn'))?.name, 'ringOn')
  })

  test('keeps -, _ between letters and stops at a digit or a dot', () => {
    assert.equal(referenceAt('\\my-violin_I', 3)?.name, 'my-violin_I')
    assert.equal(referenceAt('\\vOne1', 2)?.name, 'vOne')
    assert.equal(referenceAt('\\foo.bar', 2)?.name, 'foo')
  })

  test('not in a comment or a string', () => {
    assert.equal(referenceAt('c4 % \\pCis', 7), undefined)
    assert.equal(referenceAt('\\markup "\\pCis"', 11), undefined)
    assert.equal(referenceAt('c4 \\pCis % \\pE', 5)?.name, 'pCis')
  })
})

describe('definitionsIn', () => {
  test('an assignment, and not a longer name that starts the same', async () => {
    const found = definitionsIn(FIGURES, 'pCis')
    assert.equal(found.length, 1)
    assert.equal(FIGURES.slice(found[0].offset, found[0].offset + 4), 'pCis')
    assert.equal(found[0].preview, "pCis   = { cis'8 gis' dis'' e''~ e''2 }")
  })

  test('the preview runs to the closing brace', () => {
    const [piano] = definitionsIn(FIGURES, 'piano')
    assert.equal(piano.preview, "piano = {\n  \\clef treble\n  \\pE | \\pCis | gis8\\ringOn dis' |\n}")
  })

  test('a preview of a long block stops after twelve lines', () => {
    const text = `long = {\n${'  c4\n'.repeat(20)}}\n`
    const lines = definitionsIn(text, 'long')[0].preview.split('\n')
    assert.equal(lines.length, 13)
    assert.equal(lines.at(-1), '…')
  })

  test('a slur left open does not run the preview on', () => {
    assert.equal(definitionsIn('a = { c( d }\nb = { e) }\n', 'a')[0].preview, 'a = { c( d }')
  })

  test('<< >> and Scheme', () => {
    const text = 'both = <<\n  \\a\n  \\b\n>>\nfn = #(define-music-function (m) (ly:music?)\n  m)\n#(define (twice m) m)\n'
    assert.equal(definitionsIn(text, 'both')[0].preview, 'both = <<\n  \\a\n  \\b\n>>')
    assert.equal(definitionsIn(text, 'fn')[0].preview, 'fn = #(define-music-function (m) (ly:music?)\n  m)')
    assert.equal(definitionsIn(text, 'twice')[0].preview, '#(define (twice m) m)')
  })

  test('a quoted name', () => {
    const [found] = definitionsIn('"violin-I" = { c }\n', 'violin-I')
    assert.equal(found.offset, 1)
  })

  test('not in comments, strings, property settings or comparisons', () => {
    const text = '% pE = { c }\n%{\npE = { d }\n%}\n\\markup "pE = x"\n\\set pE = 1\npE == 2\n'
    assert.deepEqual(definitionsIn(text, 'pE'), [])
  })
})

describe('includesIn', () => {
  test('the files named, not in comments', () => {
    const text = '\\include "figures.ily"\n% \\include "old.ily"\n\\include"../parts/bass.ily"\n'
    assert.deepEqual(
      includesIn(text).map((include) => include.target),
      ['figures.ily', '../parts/bass.ily'],
    )
  })
})

describe('findDefinition', () => {
  test('in the same file', async () => {
    const found = await find(FIGURES, 'pCis', {}, 'piano =')
    assert.ok(found)
    assert.equal(found.file, 'main.ly')
    assert.deepEqual(positionAt(found.text, found.offset), { line: 2, character: 0 })
  })

  test('the nearest definition before the use, when it is defined again', async () => {
    const text = 'a = { c }\n\\a\na = { d }\n\\a\n'
    const second = await find(text, 'a', {}, 'a = { d }')
    assert.equal(second?.preview, 'a = { d }')
    const first = await find(text, 'a')
    assert.equal(first?.preview, 'a = { c }')
  })

  test('in an included file, also one it includes', async () => {
    const files = { 'figures.ily': '\\include "more.ily"\npE = { e }\n', 'more.ily': 'deep = { f }\n' }
    const text = '\\include "figures.ily"\n{ \\pE \\deep }\n'
    const pE = await find(text, 'pE', files)
    assert.equal(pE?.file, 'figures.ily')
    assert.deepEqual(positionAt(pE.text, pE.offset), { line: 1, character: 0 })
    assert.equal((await find(text, 'deep', files))?.file, 'more.ily')
  })

  test('a local definition after the include wins over the included one', async () => {
    const files = { 'figures.ily': 'pE = { e }\n' }
    const found = await find('\\include "figures.ily"\npE = { f }\n{ \\pE }\n', 'pE', files)
    assert.equal(found?.file, 'main.ly')
  })

  test('a file that includes itself, or one that cannot be read, ends the search', async () => {
    const files = { 'self.ily': '\\include "self.ily"\n' }
    assert.equal(await find('\\include "self.ily"\n\\include "gone.ily"\n{ \\x }\n', 'x', files), undefined)
  })

  test('a definition after the use when there is none before', async () => {
    const found = await find('{ \\later }\nlater = { c }\n', 'later')
    assert.equal(found?.preview, 'later = { c }')
  })

  test('none for a built-in command', async () => {
    assert.equal(await find('{ \\clef treble }', 'clef'), undefined)
  })
})
