import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, test } from 'node:test'
import { CompileService } from '../../src/compile/compiler'
import { locateLilyPond } from '../../src/compile/locate'
import { columnToCharacter, diagnosticSpan, parseStderr } from '../../src/diagnostics/parse'

// Runs under `node --test` (npm run test:unit). Every stderr sample below is
// verbatim LilyPond 2.26 output (LANGUAGE=en, --loglevel=WARNING), with only the
// directory replaced.
const dir = path.resolve('/scores')
const root = path.join(dir, 'root.ly')
const parse = (stderr: string) => parseStderr(stderr, { rootFile: root })

describe('parseStderr', () => {
  test('located errors: context lines are skipped, the closing summary is dropped', () => {
    const stderr = [
      `${root}:3:12: error: unknown command: \`\\foo'`,
      '\tc4 ',
      '           \\foo d',
      `${root}:3:12: error: string outside of text script or \\lyricmode`,
      '\tc4 ',
      '           \\foo d',
      `${root}:4:5: error: not a note name: ♪`,
      '  é ',
      '    ♪ \\bar "x" c4 \\baz',
      `fatal error: failed files: "${root}"`,
      '',
    ].join('\n')

    assert.deepEqual(parse(stderr), [
      { file: root, line: 3, column: 12, severity: 'error', message: "unknown command: `\\foo'" },
      {
        file: root,
        line: 3,
        column: 12,
        severity: 'error',
        message: 'string outside of text script or \\lyricmode',
      },
      { file: root, line: 4, column: 5, severity: 'error', message: 'not a note name: ♪' },
    ])
  })

  test('warnings, and identical entries reported once', () => {
    const warning = [
      `${root}:2:20: warning: bar check failed at: 1/4`,
      '{ \\time 4/4 c2. c2 ',
      '                   | c1 }',
    ]
    assert.deepEqual(parse([...warning, ...warning].join('\n')), [
      { file: root, line: 2, column: 20, severity: 'warning', message: 'bar check failed at: 1/4' },
    ])
  })

  test('a line-only location keeps its multi-line message', () => {
    const stderr = [
      `${root}:1: warning: no \\version statement found, please add`,
      '',
      '\\version "2.26.0"',
      '',
      'for future compatibility',
      '',
    ].join('\n')
    assert.deepEqual(parse(stderr), [
      {
        file: root,
        line: 1,
        severity: 'warning',
        message: 'no \\version statement found, please add\n\\version "2.26.0"\nfor future compatibility',
      },
    ])
  })

  test('message text before and after the context lines is kept', () => {
    const stderr = [
      `${root}:4:10: error: cannot find file: \`missing.ily'`,
      "(search path: `/scores:/usr/share/lilypond/2.26.0/ly:')",
      '\\include ',
      '         "missing.ily"',
      `${root}:2:2: error: Guile signaled an error for the expression beginning here`,
      '#',
      ' (display (car 5))',
      'In procedure car: Wrong type (expecting pair): 5',
    ].join('\n')
    assert.deepEqual(
      parse(stderr).map((d) => d.message),
      [
        "cannot find file: `missing.ily'\n(search path: `/scores:/usr/share/lilypond/2.26.0/ly:')",
        'Guile signaled an error for the expression beginning here\nIn procedure car: Wrong type (expecting pair): 5',
      ],
    )
  })

  test('column 1 and end-of-input context lines', () => {
    const stderr = [
      `${root}:5:1: error: unknown command: \`\\fod'`,
      '',
      '\\fod',
      `${root}:5:5: error: syntax error, unexpected end of input, expecting '.' or '='`,
      '\\fod',
      '    ',
    ].join('\n')
    assert.deepEqual(
      parse(stderr).map((d) => [d.column, d.message]),
      [
        [1, "unknown command: `\\fod'"],
        [5, "syntax error, unexpected end of input, expecting '.' or '='"],
      ],
    )
  })

  test('errors in an included file, with a space in its path', () => {
    const include = path.join(dir, 'sub dir', 'inc.ily')
    const stderr = [`${include}:1:13: error: unknown command: \`\\qux'`, 'tune = { c4 ', '            \\qux d }'].join('\n')
    assert.deepEqual(parse(stderr), [
      { file: include, line: 1, column: 13, severity: 'error', message: "unknown command: `\\qux'" },
    ])
  })

  test('relative paths resolve against cwd, which defaults to the root directory', () => {
    const stderr = 'parts/inc.ily:1:1: error: boom\n\nx'
    assert.equal(parse(stderr)[0].file, path.join(dir, 'parts', 'inc.ily'))
    const elsewhere = path.resolve('/elsewhere')
    assert.equal(
      parseStderr(stderr, { rootFile: root, cwd: elsewhere })[0].file,
      path.join(elsewhere, 'parts', 'inc.ily'),
    )
  })

  test('a Windows drive letter is part of the path', () => {
    const [diagnostic] = parseStderr('C:\\scores\\a b.ly:3:4: error: boom\r\n{ c\r\n   \\x }\r\n', {
      rootFile: root,
    })
    assert.equal(diagnostic.line, 3)
    assert.equal(diagnostic.column, 4)
    assert.equal(diagnostic.message, 'boom')
    assert.match(diagnostic.file, /a b\.ly$/)
  })

  test('messages without a location attach to line 1 of the root file', () => {
    const stderr = [
      'warning: ignoring unsupported formats (pdf)',
      "fatal error: unable to change directory to: `missing-dir'",
    ].join('\n')
    assert.deepEqual(parse(stderr), [
      { file: root, line: 1, severity: 'warning', message: 'ignoring unsupported formats (pdf)' },
      { file: root, line: 1, severity: 'error', message: "unable to change directory to: `missing-dir'" },
    ])
  })

  test('"failed files" is kept when it is the only sign of the failure', () => {
    const stderr = [`${root}:2:3: warning: something odd`, '{ ', '  c }', `fatal error: failed files: "${root}"`].join('\n')
    assert.deepEqual(
      parse(stderr).map((d) => [d.severity, d.message]),
      [
        ['warning', 'something odd'],
        ['error', `failed files: "${root}"`],
      ],
    )
  })

  test('a programming error is a labelled warning', () => {
    const stderr = ['programming error: bounds of this piece aren’t breakable', 'continuing, cross fingers'].join('\n')
    assert.deepEqual(parse(stderr), [
      {
        file: root,
        line: 1,
        severity: 'warning',
        message: 'programming error: bounds of this piece aren’t breakable',
      },
    ])
  })

  test('output that holds no message yields nothing', () => {
    assert.deepEqual(parse(''), [])
    assert.deepEqual(parse(';;; note: auto-compilation is enabled\nBacktrace:\n  1 (primitive-load "x")\n'), [])
  })
})

