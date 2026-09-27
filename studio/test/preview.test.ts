import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { quiet } from '../../media/preview.js'
import { charToCharacter, parseTextEdit } from '../../src/preview/pointAndClick'
import type { CompileOutcome } from '../src/ipc'
import { previewUpdate } from '../src/renderer/preview'
import { realOutcome } from './outcome'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-preview-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

function outcome(partial: Partial<CompileOutcome>): CompileOutcome {
  return { state: 'ok', rootFile: '/s/score.ly', diagnostics: [], errorCount: 0, warningCount: 0, pages: [], svg: [], midi: [], durationMs: 1, ...partial }
}

describe('previewUpdate', () => {
  const page = ['<svg/>']

  test('the pages of a run are shown, with a note when it had errors', () => {
    assert.deepEqual(previewUpdate(outcome({ svg: page }), false), { show: true })
    assert.deepEqual(previewUpdate(outcome({ state: 'failed', svg: page }), true), {
      show: true,
      note: 'The score has errors, so this may be incomplete.',
    })
  })

  test('a run without pages keeps what is on screen and says why', () => {
    assert.deepEqual(previewUpdate(outcome({ state: 'failed' }), true), {
      show: false,
      note: 'The score has errors. Showing the last version that engraved.',
    })
    assert.deepEqual(previewUpdate(outcome({ state: 'failed' }), false), {
      show: false,
      note: 'The score has errors. Fix them to see it here.',
    })
    assert.deepEqual(previewUpdate(outcome({}), false), { show: false, note: 'LilyPond produced no pages.' })
    assert.deepEqual(previewUpdate(outcome({ state: 'no-lilypond' }), true), { show: false, note: undefined })
    assert.deepEqual(previewUpdate(outcome({ state: 'no-root' }), true), { show: false })
  })

  test("preview.js's quiet() drops LilyPond's inline styles before parsing", () => {
    const svg = '<svg><style>a{}</style><a style="color:inherit;" xlink:href="textedit:///a.ly:1:2:2"><path d="M0"/></a></svg>'
    assert.equal(quiet(svg), '<svg><a xlink:href="textedit:///a.ly:1:2:2"><path d="M0"/></a></svg>')
  })
})

// Reading the pages, and checking a clicked file against the open folder, are
// the Rust side's (crates/engrave's tests).
describe('click-to-source with lilypond', () => {
  test("a note's link leads to its place in the included file", async (t) => {
    const include = path.join(scratch, 'parts', 'tune.ily')
    await fs.mkdir(path.dirname(include), { recursive: true })
    // A tab and an astral character before the note: CHAR counts code points.
    await fs.writeFile(include, 'tune = {\n\t%{𝄞%} fis\'4 g\n}\n')
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(score, '\\version "2.24.0"\n\\include "parts/tune.ily"\n{ \\tune }\n')

    const result = await realOutcome(t, score)
    if (!result) return
    assert.equal(result.state, 'ok', result.message)
    const hrefs = [...result.svg.join('\n').matchAll(/href="(textedit:[^"]*)"/g)].map(([, href]) => href)
    assert.ok(hrefs.length > 0, 'the pages carry point-and-click links')

    // As the editor takes a click: the link's CHAR is a place in the line.
    const locations = hrefs.map((href) => parseTextEdit(href)!)
    const line = '\t%{𝄞%} fis\'4 g'
    const fis = locations.find((l) => l.file === include && l.line === 2 && line.slice(charToCharacter(line, l.char)).startsWith('fis'))
    assert.ok(fis, `a link to fis in ${JSON.stringify(locations)}`)
  })
})
