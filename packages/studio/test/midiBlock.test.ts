import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { addMidiBlock, type TextEdit } from '../src/renderer/midiBlock'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/, in packages/studio/ (npm run test:unit).

function apply(text: string, edits: TextEdit[]): string {
  return [...edits].reverse().reduce((out, edit) => out.slice(0, edit.offset) + edit.text + out.slice(edit.offset + edit.length), text)
}

/** The text with `\midi { }` added, and the reveal checked to point at it. */
function added(text: string): string {
  const result = addMidiBlock(text)
  assert.equal(result.kind, 'edits', `no edits for:\n${text}`)
  if (result.kind !== 'edits') return text
  const out = apply(text, result.edits)
  assert.ok(out.startsWith('\\midi { }', result.reveal), `reveal ${result.reveal} is not at \\midi in:\n${out}`)
  return out
}

const MELODY = `\\version "2.24.0"

\\header {
  title = "Untitled"
}

\\relative c' {
  \\clef treble
  c4 d e f | g2 g |
}
`

describe('addMidiBlock', () => {
  test('after the \\layout of a score, indented as it is', () => {
    const text = '\\score {\n  \\new Staff { c4 }\n  \\layout {\n    indent = 0\n  }\n}\n'
    assert.equal(added(text), '\\score {\n  \\new Staff { c4 }\n  \\layout {\n    indent = 0\n  }\n  \\midi { }\n}\n')
  })

  test('a score without \\layout gets both, so it is still engraved', () => {
    assert.equal(added('\\score {\n\t{ c4 }\n}\n'), '\\score {\n\t{ c4 }\n\t\\layout { }\n\t\\midi { }\n}\n')
    assert.equal(added('\\score { { c4 } }'), '\\score { { c4 } \\layout { } \\midi { } }')
    assert.equal(added('\\score {{ c4 }}'), '\\score {{ c4 } \\layout { } \\midi { } }')
  })

  test('every score without \\midi, and none with it', () => {
    const text = '\\book {\n  \\score { { c } \\midi { } }\n  \\score { { d } \\layout { } }\n  \\score { { e } }\n}\n'
    assert.equal(added(text), '\\book {\n  \\score { { c } \\midi { } }\n  \\score { { d } \\layout { }\n  \\midi { } }\n  \\score { { e } \\layout { } \\midi { } }\n}\n')
    assert.deepEqual(addMidiBlock('\\score { { c } \\layout { } \\midi { } }'), { kind: 'has-midi' })
  })

  test('comments, strings and Scheme do not count', () => {
    const text = '% \\midi { }\n\\score {\n  { c4^"\\midi }" #(display "}") }\n  %{ \\midi { } %}\n  \\layout { }\n}\n'
    assert.equal(added(text), text.replace('\\layout { }\n', '\\layout { }\n  \\midi { }\n'))
    // A \midi inside the music, not the score's own block, and a \score in a markup.
    const nested = '\\score {\n  \\new Staff \\with { midiInstrument = "flute" } { c }\n  \\layout { }\n}\n\\markup \\score { { c } }\n'
    assert.equal(added(nested), nested.replace('\\layout { }\n', '\\layout { }\n  \\midi { }\n'))
  })

  test('music outside a \\score is wrapped in one', () => {
    assert.equal(
      added(MELODY),
      `\\version "2.24.0"

\\header {
  title = "Untitled"
}

\\score {
  \\relative c' {
    \\clef treble
    c4 d e f | g2 g |
  }
  \\layout { }
  \\midi { }
}
`,
    )
  })

  test('assignments and settings at the top are not music', () => {
    const text = `\\version "2.24.0"
#(set-global-staff-size 18)
\\pointAndClickOff
melody = \\relative c'' { c4 d }
words = \\lyricmode { la la }
size = #20
\\paper
{
  indent = 0
}
\\new Staff \\with { instrumentName = "Fl" } \\melody
\\markup { The end }
`
    assert.equal(
      added(text),
      text.replace(
        '\\new Staff \\with { instrumentName = "Fl" } \\melody\n',
        '\\score {\n  \\new Staff \\with { instrumentName = "Fl" } \\melody\n  \\layout { }\n  \\midi { }\n}\n',
      ),
    )
    assert.deepEqual(addMidiBlock('\\version "2.24.0"\n\\include "parts.ily"\nmelody = { c }\n'), { kind: 'no-score' })
  })

  test('Windows line breaks stay Windows line breaks', () => {
    assert.equal(added('\\score {\r\n  { c }\r\n}\r\n'), '\\score {\r\n  { c }\r\n  \\layout { }\r\n  \\midi { }\r\n}\r\n')
  })
})

describe('addMidiBlock with LilyPond', () => {
  let scratch: string

  before(async () => {
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-midi-block-')))
  })

  after(async () => {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  })

  for (const [name, text] of [
    ['melody', MELODY],
    ['score', '\\version "2.24.0"\nmelody = \\relative { c\'4 d e f }\n\\score {\n  \\new Staff \\melody\n}\n'],
  ] as const) {
    test(`the ${name} plays and is still engraved`, async (t) => {
      const score = path.join(scratch, `${name}.ly`)
      await fs.writeFile(score, added(text))
      const outcome = await realOutcome(t, score)
      if (!outcome) return
      assert.equal(outcome.state, 'ok')
      assert.ok(outcome.midiData && outcome.midiData.length > 0, 'no MIDI')
      assert.ok(outcome.pages.length > 0, 'no pages')
    })
  }
})
