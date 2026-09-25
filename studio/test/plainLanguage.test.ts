import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LyDiagnostic } from '../../src/diagnostics/parse'
import type { CompileOutcome } from '../src/ipc'
import { problemSummary, toMarkers } from '../src/renderer/diagnostics'
import { explain, markerMessage } from '../src/renderer/plainLanguage'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

const said = (message: string) => explain({ message })

describe('explain', () => {
  test("lilypond's common messages, as lilypond 2.26 prints them", () => {
    assert.match(said("unknown command: `\\stacato'") ?? '', /^“\\stacato” is not a LilyPond command/)
    assert.match(said('not a note name: h') ?? '', /^“h” is not a note/)
    assert.match(said('string outside of text script or \\lyricmode') ?? '', /Text stands among the notes/)
    assert.match(said('syntax error, unexpected end of input') ?? '', /closing brace \} is probably missing/)
    assert.match(said("syntax error, unexpected '}'") ?? '', /closing brace \} too many/)
    assert.match(said("syntax error, unexpected '}', expecting \\header") ?? '', /closing brace \} too many/)
    assert.match(said('syntax error, unexpected STRING') ?? '', /could not read the music/)
    assert.match(said('not a duration') ?? '', /duration does not exist/)
    assert.match(said("cannot find file: `parts/nope.ily'") ?? '', /“parts\/nope\.ily”/)
    assert.match(said('bar check failed at: 1/2') ?? '', /do not fill the bar/)
    assert.match(said('unterminated slur') ?? '', /Add \)/)
    assert.match(said('cannot end slur') ?? '', /none was started/)
    assert.match(said('unterminated tie') ?? '', /same pitch/)
    assert.match(said('unterminated crescendo') ?? '', /^A crescendo starts here/)
    assert.match(said('no \\version statement found, please add\n\\version "2.26.0"\nfor future compatibility') ?? '', /\\version line/)
    assert.match(said('wrong type for argument 2.  Expecting time signature, found 3') ?? '', /wrong kind of value/)
  })

  test('an unknown message has no summary, and its marker keeps it as it is', () => {
    assert.equal(said('programming error: bounds of this piece aren’t breakable'), undefined)
    assert.equal(markerMessage({ message: 'something odd' }), 'something odd')
  })

  test('a marker leads with the summary and keeps what LilyPond said', () => {
    const diagnostic: LyDiagnostic = { file: '/s/a.ly', line: 1, column: 1, severity: 'error', message: 'not a note name: h' }
    const [marker] = toMarkers([diagnostic], () => 'h4', 1)
    assert.match(marker.message, /^“h” is not a note\..*\n\nLilyPond says: not a note name: h$/s)
  })
})

describe('problemSummary', () => {
  const name = (file: string) => file.replace('/s/', '')
  const outcome = (partial: Partial<CompileOutcome>): CompileOutcome => ({
    state: 'failed', rootFile: '/s/score.ly', diagnostics: [], errorCount: 0, warningCount: 0, pages: [], svg: [], midi: [], durationMs: 1, ...partial,
  })
  const warning: LyDiagnostic = { file: '/s/score.ly', line: 4, severity: 'warning', message: 'bar check failed at: 1/4' }
  const error: LyDiagnostic = { file: '/s/parts/a.ily', line: 9, severity: 'error', message: 'weird thing\nmore' }

  test('the first error, where it is and what it means', () => {
    const summary = problemSummary(outcome({ diagnostics: [warning, error], errorCount: 1, warningCount: 1 }), name)
    assert.deepEqual(
      { ...summary, diagnostic: summary?.diagnostic.line },
      { tone: 'error', heading: '1 error, 1 warning in score.ly', text: 'Line 9 of parts/a.ily: LilyPond says: weird thing', diagnostic: 9 },
    )
  })

  test('a warning alone, in the score itself', () => {
    const summary = problemSummary(outcome({ state: 'ok', diagnostics: [warning], warningCount: 1 }), name)
    assert.equal(summary?.tone, 'warning')
    assert.match(summary?.text ?? '', /^Line 4: The notes before this bar line/)
  })

  test('nothing to say', () => {
    assert.equal(problemSummary(outcome({ state: 'ok' }), name), undefined)
    assert.equal(problemSummary(outcome({ state: 'no-lilypond' }), name), undefined)
  })
})
