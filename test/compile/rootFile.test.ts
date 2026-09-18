import * as assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import {
  includeClosure,
  includeDirsFromArgs,
  parseIncludes,
  rootsIncluding,
} from '../../src/compile/rootFile'

describe('parseIncludes', () => {
  test('finds includes, with or without a space before the name', () => {
    const source = '\\version "2.26.0"\n\\include "parts/a.ily"\n\\include"b.ily"\n{ c }\n'
    assert.deepStrictEqual(parseIncludes(source), ['parts/a.ily', 'b.ily'])
  })

  test('skips includes in comments', () => {
    const source = [
      '% \\include "line.ily"',
      '%{ \\include "block.ily"',
      '   \\include "block2.ily" %}',
      '\\include "real.ily" % \\include "trailing.ily"',
    ].join('\n')
    assert.deepStrictEqual(parseIncludes(source), ['real.ily'])
  })

  test('a percent sign or an include inside a string is text', () => {
    const source = 'title = "100% \\include \\"no.ily\\""\n\\include "yes.ily"\n'
    assert.deepStrictEqual(parseIncludes(source), ['yes.ily'])
  })

  test('unescapes the name', () => {
    assert.deepStrictEqual(parseIncludes('\\include "my \\"best\\" part.ily"'), [
      'my "best" part.ily',
    ])
  })

  test('survives unterminated comments and strings', () => {
    assert.deepStrictEqual(parseIncludes('\\include "a.ily"\n%{ \\include "b.ily"'), ['a.ily'])
    assert.deepStrictEqual(parseIncludes('\\include "a.ily"\n"open \\include "b.ily'), ['a.ily'])
  })
})

describe('includeDirsFromArgs', () => {
  test('understands every spelling lilypond accepts', () => {
    const root = path.resolve('/scores')
    assert.deepStrictEqual(
      includeDirsFromArgs(
        ['-dno-point-and-click', '-I', 'lib', '-Iother', '--include=/abs dir', '--include', 'x'],
        root,
      ),
      [
        path.join(root, 'lib'),
        path.join(root, 'other'),
        path.resolve('/abs dir'),
        path.join(root, 'x'),
      ],
    )
  })

  test('ignores a dangling flag', () => {
    assert.deepStrictEqual(includeDirsFromArgs(['-I'], '/scores'), [])
  })
})

describe('include graph', () => {
  let dir: string
  const at = (...parts: string[]) => path.join(dir, ...parts)

  before(async () => {
    // realpath: os.tmpdir() is a symlink on macOS and the closure is canonical.
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-roots-')))
    const files: Record<string, string> = {
      'song.ly': '\\include "english.ly"\n\\include "parts/melody.ily"\n\\include "coda.ily"\n',
      // Relative to the including file, and relative to the root [verified 2.26].
      'parts/melody.ily': '\\include "shared.ily"\n\\include "parts/lyrics.ily"\n',
      'parts/shared.ily': '\\include "melody.ily"\n',
      'parts/lyrics.ily': 'words = \\lyricmode { la }\n',
      'coda.ily': 'coda = { c1 }\n',
      'hymn.ly': '\\include "parts/shared.ily"\n\\include "house-style.ily"\n',
      'solo.ly': '{ c }\n',
      'lib/house-style.ily': '\\paper { }\n',
    }
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(at(name)), { recursive: true })
      await fs.writeFile(at(name), text)
    }
  })

  after(() => fs.rm(dir, { recursive: true, force: true }))

  test('follows nested includes, tolerates cycles and ignores library files', async () => {
    const closure = await includeClosure(at('song.ly'))
    assert.deepStrictEqual(
      [...closure].sort(),
      [
        at('coda.ily'),
        at('parts/lyrics.ily'),
        at('parts/melody.ily'),
        at('parts/shared.ily'),
        at('song.ly'),
      ].sort(),
    )
  })

  test('searches the -I directories', async () => {
    assert.ok(!(await includeClosure(at('hymn.ly'))).has(at('lib/house-style.ily')))
    const closure = await includeClosure(at('hymn.ly'), { includeDirs: [at('lib')] })
    assert.ok(closure.has(at('lib/house-style.ily')))
  })

  test('a root that does not exist is its own closure', async () => {
    assert.deepStrictEqual([...(await includeClosure(at('gone.ly')))], [at('gone.ly')])
  })

  test('rootsIncluding returns the roots that compile a file', async () => {
    const roots = [at('song.ly'), at('hymn.ly'), at('solo.ly')]
    assert.deepStrictEqual(await rootsIncluding(at('parts/shared.ily'), roots), roots.slice(0, 2))
    assert.deepStrictEqual(await rootsIncluding(at('coda.ily'), roots), [roots[0]])
    assert.deepStrictEqual(await rootsIncluding(at('solo.ly'), roots), [roots[2]])
    assert.deepStrictEqual(await rootsIncluding(at('lib/house-style.ily'), roots), [])
    assert.deepStrictEqual(
      await rootsIncluding(at('lib/house-style.ily'), roots, (root) =>
        root === at('hymn.ly') ? { includeDirs: [at('lib')] } : {},
      ),
      [at('hymn.ly')],
    )
  })

  test('matches a file saved under another spelling of its path', async () => {
    const link = at('link')
    await fs.symlink(at('parts'), link)
    assert.deepStrictEqual(await rootsIncluding(path.join(link, 'lyrics.ily'), [at('song.ly')]), [
      at('song.ly'),
    ])
  })
})
