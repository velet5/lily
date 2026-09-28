import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { before, describe, test } from 'node:test'
import { loadIndex, type LilyIndex } from '../../src/intellisense/data'
import { hoverAt, inMarkup, isCode } from '../../src/intellisense/hover'

// Runs under `node --test` (npm run test:unit) against the committed data.

let index: LilyIndex
before(async () => {
  index = await loadIndex(path.resolve('.'))
})

/** Hovers over the first character of `word` in `line`. */
const over = (line: string, word: string, textBefore = '') =>
  hoverAt(index, line, line.indexOf(word) + 1, textBefore)

describe('hoverAt', () => {
  test('a music function shows signature, kind and documentation', () => {
    const line = '  \\relative c\' { c4 }'
    const hover = over(line, '\\relative')
    assert.ok(hover)
    assert.equal(line.slice(hover.start, hover.end), '\\relative')
    assert.match(hover.markdown, /^```lilypond\n\\relative \[pitch\] \(music\)\n```\n\n\*music function\*/)
    assert.match(hover.markdown, /Make \*music\* relative to \*pitch\*/)
  })

  test('both ends of the word count, the space after it does not', () => {
    const line = '\\relative  c'
    assert.ok(hoverAt(index, line, 0))
    assert.ok(hoverAt(index, line, 9))
    assert.equal(hoverAt(index, line, 10), undefined)
  })

  test('a predefined command shows what it stands for', () => {
    assert.match(over('\\stemUp c4', '\\stemUp')?.markdown ?? '', /Same as\n\n```lilypond\n\\override Stem\.direction = #1\n```/)
  })

  test('keywords are documented, snippet or not', () => {
    assert.match(over('\\score {', '\\score')?.markdown ?? '', /\*keyword\*/)
  })

  test('a command on a note, and one after the voice separator', () => {
    assert.match(over('c4\\staccato', '\\staccato')?.markdown ?? '', /\*articulation\*/)
    assert.equal(over('{ c } \\\\relative', 'relative'), undefined)
  })

  test('inside \\markup a shared name is the markup command', () => {
    assert.match(over('\\tiny c4', '\\tiny')?.markdown ?? '', /\*predefined command\*/)
    assert.match(over('\\markup { \\tiny x }', '\\tiny')?.markdown ?? '', /\*markup command\*/)
    assert.match(over('  \\tiny x', '\\tiny', '\\markup {\n')?.markdown ?? '', /\*markup command\*/)
  })

  test('contexts after \\new and in a context definition', () => {
    assert.match(over('\\new PianoStaff <<', 'PianoStaff')?.markdown ?? '', /\*context\*/)
    assert.match(over('  \\Staff', '\\Staff')?.markdown ?? '', /Accepts: .*Voice/)
  })

  test('every part of a property path', () => {
    const line = '\\override Staff.NoteHead.color = #red'
    assert.match(over(line, 'Staff')?.markdown ?? '', /\*context\*/)
    assert.match(over(line, 'NoteHead')?.markdown ?? '', /layout object/)
    assert.match(over(line, 'color')?.markdown ?? '', /`color` — \*grob property, color\*/)
    assert.match(over('\\set Staff.instrumentName = "Flute"', 'instrumentName')?.markdown ?? '', /context property, markup/)
    assert.match(over('\\tweak color #red c4', 'color')?.markdown ?? '', /grob property/)
    assert.match(over('\\hide Stem', 'Stem')?.markdown ?? '', /layout object/)
  })

  test('an assignment in a \\with block', () => {
    assert.match(over('  instrumentName = "Flute"', 'instrumentName')?.markdown ?? '', /context property/)
  })

  test('bare words in music and lyrics stay silent', () => {
    assert.equal(over('Rest in the Staff, my color', 'Rest'), undefined)
    assert.equal(over('Rest in the Staff, my color', 'Staff'), undefined)
    assert.equal(over('Rest in the Staff, my color', 'color'), undefined)
    assert.equal(over('c4 d e f', 'd'), undefined)
  })

  test('comments, strings and unknown commands stay silent', () => {
    assert.equal(over('c4 % \\relative', '\\relative'), undefined)
    assert.equal(over('title = "\\relative"', '\\relative'), undefined)
    assert.equal(over('\\myOwnTune', '\\myOwnTune'), undefined)
  })
})

describe('isCode', () => {
  test('a percent sign or a quote inside a string changes nothing', () => {
    assert.equal(isCode('x = "50 % \\" of" '), true)
    assert.equal(isCode('x = "50 % of'), false)
    assert.equal(isCode('c4 % note'), false)
  })
})

describe('inMarkup', () => {
  test('open braces and command runs after \\markup', () => {
    assert.equal(inMarkup('\\markup { a \\column { b '), true)
    assert.equal(inMarkup('\\markup \\bold \\fontsize #2 '), true)
    assert.equal(inMarkup('\\markuplist { '), true)
    assert.equal(inMarkup('\\markup { a } c4 '), false)
    assert.equal(inMarkup('\\markup \\bold "x" } c4 '), false)
    assert.equal(inMarkup('{ c4 d '), false)
  })
})
