import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { locateLilyPond } from '../../src/compile/locate'
import { defaultOutDir, type CheckReport } from '../../tools/lily-check/check'
import { EXIT, formatReport, parseCompileArgs, runCli } from '../../tools/lily-check/cli'

// Runs under `node --test` from out/unit/tools/ (npm run test:unit).
const fixtures = path.resolve(__dirname, '../../../test/fixtures')

let scratch: string
let lilypondInstalled = false

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-cli-test-'))
  lilypondInstalled = await locateLilyPond().then(
    () => true,
    () => false,
  )
})

after(() => fs.rm(scratch, { recursive: true, force: true }))

function needsLilyPond(t: TestContext): boolean {
  if (!lilypondInstalled) t.skip('lilypond is not installed')
  return lilypondInstalled
}

/** Runs the CLI in-process, in the fixtures directory. */
async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await runCli(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd: fixtures,
    env: { ...process.env, LILYPOND_PATH: undefined },
  })
  return { code, stdout, stderr }
}

describe('parseCompileArgs', () => {
  const cwd = path.resolve('/work')

  test('a bare file is a text report into the default directory', () => {
    assert.deepEqual(parseCompileArgs(['score.ly'], cwd), {
      file: 'score.ly',
      json: false,
      outDir: undefined,
      lilypondPath: undefined,
      extraArgs: [],
    })
  })

  test('include directories become absolute; what follows -- goes to lilypond untouched', () => {
    const parsed = parseCompileArgs(
      ['--json', '-I', 'lib', '--include=/abs/lib', '-Iparts', 'score.ly', '--out-dir', 'out', '--', '-dno-point-and-click', '--json'],
      cwd,
    )
    assert.equal(parsed.json, true)
    assert.equal(parsed.outDir, 'out')
    assert.deepEqual(parsed.extraArgs, [
      `--include=${path.join(cwd, 'lib')}`,
      `--include=${path.resolve('/abs/lib')}`,
      `--include=${path.join(cwd, 'parts')}`,
      '-dno-point-and-click',
      '--json',
    ])
  })

  test('no file, two files and unknown options are usage errors', () => {
    assert.throws(() => parseCompileArgs([], cwd), /No file given/)
    assert.throws(() => parseCompileArgs(['a.ly', 'b.ly'], cwd), /One file/)
    assert.throws(() => parseCompileArgs(['a.ly', '--pdf'], cwd), /--pdf/)
  })
})

describe('formatReport', () => {
  const cwd = path.resolve('/work')
  const report: CheckReport = {
    ok: false,
    rootFile: path.join(cwd, 'score.ly'),
    exitCode: 1,
    errorCount: 1,
    warningCount: 1,
    diagnostics: [
      {
        file: path.join(cwd, 'parts', 'a.ily'),
        line: 3,
        column: 9,
        severity: 'error',
        message: "unknown command: `\\foo'",
        source: '\tc4 \\foo d',
        token: '\\foo',
      },
      { file: path.join(cwd, 'score.ly'), line: 1, severity: 'warning', message: 'no \\version\nadd one' },
    ],
    pages: ['/tmp/out/score.svg'],
    midi: [],
    outputDir: '/tmp/out',
    durationMs: 1234,
  }

  test('diagnostics read like lilypond prints them, relative to the working directory', () => {
    assert.equal(
      formatReport(report, cwd),
      [
        `${path.join('parts', 'a.ily')}:3:9: error: unknown command: \`\\foo'`,
        '    c4 \\foo d',
        'score.ly:1: warning: no \\version',
        '    add one',
        'FAILED: 1 error, 1 warning, 1 page in 1.2 s',
        '  /tmp/out/score.svg',
        '',
      ].join('\n'),
    )
  })

  test('a run that never happened prints only why', () => {
    const notRun: CheckReport = { ...report, error: { code: 'lilypond-not-found', message: 'Not found.' } }
    assert.equal(formatReport(notRun, cwd), 'Not found.\n')
  })
})