describe('columnToCharacter', () => {
  // Columns below are the ones lilypond printed for `\foo` in each line.
  test('tabs advance to the next multiple of 8', () => {
    assert.equal(columnToCharacter('\tc4 \\foo d', 12), 4)
    assert.equal(columnToCharacter('{ c4\t\\foo }', 9), 5)
    assert.equal(columnToCharacter('{ c4 \t\t\\foo }', 17), 7)
  })

  test('columns count code points; characters are UTF-16 units', () => {
    assert.equal(columnToCharacter('  é ♪ \\bar "x" c4 \\foo', 19), 18)
    assert.equal(columnToCharacter('{ 𝄞𝄞 \\foo }', 6), 7)
  })

  test('column 1 and columns past the end of the line', () => {
    assert.equal(columnToCharacter('\\foo', 1), 0)
    assert.equal(columnToCharacter('\\foo', 40), 4)
    assert.equal(columnToCharacter('', 3), 0)
  })
})

describe('diagnosticSpan', () => {
  const underlined = (line: string, column?: number) => {
    const { start, end } = diagnosticSpan(line, column)
    return line.slice(start, end)
  }

  test('widens to the token at the column', () => {
    assert.equal(underlined('\tc4 \\foo d', 12), '\\foo')
    assert.equal(underlined('{ c4 \\foo}', 6), '\\foo')
    assert.equal(underlined('{ c4\\< }', 5), '\\<')
    assert.equal(underlined("{ cis''4. d }", 3), "cis''4.")
    assert.equal(underlined('  é ♪ \\bar', 3), 'é')
    assert.equal(underlined('\\override Foo.bar = #1', 11), 'Foo.bar')
    assert.equal(underlined('\\include "missing.ily"', 10), '"missing.ily"')
    assert.equal(underlined('#(display (car 5))', 1), '#')
    // Scheme errors point at the parenthesis after the `#`.
    assert.equal(underlined('x = #(display (car 5)) c4', 6), '#(display (car 5))')
    assert.equal(underlined('  #(define (f x)  ', 4), '#(define (f x)')
    assert.equal(underlined('{ c4( d) }', 5), '( d)')
    assert.equal(underlined('{ 𝄞𝄞 }', 3), '𝄞')
  })

  test('is never empty on a non-empty line', () => {
    assert.deepEqual(diagnosticSpan('\\fod', 5), { start: 3, end: 4 })
    assert.deepEqual(diagnosticSpan('{ c1 } ', 7), { start: 6, end: 7 })
    assert.deepEqual(diagnosticSpan('', 1), { start: 0, end: 0 })
  })

  test('without a column, the line without its indentation', () => {
    assert.equal(underlined('  { c4 d e f }  '), '{ c4 d e f }')
    assert.deepEqual(diagnosticSpan('   '), { start: 3, end: 3 })
  })
})

