import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import { before, describe, test } from 'node:test'
import { completionsAt, type LyCompletionList } from '../../src/intellisense/completion'
import { loadIndex, type LilyIndex } from '../../src/intellisense/data'

// Runs under `node --test` (npm run test:unit) against the committed
// data/completions.json and snippets/lilypond.json; cwd is the repository root.

let index: LilyIndex
before(async () => {
  index = await loadIndex(path.resolve('.'))
})

const at = (textBefore: string) => completionsAt(index, textBefore)
const labels = (list: LyCompletionList | undefined) => list?.items.map((item) => item.label) ?? []
const item = (list: LyCompletionList | undefined, label: string) => {
  const found = list?.items.find((candidate) => candidate.label === label)
  assert.ok(found, `${label} is not offered`)
  return found
}

describe('after a backslash', () => {
  test('commands of every kind are offered, with their backslash', () => {
    const list = at('{ c4 \\')
    assert.equal(item(list, '\\transpose').kind, 'function')
    assert.equal(item(list, '\\stemUp').kind, 'music')
    assert.equal(item(list, '\\new').kind, 'keyword')
    assert.equal(item(list, '\\bold').kind, 'markup')
  })

  test('the typed backslash and letters are replaced, not doubled (D13)', () => {
    assert.equal(at('{ c4 \\')?.replace, 1)
    assert.equal(at('{ c4 \\tran')?.replace, 5)
    assert.equal(at('\\markup \\with-')?.replace, 6)
  })

  test('a command attached to a note is completed too', () => {
    assert.ok(labels(at('c4\\stac')).includes('\\staccato'))
  })

  test('what a snippet already inserts is left to the snippet (D14)', () => {
    const offered = labels(at('\\'))
    for (const name of ['\\score', '\\relative', '\\override', '\\version']) {
      assert.ok(index.commands.has(name.slice(1)), `${name} is missing from the data`)
      assert.ok(!offered.includes(name), `${name} is offered twice`)
    }
  })

  test('items carry the signature and the documentation', () => {
    const transpose = item(at('\\'), '\\transpose')
    assert.equal(transpose.detail, 'music function: (pitch) (pitch) (music)')
    assert.match(transpose.doc ?? '', /^```lilypond\n\\transpose \(pitch\) \(pitch\) \(music\)\n```/)
    assert.match(transpose.doc ?? '', /Transpose \*music\* from pitch \*from\* to pitch \*to\*/)
  })

  test('the second backslash of the voice separator starts no command', () => {
    assert.equal(at('<< { c4 } \\\\'), undefined)
    assert.ok(at('<< { c4 } \\\\ \\'))
  })

  test('music commands sort first in music, markup commands first in \\markup', () => {
    const music = at('{ c4 \\')
    assert.ok(item(music, '\\transpose').sortText! < item(music, '\\bold').sortText!)
    for (const text of ['\\markup { \\', '\\markup \\', '\\markup \\italic \\', 'x = \\markup {\n  \\column {\n    \\']) {
      const markup = at(text)
      assert.ok(item(markup, '\\bold').sortText! < item(markup, '\\transpose').sortText!, text)
    }
    const closed = at('\\markup { \\bold x } c4 \\')
    assert.ok(item(closed, '\\transpose').sortText! < item(closed, '\\bold').sortText!)
  })

  test('a name that is both is documented as the markup command inside \\markup', () => {
    assert.equal(item(at('{ \\'), '\\tiny').kind, 'music')
    const tiny = item(at('\\markup { \\'), '\\tiny')
    assert.equal(tiny.kind, 'markup')
    assert.match(tiny.detail ?? '', /^markup command/)
  })
})

describe('after \\new, \\context and \\change', () => {
  test('contexts are offered, and nothing else', () => {
    for (const text of ['\\new ', '\\new Sta', '\\context ', '\\change ', '<<\n  \\new\n    Pia']) {
      const list = at(text)
      assert.ok(labels(list).includes('PianoStaff'), text)
      assert.ok(list?.items.every((candidate) => candidate.kind === 'context'), text)
    }
    assert.equal(at('\\new Sta')?.replace, 3)
    assert.match(item(at('\\new '), 'Staff').doc ?? '', /Handles clefs, bar lines, keys, accidentals/)
  })

  test('once the context is named, a space offers nothing', () => {
    assert.equal(at('\\new Staff '), undefined)
  })

  test('in a context definition the names come with a backslash', () => {
    const list = at('\\layout {\n  \\context {\n    \\Sta')
    assert.ok(labels(list).includes('\\Staff'))
    assert.ok(!labels(list).includes('\\stemUp'))
    assert.equal(list?.replace, 4)
  })
})