describe('runCli', () => {
  test('without a command, or with an unknown one, prints the usage and exits with 2', async () => {
    const bare = await cli()
    assert.equal(bare.code, EXIT.notRun)
    assert.match(bare.stdout, /^Usage:/)

    const unknown = await cli('render', 'simple.ly')
    assert.equal(unknown.code, EXIT.notRun)
    assert.equal(unknown.stdout, '')
    assert.match(unknown.stderr, /Unknown command "render"/)

    assert.equal((await cli('--help')).code, EXIT.ok)
  })

  test('a missing file is still one JSON document, with exit code 2', async () => {
    const { code, stdout } = await cli('compile', 'missing.ly', '--json')
    const report: CheckReport = JSON.parse(stdout)
    assert.equal(code, EXIT.notRun)
    assert.equal(report.ok, false)
    assert.equal(report.error?.code, 'file-not-found')
    assert.equal(report.rootFile, path.join(fixtures, 'missing.ly'))
    assert.deepEqual(report.pages, [])
  })

  test('a lilypond that cannot be found is reported, not thrown', async () => {
    const { code, stdout } = await cli('compile', 'simple.ly', '--json', '--lilypond', path.join(scratch, 'none'))
    const report: CheckReport = JSON.parse(stdout)
    assert.equal(code, EXIT.notRun)
    assert.equal(report.error?.code, 'lilypond-not-found')
  })

  test('a clean score: exit 0 and pages that outlive the run', async (t) => {
    if (!needsLilyPond(t)) return
    const outDir = path.join(scratch, 'pages out')
    const { code, stdout, stderr } = await cli('compile', 'pages.ly', '--json', '--out-dir', outDir)
    const report: CheckReport = JSON.parse(stdout)

    assert.equal(stderr, '')
    assert.equal(code, EXIT.ok)
    assert.equal(report.ok, true)
    assert.deepEqual(report.diagnostics, [])
    assert.equal(report.outputDir, outDir)
    assert.deepEqual(report.pages, [path.join(outDir, 'pages-1.svg'), path.join(outDir, 'pages-2.svg')])
    for (const page of report.pages) assert.match(await fs.readFile(page, 'utf8'), /<svg/)
  })

  test('a broken score: exit 1, errors located in the included file, with line and token', async (t) => {
    if (!needsLilyPond(t)) return
    const { code, stdout } = await cli('compile', 'broken.ly', '--json', '--out-dir', path.join(scratch, 'broken'))
    const report: CheckReport = JSON.parse(stdout)

    assert.equal(code, EXIT.failed)
    assert.equal(report.ok, false)
    assert.equal(report.exitCode, 1)
    assert.equal(report.errorCount, 4)
    assert.equal(report.warningCount, 1)
    assert.equal(report.stderr, undefined)
    assert.deepEqual(report.diagnostics[0], {
      file: path.join(fixtures, 'parts', 'broken-part.ily'),
      line: 1,
      column: 19,
      severity: 'error',
      message: "unknown command: `\\alsoUndefined'",
      source: 'brokenPart = { c4 \\alsoUndefined d }',
      token: '\\alsoUndefined',
    })
    // Line 7 of broken.ly starts with a tab: column 24 is not character 24.
    const inRoot = report.diagnostics.find((d) => d.file === path.join(fixtures, 'broken.ly'))
    assert.equal(inRoot?.column, 24)
    assert.equal(inRoot?.token, '\\undefinedCommand')
  })

  test('the default directory is stable per file and holds only the last run', async (t) => {
    if (!needsLilyPond(t)) return
    const source = path.join(scratch, 'shrinking.ly')
    const outDir = defaultOutDir(source)
    t.after(() => fs.rm(outDir, { recursive: true, force: true }))

    await fs.copyFile(path.join(fixtures, 'pages.ly'), source)
    const first: CheckReport = JSON.parse((await cli('compile', source, '--json')).stdout)
    assert.deepEqual(first.pages.map((page) => path.relative(outDir, page)), ['shrinking-1.svg', 'shrinking-2.svg'])

    await fs.copyFile(path.join(fixtures, 'simple.ly'), source)
    const second: CheckReport = JSON.parse((await cli('compile', source, '--json')).stdout)
    assert.deepEqual(second.pages, [path.join(outDir, 'shrinking.svg')])
    assert.deepEqual(await fs.readdir(outDir), ['shrinking.svg'])
  })

  test('the text report ends with the verdict and the pages', async (t) => {
    if (!needsLilyPond(t)) return
    const { code, stdout } = await cli('compile', 'simple.ly', '--out-dir', path.join(scratch, 'text'))
    assert.equal(code, EXIT.ok)
    assert.match(stdout, /^OK: 0 errors, 0 warnings, 1 page in [\d.]+ s\n {2}.*simple\.svg\n$/)
  })
})
