import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { LyDiagnostic } from '../../src/diagnostics/parse'
import type { CompileOutcome } from '../src/ipc'
import { compileStatus, DiagnosticStore, toMarkers } from '../src/renderer/diagnostics'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

const error = (file: string, line: number, column?: number, message = 'oops'): LyDiagnostic => ({
  file, line, ...(column === undefined ? {} : { column }), severity: 'error', message,
})

function outcome(partial: Partial<CompileOutcome>): CompileOutcome {
  return { state: 'ok', rootFile: '/s/score.ly', diagnostics: [], errorCount: 0, warningCount: 0, pages: [], svg: [], midi: [], durationMs: 1234, ...partial }
}

describe('toMarkers', () => {
  const lines = ['\\version "2.24.0"', '\t{ c4 \\stacato e }', '']
  const lineAt = (line: number) => lines[line - 1]

  test('underlines the token a column points at, after a tab', () => {
    // lilypond's column 14 counts the tab as 8.
    const [marker] = toMarkers([error('/s/score.ly', 2, 14)], lineAt, lines.length)
    assert.equal(lines[1].slice(marker.startColumn - 1, marker.endColumn - 1), '\\stacato')
    assert.deepEqual([marker.startLineNumber, marker.endLineNumber, marker.severity], [2, 2, 'error'])
  })

  test('without a column, the line without its indentation', () => {
    const [marker] = toMarkers([error('/s/score.ly', 2)], lineAt, lines.length)
    assert.equal(lines[1].slice(marker.startColumn - 1, marker.endColumn - 1), '{ c4 \\stacato e }')
  })

  test('a line past the end marks the last line', () => {
    const [marker] = toMarkers([error('/s/score.ly', 9, 3)], lineAt, lines.length)
    assert.equal(marker.startLineNumber, 3)
  })
})

describe('DiagnosticStore', () => {
  test('keeps each score apart and reports the files to remark', () => {
    const store = new DiagnosticStore()
    const shared = '/s/parts/tune.ily'
    assert.deepEqual(store.update(outcome({ rootFile: '/s/a.ly', diagnostics: [error('/s/a.ly', 1), error(shared, 2)] })), ['/s/a.ly', shared])
    store.update(outcome({ rootFile: '/s/b.ly', diagnostics: [error(shared, 3)] }))
    assert.deepEqual(store.for(shared).map((d) => d.line), [2, 3])
    // A clean compile of a.ly clears what a.ly reported, not b.ly's.
    assert.deepEqual(store.update(outcome({ rootFile: '/s/a.ly' })), ['/s/a.ly', shared])
    assert.deepEqual(store.for(shared).map((d) => d.line), [3])
    assert.deepEqual(store.for('/s/a.ly'), [])
  })

  test('a save that compiled nothing changes nothing', () => {
    const store = new DiagnosticStore()
    store.update(outcome({ diagnostics: [error('/s/score.ly', 1)] }))
    assert.deepEqual(store.update(outcome({ state: 'no-root', rootFile: '/s/x.ily' })), [])
    assert.equal(store.for('/s/score.ly').length, 1)
  })

  test('first prefers an error to an earlier warning', () => {
    const store = new DiagnosticStore()
    const warning: LyDiagnostic = { ...error('/s/score.ly', 1), severity: 'warning' }
    store.update(outcome({ diagnostics: [warning, error('/s/score.ly', 5)] }))
    assert.equal(store.first('/s/score.ly')?.line, 5)
  })
})

describe('compileStatus', () => {
  const name = (file: string) => file.split('/').pop()!

  test('says what happened in plain words', () => {
    assert.deepEqual(compileStatus({ kind: 'started', rootFile: '/s/score.ly' }, name), { text: 'Engraving score.ly…', tone: 'busy' })
    const finished = (partial: Partial<CompileOutcome>) => compileStatus({ kind: 'finished', outcome: outcome(partial) }, name)
    assert.deepEqual(finished({}), { text: 'score.ly: engraved in 1.2 s', tone: 'ok' })
    assert.equal(finished({ warningCount: 1 }).text, 'score.ly: engraved with 1 warning')
    assert.equal(finished({ state: 'failed', errorCount: 2, warningCount: 1 }).text, 'score.ly: 2 errors, 1 warning')
    assert.equal(finished({ state: 'failed', message: 'Backtrace' }).detail, 'Backtrace')
    assert.equal(finished({ state: 'no-lilypond' }).text, 'LilyPond is not installed')
    assert.equal(finished({ state: 'no-root', rootFile: '/s/x.ily' }).text, 'Saved — no score includes x.ily')
  })
})