describe('against the real binary', () => {
  test('stderr of a failing compile maps back onto the source text', async (t) => {
    const installed = await locateLilyPond().then(
      () => true,
      () => false,
    )
    if (!installed) return t.skip('lilypond is not installed')

    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-test-'))
    const service = new CompileService({ tmpRoot: scratch })
    try {
      const source = ['{', '\tc4 \\foo d', '  é 𝄞 \\bar "|" c4\t\\baz', '}', '#(car 5)', ''].join('\n')
      const rootFile = path.join(scratch, 'süß dir', 'bad.ly')
      await fs.mkdir(path.dirname(rootFile))
      await fs.writeFile(rootFile, source)

      const result = await service.compile({ rootFile })
      const diagnostics = parseStderr(result.stderr, { rootFile })
      const lines = source.split('\n')
      const found = diagnostics.map((d) => {
        assert.equal(d.file, rootFile)
        const { start, end } = diagnosticSpan(lines[d.line - 1], d.column)
        return `${d.line} ${d.severity} ${lines[d.line - 1].slice(start, end)} | ${d.message.split('\n')[0]}`
      })

      assert.equal(result.ok, false)
      for (const expected of [
        '1 warning { | no \\version statement found, please add',
        "2 error \\foo | unknown command: `\\foo'",
        '3 error é | not a note name: é',
        '3 error 𝄞 | not a note name: 𝄞',
        "3 error \\baz | unknown command: `\\baz'",
        '5 error #(car 5) | Guile signaled an error for the expression beginning here',
      ]) {
        assert.ok(found.includes(expected), `${expected}\n  not in\n${found.join('\n')}`)
      }
      assert.ok(diagnostics.some((d) => /In procedure car/.test(d.message)), found.join('\n'))
      assert.ok(!diagnostics.some((d) => /failed files/.test(d.message)), found.join('\n'))
      // Nothing but messages and their context: no source excerpt leaked into a message.
      assert.ok(!diagnostics.some((d) => /\\bar/.test(d.message)), found.join('\n'))
    } finally {
      await service.dispose()
      await fs.rm(scratch, { recursive: true, force: true })
    }
  })
})
