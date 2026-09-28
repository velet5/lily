import * as assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileRows } from '../src/renderer/files'

// Runs under `node --test` from out/test/ (npm run test:unit in packages/studio/). The
// listing itself is the Rust side's (crates/engrave's tests).

describe('fileRows', () => {
  test('adds a heading for each directory once, indented by depth', () => {
    const files = ['main.ly', 'parts/violin.ily', 'parts/strings/viola.ily', 'parts/strings/cello.ily', 'z.ily'].map(
      (relative) => ({ relative, path: `/f/${relative}` }),
    )
    assert.deepEqual(
      fileRows(files).map((row) => `${'  '.repeat(row.depth)}${row.kind === 'directory' ? `${row.name}/` : row.name}`),
      ['main.ly', 'parts/', '  violin.ily', '  strings/', '    viola.ily', '    cello.ily', 'z.ily'],
    )
  })

  test('a sibling directory gets its own heading', () => {
    const files = ['a/x/1.ly', 'a/y/2.ly'].map((relative) => ({ relative, path: `/f/${relative}` }))
    assert.deepEqual(
      fileRows(files).map((row) => [row.kind, row.name, row.depth]),
      [
        ['directory', 'a', 0],
        ['directory', 'x', 1],
        ['file', '1.ly', 2],
        ['directory', 'y', 1],
        ['file', '2.ly', 2],
      ],
    )
  })
})