describe('after \\override and its relatives', () => {
  test('first a grob or a context', () => {
    for (const command of ['\\override', '\\revert', '\\once \\override', '\\hide', '\\omit']) {
      const list = at(`${command} `)
      assert.equal(item(list, 'NoteHead').kind, 'grob', command)
      assert.equal(item(list, 'Staff').kind, 'context', command)
      assert.ok(item(list, 'NoteHead').sortText! < item(list, 'Staff').sortText!, command)
    }
  })

  test('after Context. only grobs', () => {
    const list = at('\\override Staff.')
    assert.ok(labels(list).includes('TimeSignature'))
    assert.ok(list?.items.every((candidate) => candidate.kind === 'grob'))
  })

  test("after Grob. that grob's properties, the ones it sets first", () => {
    for (const text of ['\\override NoteHead.', '\\override Staff.NoteHead.', '\\revert NoteHead.', '\\tweak NoteHead.']) {
      const list = at(text)
      assert.ok(list?.items.every((candidate) => candidate.kind === 'property'), text)
      assert.ok(labels(list).includes('color'), text)
      // `stencil` is set in NoteHead's description, `color` comes from grob-interface.
      assert.ok(item(list, 'stencil').sortText! < item(list, 'color').sortText!, text)
      // A property of another grob's interface.
      assert.ok(!labels(list).includes('beam-thickness'), text)
    }
  })

  test('the partial name is what gets replaced', () => {
    assert.equal(at('\\override NoteHead.font-s')?.replace, 6)
    assert.equal(at('\\override Note')?.replace, 4)
  })

  test('properties carry type and documentation', () => {
    const color = item(at('\\override NoteHead.'), 'color')
    assert.equal(color.detail, 'color')
    assert.match(color.doc ?? '', /grob property/)
  })

  test('an unknown grob gets every grob property', () => {
    assert.ok(labels(at('\\override MyGrob.')).includes('beam-thickness'))
  })

  test('\\tweak also takes a bare property', () => {
    const list = at('c4 \\tweak ')
    assert.equal(item(list, 'color').kind, 'property')
    assert.equal(item(list, 'NoteHead').kind, 'grob')
  })

  test('nothing below Grob.property, nor after \\hide Grob.', () => {
    assert.equal(at('\\override TextSpanner.bound-details.'), undefined)
    assert.equal(at('\\hide NoteHead.'), undefined)
  })

  test('nothing once the path is complete', () => {
    assert.equal(at('\\override NoteHead.color '), undefined)
    assert.equal(at('\\override NoteHead.color = #red c4 d'), undefined)
  })
})

describe('after \\set and \\unset', () => {
  test('context properties, and contexts to qualify them', () => {
    const list = at('\\set ')
    assert.equal(item(list, 'instrumentName').kind, 'property')
    assert.equal(item(list, 'Staff').kind, 'context')
    assert.ok(!labels(list).includes('NoteHead'))
  })

  test('after Context. only context properties', () => {
    const list = at('\\unset Staff.instr')
    assert.ok(list?.items.every((candidate) => candidate.kind === 'property'))
    assert.equal(list?.replace, 5)
    assert.equal(item(list, 'instrumentName').detail, 'markup')
    assert.ok(!labels(list).includes('color'))
  })
})

describe('where nothing is offered', () => {
  test('in comments and strings', () => {
    assert.equal(at('c4 % \\'), undefined)
    assert.equal(at('%{ notes\n \\'), undefined)
    assert.equal(at('title = "Suite \\'), undefined)
    assert.ok(at('%{ notes %}\n \\'))
    assert.ok(at('title = "50 % \\" more" \\'))
  })

  test('after a space or a dot in ordinary music', () => {
    assert.equal(at('c4 d '), undefined)
    assert.equal(at('c4. '), undefined)
    assert.equal(at('c4.'), undefined)
  })
})
